// ============================================================
// @ottabase/auth - The signed-in person's own sign-in factors
// ============================================================
//
// Routes (all under /api/auth, answered by `handleAuthRequest` through `handleFactorRequest`):
//
//   GET    /factors                         the person's two-factor state and passkeys
//   POST   /factors/totp                    start authenticator-app setup: { secret, uri }
//   POST   /factors/totp/confirm            first code turns it on: { success, recoveryCodes? }
//   DELETE /factors/totp                    remove the authenticator app
//   POST   /factors/recovery-codes          a fresh set: { success, recoveryCodes }
//   POST   /factors/passkeys/options        options to add a passkey
//   POST   /factors/passkeys                add it: { credential, name } -> { success, passkey, recoveryCodes? }
//   PATCH  /factors/passkeys/:id            rename: { name }
//   DELETE /factors/passkeys/:id            remove
//
// The sign-in side (passkey sign-in, the second-factor challenge) is in two-factor.ts, which
// shares the helpers exported here.
//
// Two-factor is ON when the person has a confirmed authenticator app OR at least one passkey.
// Recovery codes are handed out when it first turns on (the confirm or the first passkey answers
// with `recoveryCodes`), can be regenerated, and are deleted when the last factor goes.
//
// Every change to a factor needs a RECENT sign-in (`authAt` on the session under 15 minutes old):
// a stolen session cookie must not be able to add its own passkey or remove the app. The answer
// otherwise is 403 `REAUTH_REQUIRED`, and the app sends the person to sign in again. Removing the
// last factor while the active organization's policy requires two-factor is 409
// `TWO_FACTOR_REQUIRED`.
//
// ============================================================

import { Authenticator, VerificationToken, type AuthenticatorType } from '@ottabase/ottaorm/models';
import { errorResponse, redactErrorForLog } from '@ottabase/utils/http-errors';
import { base64UrlEncode, hashToken, randomBytes } from './crypto';
import { ensureOrmConnection, jsonResponse, requireCsrf, resolveFrontendUrl } from './http';
import { bumpProfileVersion, getSession, readSessionIdentity, resolveAuthSecret } from './session-store';
import { announce } from './sign-in';
import { base32Encode, generateTotpSecret, matchTotpStep, openSecret, sealSecret, totpUri } from './totp';
import type { AuthEnv, CreateAuthConfigOptions, UserFactorChangedEvent } from './types';
import {
    newChallenge,
    readChallenge,
    relyingPartyFor,
    SUPPORTED_ALGORITHMS,
    verifyAuthentication,
    verifyRegistration,
    WebAuthnError,
    type AuthenticationResponseJSON,
    type CoseAlgorithm,
    type RegistrationResponseJSON,
    type RelyingParty,
} from './webauthn';

/** How old a sign-in may be and still change a factor. */
export const RECENT_SIGN_IN_MS = 15 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
export const WEBAUTHN_TIMEOUT_MS = 5 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
/** 16 base32 characters (80 bits), shown as `xxxx-xxxx-xxxx-xxxx`. */
const RECOVERY_CODE_LENGTH = 16;
/** Recovery codes do not expire; a far-future expiry keeps them out of every cleanup. */
const RECOVERY_CODE_EXPIRES = Date.UTC(9999, 0, 1);
const PASSKEY_NAME_MAX = 60;

export type Body = Record<string, unknown>;

export async function readBody(request: Request): Promise<Body> {
    const body = await request.json().catch(() => ({}));
    return body && typeof body === 'object' ? (body as Body) : {};
}

/** Every failure here: a message for people and a stable `code` for programs. */
export const fail = (message: string, status: number, code: string): Response =>
    errorResponse(message, status, { code });

export const reauthRequired = () =>
    fail('Sign in again to change how you sign in. It keeps a borrowed session from doing it.', 403, 'REAUTH_REQUIRED');

export const passkeysUnavailable = () =>
    fail(
        'Passkeys need the app at a domain name over https (or localhost in development).',
        400,
        'PASSKEYS_UNAVAILABLE',
    );

export const tooManyAttempts = () =>
    fail('Too many tries. Wait a while and try again, or use a passkey.', 429, 'TOO_MANY_ATTEMPTS');

export const secondFactorInvalid = () => fail('That code did not work. Try again.', 401, 'SECOND_FACTOR_INVALID');

