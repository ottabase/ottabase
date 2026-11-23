// End to end against real SQLite (node:sqlite behind the D1 API) and an in-memory KV: enrolling
// an authenticator app, the second-factor challenge on every sign-in method, recovery codes, the
// attempt limit, the recent-sign-in rule, passkeys, and a policy that requires two-factor.

import { autoInit, clearConnection, registerConnection, registerModels } from '@ottabase/ottaorm';
import {
    Account,
    accountsTable,
    Authenticator,
    authenticatorsTable,
    OrganizationMember,
    organizationMembersTable,
    Role,
    rolesTable,
    User,
    UserRole,
    userRolesTable,
    usersTable,
    VerificationToken,
    verificationTokensTable,
} from '@ottabase/ottaorm';
import { createD1Driver } from '@ottabase/db/drizzle-d1';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthEnv, CreateAuthConfigOptions } from '../types';
import { createPasskey, signIn as signInWithPasskey } from './soft-authenticator';
import { createSqliteD1 } from './sqlite-d1';

// First-user bootstrap (the platform owner's organization) is bootstrap.test.ts's business.
vi.mock('../bootstrap', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../bootstrap')>()),
    bootstrapFirstUser: vi.fn(async () => ({ isPlatformOwner: false, organizationId: null })),
}));

const { getSession, handleAuthRequest, hashPassword, hashToken, isTwoFactorSetupPending, resetTwoFactor } =
    await import('../backend-handler');
const { base32Decode, hotp, totpStep } = await import('../totp');

const ORIGIN = 'https://app.example.com';
const PASSWORD = 'correct horse battery staple';

function createFakeKv() {
    const store = new Map<string, { value: string; metadata?: unknown }>();
    return {
        store,
        async get(key: string) {
            return store.get(key)?.value ?? null;
        },
        async getWithMetadata(key: string) {
            const entry = store.get(key);
            return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
        },
        async put(key: string, value: string, options?: { metadata?: unknown }) {
            store.set(key, { value, metadata: options?.metadata });
        },
        async delete(key: string) {
            store.delete(key);
        },
        async list(options: { prefix: string }) {
            return {
                keys: [...store.keys()].filter((name) => name.startsWith(options.prefix)).map((name) => ({ name })),
                list_complete: true,
            };
        },
    } as unknown as NonNullable<AuthEnv['OBCF_KV']> & { store: typeof store };
}

const d1 = createSqliteD1();
const env: AuthEnv = {
    AUTH_SECRET: 'test-secret-at-least-32-chars-long!!',
    AUTH_URL: ORIGIN,
    ENVIRONMENT: 'test',
    OBCF_D1: d1 as never,
    OBCF_KV: createFakeKv(),
};
let options: CreateAuthConfigOptions = {};

/** A browser: keeps the cookies the server sets and sends them back. */
function browser() {
    const jar = new Map<string, string>();
    const take = (response: Response) => {
        for (const header of response.headers.getSetCookie()) {
            const [pair, ...attributes] = header.split(';');
            const [name, ...value] = pair.split('=');
            const expired = attributes.some((a) => /max-age=0/i.test(a.trim()));
            if (expired) jar.delete(name.trim());
            else jar.set(name.trim(), value.join('='));
        }
        return response;
    };
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const send = async (path: string, init: RequestInit = {}) =>
        take(
            await handleAuthRequest(
                new Request(`${ORIGIN}${path}`, {
                    ...init,
                    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie(), ...init.headers },
                }),
                env,
                options,
            ),
        );
    const csrf = async () => ((await (await send('/api/auth/csrf')).json()) as { csrfToken: string }).csrfToken;
    return {
        jar,
        send,
        /** A state-changing call with a fresh CSRF token in its body. */
        async post(path: string, body: Record<string, unknown> = {}, method = 'POST') {
            return send(path, { method, body: JSON.stringify({ ...body, csrfToken: await csrf() }) });
        },
        hasSession: () => [...jar.keys()].some((name) => name.endsWith('session-token')),
        hasPending: () => [...jar.keys()].some((name) => name.endsWith('second-factor')),
        request: (path: string) => new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie() } }),
    };
}

async function passwordSignIn(email = 'ana@example.com') {
    const b = browser();
    const response = await b.post('/api/auth/callback/credentials', { email, password: PASSWORD });
    return { b, response, body: (await response.json()) as Record<string, unknown> };
}

/** The current code of an authenticator app, `offset` steps from now. */
async function codeFor(secret: string, offset = 0): Promise<string> {
    return hotp(base32Decode(secret), totpStep() + offset);
}

