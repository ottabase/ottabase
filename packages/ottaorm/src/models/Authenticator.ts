// ============================================================
// @ottabase/ottaorm - Authenticator Model (passkeys and authenticator apps)
// ============================================================

import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { BaseModel, ModelFields, type PackageType } from '../base/BaseModel';
import { authenticatorsTable, type AuthenticatorType } from './Authenticator.schema';

/** User ids per `withTwoFactor` statement: D1 binds at most 100 parameters. */
const WITH_TWO_FACTOR_CHUNK = 90;

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

    /** The person's authenticator app (at most one): confirmed, or still waiting for its first code. */
    static async totpFor(userId: string): Promise<AuthenticatorType | null> {
        const rows = await this.qb()
            .select()
            .from(authenticatorsTable)
            .where(and(eq(authenticatorsTable.userId, userId), eq(authenticatorsTable.kind, 'totp')))
            .limit(1);
        return this.firstRow(rows as AuthenticatorType[]);
    }

    /**
     * True when two-factor sign-in is on: a confirmed authenticator app or at least one passkey.
     * A passkey is confirmed when it is added, so "any confirmed row" covers both.
     */
    static async hasTwoFactor(userId: string): Promise<boolean> {
        const rows = await this.qb()
            .select({ id: authenticatorsTable.id })
            .from(authenticatorsTable)
            .where(and(eq(authenticatorsTable.userId, userId), isNotNull(authenticatorsTable.confirmedAt)))
            .limit(1);
        return (rows as unknown[]).length > 0;
    }

    /** Of these people, the ones with two-factor sign-in on. For a roster's status column. */
    static async withTwoFactor(userIds: string[]): Promise<Set<string>> {
        const enabled = new Set<string>();
        const unique = [...new Set(userIds)];
        // D1 binds at most 100 parameters per statement; stay well under it.
        for (let i = 0; i < unique.length; i += WITH_TWO_FACTOR_CHUNK) {
            const rows = (await this.qb()
                .selectDistinct({ userId: authenticatorsTable.userId })
                .from(authenticatorsTable)
                .where(
                    and(
                        inArray(authenticatorsTable.userId, unique.slice(i, i + WITH_TWO_FACTOR_CHUNK)),
                        isNotNull(authenticatorsTable.confirmedAt),
                    ),
                )) as Array<{ userId: string }>;
            for (const row of rows) enabled.add(row.userId);
        }
        return enabled;
    }

    /**
     * Start (or restart) authenticator-app setup: the one unconfirmed row now holds this sealed
     * secret. One upsert against the partial unique index, so two setups racing leave one row.
     * False when the person already has a confirmed app (nothing is changed then).
     */
    static async beginTotp(userId: string, sealedSecret: string): Promise<boolean> {
        const now = Date.now();
        const rows = await this.qb()
            .insert(authenticatorsTable)
            .values({ userId, kind: 'totp', secret: sealedSecret })
            .onConflictDoUpdate({
                target: authenticatorsTable.userId,
                targetWhere: sql`${authenticatorsTable.kind} = 'totp'`,
                set: { secret: sealedSecret, lastStep: null, lastUsedAt: null, createdAt: now, updatedAt: now },
                setWhere: isNull(authenticatorsTable.confirmedAt),
            })
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length > 0;
    }

    /**
     * Record that a code for `step` was accepted. One statement, so of two requests carrying the
     * same code exactly one wins: the row only moves forward when `step` is newer than the last
     * accepted one, and the first accepted code confirms the app in the same write. False when
     * the step was already used.
     */
    static async acceptTotpStep(id: string, step: number): Promise<boolean> {
        const now = Date.now();
        const rows = await this.qb()
            .update(authenticatorsTable)
            .set({
                lastStep: step,
                lastUsedAt: now,
                confirmedAt: sql`coalesce(${authenticatorsTable.confirmedAt}, ${now})`,
            })
            .where(
                and(
                    eq(authenticatorsTable.id, id),
                    or(isNull(authenticatorsTable.lastStep), lt(authenticatorsTable.lastStep, step)),
                ),
            )
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length > 0;
    }

    /** Remove the authenticator app, confirmed or not. */
    static async removeTotp(userId: string): Promise<boolean> {
        const rows = await this.qb()
            .delete(authenticatorsTable)
            .where(and(eq(authenticatorsTable.userId, userId), eq(authenticatorsTable.kind, 'totp')))
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length > 0;
    }

    /** Remove every factor a person has (an administrator's reset). Returns how many went. */
    static async removeAllForUser(userId: string): Promise<number> {
        const rows = await this.qb()
            .delete(authenticatorsTable)
            .where(eq(authenticatorsTable.userId, userId))
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length;
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

    /**
     * After a passkey signed in: its new counter and when. The counter only moves forward (a
     * synced passkey reports 0 every time and always passes): false when another assertion with
     * this counter or a later one landed first, which the caller treats as a replay.
     */
    static async touchPasskey(id: string, counter: number): Promise<boolean> {
        const rows = await this.qb()
            .update(authenticatorsTable)
            .set({ counter, lastUsedAt: Date.now() })
            .where(
                counter === 0
                    ? eq(authenticatorsTable.id, id)
                    : and(eq(authenticatorsTable.id, id), lt(authenticatorsTable.counter, counter)),
            )
            .returning({ id: authenticatorsTable.id });
        return (rows as unknown[]).length > 0;
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