export const authenticatorUnreadable = () =>
    fail(
        'Your authenticator app can no longer be read. Use a recovery code or a passkey, then set the app up again.',
        409,
        'AUTHENTICATOR_UNREADABLE',
    );

function appName(env: AuthEnv, options: CreateAuthConfigOptions): string {
    if (options.appName) return options.appName;
    try {
        return new URL(resolveFrontendUrl(env)).hostname;
    } catch {
        return 'Ottabase';
    }
}

export function relyingParty(env: AuthEnv, options: CreateAuthConfigOptions): RelyingParty | null {
    return relyingPartyFor(resolveFrontendUrl(env), appName(env, options));
}

/** Can this app offer passkeys at its address? For the login page's config. */
export function passkeysAvailable(env: AuthEnv, options: CreateAuthConfigOptions = {}): boolean {
    return relyingParty(env, options) !== null;
}

/** `user.id` in the WebAuthn sense: opaque bytes the authenticator hands back as `userHandle`. */
function userHandle(userId: string): string {
    return base64UrlEncode(new TextEncoder().encode(userId));
}

// ---------- WebAuthn challenges: single-use rows in verification_tokens ----------

export const challengeIdentifier = {
    signIn: 'webauthn:signin',
    register: (userId: string) => `webauthn:register:${userId}`,
    factor: (userId: string) => `webauthn:factor:${userId}`,
};

export async function issueChallenge(identifier: string): Promise<string> {
    await VerificationToken.deleteExpiredFor(identifier);
    const challenge = newChallenge();
    await VerificationToken.create({
        identifier,
        token: await hashToken(challenge),
        expires: Date.now() + CHALLENGE_MS,
    });
    return challenge;
}

/** The challenge a response answers, consumed (so it works once) and unexpired, or null. */
export async function consumeChallenge(identifier: string, clientDataJSON: unknown): Promise<string | null> {
    const challenge = readChallenge(clientDataJSON);
    if (!challenge) return null;
    const row = await VerificationToken.consumeByIdentifierAndToken(identifier, await hashToken(challenge));
    if (!row) return null;
    const expires = Number(row.get('expires'));
    return Number.isFinite(expires) && expires >= Date.now() ? challenge : null;
}

