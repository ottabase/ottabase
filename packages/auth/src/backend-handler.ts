// ============================================================
// @ottabase/auth - Backend Request Handler (Cloudflare Workers)
// ============================================================
//
// `handleAuthRequest` is a small, self-contained router covering every `/api/auth/*`
// sub-path that isn't already owned by the host app (register,
// verify-email, password reset/change stay in the app -- see
// packages/auth/README.md for the full route table).
//
// ============================================================

import { Account, User, VerificationToken } from '@ottabase/ottaorm/models';
import { errorResponse, redactErrorForLog } from '@ottabase/utils/http-errors';
import { withNotice } from '@ottabase/utils/url';
import { requestLocaleDefaults } from './request-locale';
import { serializeCookie, parseCookies, clearCookie } from './cookies';
import { verifyPassword, randomToken, getDummyPasswordHash, hashToken } from './crypto';
import { createCsrfCookiePair } from './csrf';
import { handleFactorRequest } from './factors';
import { handleSignInFactorRequest } from './two-factor';
import {
    csrfCookieName,
    ensureOrmConnection,
    jsonResponse,
    requireCsrf,
    resolveFrontendUrl,
    sanitizeCallbackPath,
} from './http';
import { signJwt, verifyJwt } from './jwt';
import {
    exchangeCodeForTokens,
    fetchUserProfile,
    buildAuthorizationUrl,
    createPkcePair,
} from './providers/oauth-client';
import { getConfiguredProvider } from './providers/presets';
import { resolveMagicLinkSender } from './providers';
import {
    authCookieBase,
    buildClearSessionCookie,
    getSession,
    isProductionCookieEnv,
    resolveAuthSecret,
    resolveSecureCookie,
    resolveSessionCookieName,
    revokeSession,
} from './session-store';
import {
    announce,
    authorizedUserFrom,
    jsonForOutcome,
    signInOrChallenge,
    twoFactorPageUrl,
    type SignInOutcome,
} from './sign-in';
import type { AuthEnv, AuthorizedUser, CreateAuthConfigOptions, SessionTokenPayload } from './types';

export type {
    AuthEnv,
    AuthEvents,
    AuthorizedUser,
    CreateAuthConfigOptions,
    CredentialsAuthorizeOptions,
    SecondFactorPolicyInput,
    UserCreatedEvent,
    UserFactorChangedEvent,
    UserVerifiedEvent,
} from './types';
export type { FirstUserBootstrapResult } from './bootstrap';
export { hashPassword, verifyPassword, hashToken } from './crypto';
export { requireCsrf } from './http';
export { passkeysAvailable, RECENT_SIGN_IN_MS, requireRecentSignIn, resetTwoFactor } from './factors';
export { completeSignIn, type CompletedSignIn, type CompleteSignInDetails, type SignInMethod } from './sign-in';
export {
    bumpOrganizationVersion,
    bumpProfileVersion,
    isTwoFactorSetupPending,
    sessionRefusal,
    type SessionIdentity,
    type SessionRefusal,
} from './session-store';
export { bootstrapFirstUser, provisionPlatformOwnerOrganization } from './bootstrap';
export {
    getSession,
    revokeAllUserSessions,
    revokeSession,
    createSessionCookieForUser,
    authCookieBase,
    buildClearSessionCookie,
    listUserSessions,
    readSessionIdentity,
    renameUserSession,
    revokeOtherUserSessions,
    revokeUserSessionById,
    sessionPublicId,
    wasSessionRevoked,
    purgeUserSessions,
} from './session-store';
export type { SessionSummary, SessionMetadata } from './session-store';
export { describeRequestDevice, describeUserAgent, maskIp } from './device';
export type { SessionDevice } from './device';
export { pickLocaleFromAcceptLanguage, requestLocaleDefaults } from './request-locale';
export type { RequestLocaleDefaults } from './request-locale';

