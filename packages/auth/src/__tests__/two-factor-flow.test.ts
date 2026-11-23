// End to end against real SQLite (node:sqlite behind the D1 API) and an in-memory KV: enrolling
// an authenticator app, the second-factor challenge on every sign-in method, recovery codes, the
// attempt limits, the recent-sign-in rule, passkeys, and a policy that requires two-factor.

import { autoInit, clearConnection, registerConnection, registerModels } from '@ottabase/ottaorm';
import {
    Account,
    accountsTable,
    Authenticator,
    authenticatorsTable,
    OrganizationMember,
    organizationMembersTable,
    organizationsTable,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signInWithCredentials } from '../client-api';
import { getFactors, getTwoFactorChallenge, submitTwoFactor } from '../client-factors';
import type { AuthEnv, CreateAuthConfigOptions, SecondFactorPolicyInput } from '../types';
import { createPasskey, signIn as signInWithPasskey, type SoftAlgorithm } from './soft-authenticator';
import { createSqliteD1 } from './sqlite-d1';

// First-user bootstrap (the platform owner's organization) is bootstrap.test.ts's business.
vi.mock('../bootstrap', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../bootstrap')>()),
    bootstrapFirstUser: vi.fn(async () => ({ isPlatformOwner: false, organizationId: null })),
}));
// An OAuth provider that answers without the network: Ana's Google identity.
vi.mock('../providers/presets', () => ({ getConfiguredProvider: () => ({ id: 'google' }) }));
vi.mock('../providers/oauth-client', () => ({
    exchangeCodeForTokens: vi.fn(async () => ({ access_token: 'token' })),
    fetchUserProfile: vi.fn(async () => ({
        email: 'ana@example.com',
        providerAccountId: 'google-ana',
        emailVerified: true,
        name: 'Ana',
        image: null,
    })),
    buildAuthorizationUrl: vi.fn(),
    createPkcePair: vi.fn(),
}));

const {
    bumpOrganizationVersion,
    bumpProfileVersion,
    createSessionCookieForUser,
    getSession,
    handleAuthRequest,
    hashPassword,
    hashToken,
    isTwoFactorSetupPending,
    readSessionIdentity,
    requireRecentSignIn,
    resetTwoFactor,
    sessionRefusal,
} = await import('../backend-handler');
const { base32Decode, hotp, totpStep } = await import('../totp');
const { signJwt } = await import('../jwt');

const ORIGIN = 'https://app.example.com';
const RP = { rpId: 'app.example.com', origin: ORIGIN };
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
    const adopt = (header: string) => {
        const [pair, ...attributes] = header.split(';');
        const [name, ...value] = pair.split('=');
        const expired = attributes.some((a) => /max-age=0/i.test(a.trim()));
        if (expired) jar.delete(name.trim());
        else jar.set(name.trim(), value.join('='));
    };
    const take = (response: Response) => {
        for (const header of response.headers.getSetCookie()) adopt(header);
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
        adopt,
        send,
        csrf,
        /** A state-changing call with a fresh CSRF token in its body. */
        async post(path: string, body: Record<string, unknown> = {}, method = 'POST') {
            return send(path, { method, body: JSON.stringify({ ...body, csrfToken: await csrf() }) });
        },
        hasSession: () => [...jar.keys()].some((name) => name.endsWith('session-token')),
        hasPending: () => [...jar.keys()].some((name) => name.endsWith('second-factor')),
        request: (path: string) => new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie() } }),
    };
}
type Browser = ReturnType<typeof browser>;

async function passwordSignIn(email = 'ana@example.com') {
    const b = browser();
    const response = await b.post('/api/auth/callback/credentials', { email, password: PASSWORD });
    return { b, response, body: (await response.json()) as Record<string, unknown> };
}

/** The current code of an authenticator app, `offset` steps from now. */
async function codeFor(secret: string, offset = 0): Promise<string> {
    return hotp(base32Decode(secret), totpStep() + offset);
}

/** A six-digit code the app would refuse now (none of the steps it accepts). */
async function wrongCodeFor(secret: string): Promise<string> {
    const accepted = await Promise.all([-1, 0, 1].map((offset) => codeFor(secret, offset)));
    let n = 0;
    while (accepted.includes(String(n).padStart(6, '0'))) n++;
    return String(n).padStart(6, '0');
}

