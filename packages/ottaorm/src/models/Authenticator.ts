// ============================================================
// @ottabase/ottaorm - Authenticator Model (passkeys and authenticator apps)
// ============================================================

import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { BaseModel, ModelFields, type PackageType } from '../base/BaseModel';
import { authenticatorsTable, type AuthenticatorType } from './Authenticator.schema';

export { authenticatorsTable, type AuthenticatorType, type NewAuthenticatorType } from './Authenticator.schema';

export type AuthenticatorKind = 'passkey' | 'totp';

/**
 * The sign-in factors a person added beyond their password (see Authenticator.schema.ts).
 *
 * `@ottabase/auth` owns every read and write: the verification (WebAuthn signatures, TOTP codes,
 * sealing) lives there, and the persistence lives here. Every method goes straight to the
 * query builder, like VerificationToken, because the sign-in flow runs before there is any
 * security context; the RLS registry denies the table to generic CRUD.
 */
export class Authenticator extends BaseModel {
    static entity = 'authenticators';
    static table = authenticatorsTable;
    static primaryKey = 'id';
    static packageName = '@ottabase/ottaorm';
    static packageType: PackageType = 'core';

    // Never serialized: a sealed secret or a public key has no business in a response.
    protected static hidden = ['secret', 'publicKey', 'credentialId'];

    protected static fields: ModelFields = {
        id: { type: 'id', primaryKey: true, editable: false, uiConfig: { label: 'ID' } },
        userId: { type: 'string', editable: false, uiConfig: { label: 'User' } },
        kind: { type: 'string', editable: false, uiConfig: { label: 'Kind' } },
        name: { type: 'string', editable: true, uiConfig: { label: 'Name' } },
    };

    private static qb() {
        return this.getDriver().getDb();
    }

    private static firstRow<T>(rows: T[] | T): T | null {
        return (Array.isArray(rows) ? rows[0] : rows) ?? null;
    }

    /** Every factor of a person, oldest first. Includes an unconfirmed authenticator app. */
    static async listForUser(userId: string): Promise<AuthenticatorType[]> {
        const rows = await this.qb()
            .select()
            .from(authenticatorsTable)
            .where(eq(authenticatorsTable.userId, userId))
            .orderBy(authenticatorsTable.createdAt);
        return rows as AuthenticatorType[];
    }

    /** The passkey a WebAuthn assertion names, whoever it belongs to. */
    static async findPasskey(credentialId: string): Promise<AuthenticatorType | null> {
        const rows = await this.qb()
            .select()
            .from(authenticatorsTable)
            .where(and(eq(authenticatorsTable.kind, 'passkey'), eq(authenticatorsTable.credentialId, credentialId)))
            .limit(1);
        return this.firstRow(rows as AuthenticatorType[]);
    }

    /** The person's authenticator app: confirmed, or still waiting for its first code. */
    static async totpFor(userId: string): Promise<AuthenticatorType | null> {
        const rows = await this.qb()
            .select()
            .from(authenticatorsTable)
            .where(and(eq(authenticatorsTable.userId, userId), eq(authenticatorsTable.kind, 'totp')))
            .limit(1);
        return this.firstRow(rows as AuthenticatorType[]);
    }

    /** True when two-factor sign-in is on: a confirmed authenticator app. */
    static async hasTwoFactor(userId: string): Promise<boolean> {
        const rows = await this.qb()
            .select({ id: authenticatorsTable.id })
            .from(authenticatorsTable)
            .where(
                and(
                    eq(authenticatorsTable.userId, userId),
                    eq(authenticatorsTable.kind, 'totp'),
                    isNotNull(authenticatorsTable.confirmedAt),
                ),
            )
            .limit(1);
        return (rows as unknown[]).length > 0;
    }

    /** Of these people, the ones with two-factor sign-in on. For a roster's status column. */
    static async withTwoFactor(userIds: string[]): Promise<Set<string>> {
        if (userIds.length === 0) return new Set();
        const rows = (await this.qb()
            .select({ userId: authenticatorsTable.userId })
            .from(authenticatorsTable)
            .where(
                and(
                    inArray(authenticatorsTable.userId, userIds),
                    eq(authenticatorsTable.kind, 'totp'),
                    isNotNull(authenticatorsTable.confirmedAt),
                ),
            )) as Array<{ userId: string }>;
        return new Set(rows.map((row) => row.userId));
    }