const CSRF_COOKIE_MAX_AGE = 60 * 60; // 1 hour
const OAUTH_STATE_MAX_AGE = 10 * 60; // 10 minutes
const MAGIC_LINK_MAX_AGE_SECONDS = 15 * 60; // 15 minutes -- short-lived, unlike the app's own 24h email-verification links

// The OAuth-state cookie is scoped to Path=/api/auth so it can only use __Secure- (not __Host-).
function oauthStateCookieName(env: AuthEnv): string {
    return `${isProductionCookieEnv(env) ? '__Secure-' : ''}${authCookieBase(env, 'oauth-state')}`;
}

/**
 * The URL notice code for each auth failure. Codes, never messages, travel in the URL; the app's
 * notice registry owns the wording (`auth.oauth-signin` and friends).
 */
const AUTH_NOTICE_CODES: Record<string, string> = {
    OAuthAccountNotLinked: 'auth.oauth-account-not-linked',
    OAuthCallback: 'auth.oauth-callback',
    OAuthSignin: 'auth.oauth-signin',
    Verification: 'auth.verification',
    AccountProvisioning: 'auth.account-provisioning',
};

/** Absolute URL of the configured error page (`options.errorPage`, default `/login`) with `notice=<code>`. */
function errorPageUrl(env: AuthEnv, options: CreateAuthConfigOptions | undefined, code: string): string {
    const errorPage = options?.errorPage || '/login';
    return withNotice(`${resolveFrontendUrl(env)}${errorPage}`, AUTH_NOTICE_CODES[code] ?? 'auth.failed');
}

function errorRedirect(env: AuthEnv, options: CreateAuthConfigOptions | undefined, code: string): Response {
    return Response.redirect(errorPageUrl(env, options, code), 302);
}

/**
 * A redirect-based sign-in's outcome (OAuth, magic link): the destination with the session
 * cookie, the second-factor page with the pending cookie, or the provisioning error page.
 */
function redirectForOutcome(
    outcome: SignInOutcome,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    callbackUrl: string,
    extraCookies: string[] = [],
): Response {
    if (outcome.kind === 'failed') {
        const headers: Array<[string, string]> = [['Location', errorPageUrl(env, options, 'AccountProvisioning')]];
        for (const cookie of extraCookies) headers.push(['Set-Cookie', cookie]);
        return new Response(null, { status: 302, headers });
    }
    const location =
        outcome.kind === 'session'
            ? `${resolveFrontendUrl(env)}${callbackUrl}`
            : twoFactorPageUrl(env, options, callbackUrl);
    const headers: Array<[string, string]> = [
        ['Location', location],
        ['Set-Cookie', outcome.cookie],
    ];
    for (const cookie of extraCookies) headers.push(['Set-Cookie', cookie]);
    return new Response(null, { status: 302, headers });
}

/**
 * `user.created` for an account this handler just made (it has no workspace yet: the app's
 * sign-in hook provisions one), and `user.verified` too when it was created verified.
 */
async function announceNewUser(
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    user: { id: string; email: string; name: string | null; emailVerified: number | null },
    method: 'oauth' | 'magic-link',
): Promise<void> {
    const at = Date.now();
    const { id: userId, email, name } = user;
    await announce(env, options, 'user.created', { userId, email, name, organizationId: null, method, at });
    if (user.emailVerified) await announce(env, options, 'user.verified', { userId, email, at: user.emailVerified });
}

async function defaultCredentialsAuthorize(
    credentials: { email: string; password: string },
    env: AuthEnv,
    options?: CreateAuthConfigOptions,
): Promise<AuthorizedUser | null> {
    const email = typeof credentials.email === 'string' ? credentials.email.trim().toLowerCase() : '';
    const password = typeof credentials.password === 'string' ? credentials.password : '';
    const minLength = options?.minPasswordLength ?? 6;

    if (!email || !password || password.length < minLength) return null;
    if (!env.OBCF_D1) throw new Error('OBCF_D1 database binding is required for credentials authentication');

    ensureOrmConnection(env);
    const user = await User.first({ email });

    const passwordHash = (user?.get('passwordHash') as string | null) ?? null;

    // Equalize timing between "no such user / no password set" and "wrong password":
    // both paths run exactly one PBKDF2 derive, so response time does not reveal whether
    // an account exists (user-enumeration oracle).
    if (!user || !passwordHash) {
        await verifyPassword(password, await getDummyPasswordHash());
        return null;
    }

    const valid = await verifyPassword(password, passwordHash);
    if (!valid) return null;

    return authorizedUserFrom(user);
}