/** Turn the authenticator app on for a signed-in browser; returns its secret and the confirm answer. */
async function enrollTotpWith(b: Browser) {
    const begin = (await (await b.post('/api/auth/factors/totp')).json()) as { secret: string; uri: string };
    const confirm = await b.post('/api/auth/factors/totp/confirm', { code: await codeFor(begin.secret) });
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = (await confirm.json()) as { recoveryCodes?: string[] };
    return { secret: begin.secret, recoveryCodes: recoveryCodes ?? [], uri: begin.uri };
}

/** Sign in and turn the authenticator app on; returns its secret and recovery codes. */
async function enrollTotp(email = 'ana@example.com') {
    const { b } = await passwordSignIn(email);
    return enrollTotpWith(b);
}

/** A recent session for an account with two-factor on: the password, then the next code. */
async function signInWithCode(secret: string, email = 'ana@example.com') {
    const { b } = await passwordSignIn(email);
    const finished = await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) });
    expect(finished.status).toBe(200);
    return b;
}

/** Add a passkey through the person's factor routes; returns it and the add answer. */
async function addPasskey(b: Browser, algorithm: SoftAlgorithm = -7) {
    const creation = (await (await b.post('/api/auth/factors/passkeys/options')).json()) as {
        challenge: string;
        rp: { id: string };
        user: { id: string };
    };
    expect(creation.rp.id).toBe('app.example.com');
    const { passkey, response } = await createPasskey(RP, creation.challenge, {
        userHandle: creation.user.id,
        algorithm,
    });
    const added = await b.post('/api/auth/factors/passkeys', { credential: response, name: 'Laptop' });
    expect(added.status).toBe(200);
    return { passkey, body: (await added.json()) as { passkey: { id: string }; recoveryCodes?: string[] } };
}

/** Finish a pending sign-in with a passkey. */
async function finishWithPasskey(b: Browser, passkey: Awaited<ReturnType<typeof addPasskey>>['passkey']) {
    const { challenge } = (await (await b.post('/api/auth/two-factor/passkey-options')).json()) as {
        challenge: string;
    };
    return b.post('/api/auth/two-factor/challenge', { passkey: await signInWithPasskey(passkey, RP, challenge) });
}

async function anaId(): Promise<string> {
    return String((await User.first({ email: 'ana@example.com' }))!.get('id'));
}

const recoveryCount = async () => VerificationToken.countByIdentifier(`recovery:${await anaId()}`);
const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