export function parseTransports(raw: string | null): string[] {
    try {
        const parsed = JSON.parse(raw ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
        return [];
    }
}

export function requestOptions(rp: RelyingParty, challenge: string, passkeys: AuthenticatorType[] = []) {
    return {
        challenge,
        rpId: rp.id,
        timeout: WEBAUTHN_TIMEOUT_MS,
        userVerification: 'required',
        allowCredentials: passkeys.map((passkey) => ({
            type: 'public-key',
            id: passkey.credentialId,
            transports: parseTransports(passkey.transports),
        })),
    };
}

/**
 * Check a passkey assertion against the passkey it names and move its counter forward. When
 * `ownerId` is given (the second-factor challenge), a passkey of anyone else is refused BEFORE its
 * signature is checked or its counter touched. Throws WebAuthnError.
 */
export async function checkPasskey(
    response: AuthenticationResponseJSON,
    rp: RelyingParty,
    challenge: string,
    ownerId?: string,
): Promise<AuthenticatorType> {
    const credentialId = typeof response?.id === 'string' ? response.id : '';
    const stored = credentialId ? await Authenticator.findPasskey(credentialId) : null;
    if (!stored || !stored.publicKey || stored.algorithm == null) throw new WebAuthnError('credential-unknown');
    if (ownerId !== undefined && stored.userId !== ownerId) throw new WebAuthnError('credential-unknown');
    const handle = response.response?.userHandle;
    if (handle && handle !== userHandle(stored.userId)) throw new WebAuthnError('user-handle-mismatch');
    const { counter } = await verifyAuthentication(response, rp, challenge, {
        publicKey: JSON.parse(stored.publicKey) as JsonWebKey,
        algorithm: stored.algorithm as CoseAlgorithm,
        counter: Number(stored.counter) || 0,
    });
    // Two assertions racing with the same counter: only one moves it.
    if (!(await Authenticator.touchPasskey(stored.id, counter))) throw new WebAuthnError('counter-replayed');
    return stored;
}

export function logRefused(event: string, error: unknown): void {
    const reason = error instanceof WebAuthnError ? error.reason : undefined;
    console.warn(JSON.stringify({ event, ...(reason ? { reason } : { error: redactErrorForLog(error) }) }));
}

// ---------- the authenticator-app secret ----------

/** The key TOTP secrets are sealed under: AUTH_FACTOR_KEY when set, else AUTH_SECRET. */
function factorKey(env: AuthEnv): string {
    return env.AUTH_FACTOR_KEY || resolveAuthSecret(env);
}

/**
 * The plaintext secret of a sealed authenticator app, or null when it cannot be opened (the key
 * changed since it was sealed). Logged; the caller answers 409 `AUTHENTICATOR_UNREADABLE`.
 */
export async function openTotpSecret(env: AuthEnv, sealed: string): Promise<string | null> {
    const key = factorKey(env);
    try {
        return await openSecret(key, sealed);
    } catch (error) {
        console.warn(JSON.stringify({ event: 'auth_totp_secret_unreadable', error: redactErrorForLog(error) }));
        return null;
    }
}

/** Does `code` match the app now, and is its step unused? Accepting it spends the step. */
export async function acceptTotpCode(totp: AuthenticatorType, secret: string, code: unknown): Promise<boolean> {
    const step = typeof code === 'string' ? await matchTotpStep(secret, code) : null;
    return step !== null && (await Authenticator.acceptTotpStep(totp.id, step));
}

// ---------- attempt limits ----------

const ATTEMPT_LIMIT_PER_SIGN_IN = 5;
const ATTEMPT_LIMIT_PER_ACCOUNT = 30;
const ACCOUNT_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

const attemptIdentifier = {
    signIn: (pendingJti: string) => `factor-attempt:${pendingJti}`,
    account: (userId: string) => `factor-attempt-account:${userId}`,
};

/**
 * Count one guess (a code or a recovery code) and say whether it must be refused unchecked: more
 * than five against this pending sign-in, or more than thirty against the account in an hour.
 * Rows in verification_tokens, inserted then counted, so parallel guesses cannot all slip under
 * the limit (see VerificationToken.recordAttempts). `pending` is absent at setup confirm, where
 * only the account limit applies. A passkey is never counted.
 */
export async function attemptRefused(userId: string, pending?: { jti: string; expiresAt: number }): Promise<boolean> {
    const scopes = [
        {
            identifier: attemptIdentifier.account(userId),
            expires: Date.now() + ACCOUNT_ATTEMPT_WINDOW_MS,
            limit: ATTEMPT_LIMIT_PER_ACCOUNT,
        },
        ...(pending
            ? [
                  {
                      identifier: attemptIdentifier.signIn(pending.jti),
                      expires: pending.expiresAt,
                      limit: ATTEMPT_LIMIT_PER_SIGN_IN,
                  },
              ]
            : []),
    ];
    const counts = await VerificationToken.recordAttempts(scopes);
    return counts.some((count, i) => count > scopes[i].limit);
}

/** A guess succeeded: the person starts from zero on both counters. */
export async function clearAttempts(userId: string, pendingJti?: string): Promise<void> {
    await Promise.all([
        VerificationToken.deleteByIdentifier(attemptIdentifier.account(userId)),
        pendingJti ? VerificationToken.deleteByIdentifier(attemptIdentifier.signIn(pendingJti)) : null,
    ]);
}

// ---------- recovery codes ----------

export const recoveryIdentifier = (userId: string) => `recovery:${userId}`;

/** Lowercase, no separators: what the person typed, however they typed it. */
export function normalizeRecoveryCode(code: string): string | null {
    const normalized = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalized.length === RECOVERY_CODE_LENGTH ? normalized : null;
}

/** Replace the person's recovery codes; returns the new ones, shown once and stored only hashed. */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
        // 10 random bytes are exactly 16 base32 characters.
        base32Encode(randomBytes(10)).toLowerCase(),
    );
    const hashes = await Promise.all(codes.map((code) => hashToken(code)));
    await VerificationToken.replaceForIdentifier(recoveryIdentifier(userId), hashes, RECOVERY_CODE_EXPIRES);
    return codes.map((code) => code.match(/.{4}/g)!.join('-'));
}

