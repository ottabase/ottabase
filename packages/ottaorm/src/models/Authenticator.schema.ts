// ============================================================
// @ottabase/ottaorm - Authenticator table schema (passkeys and authenticator apps)
// ============================================================

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * One row per sign-in factor a person added to their account, beyond the password:
 *
 * - `passkey`: a WebAuthn credential. `credentialId` (base64url) finds it at sign-in, `publicKey`
 *   (a JWK) checks its signatures, `algorithm` is the COSE algorithm, `counter` the last signature
 *   counter the authenticator reported.
 * - `totp`: an authenticator app (RFC 6238). At most one per person (a partial unique index).
 *   `secret` is the shared key SEALED under `AUTH_FACTOR_KEY` (else `AUTH_SECRET`), never
 *   plaintext; `lastStep` the last accepted 30-second step (a code is never accepted twice);
 *   `confirmedAt` null while setup waits for the first code.
 *
 * Every confirmed row (a passkey always is) means two-factor sign-in is on.
 *
 * Recovery codes are not here: they are single-use `verification_tokens` rows (hashed), consumed
 * atomically like a magic link. Nothing reads this table through generic CRUD.
 */
export const authenticatorsTable = sqliteTable(
    'authenticators',
    {
        id: text('id')
            .primaryKey()
            .$defaultFn(() => crypto.randomUUID()),
        userId: text('user_id').notNull(),
        kind: text('kind').notNull(), // passkey, totp
        /** The person's name for it ("Work laptop"). */
        name: text('name'),
        credentialId: text('credential_id'),
        publicKey: text('public_key'),
        algorithm: integer('algorithm'),
        counter: integer('counter').default(0),
        /** JSON array of the transports the browser reported (`usb`, `internal`, `hybrid`...). */
        transports: text('transports'),
        secret: text('secret'),
        lastStep: integer('last_step'),
        confirmedAt: integer('confirmed_at'),
        lastUsedAt: integer('last_used_at'),
        // App identifier for multi-app database sharing (nullable, opt-in)
        appId: text('app_id'),
        createdAt: integer('created_at')
            .$defaultFn(() => Date.now())
            .notNull(),
        updatedAt: integer('updated_at')
            .$defaultFn(() => Date.now())
            .$onUpdateFn(() => Date.now())
            .notNull(),
    },
    (t) => ({
        // A credential id names one passkey everywhere: the sign-in lookup is global.
        credentialUnique: uniqueIndex('authenticators_credential_unique').on(t.credentialId),
        userIdx: index('authenticators_user_idx').on(t.userId),
        // One authenticator app per person. The condition is a literal on purpose: the runtime
        // migration drops a WHERE with bind parameters, which would make this a global unique index.
        totpUnique: uniqueIndex('authenticators_totp_user_unique')
            .on(t.userId)
            .where(sql`${t.kind} = 'totp'`),
    }),
);

export type AuthenticatorType = typeof authenticatorsTable.$inferSelect;
export type NewAuthenticatorType = typeof authenticatorsTable.$inferInsert;
