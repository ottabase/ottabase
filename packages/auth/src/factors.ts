// ============================================================
// @ottabase/auth - Passkeys, two-factor sign-in and the person's own factors
// ============================================================
//
// Routes (all under /api/auth, all answered by `handleAuthRequest`):
//
//   POST   /passkey/options                 sign-in options for a passkey (anyone)
//   POST   /callback/passkey                sign in with a passkey (anyone)
//   GET    /two-factor/challenge            is a sign-in waiting on a second factor?
//   POST   /two-factor/challenge            finish it: { code } | { recoveryCode } | { passkey }
//   POST   /two-factor/passkey-options      options to finish it with a passkey
//   GET    /factors                         the signed-in person's passkeys and authenticator app
//   POST   /factors/totp                    start authenticator-app setup: { secret, uri }
//   POST   /factors/totp/confirm            first code turns it on: { recoveryCodes }
//   DELETE /factors/totp                    turn it off
//   POST   /factors/recovery-codes          a fresh set: { recoveryCodes }
//   POST   /factors/passkeys/options        options to add a passkey
//   POST   /factors/passkeys                add it: { credential, name }
//   PATCH  /factors/passkeys/:id            rename: { name }
//   DELETE /factors/passkeys/:id            remove
//
// Every change to a factor needs a RECENT sign-in (the session is under 15 minutes old): a stolen
// session cookie must not be able to add its own passkey or turn the authenticator app off. The
// answer otherwise is 403 `REAUTH_REQUIRED`, and the app sends the person to sign in again.
//
// Codes are guessable in principle (a million of them), so wrong codes and recovery codes are
// counted per person in KV: five in fifteen minutes and the challenge answers 429 until the window
// passes. KV is eventually consistent, so a determined attacker across colos may get a few more
// tries than five, never a meaningful number.
//
// ============================================================

import { userKey } from '@ottabase/cf/cache-keys';
import { Authenticator, User, VerificationToken, type AuthenticatorType } from '@ottabase/ottaorm/models';
import { redactErrorForLog } from '@ottabase/utils/http-errors';
import { base64UrlEncode, hashToken, randomBytes } from './crypto';
import { ensureOrmConnection, jsonResponse, requireCsrf, resolveFrontendUrl } from './http';
import { bumpProfileVersion, getSession, readSessionIdentity, resolveAuthSecret } from './session-store';
import {
    announce,
    authorizedUserFrom,
    clearPendingSecondFactorCookie,
    completeSignIn,
    jsonForOutcome,
    readPendingSecondFactor,
    signInOrChallenge,
} from './sign-in';
import { base32Encode, generateTotpSecret, matchTotpStep, openSecret, sealSecret, totpUri } from './totp';
import type { AuthEnv, CreateAuthConfigOptions } from './types';
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

/** How old a session may be and still change a factor. */
export const RECENT_SIGN_IN_MS = 15 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const WEBAUTHN_TIMEOUT_MS = 5 * 60 * 1000;
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const RECOVERY_CODE_COUNT = 10;
/** Recovery codes do not expire; a far-future expiry keeps them out of every cleanup. */
const RECOVERY_CODE_EXPIRES = Date.UTC(9999, 0, 1);
const PASSKEY_NAME_MAX = 60;

type Body = Record<string, unknown>;

async function readBody(request: Request): Promise<Body> {
    const body = await request.json().catch(() => ({}));
    return body && typeof body === 'object' ? (body as Body) : {};
}

function appName(env: AuthEnv, options: CreateAuthConfigOptions): string {
    if (options.appName) return options.appName;
    try {
        return new URL(resolveFrontendUrl(env)).hostname;
    } catch {
        return 'Ottabase';
    }
}