/** Resolve the effective options for a request, applying environment-derived defaults. */
function resolveOptions(env: AuthEnv, options?: CreateAuthConfigOptions): CreateAuthConfigOptions {
    const envDisableCredentials = env.AUTH_DISABLE_CREDENTIALS === 'true' || env.AUTH_DISABLE_CREDENTIALS === '1';
    const envRequireVerified = env.AUTH_REQUIRE_EMAIL_VERIFIED === 'true' || env.AUTH_REQUIRE_EMAIL_VERIFIED === '1';

    return {
        ...options,
        disableCredentials: options?.disableCredentials ?? envDisableCredentials,
        requireVerifiedEmail: options?.requireVerifiedEmail ?? envRequireVerified,
    };
}

async function handleCsrf(env: AuthEnv, request: Request): Promise<Response> {
    const secret = resolveAuthSecret(env);
    const { token, cookieValue } = await createCsrfCookiePair(secret);
    const cookie = serializeCookie(csrfCookieName(env), cookieValue, {
        maxAgeSeconds: CSRF_COOKIE_MAX_AGE,
        secure: resolveSecureCookie(env, request),
        sameSite: 'Lax',
        httpOnly: true,
    });
    return jsonResponse({ csrfToken: token }, 200, { 'Set-Cookie': cookie });
}

async function handleGetSession(request: Request, env: AuthEnv, options: CreateAuthConfigOptions): Promise<Response> {
    const session = await getSession(request, env, options);
    if (session?.user?.id && options.onSession) {
        try {
            await options.onSession({ userId: session.user.id, email: session.user.email ?? null });
        } catch {
            // The app's bookkeeping; the session read answers either way.
        }
    }
    return jsonResponse(session ?? null);
}

async function handleCredentialsCallback(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
): Promise<Response> {
    if (options.disableCredentials) {
        return errorResponse('Credentials sign-in is disabled', 403, { code: 'CREDENTIALS_DISABLED' });
    }

    const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; csrfToken?: string };

    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const user = options.authorize
        ? await options.authorize({ email, password })
        : await defaultCredentialsAuthorize({ email, password }, env, options);

    if (!user) {
        return errorResponse('Invalid email or password', 401, { code: 'INVALID_CREDENTIALS' });
    }

    if (options.requireVerifiedEmail && !user.emailVerified) {
        return errorResponse('Please verify your email before signing in', 401, { code: 'EMAIL_UNVERIFIED' });
    }

    return jsonForOutcome(await signInOrChallenge(user, env, request, options, 'password'));
}

async function handleOAuthSignIn(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    providerId: string,
): Promise<Response> {
    const provider = getConfiguredProvider(providerId, env);
    if (!provider) {
        return errorRedirect(env, options, 'OAuthSignin');
    }

    const url = new URL(request.url);
    const callbackUrl = sanitizeCallbackPath(url.searchParams.get('callbackUrl'));
    const state = randomToken(16);
    const { codeVerifier, codeChallenge } = await createPkcePair();

    const statePayload = { state, codeVerifier, callbackUrl, providerId, purpose: 'oauth-state' };
    const stateToken = await signJwt(statePayload, resolveAuthSecret(env), { expiresInSeconds: OAUTH_STATE_MAX_AGE });
    const stateCookie = serializeCookie(oauthStateCookieName(env), stateToken, {
        maxAgeSeconds: OAUTH_STATE_MAX_AGE,
        secure: resolveSecureCookie(env, request),
        sameSite: 'Lax',
        httpOnly: true,
        path: '/api/auth',
    });

    const redirectUri = `${resolveFrontendUrl(env)}/api/auth/callback/${providerId}`;
    const authorizationUrl = buildAuthorizationUrl(provider, { redirectUri, state, codeChallenge });

    return new Response(null, { status: 302, headers: { Location: authorizationUrl, 'Set-Cookie': stateCookie } });
}