    /** Start (or restart) authenticator-app setup: one unconfirmed row holding the sealed secret. */
    static async beginTotp(userId: string, sealedSecret: string): Promise<void> {
        await this.qb()
            .delete(authenticatorsTable)
            .where(
                and(
                    eq(authenticatorsTable.userId, userId),
                    eq(authenticatorsTable.kind, 'totp'),
                    isNull(authenticatorsTable.confirmedAt),
                ),
            );
        await this.qb().insert(authenticatorsTable).values({ userId, kind: 'totp', secret: sealedSecret });
    }

    /**
     * Record that a code for `step` was accepted. One statement, so of two requests carrying the
     * same code exactly one wins: the row only moves forward when `step` is newer than the last
     * accepted one. Confirms the app on its first code. False when the step was already used.
     */
    static async acceptTotpStep(id: string, step: number): Promise<boolean> {
        const now = Date.now();
        const rows = await this.qb()
            .update(authenticatorsTable)
            .set({ lastStep: step, lastUsedAt: now })
            .where(
                and(
                    eq(authenticatorsTable.id, id),
                    or(isNull(authenticatorsTable.lastStep), lt(authenticatorsTable.lastStep, step)),
                ),
            )
            .returning({ id: authenticatorsTable.id, confirmedAt: authenticatorsTable.confirmedAt });
        const row = this.firstRow(rows as Array<{ id: string; confirmedAt: number | null }>);
        if (!row) return false;
        if (row.confirmedAt == null) {
            await this.qb().update(authenticatorsTable).set({ confirmedAt: now }).where(eq(authenticatorsTable.id, id));
        }
        return true;
    }

    /** Turn two-factor sign-in off: the authenticator app goes, confirmed or not. */
    static async removeTotp(userId: string): Promise<boolean> {
        const rows = await this.qb()
            .delete(authenticatorsTable)
            .where(and(eq(authenticatorsTable.userId, userId), eq(authenticatorsTable.kind, 'totp')))
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length > 0;
    }

    static async addPasskey(input: {
        userId: string;
        name: string;
        credentialId: string;
        publicKey: string;
        algorithm: number;
        counter: number;
        transports: string[];
    }): Promise<AuthenticatorType> {
        const rows = await this.qb()
            .insert(authenticatorsTable)
            .values({
                userId: input.userId,
                kind: 'passkey',
                name: input.name,
                credentialId: input.credentialId,
                publicKey: input.publicKey,
                algorithm: input.algorithm,
                counter: input.counter,
                transports: JSON.stringify(input.transports),
                confirmedAt: Date.now(),
            })
            .returning();
        return this.firstRow(rows as AuthenticatorType[]) as AuthenticatorType;
    }

    /** After a passkey signed in: its new counter and when. */
    static async touchPasskey(id: string, counter: number): Promise<void> {
        await this.qb()
            .update(authenticatorsTable)
            .set({ counter, lastUsedAt: Date.now() })
            .where(eq(authenticatorsTable.id, id));
    }

    static async renamePasskey(userId: string, id: string, name: string): Promise<boolean> {
        const rows = await this.qb()
            .update(authenticatorsTable)
            .set({ name })
            .where(
                and(
                    eq(authenticatorsTable.id, id),
                    eq(authenticatorsTable.userId, userId),
                    eq(authenticatorsTable.kind, 'passkey'),
                ),
            )
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length > 0;
    }

    /** Only the owner's own passkey: the user id is part of the match, never trusted from the id alone. */
    static async removePasskey(userId: string, id: string): Promise<boolean> {
        const rows = await this.qb()
            .delete(authenticatorsTable)
            .where(
                and(
                    eq(authenticatorsTable.id, id),
                    eq(authenticatorsTable.userId, userId),
                    eq(authenticatorsTable.kind, 'passkey'),
                ),
            )
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length > 0;
    }
}