function relyingParty(env: AuthEnv, options: CreateAuthConfigOptions): RelyingParty | null {
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

const challengeIdentifier = {
    signIn: 'webauthn:signin',
    register: (userId: string) => `webauthn:register:${userId}`,
    factor: (userId: string) => `webauthn:factor:${userId}`,
};

async function issueChallenge(identifier: string): Promise<string> {
    await VerificationToken.deleteExpiredFor(identifier).catch(() => {});
    const challenge = newChallenge();
    await VerificationToken.create({
        identifier,
        token: await hashToken(challenge),
        expires: Date.now() + CHALLENGE_MS,
    });
    return challenge;
}

/** The challenge a response answers, consumed (so it works once) and unexpired, or null. */
async function consumeChallenge(identifier: string, clientDataJSON: unknown): Promise<string | null> {
    const challenge = readChallenge(clientDataJSON);
    if (!challenge) return null;
    const row = await VerificationToken.consumeByIdentifierAndToken(identifier, await hashToken(challenge));
    if (!row) return null;
    const expires = Number(row.get('expires'));
    return Number.isFinite(expires) && expires >= Date.now() ? challenge : null;
}

function requestOptions(rp: RelyingParty, challenge: string, passkeys: AuthenticatorType[] = []) {
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

function parseTransports(raw: string | null): string[] {
    try {
        const parsed = JSON.parse(raw ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
        return [];
    }
}

/** Check a passkey assertion against the passkey it names; bumps its counter. Throws WebAuthnError. */
async function checkPasskey(
    response: AuthenticationResponseJSON,
    rp: RelyingParty,
    challenge: string,
): Promise<AuthenticatorType> {
    const credentialId = typeof response?.id === 'string' ? response.id : '';
    const stored = credentialId ? await Authenticator.findPasskey(credentialId) : null;
    if (!stored || !stored.publicKey || stored.algorithm == null) throw new WebAuthnError('credential-unknown');
    const handle = response.response?.userHandle;
    if (handle && handle !== userHandle(stored.userId)) throw new WebAuthnError('user-handle-mismatch');
    const { counter } = await verifyAuthentication(response, rp, challenge, {
        publicKey: JSON.parse(stored.publicKey) as JsonWebKey,
        algorithm: stored.algorithm as CoseAlgorithm,
        counter: Number(stored.counter) || 0,
    });
    await Authenticator.touchPasskey(stored.id, counter);
    return stored;
}

function logRefused(event: string, error: unknown): void {
    const reason = error instanceof WebAuthnError ? error.reason : undefined;
    console.warn(JSON.stringify({ event, ...(reason ? { reason } : { error: redactErrorForLog(error) }) }));
}

// ---------- failed-attempt counter ----------

function failuresKey(userId: string): string {
    return userKey('auth', userId, 'factor-failures');
}

/** Fails closed: without KV the attempts cannot be counted, so none are allowed. */
async function tooManyFailures(env: AuthEnv, userId: string): Promise<boolean> {
    if (!env.OBCF_KV) return true;
    const count = Number(await env.OBCF_KV.get(failuresKey(userId))) || 0;
    return count >= FAILURE_LIMIT;
}

async function recordFailure(env: AuthEnv, userId: string): Promise<void> {
    if (!env.OBCF_KV) return;
    const count = (Number(await env.OBCF_KV.get(failuresKey(userId))) || 0) + 1;
    await env.OBCF_KV.put(failuresKey(userId), String(count), { expirationTtl: FAILURE_WINDOW_SECONDS });
}

async function clearFailures(env: AuthEnv, userId: string): Promise<void> {
    await env.OBCF_KV?.delete(failuresKey(userId)).catch(() => {});
}

const tooManyResponse = () =>
    jsonResponse(
        { error: 'Too many wrong codes. Wait fifteen minutes and try again.', code: 'TOO_MANY_ATTEMPTS' },
        429,
    );

// ---------- recovery codes ----------

const recoveryIdentifier = (userId: string) => `recovery:${userId}`;

/** Lowercase, no separators: what the person typed, however they typed it. */
function normalizeRecoveryCode(code: string): string {
    return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Replace the person's recovery codes; returns the new ones, shown once and stored only hashed. */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
    const identifier = recoveryIdentifier(userId);
    await VerificationToken.deleteByIdentifier(identifier);
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
        codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
        await VerificationToken.create({
            identifier,
            token: await hashToken(normalizeRecoveryCode(raw)),
            expires: RECOVERY_CODE_EXPIRES,
        });
    }
    return codes;
}

/**
 * Turn a person's two-factor sign-in off on someone else's say-so: an organization manager
 * resetting a member who lost their phone. Removes the authenticator app and the recovery codes,
 * refreshes their live sessions' snapshot, and announces it. Authorization is the caller's job.
 */
export async function resetTwoFactor(
    userId: string,
    env: AuthEnv,
    options: CreateAuthConfigOptions = {},
): Promise<{ removed: boolean }> {
    ensureOrmConnection(env);
    const removed = await Authenticator.removeTotp(userId);
    await VerificationToken.deleteByIdentifier(recoveryIdentifier(userId));
    await bumpProfileVersion(userId, env, options);
    if (removed) {
        await announce(env, options, 'user.factor.changed', {
            userId,
            factor: 'totp',
            change: 'removed',
            at: Date.now(),
        });
    }
    return { removed };
}

// ---------- the second factor itself ----------

/**
 * Does the submitted proof belong to this person? A code from their authenticator app (each step
 * accepted once), one of their recovery codes (consumed), or one of their passkeys.
 */
async function verifySecondFactor(
    userId: string,
    body: Body,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
): Promise<boolean> {
    if (typeof body.code === 'string') {
        const totp = await Authenticator.totpFor(userId);
        if (!totp?.secret || totp.confirmedAt == null) return false;
        const secret = await openSecret(resolveAuthSecret(env), totp.secret);
        const step = await matchTotpStep(secret, body.code);
        return step !== null && (await Authenticator.acceptTotpStep(totp.id, step));
    }
    if (typeof body.recoveryCode === 'string') {
        const normalized = normalizeRecoveryCode(body.recoveryCode);
        if (normalized.length !== 10) return false;
        const used = await VerificationToken.consumeByIdentifierAndToken(
            recoveryIdentifier(userId),
            await hashToken(normalized),
        );
        if (used)
            await announce(env, options, 'user.factor.changed', {
                userId,
                factor: 'recovery-codes',
                change: 'removed',
                at: Date.now(),
            });
        return !!used;
    }
    if (body.passkey && typeof body.passkey === 'object') {
        const rp = relyingParty(env, options);
        if (!rp) return false;
        const response = body.passkey as AuthenticationResponseJSON;
        const challenge = await consumeChallenge(challengeIdentifier.factor(userId), response.response?.clientDataJSON);
        if (!challenge) return false;
        try {
            const passkey = await checkPasskey(response, rp, challenge);
            return passkey.userId === userId;
        } catch (error) {
            logRefused('auth_second_factor_passkey_refused', error);
            return false;
        }
    }
    return false;
}

async function handleChallengeState(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const userId = await readPendingSecondFactor(request, env);
    if (!userId) return jsonResponse({ pending: false });
    const passkeys = (await Authenticator.listForUser(userId)).filter((row) => row.kind === 'passkey');
    return jsonResponse({
        pending: true,
        passkey: passkeys.length > 0 && !!relyingParty(env, options),
        recoveryCodes: (await VerificationToken.countByIdentifier(recoveryIdentifier(userId))) > 0,
    });
}

async function handleChallenge(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;

    const userId = await readPendingSecondFactor(request, env);
    if (!userId) {
        return jsonResponse({ error: 'This sign-in expired. Start again.', code: 'SECOND_FACTOR_EXPIRED' }, 401);
    }
    if (await tooManyFailures(env, userId)) return tooManyResponse();

    if (!(await verifySecondFactor(userId, body, env, options))) {
        await recordFailure(env, userId);
        return jsonResponse({ error: 'That code did not work. Try again.', code: 'SECOND_FACTOR_INVALID' }, 401);
    }
    await clearFailures(env, userId);

    const user = await User.find(userId);
    if (!user) return jsonResponse({ error: 'This sign-in expired. Start again.', code: 'SECOND_FACTOR_EXPIRED' }, 401);
    const completed = await completeSignIn(authorizedUserFrom(user), env, request, options);
    return jsonForOutcome(completed ? { kind: 'session', ...completed } : { kind: 'failed' }, [
        clearPendingSecondFactorCookie(env, request),
    ]);
}

async function handleChallengePasskeyOptions(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    const userId = await readPendingSecondFactor(request, env);
    const rp = relyingParty(env, options);
    if (!userId || !rp) return jsonResponse({ error: 'No passkey sign-in is waiting.' }, 400);
    const passkeys = (await Authenticator.listForUser(userId)).filter((row) => row.kind === 'passkey');
    if (passkeys.length === 0) return jsonResponse({ error: 'No passkey sign-in is waiting.' }, 400);
    return jsonResponse(requestOptions(rp, await issueChallenge(challengeIdentifier.factor(userId)), passkeys));
}

// ---------- passkey sign-in ----------

const passkeysUnavailable = () =>
    jsonResponse(
        {
            error: 'Passkeys need the app at a domain name over https (or localhost in development).',
            code: 'PASSKEYS_UNAVAILABLE',
        },
        400,
    );

async function handlePasskeySignInOptions(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    const rp = relyingParty(env, options);
    if (!rp) return passkeysUnavailable();
    // No allow-list: the browser offers whichever of this site's passkeys the person picks.
    return jsonResponse(requestOptions(rp, await issueChallenge(challengeIdentifier.signIn)));
}

async function handlePasskeySignIn(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    const rp = relyingParty(env, options);
    if (!rp) return passkeysUnavailable();

    const refused = () => jsonResponse({ error: 'That passkey could not sign you in.', code: 'PASSKEY_REFUSED' }, 401);
    const response = body.credential as AuthenticationResponseJSON | undefined;
    if (!response || typeof response !== 'object') return refused();
    const challenge = await consumeChallenge(challengeIdentifier.signIn, response.response?.clientDataJSON);
    if (!challenge) return refused();

    let passkey: AuthenticatorType;
    try {
        passkey = await checkPasskey(response, rp, challenge);
    } catch (error) {
        logRefused('auth_passkey_sign_in_refused', error);
        return refused();
    }
    const user = await User.find(passkey.userId);
    if (!user) return refused();
    const authorized = authorizedUserFrom(user);
    if (options.requireVerifiedEmail && !authorized.emailVerified) {
        return jsonResponse({ error: 'Please verify your email before signing in' }, 401);
    }
    return jsonForOutcome(await signInOrChallenge(authorized, env, request, options, 'passkey'));
}

// ---------- the person's own factors ----------

interface Caller {
    userId: string;
    email: string;
    name: string | null;
    recentSignIn: boolean;
    recentUntil: number;
}

async function resolveCaller(request: Request, env: AuthEnv, options: CreateAuthConfigOptions): Promise<Caller | null> {
    const session = await getSession(request, env, options);
    const identity = await readSessionIdentity(request, env);
    if (!session || !identity || identity.userId !== session.user.id) return null;
    const recentUntil = identity.createdMs + RECENT_SIGN_IN_MS;
    return {
        userId: session.user.id,
        email: session.user.email,
        name: (session.user.name as string | null) ?? null,
        recentSignIn: identity.createdMs > 0 && Date.now() < recentUntil,
        recentUntil,
    };
}

const reauthRequired = () =>
    jsonResponse(
        {
            error: 'Sign in again to change how you sign in. It keeps a borrowed session from doing it.',
            code: 'REAUTH_REQUIRED',
        },
        403,
    );

async function factorSummary(caller: Caller, env: AuthEnv, options: CreateAuthConfigOptions) {
    const rows = await Authenticator.listForUser(caller.userId);
    const totp = rows.find((row) => row.kind === 'totp');
    return {
        twoFactor: {
            enabled: !!totp && totp.confirmedAt != null,
            pending: !!totp && totp.confirmedAt == null,
            recoveryCodesLeft: await VerificationToken.countByIdentifier(recoveryIdentifier(caller.userId)),
        },
        passkeys: rows
            .filter((row) => row.kind === 'passkey')
            .map((row) => ({
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
    caller: Caller,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    factor: 'totp' | 'passkey' | 'recovery-codes',
    change: 'added' | 'removed' | 'regenerated',
): Promise<void> {
    // The two-factor flag rides in every live session's snapshot: re-read it on the next request.
    if (factor === 'totp') await bumpProfileVersion(caller.userId, env, options).catch(() => {});
    await announce(env, options, 'user.factor.changed', { userId: caller.userId, factor, change, at: Date.now() });
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
    if (!caller) return jsonResponse({ error: 'Unauthorized' }, 401);
    if (method === 'GET') return jsonResponse(await factorSummary(caller, env, options));

    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    if (!caller.recentSignIn) return reauthRequired();

    if (what === 'totp' && id === undefined && method === 'POST') {
        if (await Authenticator.hasTwoFactor(caller.userId)) {
            return jsonResponse({ error: 'Two-factor sign-in is already on.', code: 'ALREADY_ENABLED' }, 409);
        }
        const secret = generateTotpSecret();
        await Authenticator.beginTotp(caller.userId, await sealSecret(resolveAuthSecret(env), secret));
        return jsonResponse({ secret, uri: totpUri({ secret, account: caller.email, issuer: appName(env, options) }) });
    }

    if (what === 'totp' && id === 'confirm') {
        const totp = await Authenticator.totpFor(caller.userId);
        if (!totp?.secret || totp.confirmedAt != null) {
            return jsonResponse({ error: 'Start the setup again.', code: 'NO_PENDING_SETUP' }, 409);
        }
        if (await tooManyFailures(env, caller.userId)) return tooManyResponse();
        const secret = await openSecret(resolveAuthSecret(env), totp.secret);
        const step = typeof body.code === 'string' ? await matchTotpStep(secret, body.code) : null;
        if (step === null || !(await Authenticator.acceptTotpStep(totp.id, step))) {
            await recordFailure(env, caller.userId);
            return jsonResponse(
                {
                    error: 'That code did not match. Check the time on your phone and try the next one.',
                    code: 'CODE_INVALID',
                },
                400,
            );
        }
        await clearFailures(env, caller.userId);
        const recoveryCodes = await issueRecoveryCodes(caller.userId);
        await factorChanged(caller, env, options, 'totp', 'added');
        return jsonResponse({ success: true, recoveryCodes });
    }

    if (what === 'totp' && method === 'DELETE') {
        await Authenticator.removeTotp(caller.userId);
        await VerificationToken.deleteByIdentifier(recoveryIdentifier(caller.userId));
        await factorChanged(caller, env, options, 'totp', 'removed');
        return jsonResponse({ success: true });
    }

    if (what === 'recovery-codes') {
        if (!(await Authenticator.hasTwoFactor(caller.userId))) {
            return jsonResponse({ error: 'Turn on two-factor sign-in first.', code: 'NOT_ENABLED' }, 409);
        }
        const recoveryCodes = await issueRecoveryCodes(caller.userId);
        await factorChanged(caller, env, options, 'recovery-codes', 'regenerated');
        return jsonResponse({ success: true, recoveryCodes });
    }

    if (what === 'passkeys' && id === 'options') {
        const rp = relyingParty(env, options);
        if (!rp) return passkeysUnavailable();
        const existing = (await Authenticator.listForUser(caller.userId)).filter((row) => row.kind === 'passkey');
        return jsonResponse({
            challenge: await issueChallenge(challengeIdentifier.register(caller.userId)),
            rp: { id: rp.id, name: rp.name },
            user: { id: userHandle(caller.userId), name: caller.email, displayName: caller.name || caller.email },
            pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
            timeout: WEBAUTHN_TIMEOUT_MS,
            attestation: 'none',
            authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
            excludeCredentials: existing.map((row) => ({
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
        const refused = () =>
            jsonResponse({ error: 'That passkey could not be added. Try again.', code: 'PASSKEY_REFUSED' }, 400);
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
            return jsonResponse({ error: 'That passkey is already added.', code: 'PASSKEY_EXISTS' }, 409);
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
        await factorChanged(caller, env, options, 'passkey', 'added');
        return jsonResponse({ success: true, passkey: { id: row.id, name: row.name } });
    }

    if (what === 'passkeys' && method === 'PATCH') {
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, PASSKEY_NAME_MAX) : '';
        if (!name) return jsonResponse({ error: 'Give the passkey a name.' }, 400);
        const ok = await Authenticator.renamePasskey(caller.userId, id, name);
        return ok ? jsonResponse({ success: true }) : jsonResponse({ error: 'Not found' }, 404);
    }

    if (what === 'passkeys' && method === 'DELETE') {
        const ok = await Authenticator.removePasskey(caller.userId, id);
        if (!ok) return jsonResponse({ error: 'Not found' }, 404);
        await factorChanged(caller, env, options, 'passkey', 'removed');
        return jsonResponse({ success: true });
    }

    return null;
}

/** The passkey, second-factor and factor routes, or null for any other path. */
export async function handleFactorRequest(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    segments: string[],
): Promise<Response | null> {
    const [action, param, ...rest] = segments;
    const method = request.method;
    const route =
        (action === 'passkey' && param === 'options' && method === 'POST' && 'passkey-options') ||
        (action === 'callback' && param === 'passkey' && method === 'POST' && 'passkey-sign-in') ||
        (action === 'two-factor' && param === 'challenge' && (method === 'GET' || method === 'POST') && 'challenge') ||
        (action === 'two-factor' && param === 'passkey-options' && method === 'POST' && 'challenge-passkey') ||
        (action === 'factors' && 'factors') ||
        null;
    if (!route) return null;

    ensureOrmConnection(env);
    switch (route) {
        case 'passkey-options':
            return handlePasskeySignInOptions(request, env, options);
        case 'passkey-sign-in':
            return handlePasskeySignIn(request, env, options);
        case 'challenge':
            return method === 'GET'
                ? handleChallengeState(request, env, options)
                : handleChallenge(request, env, options);
        case 'challenge-passkey':
            return handleChallengePasskeyOptions(request, env, options);
        case 'factors':
            return handleFactors(
                request,
                env,
                options,
                [param, ...rest].filter((s): s is string => s !== undefined),
            );
    }
}