/** Redirect to the error page and clear the OAuth-state cookie (cleaned up on every terminal path). */
function oauthErrorRedirect(
    env: AuthEnv,
    options: CreateAuthConfigOptions | undefined,
    code: string,
    request: Request,
): Response {
    const location = errorPageUrl(env, options, code);
    const clearState = clearCookie(oauthStateCookieName(env), {
        secure: resolveSecureCookie(env, request),
        path: '/api/auth',
    });
    return new Response(null, {
        status: 302,
        headers: [
            ['Location', location],
            ['Set-Cookie', clearState],
        ],
    });
}

async function handleOAuthCallback(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    providerId: string,
): Promise<Response> {
    const url = new URL(request.url);

    if (url.searchParams.get('error')) {
        return oauthErrorRedirect(env, options, 'OAuthSignin', request);
    }

    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const cookies = parseCookies(request.headers.get('Cookie'));
    const stateToken = cookies[oauthStateCookieName(env)];

    if (!code || !stateParam || !stateToken) {
        return oauthErrorRedirect(env, options, 'OAuthCallback', request);
    }

    const statePayload = await verifyJwt<{
        state: string;
        codeVerifier: string;
        callbackUrl: string;
        providerId: string;
        purpose?: string;
    }>(stateToken, resolveAuthSecret(env));

    if (
        !statePayload ||
        statePayload.purpose !== 'oauth-state' ||
        statePayload.state !== stateParam ||
        statePayload.providerId !== providerId
    ) {
        return oauthErrorRedirect(env, options, 'OAuthCallback', request);
    }

    const provider = getConfiguredProvider(providerId, env);
    if (!provider) {
        return oauthErrorRedirect(env, options, 'OAuthSignin', request);
    }

    let userId!: string;
    let userEmail!: string;
    let userName: string | null = null;
    let userImage: string | null = null;
    let emailVerifiedAt: number | null = null;

    try {
        const redirectUri = `${resolveFrontendUrl(env)}/api/auth/callback/${providerId}`;
        const tokens = await exchangeCodeForTokens(provider, {
            code,
            redirectUri,
            codeVerifier: statePayload.codeVerifier,
        });
        const profile = await fetchUserProfile(provider, tokens);

        if (!profile.email) {
            return oauthErrorRedirect(env, options, 'OAuthCallback', request);
        }

        const normalizedEmail = profile.email.trim().toLowerCase();

        ensureOrmConnection(env);

        const existingAccount = await Account.first({
            provider: providerId,
            providerAccountId: profile.providerAccountId,
        });

        if (existingAccount) {
            const user = await User.find(String(existingAccount.get('userId')));
            if (!user) return oauthErrorRedirect(env, options, 'OAuthCallback', request);
            userId = String(user.get('id'));
            userEmail = String(user.get('email'));
            userName = (user.get('name') as string | null) ?? null;
            userImage = user.imageUrl();
            emailVerifiedAt = user.get('emailVerified') ? new Date(user.get('emailVerified') as any).getTime() : null;
        } else {
            const existingUser = await User.first({ email: normalizedEmail });
            if (existingUser) {
                // An account already exists for this email but has never signed in with this
                // provider before. Do not silently link -- that would let anyone able to
                // register an OAuth identity with a matching (possibly unverified) email
                // hijack an existing account. Require the user to sign in with their
                // existing method first and link providers explicitly. The one opt-in exception
                // (`oauthClaimsUnclaimedUsers`): a row nobody has claimed yet (no password, no
                // linked sign-in, e.g. created for an email invite) whose email the provider verified.
                const existingUserId = String(existingUser.get('id'));
                const claimable =
                    options.oauthClaimsUnclaimedUsers === true &&
                    profile.emailVerified === true &&
                    !existingUser.get('passwordHash') &&
                    !(await Account.first({ userId: existingUserId }));
                if (!claimable) {
                    return oauthErrorRedirect(env, options, 'OAuthAccountNotLinked', request);
                }

                userId = existingUserId;
                userEmail = String(existingUser.get('email'));
                userName = (existingUser.get('name') as string | null) ?? profile.name;
                userImage = existingUser.imageUrl() ?? profile.image;
                // emailVerifiedAt stays null so the verified-email step below marks and announces it.
                await Account.create({
                    userId,
                    type: 'oauth',
                    provider: providerId,
                    providerAccountId: profile.providerAccountId,
                });
            } else {
                emailVerifiedAt = profile.emailVerified ? Date.now() : null;
                const newUser = await User.create({
                    email: normalizedEmail,
                    name: profile.name,
                    image: profile.image,
                    emailVerified: emailVerifiedAt,
                    ...requestLocaleDefaults(request, options?.supportedLanguages),
                });

                userId = String(newUser.get('id'));
                userEmail = normalizedEmail;
                userName = profile.name;
                userImage = profile.image;

                try {
                    // Identity link only. The provider tokens were used above to fetch the profile and
                    // are dropped here on purpose: nothing reads them back, so storing them would be a
                    // plaintext credential column with no consumer (see Account.schema.ts).
                    await Account.create({
                        userId,
                        type: 'oauth',
                        provider: providerId,
                        providerAccountId: profile.providerAccountId,
                    });
                } catch (accountError) {
                    // Roll back the just-created user so a failed Account insert does not leave an
                    // orphan user row -- which would otherwise trip the "existingUser but no account"
                    // branch above and lock this email into OAuthAccountNotLinked forever.
                    try {
                        await User.delete(userId);
                    } catch (cleanupError) {
                        console.error(
                            JSON.stringify({
                                event: 'auth_oauth_user_rollback_failed',
                                error: redactErrorForLog(cleanupError),
                            }),
                        );
                    }
                    throw accountError;
                }
                // Announced once the identity link holds: a rolled-back user never existed.
                await announceNewUser(
                    env,
                    options,
                    { id: userId, email: userEmail, name: userName, emailVerified: emailVerifiedAt },
                    'oauth',
                );
            }
        }

        // OAuth identity providers are trusted to have verified the user's email themselves --
        // but only when this OAuth sign-in itself actually asserts the email is verified. An
        // unverified provider email (e.g. GitHub falling back to an unverified primary/first
        // address) must not silently mark a pre-existing account as verified.
        if (!emailVerifiedAt && profile.emailVerified) {
            emailVerifiedAt = Date.now();
            await User.update(userId, { emailVerified: emailVerifiedAt });
            await announce(env, options, 'user.verified', { userId, email: userEmail, at: emailVerifiedAt });
        }
    } catch (error) {
        console.error(
            JSON.stringify({ event: 'auth_oauth_callback_failed', providerId, error: redactErrorForLog(error) }),
        );
        return oauthErrorRedirect(env, options, 'OAuthCallback', request);
    }

    // Honor the verified-email requirement for OAuth too: if the deployment requires a
    // verified email and this provider did not assert one, do not sign the user in.
    if (options.requireVerifiedEmail && !emailVerifiedAt) {
        return oauthErrorRedirect(env, options, 'Verification', request);
    }

    const clearState = clearCookie(oauthStateCookieName(env), {
        secure: resolveSecureCookie(env, request),
        path: '/api/auth',
    });
    const outcome = await signInOrChallenge(
        { id: userId, email: userEmail, name: userName, image: userImage, emailVerified: emailVerifiedAt },
        env,
        request,
        options,
        `oauth:${providerId}`,
    );
    return redirectForOutcome(outcome, env, options, sanitizeCallbackPath(statePayload.callbackUrl), [clearState]);
}

