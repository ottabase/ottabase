// ============================================================
// @ottabase/auth - The one tail every sign-in runs
// ============================================================
//
// Password, magic link, OAuth and passkey sign-ins all end here. `signInOrChallenge` is the only
// place that decides between a session and a second-factor challenge, so no sign-in method can
// skip the second factor by accident:
//
//   - a passkey with user verification IS two factors (the device and the fingerprint, face or
//     PIN), so it never gets the challenge;
//   - every other method, when the account has two-factor on (an authenticator app or a
//     passkey), gets a short-lived signed "pending" cookie instead of a session, and the session
//     is issued by `POST /api/auth/two-factor/challenge` once a code, recovery code or passkey
//     checks out.
//
// Every session a sign-in issues carries `authAt` (when the person proved who they are) and
// `signInMethod`. Sessions minted outside this tail (the password-change reissue, the first-run
// owner wizard, SSO through an identity provider, which owns its own MFA) call
// `createSessionCookieForUser` directly, are not challenged, and pass those two themselves.
//
// ============================================================

import { Authenticator, type User } from '@ottabase/ottaorm/models';
import { errorResponse, redactErrorForLog } from '@ottabase/utils/http-errors';
import { bootstrapFirstUser } from './bootstrap';
import { clearCookie, parseCookies, serializeCookie } from './cookies';
import { ensureOrmConnection, jsonResponse, resolveFrontendUrl } from './http';
import { signJwt, verifyJwt } from './jwt';
import {
    authCookieBase,
    createSessionCookieForUser,
    isProductionCookieEnv,
    resolveAuthSecret,
    resolveSecureCookie,
    type CreatedSession,
} from './session-store';
import type { AuthEnv, AuthEvents, AuthorizedUser, CreateAuthConfigOptions } from './types';

const PENDING_MAX_AGE_SECONDS = 10 * 60;
const PENDING_PURPOSE = 'second-factor';

/**
 * How a session signed in, stored on it: `password`, `magic-link`, `oauth:<provider>`, `passkey`,
 * `register`, `owner`, `sso:<connectionId>`, or whatever a host passes. Only `passkey` changes
 * what happens here (it is never challenged).
 */
export type SignInMethod = string;

/**
 * Runs the app's `onSignIn` hook before the session is issued. False when it threw: the app could
 * not finish the account (its workspace, say), so the caller refuses the sign-in instead of
 * issuing a session for a half-provisioned account.
 */
export async function runSignInHook(
    options: CreateAuthConfigOptions,
    params: { userId: string; email?: string | null },
): Promise<boolean> {
    try {
        await options.onSignIn?.(params);
        return true;
    } catch (error) {
        console.error(JSON.stringify({ event: 'auth_sign_in_hook_failed', error: redactErrorForLog(error) }));
        return false;
    }
}

/** Hands an account event to the app's `emit`. Best-effort: a listener never fails a sign-in. */
export async function announce<K extends keyof AuthEvents>(
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    name: K,
    payload: AuthEvents[K],
): Promise<void> {
    try {
        await options.emit?.(env, name, payload);
    } catch (error) {
        console.warn(JSON.stringify({ event: 'auth_event_failed', name, error: redactErrorForLog(error) }));
    }
}

/** The identity a session is issued for, read off the user row. */
export function authorizedUserFrom(user: User): AuthorizedUser {
    const raw = user.get('emailVerified');
    const emailVerified = raw ? (raw instanceof Date ? raw.getTime() : Number(raw)) : null;
    return {
        id: String(user.get('id')),
        email: String(user.get('email')),
        name: (user.get('name') as string | null) ?? null,
        // The uploaded avatar, else the OAuth provider's picture (see User.imageUrl).
        image: user.imageUrl() ?? null,
        emailVerified: Number.isFinite(emailVerified) ? emailVerified : null,
    };
}

/** A finished sign-in: the session cookie to set and the client's copy of the session. */
export interface CompletedSignIn {
    cookie: string;
    session: { user: CreatedSession['user']; expires: number };
}

/** What a sign-in already knows when it completes. */
export interface CompleteSignInDetails {
    /** Stored on the session (`register` for the app's sign-up route). */
    signInMethod?: SignInMethod;
    /** The two-factor flag when the caller already read it, so session creation skips the query. */
    twoFactorEnabled?: boolean;
}

/**
 * Issue the session: first-user bootstrap, the app's `onSignIn` hook, then the cookie, stamped
 * with `authAt` = now (a real sign-in). Null when the account could not be finished (logged
 * here): the caller answers 500 `ACCOUNT_PROVISIONING_FAILED` and issues no session. The app's
 * register route calls it too (`{ signInMethod: 'register' }`): a brand-new account has no
 * second factor to ask for.
 */
export async function completeSignIn(
    user: AuthorizedUser,
    env: AuthEnv,
    request: Request,
    options: CreateAuthConfigOptions = {},
    details: CompleteSignInDetails = {},
): Promise<CompletedSignIn | null> {
    ensureOrmConnection(env);
    try {
        await bootstrapFirstUser(env, user);
    } catch (error) {
        console.error(JSON.stringify({ event: 'auth_first_user_bootstrap_failed', error: redactErrorForLog(error) }));
        return null;
    }
    if (!(await runSignInHook(options, { userId: user.id, email: user.email }))) return null;

    const { cookie, session } = await createSessionCookieForUser(
        {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            emailVerified: user.emailVerified,
            authAt: Date.now(),
            signInMethod: details.signInMethod ?? null,
            twoFactorEnabled: details.twoFactorEnabled,
        },
        env,
        request,
        options,
    );
    return { cookie, session: { user: session.user, expires: session.expiresAt } };
}