/** Sign in and turn the authenticator app on; returns its secret and recovery codes. */
async function enrollTotp(email = 'ana@example.com') {
    const { b } = await passwordSignIn(email);
    const begin = (await (await b.post('/api/auth/factors/totp')).json()) as { secret: string; uri: string };
    const confirm = await b.post('/api/auth/factors/totp/confirm', { code: await codeFor(begin.secret) });
    const { recoveryCodes } = (await confirm.json()) as { recoveryCodes: string[] };
    return { secret: begin.secret, recoveryCodes, uri: begin.uri };
}

/** A recent session for an account with two-factor on: the password, then the next code. */
async function signInWithCode(secret: string, email = 'ana@example.com') {
    const { b } = await passwordSignIn(email);
    const finished = await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) });
    expect(finished.status).toBe(200);
    return b;
}

beforeAll(async () => {
    const driver = createD1Driver(d1);
    const result = await autoInit({
        driver,
        schema: {
            usersTable,
            accountsTable,
            authenticatorsTable,
            verificationTokensTable,
            organizationMembersTable,
            rolesTable,
            userRolesTable,
        },
        verbose: false,
    });
    expect(result.details.errors).toEqual([]);
    registerConnection('default', driver);
    registerModels([User, Account, VerificationToken, Authenticator, OrganizationMember, Role, UserRole]);
});
afterAll(() => clearConnection('default'));

beforeEach(async () => {
    vi.useRealTimers();
    options = {};
    (env.OBCF_KV as unknown as { store: Map<string, unknown> }).store.clear();
    await d1.exec('DELETE FROM users; DELETE FROM authenticators; DELETE FROM verification_tokens;');
    await User.create({
        email: 'ana@example.com',
        name: 'Ana',
        passwordHash: await hashPassword(PASSWORD),
        emailVerified: Date.now(),
    });
});

describe('without an authenticator app', () => {
    it('signs in with the password alone', async () => {
        const { b, body } = await passwordSignIn();
        expect(body.success).toBe(true);
        expect(b.hasSession()).toBe(true);
    });
});

describe('enrolling an authenticator app', () => {
    it('turns on with the first code, hands out ten recovery codes, and reports it', async () => {
        const { uri, recoveryCodes } = await enrollTotp();
        expect(uri).toMatch(/^otpauth:\/\/totp\/app\.example\.com:ana%40example\.com\?secret=/);
        expect(recoveryCodes).toHaveLength(10);
        expect(new Set(recoveryCodes).size).toBe(10);
        for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);

        const { b } = await passwordSignIn();
        expect(b.hasSession()).toBe(false);
    });

    it('stores the secret sealed and the recovery codes hashed', async () => {
        const { secret, recoveryCodes } = await enrollTotp();
        const raw = JSON.stringify(await d1.prepare('SELECT * FROM authenticators').all());
        expect(raw).not.toContain(secret);
        const tokens = JSON.stringify(await d1.prepare('SELECT * FROM verification_tokens').all());
        expect(tokens).not.toContain(recoveryCodes[0].replace('-', ''));
    });

    it('refuses a wrong first code and keeps two-factor off', async () => {
        const { b } = await passwordSignIn();
        await b.post('/api/auth/factors/totp');
        const response = await b.post('/api/auth/factors/totp/confirm', { code: '000000' });
        expect(response.status).toBe(400);
        const summary = (await (await b.send('/api/auth/factors')).json()) as {
            twoFactor: { enabled: boolean; pending: boolean };
        };
        expect(summary.twoFactor).toMatchObject({ enabled: false, pending: true });
    });

    it('needs a recent sign-in to change anything', async () => {
        const { b } = await passwordSignIn();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);
        const response = await b.post('/api/auth/factors/totp');
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'REAUTH_REQUIRED' });
        // Reading the factors is still fine.
        expect((await b.send('/api/auth/factors')).status).toBe(200);
    });
});