/** Put a consumed recovery code back (its sign-in failed after the code was spent). */
export async function restoreRecoveryCode(userId: string, hash: string): Promise<void> {
    await VerificationToken.create({
        identifier: recoveryIdentifier(userId),
        token: hash,
        expires: RECOVERY_CODE_EXPIRES,
    });
}

// ---------- recent sign-in ----------

interface Caller {
    userId: string;
    email: string;
    name: string | null;
    recentSignIn: boolean;
    /** When the recent-sign-in window closes, epoch ms; null when the session never signed in. */
    recentUntil: number | null;
    /** When the active organization's policy requires two-factor from; null when none does. */
    requiredFrom: number | null;
}

async function resolveCaller(request: Request, env: AuthEnv, options: CreateAuthConfigOptions): Promise<Caller | null> {
    const [session, identity] = await Promise.all([
        getSession(request, env, options),
        readSessionIdentity(request, env),
    ]);
    if (!session || !identity || identity.userId !== session.user.id) return null;
    // `authAt` is stamped by a real sign-in only, and a reissued session copies it: neither a
    // fresh cookie nor a password change moves the window.
    const recentUntil = identity.authAt !== null ? identity.authAt + RECENT_SIGN_IN_MS : null;
    return {
        userId: session.user.id,
        email: session.user.email,
        name: (session.user.name as string | null) ?? null,
        recentSignIn: recentUntil !== null && Date.now() < recentUntil,
        recentUntil,
        requiredFrom: session.user.twoFactorRequiredFrom ?? null,
    };
}

/**
 * Null when this request's session signed in within the last 15 minutes, else the answer to send:
 * 401 `UNAUTHORIZED` without a session, 403 `REAUTH_REQUIRED` with an older one. For a host route
 * as sensitive as a factor change (an administrator resetting someone's two-factor).
 */
export async function requireRecentSignIn(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions = {},
): Promise<Response | null> {
    const caller = await resolveCaller(request, env, options);
    if (!caller) return fail('Unauthorized', 401, 'UNAUTHORIZED');
    return caller.recentSignIn ? null : reauthRequired();
}

// ---------- the person's factors ----------

/** What a person's factor rows add up to. */
function factorState(rows: AuthenticatorType[]) {
    const totp = rows.find((row) => row.kind === 'totp') ?? null;
    const passkeys = rows.filter((row) => row.kind === 'passkey');
    const totpOn = !!totp && totp.confirmedAt != null;
    return { totp, totpOn, passkeys, enabled: totpOn || passkeys.length > 0 };
}

/** A policy of the active organization requires two-factor now. */
const policyApplies = (caller: Caller) => caller.requiredFrom !== null && Date.now() >= caller.requiredFrom;

const twoFactorRequired = () =>
    fail(
        'Your organization requires two-factor sign-in, so the last way to give it cannot be removed. Add another first.',
        409,
        'TWO_FACTOR_REQUIRED',
    );

async function factorSummary(caller: Caller, env: AuthEnv, options: CreateAuthConfigOptions) {
    const [rows, recoveryCodesLeft] = await Promise.all([
        Authenticator.listForUser(caller.userId),
        VerificationToken.countByIdentifier(recoveryIdentifier(caller.userId)),
    ]);
    const state = factorState(rows);
    return {
        twoFactor: {
            enabled: state.enabled,
            totp: state.totpOn,
            totpPending: !!state.totp && !state.totpOn,
            passkeys: state.passkeys.length,
            recoveryCodesLeft,
            requiredFrom: caller.requiredFrom,
        },
        passkeys: state.passkeys.map((row) => ({
            id: row.id,
            name: row.name ?? 'Passkey',
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt ?? null,
            transports: parseTransports(row.transports),
        })),
        passkeysAvailable: !!relyingParty(env, options),
        recentSignIn: caller.recentSignIn,
        recentSignInUntil: caller.recentSignIn ? caller.recentUntil : null,
    };
}

async function factorChanged(
    userId: string,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    factor: UserFactorChangedEvent['factor'],
    change: UserFactorChangedEvent['change'],
): Promise<void> {
    // The two-factor flag rides in every live session's snapshot: re-read it on the next request.
    if (factor !== 'recovery-codes') {
        await bumpProfileVersion(userId, env, options).catch((error) => {
            console.warn(
                JSON.stringify({ event: 'auth_profile_version_bump_failed', error: redactErrorForLog(error) }),
            );
        });
    }
    await announce(env, options, 'user.factor.changed', { userId, factor, change, at: Date.now() });
}