// ---------- the pending second factor ----------

function pendingCookieName(env: AuthEnv): string {
    // Scoped to /api/auth, so only __Secure- (not __Host-, which requires Path=/).
    return `${isProductionCookieEnv(env) ? '__Secure-' : ''}${authCookieBase(env, 'second-factor')}`;
}

/** A sign-in waiting on its second factor, as the pending cookie carries it. */
export interface PendingSecondFactor {
    userId: string;
    /** This pending sign-in's id: its wrong-code attempts are counted under it. */
    jti: string;
    /** How the first factor was given; the session the challenge issues keeps it. */
    signInMethod: SignInMethod;
    /** When the pending cookie expires, epoch ms. */
    expiresAt: number;
}

export async function pendingSecondFactorCookie(
    userId: string,
    signInMethod: SignInMethod,
    env: AuthEnv,
    request: Request,
): Promise<string> {
    const token = await signJwt(
        { sub: userId, jti: crypto.randomUUID(), purpose: PENDING_PURPOSE, method: signInMethod },
        resolveAuthSecret(env),
        { expiresInSeconds: PENDING_MAX_AGE_SECONDS },
    );
    return serializeCookie(pendingCookieName(env), token, {
        maxAgeSeconds: PENDING_MAX_AGE_SECONDS,
        secure: resolveSecureCookie(env, request),
        sameSite: 'Lax',
        httpOnly: true,
        path: '/api/auth',
    });
}

/** The sign-in this request's pending cookie is waiting on, or null. */
export async function readPendingSecondFactor(request: Request, env: AuthEnv): Promise<PendingSecondFactor | null> {
    const token = parseCookies(request.headers.get('Cookie'))[pendingCookieName(env)];
    if (!token) return null;
    try {
        const payload = await verifyJwt<{
            sub?: string;
            jti?: string;
            purpose?: string;
            method?: string;
            exp?: number;
        }>(token, resolveAuthSecret(env));
        if (
            payload?.purpose !== PENDING_PURPOSE ||
            typeof payload.sub !== 'string' ||
            typeof payload.jti !== 'string'
        ) {
            return null;
        }
        return {
            userId: payload.sub,
            jti: payload.jti,
            signInMethod: typeof payload.method === 'string' ? payload.method : 'password',
            expiresAt: (Number(payload.exp) || 0) * 1000,
        };
    } catch {
        return null;
    }
}

export function clearPendingSecondFactorCookie(env: AuthEnv, request: Request): string {
    return clearCookie(pendingCookieName(env), { secure: resolveSecureCookie(env, request), path: '/api/auth' });
}

/** The second-factor page for a redirect-based sign-in, keeping where the person was going. */
export function twoFactorPageUrl(env: AuthEnv, options: CreateAuthConfigOptions, callbackUrl: string): string {
    const page = options.twoFactorPage || '/login/two-factor';
    const url = new URL(`${resolveFrontendUrl(env)}${page}`);
    url.searchParams.set('callbackUrl', callbackUrl);
    return url.toString();
}

export type SignInOutcome =
    | ({ kind: 'session' } & CompletedSignIn)
    | { kind: 'second-factor'; cookie: string }
    /** The account could not be finished (bootstrap or the app's sign-in hook failed). */
    | { kind: 'failed' };

/** The 500 for a sign-in whose account could not be finished. Opaque like every 5xx; the code is stable. */
export function provisioningFailedResponse(headers?: Headers): Response {
    return errorResponse('Account setup could not be completed. Please try again.', 500, {
        code: 'ACCOUNT_PROVISIONING_FAILED',
        headers,
    });
}

/**
 * A JSON sign-in's outcome (password, passkey, the challenge itself). A second factor answers 200
 * `{ twoFactorRequired: true, code: 'SECOND_FACTOR_REQUIRED' }` with the pending cookie and no
 * session.
 */
export function jsonForOutcome(outcome: SignInOutcome, extraCookies: string[] = []): Response {
    const headers = new Headers();
    for (const cookie of extraCookies) headers.append('Set-Cookie', cookie);
    if (outcome.kind === 'failed') return provisioningFailedResponse(headers);
    headers.append('Set-Cookie', outcome.cookie);
    if (outcome.kind === 'second-factor') {
        return jsonResponse({ twoFactorRequired: true, code: 'SECOND_FACTOR_REQUIRED' }, 200, headers);
    }
    return jsonResponse({ success: true, session: outcome.session }, 200, headers);
}

/**
 * The tail of every interactive sign-in. A passkey signs straight in; any other method signs in
 * when the account has no second factor, and otherwise gets the pending cookie. The two-factor
 * flag read here rides along to the session, so it is read once per sign-in.
 */
export async function signInOrChallenge(
    user: AuthorizedUser,
    env: AuthEnv,
    request: Request,
    options: CreateAuthConfigOptions,
    method: SignInMethod,
): Promise<SignInOutcome> {
    ensureOrmConnection(env);
    // A passkey sign-in means the account has a passkey, so two-factor is on by definition.
    const twoFactorEnabled = method === 'passkey' ? true : await Authenticator.hasTwoFactor(user.id);
    if (method !== 'passkey' && twoFactorEnabled) {
        return { kind: 'second-factor', cookie: await pendingSecondFactorCookie(user.id, method, env, request) };
    }
    const completed = await completeSignIn(user, env, request, options, { signInMethod: method, twoFactorEnabled });
    return completed ? { kind: 'session', ...completed } : { kind: 'failed' };
}