/** Ana is an active member of each organization; `active` is the one she works in. */
async function joinOrganizations(orgIds: string[], active: string) {
    const userId = await anaId();
    const now = Date.now();
    for (const [i, id] of orgIds.entries()) {
        await d1
            .prepare('INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .bind(id, id, id, now, now)
            .run();
        await d1
            .prepare(
                'INSERT INTO organization_members (id, organization_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(`m-${id}`, id, userId, 'member', 'active', now + i, now, now)
            .run();
    }
    await User.update(userId, { activeOrganizationId: active });
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
            organizationsTable,
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
    delete env.AUTH_FACTOR_KEY;
    (env.OBCF_KV as unknown as { store: Map<string, unknown> }).store.clear();
    await d1.exec(
        'DELETE FROM organization_members; DELETE FROM organizations; DELETE FROM accounts; DELETE FROM users; DELETE FROM authenticators; DELETE FROM verification_tokens;',
    );
    await User.create({
        email: 'ana@example.com',
        name: 'Ana',
        passwordHash: await hashPassword(PASSWORD),
        emailVerified: Date.now(),
    });
});

describe('without a second factor', () => {
    it('signs in with the password alone, stamping when and how', async () => {
        const { b, body } = await passwordSignIn();
        expect(body.success).toBe(true);
        expect(b.hasSession()).toBe(true);
        const identity = await readSessionIdentity(b.request('/'), env);
        expect(identity?.signInMethod).toBe('password');
        expect(identity?.authAt).toBeGreaterThan(Date.now() - 5000);
    });
});

describe('enrolling an authenticator app', () => {
    it('turns on with the first code, hands out ten recovery codes, and reports it', async () => {
        const { uri, recoveryCodes } = await enrollTotp();
        expect(uri).toMatch(/^otpauth:\/\/totp\/app\.example\.com:ana%40example\.com\?secret=/);
        expect(recoveryCodes).toHaveLength(10);
        expect(new Set(recoveryCodes).size).toBe(10);
        for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);

        const { b } = await passwordSignIn();
        expect(b.hasSession()).toBe(false);
    });

    it('stores the secret sealed and the recovery codes hashed', async () => {
        const { secret, recoveryCodes } = await enrollTotp();
        const raw = JSON.stringify(await d1.prepare('SELECT * FROM authenticators').all());
        expect(raw).not.toContain(secret);
        const tokens = JSON.stringify(await d1.prepare('SELECT * FROM verification_tokens').all());
        expect(tokens).not.toContain(recoveryCodes[0].replace(/-/g, ''));
    });

    it('refuses a wrong first code and keeps two-factor off', async () => {
        const { b } = await passwordSignIn();
        const { secret } = (await (await b.post('/api/auth/factors/totp')).json()) as { secret: string };
        const response = await b.post('/api/auth/factors/totp/confirm', { code: await wrongCodeFor(secret) });
        expect(response.status).toBe(401);
        expect(await codeOf(response)).toBe('SECOND_FACTOR_INVALID');
        const summary = (await (await b.send('/api/auth/factors')).json()) as { twoFactor: Record<string, unknown> };
        expect(summary.twoFactor).toEqual({
            enabled: false,
            totp: false,
            totpPending: true,
            passkeys: 0,
            recoveryCodesLeft: 0,
            requiredFrom: null,
        });
    });

    it('keeps one authenticator app per person, whatever the setup restarts', async () => {
        const { b } = await passwordSignIn();
        await b.post('/api/auth/factors/totp');
        await b.post('/api/auth/factors/totp');
        const { secret } = (await (await b.post('/api/auth/factors/totp')).json()) as { secret: string };
        expect((await d1.prepare("SELECT * FROM authenticators WHERE kind = 'totp'").all()).results).toHaveLength(1);
        // The latest secret is the one that confirms.
        expect((await b.post('/api/auth/factors/totp/confirm', { code: await codeFor(secret) })).status).toBe(200);
        const again = await b.post('/api/auth/factors/totp');
        expect(again.status).toBe(409);
        expect(await codeOf(again)).toBe('ALREADY_ENABLED');
    });

    it('needs a recent sign-in to change anything', async () => {
        const { b } = await passwordSignIn();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);
        const response = await b.post('/api/auth/factors/totp');
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe('REAUTH_REQUIRED');
        // Reading the factors is still fine.
        expect((await b.send('/api/auth/factors')).status).toBe(200);
        expect(await requireRecentSignIn(b.request('/api/admin/x'), env, options)).not.toBeNull();
    });

    it('does not refresh the window when the session is reissued (the password-change reissue)', async () => {
        const { b } = await passwordSignIn();
        expect(await requireRecentSignIn(b.request('/api/admin/x'), env, options)).toBeNull();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);

        // What the app's password change does: a new session for this device, old authAt copied.
        const old = (await readSessionIdentity(b.request('/'), env))!;
        const { cookie } = await createSessionCookieForUser(
            { id: old.userId, email: 'ana@example.com', authAt: old.authAt, signInMethod: old.signInMethod },
            env,
            b.request('/'),
            options,
        );
        b.adopt(cookie);
        const reissued = (await readSessionIdentity(b.request('/'), env))!;
        expect(reissued.jti).not.toBe(old.jti);
        expect(reissued.authAt).toBe(old.authAt);
        expect(reissued.signInMethod).toBe('password');

        const response = await b.post('/api/auth/factors/totp');
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe('REAUTH_REQUIRED');
    });

    it('answers AUTHENTICATOR_UNREADABLE after the sealing key changes, and a recovery code still works', async () => {
        const { secret, recoveryCodes } = await enrollTotp();
        env.AUTH_FACTOR_KEY = 'a-different-factor-key-entirely!!';
        const { b } = await passwordSignIn();
        const unreadable = await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) });
        expect(unreadable.status).toBe(409);
        expect(await codeOf(unreadable)).toBe('AUTHENTICATOR_UNREADABLE');
        // Not counted as a guess.
        expect(await VerificationToken.countLiveByIdentifier(`factor-attempt-account:${await anaId()}`)).toBe(0);
        const recovered = await b.post('/api/auth/two-factor/challenge', { recoveryCode: recoveryCodes[0] });
        expect(recovered.status).toBe(200);
        expect(b.hasSession()).toBe(true);
    });

    it('sweeps expired attempt rows of other sign-ins when a new guess is counted', async () => {
        await VerificationToken.recordAttempts([{ identifier: 'factor-attempt:old-sign-in', expires: Date.now() - 1 }]);
        await VerificationToken.recordAttempts([{ identifier: 'magic-link:keep', expires: Date.now() - 1 }]);
        const { secret } = await enrollTotp();
        const { b } = await passwordSignIn();
        // A code from well outside the accepted window: a wrong guess, counted.
        await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 5) });
        expect(await VerificationToken.countByIdentifier('factor-attempt:old-sign-in')).toBe(0);
        // Only attempt rows are swept.
        expect(await VerificationToken.countByIdentifier('magic-link:keep')).toBe(1);
    });
});