async function handleMagicLinkSend(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
        email?: string;
        csrfToken?: string;
        callbackUrl?: string;
    };

    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) {
        return errorResponse('A valid email is required', 400, { code: 'VALIDATION_ERROR' });
    }

    const sender = resolveMagicLinkSender(env);
    if (!sender) {
        return errorResponse('Magic link sign-in is not configured', 500, {
            code: 'MAGIC_LINK_UNAVAILABLE',
            exposure: 'public',
        });
    }

    ensureOrmConnection(env);
    const identifier = `login:${email}`;
    // The plaintext token goes only in the emailed link; the database stores just its
    // hash, so a DB read leak cannot be replayed to mint a session.
    const token = randomToken(32);
    const tokenHash = await hashToken(token);
    const expiresAtMs = Date.now() + MAGIC_LINK_MAX_AGE_SECONDS * 1000;

    // Invalidate any prior outstanding link for this email (one active link at a time).
    await VerificationToken.deleteByIdentifier(identifier).catch(() => {});
    await VerificationToken.create({ identifier, token: tokenHash, expires: expiresAtMs });

    const callbackUrl = sanitizeCallbackPath(body.callbackUrl);
    // Derive the link origin from the configured frontend URL, NOT the incoming Host
    // header, so a spoofed/forwarded Host cannot poison the emailed link.
    const verifyUrl = new URL('/api/auth/callback/email', resolveFrontendUrl(env));
    verifyUrl.searchParams.set('token', token);
    verifyUrl.searchParams.set('email', email);
    verifyUrl.searchParams.set('callbackUrl', callbackUrl);

    try {
        await sender.send({ identifier: email, url: verifyUrl.toString(), expires: new Date(expiresAtMs) });
    } catch (error) {
        // Don't leave a live token behind if the email never went out.
        await VerificationToken.deleteByIdentifierAndToken(identifier, tokenHash).catch(() => {});
        console.error(JSON.stringify({ event: 'auth_magic_link_send_failed', error: redactErrorForLog(error) }));
        return errorResponse('Failed to send magic link', 502, { code: 'MAGIC_LINK_SEND_FAILED', exposure: 'public' });
    }

    return jsonResponse({ success: true });
}