/** Two-factor just turned off: the recovery codes go with it. */
async function lastFactorRemoved(userId: string): Promise<void> {
    await VerificationToken.deleteByIdentifier(recoveryIdentifier(userId));
}

/**
 * Turn a person's two-factor sign-in off on someone else's say-so: an organization manager
 * resetting a member who lost their device. Removes every factor (authenticator app, passkeys,
 * recovery codes), refreshes their live sessions' snapshot, and announces it
 * (`factor: 'all', change: 'removed'`). Authorization is the caller's job; pair it with
 * `requireRecentSignIn` on the administrator's request.
 */
export async function resetTwoFactor(
    userId: string,
    env: AuthEnv,
    options: CreateAuthConfigOptions = {},
): Promise<{ removed: boolean }> {
    ensureOrmConnection(env);
    const [removedFactors, removedCodes] = await Promise.all([
        Authenticator.removeAllForUser(userId),
        VerificationToken.deleteByIdentifier(recoveryIdentifier(userId)),
    ]);
    await bumpProfileVersion(userId, env, options);
    const removed = removedFactors + removedCodes > 0;
    if (removed)
        await announce(env, options, 'user.factor.changed', {
            userId,
            factor: 'all',
            change: 'removed',
            at: Date.now(),
        });
    return { removed };
}