describe('the second-factor challenge', () => {
    it('stops a password sign-in at the challenge and finishes it with the next code', async () => {
        const { secret } = await enrollTotp();
        const { b, response, body } = await passwordSignIn();
        expect(response.status).toBe(200);
        expect(body).toEqual({ twoFactorRequired: true, code: 'SECOND_FACTOR_REQUIRED' });
        expect(b.hasSession()).toBe(false);
        expect(b.hasPending()).toBe(true);
        expect(await (await b.send('/api/auth/two-factor/challenge')).json()).toEqual({
            pending: true,
            methods: { totp: true, passkey: false, recoveryCode: true },
        });

        // The enrollment code's step is spent; the next step's code is not.
        const finished = await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) });
        expect(finished.status).toBe(200);
        expect(await finished.json()).toMatchObject({ success: true });
        expect(b.hasSession()).toBe(true);
        expect(b.hasPending()).toBe(false);
        // The session keeps the first factor's method.
        expect((await readSessionIdentity(b.request('/'), env))?.signInMethod).toBe('password');
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

    it('gives a recovery code back when the sign-in fails after it was spent', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { recoveryCodes } = await enrollTotp();
        const { b } = await passwordSignIn();
        options = {
            onSignIn: () => {
                throw new Error('workspace unavailable');
            },
        };
        const failed = await b.post('/api/auth/two-factor/challenge', { recoveryCode: recoveryCodes[0] });
        expect(failed.status).toBe(500);
        expect(await codeOf(failed)).toBe('ACCOUNT_PROVISIONING_FAILED');
        expect(await recoveryCount()).toBe(10);

        options = {};
        expect((await b.post('/api/auth/two-factor/challenge', { recoveryCode: recoveryCodes[0] })).status).toBe(200);
        expect(await recoveryCount()).toBe(9);
    });

    it('answers 429 after five wrong codes, even to the right one', async () => {
        const { secret } = await enrollTotp();
        const { b } = await passwordSignIn();
        const wrong = await wrongCodeFor(secret);
        for (let i = 0; i < 5; i++) {
            expect((await b.post('/api/auth/two-factor/challenge', { code: wrong })).status).toBe(401);
        }
        const blocked = await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) });
        expect(blocked.status).toBe(429);
        expect(await codeOf(blocked)).toBe('TOO_MANY_ATTEMPTS');
        expect(b.hasSession()).toBe(false);
    });

    it('never lets parallel wrong codes past the per-sign-in limit', async () => {
        const { secret } = await enrollTotp();
        const { b } = await passwordSignIn();
        const wrong = await wrongCodeFor(secret);
        const csrfToken = await b.csrf();
        const responses = await Promise.all(
            Array.from({ length: 10 }, () =>
                b.send('/api/auth/two-factor/challenge', {
                    method: 'POST',
                    body: JSON.stringify({ code: wrong, csrfToken }),
                }),
            ),
        );
        const statuses = responses.map((response) => response.status);
        expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
        expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(5);
        expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(5);
    });

    it('lets a second pending sign-in try after another one used its five', async () => {
        const { secret } = await enrollTotp();
        const first = await passwordSignIn();
        const wrong = await wrongCodeFor(secret);
        for (let i = 0; i < 5; i++) await first.b.post('/api/auth/two-factor/challenge', { code: wrong });
        expect((await first.b.post('/api/auth/two-factor/challenge', { code: wrong })).status).toBe(429);

        const second = await passwordSignIn();
        expect((await second.b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) })).status).toBe(
            200,
        );
        // Success clears the account's counter too.
        expect(await VerificationToken.countLiveByIdentifier(`factor-attempt-account:${await anaId()}`)).toBe(0);
    });

    it('refuses a challenge with no pending sign-in', async () => {
        const b = browser();
        const response = await b.post('/api/auth/two-factor/challenge', { code: '123456' });
        expect(response.status).toBe(401);
        expect(await codeOf(response)).toBe('SECOND_FACTOR_EXPIRED');
        const passkeyOptions = await b.post('/api/auth/two-factor/passkey-options');
        expect(passkeyOptions.status).toBe(401);
        expect(await codeOf(passkeyOptions)).toBe('SECOND_FACTOR_EXPIRED');
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

    it('sends an OAuth sign-in to the second-factor page, and the session keeps the provider', async () => {
        const { secret } = await enrollTotp();
        await Account.create({
            userId: await anaId(),
            type: 'oauth',
            provider: 'google',
            providerAccountId: 'google-ana',
        });
        const b = browser();
        b.jar.set(
            'ottabase.oauth-state',
            await signJwt(
                { state: 's', codeVerifier: 'v', callbackUrl: '/admin', providerId: 'google', purpose: 'oauth-state' },
                env.AUTH_SECRET!,
                { expiresInSeconds: 600 },
            ),
        );
        const response = await b.send('/api/auth/callback/google?code=c&state=s');
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe(`${ORIGIN}/login/two-factor?callbackUrl=%2Fadmin`);
        expect(b.hasSession()).toBe(false);
        expect(b.hasPending()).toBe(true);

        expect((await b.post('/api/auth/two-factor/challenge', { code: await codeFor(secret, 1) })).status).toBe(200);
        expect((await readSessionIdentity(b.request('/'), env))?.signInMethod).toBe('oauth:google');
    });

    it('turns off with a recent session, taking the recovery codes with it', async () => {
        const { secret } = await enrollTotp();
        expect(await recoveryCount()).toBe(10);

        const b = await signInWithCode(secret);
        expect((await b.post('/api/auth/factors/totp', {}, 'DELETE')).status).toBe(200);
        expect(await recoveryCount()).toBe(0);

        const { b: next } = await passwordSignIn();
        expect(next.hasSession()).toBe(true);
    });

    it('can be reset for a person who lost their device (resetTwoFactor), passkeys included', async () => {
        const { secret } = await enrollTotp();
        await addPasskey(await signInWithCode(secret));
        const userId = await anaId();
        expect(await resetTwoFactor(userId, env)).toEqual({ removed: true });
        expect(await Authenticator.listForUser(userId)).toEqual([]);
        expect(await recoveryCount()).toBe(0);
        expect((await passwordSignIn()).b.hasSession()).toBe(true);
        expect(await resetTwoFactor(userId, env)).toEqual({ removed: false });
    });
});