async function handleMagicLinkCallback(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || '';
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const callbackUrl = sanitizeCallbackPath(url.searchParams.get('callbackUrl'));

    if (!token || !email) {
        return errorRedirect(env, options, 'Verification');
    }

    ensureOrmConnection(env);
    const identifier = `login:${email}`;
    const tokenHash = await hashToken(token);
    // Atomic single-use consume: exactly one concurrent request can win the delete, so
    // the same link cannot be redeemed twice (double-spend race).
    const verification = await VerificationToken.consumeByIdentifierAndToken(identifier, tokenHash);

    if (!verification) {
        return errorRedirect(env, options, 'Verification');
    }

    const expiresAt = Number(verification.get('expires'));
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
        return errorRedirect(env, options, 'Verification');
    }

    // Redeeming the link proves the address: a new account is created verified, an unverified
    // one becomes verified now, and a verified one keeps its original time.
    const now = Date.now();
    let user = await User.first({ email });
    if (!user) {
        user = await User.create({
            email,
            name: null,
            emailVerified: now,
            ...requestLocaleDefaults(request, options?.supportedLanguages),
        });
        await announceNewUser(
            env,
            options,
            { id: String(user.get('id')), email, name: null, emailVerified: now },
            'magic-link',
        );
    } else if (!user.get('emailVerified')) {
        await User.update(String(user.get('id')), { emailVerified: now });
        await announce(env, options, 'user.verified', { userId: String(user.get('id')), email, at: now });
    }

    const outcome = await signInOrChallenge(
        {
            id: String(user.get('id')),
            email,
            name: (user.get('name') as string | null) ?? null,
            image: user.imageUrl(),
            emailVerified: Date.now(),
        },
        env,
        request,
        options,
        'magic-link',
    );
    return redirectForOutcome(outcome, env, options, callbackUrl);
}