async function handleFactors(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    rest: string[],
): Promise<Response | null> {
    const method = request.method;
    const [what, id] = rest;
    const known =
        (what === undefined && method === 'GET') ||
        (what === 'totp' && id === undefined && (method === 'POST' || method === 'DELETE')) ||
        (what === 'totp' && id === 'confirm' && method === 'POST') ||
        (what === 'recovery-codes' && id === undefined && method === 'POST') ||
        (what === 'passkeys' && (id === undefined || id === 'options') && method === 'POST') ||
        (what === 'passkeys' && id !== undefined && id !== 'options' && (method === 'PATCH' || method === 'DELETE'));
    if (!known) return null;

    const caller = await resolveCaller(request, env, options);
    if (!caller) return fail('Unauthorized', 401, 'UNAUTHORIZED');
    if (method === 'GET') return jsonResponse(await factorSummary(caller, env, options));

    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    if (!caller.recentSignIn) return reauthRequired();

    const state = factorState(await Authenticator.listForUser(caller.userId));

    if (what === 'totp' && id === undefined && method === 'POST') {
        const alreadyOn = () => fail('An authenticator app is already set up.', 409, 'ALREADY_ENABLED');
        if (state.totpOn) return alreadyOn();
        const secret = generateTotpSecret();
        if (!(await Authenticator.beginTotp(caller.userId, await sealSecret(factorKey(env), secret)))) {
            return alreadyOn();
        }
        return jsonResponse({ secret, uri: totpUri({ secret, account: caller.email, issuer: appName(env, options) }) });
    }

    if (what === 'totp' && id === 'confirm') {
        if (!state.totp?.secret || state.totpOn) return fail('Start the setup again.', 409, 'NO_PENDING_SETUP');
        const secret = await openTotpSecret(env, state.totp.secret);
        if (secret === null) return fail('Start the setup again.', 409, 'AUTHENTICATOR_UNREADABLE');
        if (await attemptRefused(caller.userId)) return tooManyAttempts();
        if (!(await acceptTotpCode(state.totp, secret, body.code))) {
            return fail(
                'That code did not match. Check the time on your phone and try the next one.',
                401,
                'SECOND_FACTOR_INVALID',
            );
        }
        await clearAttempts(caller.userId);
        // Recovery codes come with two-factor turning on, not with every factor added.
        const recoveryCodes = state.enabled ? undefined : await issueRecoveryCodes(caller.userId);
        await factorChanged(caller.userId, env, options, 'totp', 'added');
        return jsonResponse({ success: true, ...(recoveryCodes ? { recoveryCodes } : {}) });
    }

    if (what === 'totp' && method === 'DELETE') {
        if (!state.totp) return fail('No authenticator app is set up.', 404, 'NOT_FOUND');
        const lastFactor = state.totpOn && state.passkeys.length === 0;
        if (lastFactor && policyApplies(caller)) return twoFactorRequired();
        await Authenticator.removeTotp(caller.userId);
        if (lastFactor) await lastFactorRemoved(caller.userId);
        await factorChanged(caller.userId, env, options, 'totp', 'removed');
        return jsonResponse({ success: true });
    }

    if (what === 'recovery-codes') {
        if (!state.enabled) return fail('Turn on two-factor sign-in first.', 409, 'NOT_ENABLED');
        const recoveryCodes = await issueRecoveryCodes(caller.userId);
        await factorChanged(caller.userId, env, options, 'recovery-codes', 'regenerated');
        return jsonResponse({ success: true, recoveryCodes });
    }

    if (what === 'passkeys' && id === 'options') {
        const rp = relyingParty(env, options);
        if (!rp) return passkeysUnavailable();
        return jsonResponse({
            challenge: await issueChallenge(challengeIdentifier.register(caller.userId)),
            rp: { id: rp.id, name: rp.name },
            user: { id: userHandle(caller.userId), name: caller.email, displayName: caller.name || caller.email },
            pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
            timeout: WEBAUTHN_TIMEOUT_MS,
            attestation: 'none',
            authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
            excludeCredentials: state.passkeys.map((row) => ({
                type: 'public-key',
                id: row.credentialId,
                transports: parseTransports(row.transports),
            })),
        });
    }

    if (what === 'passkeys' && id === undefined) {
        const rp = relyingParty(env, options);
        if (!rp) return passkeysUnavailable();
        const response = body.credential as RegistrationResponseJSON | undefined;
        const refused = () => fail('That passkey could not be added. Try again.', 400, 'PASSKEY_REFUSED');
        if (!response || typeof response !== 'object') return refused();
        const challenge = await consumeChallenge(
            challengeIdentifier.register(caller.userId),
            response.response?.clientDataJSON,
        );
        if (!challenge) return refused();
        let verified;
        try {
            verified = await verifyRegistration(response, rp, challenge);
        } catch (error) {
            logRefused('auth_passkey_registration_refused', error);
            return refused();
        }
        if (await Authenticator.findPasskey(verified.credentialId)) {
            return fail('That passkey is already added.', 409, 'PASSKEY_EXISTS');
        }
        const name =
            typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, PASSKEY_NAME_MAX) : 'Passkey';
        const row = await Authenticator.addPasskey({
            userId: caller.userId,
            name,
            credentialId: verified.credentialId,
            publicKey: JSON.stringify(verified.publicKey),
            algorithm: verified.algorithm,
            counter: verified.counter,
            transports: verified.transports,
        });
        const recoveryCodes = state.enabled ? undefined : await issueRecoveryCodes(caller.userId);
        await factorChanged(caller.userId, env, options, 'passkey', 'added');
        return jsonResponse({
            success: true,
            passkey: { id: row.id, name: row.name },
            ...(recoveryCodes ? { recoveryCodes } : {}),
        });
    }

    if (what === 'passkeys' && method === 'PATCH') {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, PASSKEY_NAME_MAX) : '';
        if (!name) return fail('Give the passkey a name.', 400, 'VALIDATION_ERROR');
        const ok = await Authenticator.renamePasskey(caller.userId, id, name);
        return ok ? jsonResponse({ success: true }) : fail('Not found', 404, 'NOT_FOUND');
    }

    if (what === 'passkeys' && method === 'DELETE') {
        if (!state.passkeys.some((row) => row.id === id)) return fail('Not found', 404, 'NOT_FOUND');
        const lastFactor = state.passkeys.length === 1 && !state.totpOn;
        if (lastFactor && policyApplies(caller)) return twoFactorRequired();
        if (!(await Authenticator.removePasskey(caller.userId, id))) return fail('Not found', 404, 'NOT_FOUND');
        if (lastFactor) await lastFactorRemoved(caller.userId);
        await factorChanged(caller.userId, env, options, 'passkey', 'removed');
        return jsonResponse({ success: true });
    }

    return null;
}

/** The signed-in person's factor routes (`/factors/*`), or null for any other path. */
export async function handleFactorRequest(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    segments: string[],
): Promise<Response | null> {
    const [action, ...rest] = segments;
    if (action !== 'factors') return null;
    ensureOrmConnection(env);
    return handleFactors(request, env, options, rest);
}