describe('passkeys', () => {
    it('adds a passkey and signs in with it, skipping the code', async () => {
        const { secret } = await enrollTotp();
        const { passkey } = await addPasskey(await signInWithCode(secret));

        const b = browser();
        const { challenge } = (await (await b.post('/api/auth/passkey/options')).json()) as { challenge: string };
        const assertion = await signInWithPasskey(passkey, RP, challenge);
        const response = await b.post('/api/auth/callback/passkey', { credential: assertion });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true });
        expect(b.hasSession()).toBe(true);
        expect((await readSessionIdentity(b.request('/'), env))?.signInMethod).toBe('passkey');

        // The challenge was single-use.
        const replay = await browser().post('/api/auth/callback/passkey', { credential: assertion });
        expect(replay.status).toBe(401);
        expect(await codeOf(replay)).toBe('PASSKEY_REFUSED');
    });

    it('signs in with an RS256 passkey', async () => {
        const { b } = await passwordSignIn();
        const { passkey } = await addPasskey(b, -257);
        const next = browser();
        const { challenge } = (await (await next.post('/api/auth/passkey/options')).json()) as { challenge: string };
        const response = await next.post('/api/auth/callback/passkey', {
            credential: await signInWithPasskey(passkey, RP, challenge),
        });
        expect(response.status).toBe(200);
    });

    it('refuses a passkey made without user verification', async () => {
        const { b } = await passwordSignIn();
        const creation = (await (await b.post('/api/auth/factors/passkeys/options')).json()) as {
            challenge: string;
            user: { id: string };
        };
        const { response } = await createPasskey(RP, creation.challenge, {
            userHandle: creation.user.id,
            userVerified: false,
        });
        const refused = await b.post('/api/auth/factors/passkeys', { credential: response });
        expect(refused.status).toBe(400);
        expect(await codeOf(refused)).toBe('PASSKEY_REFUSED');
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
        const foreign = await other.b.post(`/api/auth/factors/passkeys/${id}`, {}, 'DELETE');
        expect(foreign.status).toBe(404);
        expect(await codeOf(foreign)).toBe('NOT_FOUND');

        expect((await b.post(`/api/auth/factors/passkeys/${id}`, { name: 'Phone' }, 'PATCH')).status).toBe(200);
        expect((await b.post(`/api/auth/factors/passkeys/${id}`, {}, 'DELETE')).status).toBe(200);
        const after = (await (await b.send('/api/auth/factors')).json()) as { passkeys: unknown[] };
        expect(after.passkeys).toHaveLength(0);
    });

    it('hands out recovery codes with the first passkey and deletes them with the last factor', async () => {
        const { b } = await passwordSignIn();
        const first = await addPasskey(b);
        expect(first.body.recoveryCodes).toHaveLength(10);
        const second = await addPasskey(b);
        expect(second.body.recoveryCodes).toBeUndefined();
        expect(await recoveryCount()).toBe(10);

        expect((await b.post(`/api/auth/factors/passkeys/${first.body.passkey.id}`, {}, 'DELETE')).status).toBe(200);
        expect(await recoveryCount()).toBe(10);
        expect((await b.post(`/api/auth/factors/passkeys/${second.body.passkey.id}`, {}, 'DELETE')).status).toBe(200);
        expect(await recoveryCount()).toBe(0);
    });

    it('keeps the recovery codes when an app is added to a passkey account', async () => {
        const { b } = await passwordSignIn();
        const { body } = await addPasskey(b);
        const { recoveryCodes } = await enrollTotpWith(b);
        expect(recoveryCodes).toEqual([]);
        expect(await recoveryCount()).toBe(10);
        expect(body.recoveryCodes).toHaveLength(10);
    });

    it('challenges a passkey-only account on a password sign-in', async () => {
        const { b } = await passwordSignIn();
        const { passkey } = await addPasskey(b);
        const next = await passwordSignIn();
        expect(next.body).toEqual({ twoFactorRequired: true, code: 'SECOND_FACTOR_REQUIRED' });
        expect(await (await next.b.send('/api/auth/two-factor/challenge')).json()).toEqual({
            pending: true,
            methods: { totp: false, passkey: true, recoveryCode: true },
        });
        expect((await finishWithPasskey(next.b, passkey)).status).toBe(200);
        expect(next.b.hasSession()).toBe(true);
    });

    it('finishes a password sign-in with a passkey instead of a code', async () => {
        const { secret } = await enrollTotp();
        const { passkey } = await addPasskey(await signInWithCode(secret));
        const { b } = await passwordSignIn();
        expect(await (await b.send('/api/auth/two-factor/challenge')).json()).toMatchObject({
            methods: { passkey: true },
        });
        expect((await finishWithPasskey(b, passkey)).status).toBe(200);
        expect(b.hasSession()).toBe(true);
    });

    it('finishes with a passkey while the code attempts are used up', async () => {
        const { secret } = await enrollTotp();
        const { passkey } = await addPasskey(await signInWithCode(secret));
        const { b } = await passwordSignIn();
        const wrong = await wrongCodeFor(secret);
        for (let i = 0; i < 5; i++) await b.post('/api/auth/two-factor/challenge', { code: wrong });
        expect((await b.post('/api/auth/two-factor/challenge', { code: wrong })).status).toBe(429);
        expect((await finishWithPasskey(b, passkey)).status).toBe(200);
        expect(b.hasSession()).toBe(true);
    });

    it('refuses someone else’s passkey at the challenge without touching it', async () => {
        await User.create({ email: 'bo@example.com', name: 'Bo', passwordHash: await hashPassword(PASSWORD) });
        const bo = await passwordSignIn('bo@example.com');
        const { passkey: bosKey } = await addPasskey(bo.b);
        const { passkey: anasKey } = await addPasskey((await passwordSignIn()).b);
        void anasKey;

        const { b } = await passwordSignIn();
        const { challenge } = (await (await b.post('/api/auth/two-factor/passkey-options')).json()) as {
            challenge: string;
        };
        const assertion = await signInWithPasskey({ ...bosKey, counter: 5 }, RP, challenge);
        const refused = await b.post('/api/auth/two-factor/challenge', { passkey: assertion });
        expect(refused.status).toBe(401);
        expect(await codeOf(refused)).toBe('PASSKEY_REFUSED');
        const row = await Authenticator.findPasskey(assertion.id);
        expect(row?.counter).toBe(0);
    });

    it('has no passkeys at an IP address', async () => {
        const saved = env.AUTH_URL;
        env.AUTH_URL = 'http://127.0.0.1:3003';
        try {
            const response = await browser().post('/api/auth/passkey/options');
            expect(response.status).toBe(400);
            expect(await codeOf(response)).toBe('PASSKEYS_UNAVAILABLE');
        } finally {
            env.AUTH_URL = saved;
        }
    });
});