describe('the second-factor challenge', () => {
    it('stops a password sign-in at the challenge and finishes it with the next code', async () => {
        const { secret } = await enrollTotp();
        const { b, response, body } = await passwordSignIn();
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ success: false, twoFactorRequired: true });
        expect(b.hasSession()).toBe(false);
        expect(b.hasPending()).toBe(true);
        expect(await (await b.send('/api/auth/two-factor/challenge')).json()).toEqual({
            pending: true,
            passkey: false,
            recoveryCodes: true,
        });

        // The enrollment code's step is spent; the next step's code is not.
        const finished = await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) });
        expect(finished.status).toBe(200);
        expect(await finished.json()).toMatchObject({ success: true });
        expect(b.hasSession()).toBe(true);
        expect(b.hasPending()).toBe(false);
    });

    it('never accepts the same code twice', async () => {
        const { secret } = await enrollTotp();
        const code = await codeFor(secret, 1);
        const first = await passwordSignIn();
        expect((await first.b.post('/api/auth/two-factor/challenge', { code })).status).toBe(200);
        const second = await passwordSignIn();
        expect((await second.b.post('/api/auth/two-factor/challenge', { code })).status).toBe(401);
    });

    it('takes a recovery code once', async () => {
        const { recoveryCodes } = await enrollTotp();
        const first = await passwordSignIn();
        const used = await first.b.post('/api/auth/two-factor/challenge', {
            recoveryCode: recoveryCodes[0].toUpperCase(),
        });
        expect(used.status).toBe(200);
        const again = await passwordSignIn();
        expect((await again.b.post('/api/auth/two-factor/challenge', { recoveryCode: recoveryCodes[0] })).status).toBe(
            401,
        );
    });

    it('answers 429 after five wrong codes, even to the right one', async () => {
        const { secret } = await enrollTotp();
        const { b } = await passwordSignIn();
        for (let i = 0; i < 5; i++) {
            expect((await b.post('/api/auth/two-factor/challenge', { code: '000000' })).status).toBe(401);
        }
        const blocked = await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) });
        expect(blocked.status).toBe(429);
        expect(b.hasSession()).toBe(false);
    });

    it('refuses a challenge with no pending sign-in', async () => {
        const b = browser();
        const response = await b.post('/api/auth/two-factor/challenge', { code: '123456' });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'SECOND_FACTOR_EXPIRED' });
    });

    it('sends a magic-link sign-in to the second-factor page instead of signing in', async () => {
        await enrollTotp();
        const token = 'magic-token';
        await VerificationToken.create({
            identifier: 'login:ana@example.com',
            token: await hashToken(token),
            expires: Date.now() + 60_000,
        });
        const b = browser();
        const response = await b.send(
            `/api/auth/callback/email?token=${token}&email=ana@example.com&callbackUrl=/admin`,
        );
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe(`${ORIGIN}/login/two-factor?callbackUrl=%2Fadmin`);
        expect(b.hasSession()).toBe(false);
        expect(b.hasPending()).toBe(true);
    });

    it('turns off with a recent session, taking the recovery codes with it', async () => {
        const { secret } = await enrollTotp();
        const userId = String((await User.first({ email: 'ana@example.com' }))!.get('id'));
        expect(await VerificationToken.countByIdentifier(`recovery:${userId}`)).toBe(10);

        const b = await signInWithCode(secret);
        expect((await b.post('/api/auth/factors/totp', {}, 'DELETE')).status).toBe(200);
        expect(await VerificationToken.countByIdentifier(`recovery:${userId}`)).toBe(0);

        const { b: next } = await passwordSignIn();
        expect(next.hasSession()).toBe(true);
    });

    it('can be reset for a person who lost their phone (resetTwoFactor)', async () => {
        await enrollTotp();
        const userId = String((await User.first({ email: 'ana@example.com' }))!.get('id'));
        expect(await resetTwoFactor(userId, env)).toEqual({ removed: true });
        expect(await VerificationToken.countByIdentifier(`recovery:${userId}`)).toBe(0);
        expect((await passwordSignIn()).b.hasSession()).toBe(true);
        expect(await resetTwoFactor(userId, env)).toEqual({ removed: false });
    });
});

