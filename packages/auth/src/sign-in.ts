// ============================================================
// @ottabase/auth - The one tail every sign-in runs
// ============================================================
//
// Password, magic link, OAuth and passkey sign-ins all end here. `signInOrChallenge` is the only
// place that decides between a session and a second-factor challenge, so no sign-in method can
// skip the authenticator app by accident:
//
//   - a passkey with user verification IS two factors (the device and the fingerprint, face or
//     PIN), so it never gets the challenge;
//   - every other method, when the account has an authenticator app, gets a short-lived signed
//     "pending" cookie instead of a session, and the session is issued by
//     `POST /api/auth/two-factor/challenge` once a code, recovery code or passkey checks out.
//
// Sessions minted outside a sign-in (the password-change reissue, the first-run owner wizard,
// SSO through the identity provider, which owns its own MFA) call `createSessionCookieForUser`
// directly and are not challenged.
//
// ============================================================

import { Authenticator, type User } from '@ottabase/ottaorm/models';
import { redactErrorForLog } from '@ottabase/utils/http-errors';
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

export type SignInMethod = 'credentials' | 'oauth' | 'magic-link' | 'passkey';

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

/**
 * Issue the session: first-user bootstrap, the app's `onSignIn` hook, then the cookie. Null when
 * the account could not be finished (logged here): the caller answers 500
 * `ACCOUNT_PROVISIONING_FAILED` and issues no session. The app's register route calls it too:
 * a brand-new account has no second factor to ask for.
 */
export async function completeSignIn(
    user: AuthorizedUser,
    env: AuthEnv,
    request: Request,
    options: CreateAuthConfigOptions = {},
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
        { id: user.id, email: user.email, name: user.name, image: user.image, emailVerified: user.emailVerified },
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

export async function pendingSecondFactorCookie(userId: string, env: AuthEnv, request: Request): Promise<string> {
    const token = await signJwt({ sub: userId, purpose: PENDING_PURPOSE }, resolveAuthSecret(env), {
        expiresInSeconds: PENDING_MAX_AGE_SECONDS,
    });
    return serializeCookie(pendingCookieName(env), token, {
        maxAgeSeconds: PENDING_MAX_AGE_SECONDS,
        secure: resolveSecureCookie(env, request),
        sameSite: 'Lax',
        httpOnly: true,
        path: '/api/auth',
    });
}

/** The user a sign-in is waiting on a second factor for, or null. */
export async function readPendingSecondFactor(request: Request, env: AuthEnv): Promise<string | null> {
    const token = parseCookies(request.headers.get('Cookie'))[pendingCookieName(env)];
    if (!token) return null;
    try {
        const payload = await verifyJwt<{ sub?: string; purpose?: string }>(token, resolveAuthSecret(env));
        return payload?.purpose === PENDING_PURPOSE && typeof payload.sub === 'string' ? payload.sub : null;
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

/**
 * Does this account have to pass a second factor? A missing table (an app that has not run its
 * migrations since this version) means nobody has one yet; any other failure throws, so the
 * sign-in fails closed instead of skipping the check.
 */
async function needsSecondFactor(userId: string): Promise<boolean> {
    try {
        return await Authenticator.hasTwoFactor(userId);
    } catch (error) {
        if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return false;
        throw error;
    }
}

export type SignInOutcome =
    | ({ kind: 'session' } & CompletedSignIn)
    | { kind: 'second-factor'; cookie: string }
    /** The account could not be finished (bootstrap or the app's sign-in hook failed). */
    | { kind: 'failed' };

/**
 * A JSON sign-in's outcome (password, passkey, the challenge itself). A second factor answers 200
 * with `{ success: false, twoFactorRequired: true }` and the pending cookie: no session, and an
 * error message an older client can show as it is.
 */
export function jsonForOutcome(outcome: SignInOutcome, extraCookies: string[] = []): Response {
    const headers = new Headers();
    for (const cookie of extraCookies) headers.append('Set-Cookie', cookie);
    if (outcome.kind === 'failed') {
        return jsonResponse(
            { error: 'Account setup could not be completed. Please try again.', code: 'ACCOUNT_PROVISIONING_FAILED' },
            500,
            headers,
        );
    }
    headers.append('Set-Cookie', outcome.cookie);
    if (outcome.kind === 'second-factor') {
        return jsonResponse(
            {
                success: false,
                twoFactorRequired: true,
                error: 'Enter the code from your authenticator app to finish signing in.',
            },
            200,
            headers,
        );
    }
    return jsonResponse({ success: true, session: outcome.session }, 200, headers);
}

/**
 * The tail of every interactive sign-in. A passkey signs straight in; any other method signs in
 * when the account has no authenticator app, and otherwise gets the pending cookie.
 */
export async function signInOrChallenge(
    user: AuthorizedUser,
    env: AuthEnv,
    request: Request,
    options: CreateAuthConfigOptions,
    method: SignInMethod,
): Promise<SignInOutcome> {
    ensureOrmConnection(env);
    if (method !== 'passkey' && (await needsSecondFactor(user.id))) {
        return { kind: 'second-factor', cookie: await pendingSecondFactorCookie(user.id, env, request) };
    }
    const completed = await completeSignIn(user, env, request, options);
    return completed ? { kind: 'session', ...completed } : { kind: 'failed' };
}