describe('a policy that requires two-factor', () => {
    const past = () => Date.now() - 1000;

    it('confines a session without it to /api/auth and /api/users/me until it is on', async () => {
        options = { secondFactorRequiredFrom: async () => past() };
        const { b } = await passwordSignIn();
        expect(b.hasSession()).toBe(true);

        const things = b.request('/api/things');
        expect(await getSession(things, env, options)).toBeNull();
        // Not signed out: the refusal is recorded so a 401 elsewhere can say why.
        expect(sessionRefusal(things)).toBe('two-factor-setup');
        expect(await isTwoFactorSetupPending(b.request('/api/things'), env, options)).toBe(true);
        expect(await getSession(b.request('/api/users/me'), env, options)).not.toBeNull();
        expect(await getSession(b.request('/api/users/me/avatar'), env, options)).toBeNull();
        const session = await getSession(b.request('/api/auth/session'), env, options);
        expect(session?.user).toMatchObject({ twoFactorEnabled: false, twoFactorSetupRequired: true });

        await enrollTotpWith(b);
        const after = await getSession(b.request('/api/things'), env, options);
        expect(after?.user).toMatchObject({ twoFactorEnabled: true, twoFactorSetupRequired: false });
        expect(sessionRefusal(b.request('/api/never-seen'))).toBeUndefined();
    });

    it('is satisfied by a passkey', async () => {
        options = { secondFactorRequiredFrom: async () => past() };
        const { b } = await passwordSignIn();
        expect(await getSession(b.request('/api/things'), env, options)).toBeNull();
        await addPasskey(b);
        expect(await getSession(b.request('/api/things'), env, options)).not.toBeNull();
    });

    it('refuses to remove the last factor while it applies', async () => {
        options = { secondFactorRequiredFrom: async () => past() };
        const { b } = await passwordSignIn();
        await enrollTotpWith(b);
        const refused = await b.post('/api/auth/factors/totp', {}, 'DELETE');
        expect(refused.status).toBe(409);
        expect(await codeOf(refused)).toBe('TWO_FACTOR_REQUIRED');

        const { body } = await addPasskey(b);
        // With a passkey there, the app may go; then the passkey is the last one.
        expect((await b.post('/api/auth/factors/totp', {}, 'DELETE')).status).toBe(200);
        const last = await b.post(`/api/auth/factors/passkeys/${body.passkey.id}`, {}, 'DELETE');
        expect(last.status).toBe(409);
        expect(await codeOf(last)).toBe('TWO_FACTOR_REQUIRED');
        const summary = (await (await b.send('/api/auth/factors')).json()) as { twoFactor: { requiredFrom: number } };
        expect(summary.twoFactor.requiredFrom).toBeLessThan(Date.now());
    });

    it('lets everyone in before its date', async () => {
        options = { secondFactorRequiredFrom: async () => Date.now() + 86_400_000 };
        const { b } = await passwordSignIn();
        const session = await getSession(b.request('/api/things'), env, options);
        expect(session?.user).toMatchObject({ twoFactorSetupRequired: false });
        expect(session?.user.twoFactorRequiredFrom).toBeGreaterThan(Date.now());
    });

    it('applies only in the organization that has it', async () => {
        const asked: SecondFactorPolicyInput[] = [];
        options = {
            secondFactorRequiredFrom: async (_env, input) => {
                asked.push(input);
                return input.organizationId === 'org-strict' ? past() : null;
            },
        };
        await joinOrganizations(['org-relaxed', 'org-strict'], 'org-relaxed');
        const { b } = await passwordSignIn();
        expect(await getSession(b.request('/api/things'), env, options)).not.toBeNull();
        expect(asked.at(-1)).toMatchObject({ organizationId: 'org-relaxed', signInMethod: 'password' });

        // Switching to the strict organization confines the session; /api/users/me can switch back.
        await User.update(await anaId(), { activeOrganizationId: 'org-strict' });
        await bumpProfileVersion(await anaId(), env);
        expect(await getSession(b.request('/api/things'), env, options)).toBeNull();
        expect(await getSession(b.request('/api/users/me'), env, options)).not.toBeNull();

        await User.update(await anaId(), { activeOrganizationId: 'org-relaxed' });
        await bumpProfileVersion(await anaId(), env);
        expect(await getSession(b.request('/api/things'), env, options)).not.toBeNull();
    });

    it('reaches every live session in an organization with one version bump', async () => {
        let requiredFrom: number | null = null;
        options = {
            secondFactorRequiredFrom: async (_env, { organizationId }) =>
                organizationId === 'org-a' ? requiredFrom : null,
        };
        await joinOrganizations(['org-a'], 'org-a');
        const { b } = await passwordSignIn();
        expect(await getSession(b.request('/api/things'), env, options)).not.toBeNull();

        requiredFrom = past();
        // The snapshot still reflects the old rule until the organization's version moves.
        expect(await getSession(b.request('/api/things'), env, options)).not.toBeNull();
        await bumpOrganizationVersion('org-a', env);
        expect(await getSession(b.request('/api/things'), env, options)).toBeNull();
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

describe('the browser client against the real routes', () => {
    /** Points the client's fetch at the handler through one browser's cookie jar. */
    function clientThrough(b: Browser) {
        vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) =>
            b.send(String(input), { method: init.method, body: init.body as string | undefined }),
        );
    }
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('signs in with a password, reads the challenge, refuses a wrong code and finishes with a recovery code', async () => {
        const { secret, recoveryCodes } = await enrollTotp();
        const b = browser();
        clientThrough(b);

        const first = await signInWithCredentials({ email: 'ana@example.com', password: PASSWORD });
        expect(first).toMatchObject({ success: false, twoFactorRequired: true });

        const state = await getTwoFactorChallenge();
        expect(state).toEqual({ pending: true, methods: { totp: true, passkey: false, recoveryCode: true } });

        const wrong = await submitTwoFactor({ code: await wrongCodeFor(secret) });
        expect(wrong).toMatchObject({ success: false, code: 'SECOND_FACTOR_INVALID' });

        const done = await submitTwoFactor({ recoveryCode: recoveryCodes[0]! });
        expect(done.success).toBe(true);
        expect(done.session?.user.email).toBe('ana@example.com');

        const factors = await getFactors();
        expect(factors.success).toBe(true);
        if (factors.success) {
            expect(factors.twoFactor).toMatchObject({ enabled: true, totp: true, passkeys: 0, recoveryCodesLeft: 9 });
            expect(factors.recentSignIn).toBe(true);
        }
    });

    it('reports an expired sign-in with its code', async () => {
        clientThrough(browser());
        expect(await getTwoFactorChallenge()).toMatchObject({ pending: false });
        expect(await submitTwoFactor({ code: '123456' })).toMatchObject({
            success: false,
            code: 'SECOND_FACTOR_EXPIRED',
        });
    });
});