describe('passkeys', () => {
    async function addPasskey(b: ReturnType<typeof browser>) {
        const options = (await (await b.post('/api/auth/factors/passkeys/options')).json()) as {
            challenge: string;
            rp: { id: string };
            user: { id: string };
            excludeCredentials: unknown[];
        };
        expect(options.rp.id).toBe('app.example.com');
        const { passkey, response } = await createPasskey(
            { rpId: 'app.example.com', origin: ORIGIN },
            options.challenge,
            {
                userHandle: options.user.id,
            },
        );
        const added = await b.post('/api/auth/factors/passkeys', { credential: response, name: 'Laptop' });
        expect(added.status).toBe(200);
        return passkey;
    }

    it('adds a passkey and signs in with it, skipping the code', async () => {
        const { secret } = await enrollTotp();
        const passkey = await addPasskey(await signInWithCode(secret));

        const b = browser();
        const { challenge } = (await (await b.post('/api/auth/passkey/options')).json()) as { challenge: string };
        const assertion = await signInWithPasskey(passkey, { rpId: 'app.example.com', origin: ORIGIN }, challenge);
        const response = await b.post('/api/auth/callback/passkey', { credential: assertion });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true });
        expect(b.hasSession()).toBe(true);

        // The challenge was single-use.
        const replay = await browser().post('/api/auth/callback/passkey', { credential: assertion });
        expect(replay.status).toBe(401);
    });

    it('lists, renames and removes only the owner’s passkeys', async () => {
        const { b } = await passwordSignIn();
        await addPasskey(b);
        const summary = (await (await b.send('/api/auth/factors')).json()) as {
            passkeys: Array<{ id: string; name: string }>;
        };
        expect(summary.passkeys).toHaveLength(1);
        const id = summary.passkeys[0].id;
        expect(summary.passkeys[0].name).toBe('Laptop');

        await User.create({ email: 'bo@example.com', name: 'Bo', passwordHash: await hashPassword(PASSWORD) });
        const other = await passwordSignIn('bo@example.com');
        expect((await other.b.post(`/api/auth/factors/passkeys/${id}`, {}, 'DELETE')).status).toBe(404);

        expect((await b.post(`/api/auth/factors/passkeys/${id}`, { name: 'Phone' }, 'PATCH')).status).toBe(200);
        expect((await b.post(`/api/auth/factors/passkeys/${id}`, {}, 'DELETE')).status).toBe(200);
        const after = (await (await b.send('/api/auth/factors')).json()) as { passkeys: unknown[] };
        expect(after.passkeys).toHaveLength(0);
    });

    it('finishes a password sign-in with a passkey instead of a code', async () => {
        const { secret } = await enrollTotp();
        const passkey = await addPasskey(await signInWithCode(secret));
        const { b } = await passwordSignIn();
        expect(await (await b.send('/api/auth/two-factor/challenge')).json()).toMatchObject({ passkey: true });
        const { challenge } = (await (await b.post('/api/auth/two-factor/passkey-options')).json()) as {
            challenge: string;
        };
        const assertion = await signInWithPasskey(passkey, { rpId: 'app.example.com', origin: ORIGIN }, challenge);
        expect((await b.post('/api/auth/two-factor/challenge', { passkey: assertion })).status).toBe(200);
        expect(b.hasSession()).toBe(true);
    });

    it('has no passkeys at an IP address', async () => {
        const saved = env.AUTH_URL;
        env.AUTH_URL = 'http://127.0.0.1:3003';
        try {
            const response = await browser().post('/api/auth/passkey/options');
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ code: 'PASSKEYS_UNAVAILABLE' });
        } finally {
            env.AUTH_URL = saved;
        }
    });
});

describe('a policy that requires two-factor', () => {
    it('confines a session without it to /api/auth until it is on', async () => {
        options = { secondFactorRequiredFrom: async () => Date.now() - 1000 };
        const { b } = await passwordSignIn();
        expect(b.hasSession()).toBe(true);

        expect(await getSession(b.request('/api/things'), env, options)).toBeNull();
        // Not signed out: a 401 elsewhere can say why (X-Session-Ended: two-factor-setup).
        expect(await isTwoFactorSetupPending(b.request('/api/things'), env, options)).toBe(true);
        const session = await getSession(b.request('/api/auth/session'), env, options);
        expect(session?.user).toMatchObject({ twoFactorEnabled: false, twoFactorSetupRequired: true });

        const begin = (await (await b.post('/api/auth/factors/totp')).json()) as { secret: string };
        expect((await b.post('/api/auth/factors/totp/confirm', { code: await codeFor(begin.secret) })).status).toBe(
            200,
        );

        const after = await getSession(b.request('/api/things'), env, options);
        expect(after?.user).toMatchObject({ twoFactorEnabled: true, twoFactorSetupRequired: false });
    });

    it('lets everyone in before its date', async () => {
        options = { secondFactorRequiredFrom: async () => Date.now() + 86_400_000 };
        const { b } = await passwordSignIn();
        const session = await getSession(b.request('/api/things'), env, options);
        expect(session?.user).toMatchObject({ twoFactorSetupRequired: false });
        expect(session?.user.twoFactorRequiredFrom).toBeGreaterThan(Date.now());
    });

    it('fails the sign-in closed when the policy cannot be read', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        options = {
            secondFactorRequiredFrom: async () => {
                throw new Error('policy table unreachable');
            },
        };
        const { b, response } = await passwordSignIn();
        expect(response.status).toBe(500);
        expect(b.hasSession()).toBe(false);
    });
});