async function handleSignOut(request: Request, env: AuthEnv, options: CreateAuthConfigOptions): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { csrfToken?: string };
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;

    const cookies = parseCookies(request.headers.get('Cookie'));
    const token = cookies[resolveSessionCookieName(env)];
    const payload = token ? await verifyJwt<SessionTokenPayload>(token, resolveAuthSecret(env)) : null;

    if (payload?.sub && payload.jti) {
        await revokeSession(payload.sub, payload.jti, env);
        try {
            await options.onSignOut?.(payload.sub);
        } catch (error) {
            console.warn(JSON.stringify({ event: 'auth_sign_out_hook_failed', error: redactErrorForLog(error) }));
        }
    }

    const cookie = buildClearSessionCookie(env, request);
    return jsonResponse({ success: true }, 200, { 'Set-Cookie': cookie });
}

/**
 * Handle every `/api/auth/*` request not already owned by the host app.
 * Covers: csrf, session, credentials + OAuth + magic-link + passkey sign-in, the second-factor
 * challenge, the signed-in person's factors (`/factors/*`), sign-out.
 */
async function routeAuthRequest(request: Request, env: AuthEnv, options?: CreateAuthConfigOptions): Promise<Response> {
    try {
        if (!env.OBCF_D1) {
            return errorResponse('OBCF_D1 database binding is required for authentication', 500, {
                code: 'CONFIG_ERROR',
            });
        }

        const resolvedOptions = resolveOptions(env, options);
        const url = new URL(request.url);
        const match = url.pathname.match(/\/api\/auth\/(.+)$/);
        const segments = (match?.[1] ?? '').split('/').filter(Boolean);
        const [action, param] = segments;

        if (action === 'csrf' && request.method === 'GET') {
            return await handleCsrf(env, request);
        }

        if (action === 'session' && request.method === 'GET') {
            return await handleGetSession(request, env, resolvedOptions);
        }

        // Passkey sign-in and the second-factor challenge, then the signed-in person's own factors.
        const factorResponse =
            (await handleSignInFactorRequest(request, env, resolvedOptions, segments)) ??
            (await handleFactorRequest(request, env, resolvedOptions, segments));
        if (factorResponse) return factorResponse;

        if (action === 'callback' && param === 'credentials' && request.method === 'POST') {
            return await handleCredentialsCallback(request, env, resolvedOptions);
        }

        if (action === 'callback' && param === 'email' && request.method === 'GET') {
            return await handleMagicLinkCallback(request, env, resolvedOptions);
        }

        if (action === 'callback' && param && request.method === 'GET') {
            return await handleOAuthCallback(request, env, resolvedOptions, param);
        }

        if (action === 'signin' && param === 'email' && request.method === 'POST') {
            return await handleMagicLinkSend(request, env, resolvedOptions);
        }

        if (action === 'signin' && param && request.method === 'GET') {
            return await handleOAuthSignIn(request, env, resolvedOptions, param);
        }

        if (action === 'signout' && request.method === 'POST') {
            return await handleSignOut(request, env, resolvedOptions);
        }

        return errorResponse('Not found', 404, { code: 'NOT_FOUND' });
    } catch (error) {
        // Every handler above is awaited, so a rejection lands here rather than escaping the router.
        console.error(JSON.stringify({ event: 'auth_request_failed', error: redactErrorForLog(error) }));
        return errorResponse('Authentication error', 500, { code: 'AUTH_ERROR' });
    }
}

/**
 * Route an auth request and prevent browsers, proxies, and CDNs from caching
 * session-bearing responses or redirects.
 */
export async function handleAuthRequest(
    request: Request,
    env: AuthEnv,
    options?: CreateAuthConfigOptions,
): Promise<Response> {
    const response = await routeAuthRequest(request, env, options);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store, private');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
