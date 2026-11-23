// ============================================================
// @ottabase/auth - Shared Type Definitions
// ============================================================

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { ProviderEnv } from './providers/types';

/** A normalized, authenticated user as embedded in a session. */
export interface SessionUser {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
    emailVerified?: number | null;
    organizationId?: string | null;
    roles?: string[];
    permissions?: string[];
    /**
     * True when the user is a PLATFORM administrator — derived server-side from a SYSTEM-scoped
     * `platform:admin`/'*:*' grant, never from a role name or an org-scoped grant. Drives the
     * platform-only sections of the admin UI; the server enforces the same boundary independently.
     */
    platformAdmin?: boolean;
    createdAt?: number | null;
    /** IANA zone the person formats dates in; null until set (the app fills it from the request on sign-up). */
    timezone?: string | null;
    /** BCP 47 tag (`en-GB`) for language and number/date formats; null until set. */
    locale?: string | null;
    /** Two-factor sign-in is on (a confirmed authenticator app or at least one passkey). */
    twoFactorEnabled?: boolean;
    /**
     * Epoch ms from which a policy of the ACTIVE organization requires two-factor of this person;
     * null when none does.
     */
    twoFactorRequiredFrom?: number | null;
    /**
     * A policy requires two-factor now and it is off. The session reaches `/api/auth/*` and
     * `/api/users/me` only (so the person can set it up, or switch to another organization) until
     * it is turned on.
     */
    twoFactorSetupRequired?: boolean;
    [key: string]: unknown;
}

/** The session shape returned by `getSession()` and `GET /api/auth/session`. */
export interface Session {
    user: SessionUser;
    /** Epoch milliseconds. */
    expires: number;
}

/** Claims embedded in the signed session JWT. */
export interface SessionTokenPayload extends Record<string, unknown> {
    /** Subject -- the user id. */
    sub: string;
    /** Session id, used as the KV revocation-registry key. */
    jti: string;
    email: string;
    name?: string | null;
    image?: string | null;
    emailVerified?: number | null;
    organizationId?: string | null;
    createdAt?: number | null;
    /** Mirrors the KV profile-version counter at the time the session was issued/refreshed. */
    profileVersion?: number;
    /** Session creation time in epoch MILLISECONDS. `iat` is only second-granular; `cms` is
     *  used for the bulk-revocation comparison so a session reissued in the same second as a
     *  revoke-all is not wrongly invalidated when its KV snapshot has not yet propagated. */
    cms?: number;
    /**
     * When the person last proved who they are, epoch ms: set only when a real sign-in completes
     * (a password and its second factor, a passkey, a magic link, OAuth, registration, the
     * first-run owner). A session reissued without one (the password-change reissue) copies the
     * old value, so it never refreshes the recent-sign-in window. Absent means "not recent".
     */
    authAt?: number;
    /** How the session signed in (`password`, `magic-link`, `oauth:<provider>`, `passkey`...). Immutable. */
    signInMethod?: string;
    iat?: number;
    exp?: number;
}

/** Cloudflare bindings + environment variables consumed by the auth backend. */
export interface AuthEnv extends ProviderEnv {
    AUTH_SECRET?: string;
    /**
     * Key the authenticator-app secrets are sealed under (else AUTH_SECRET). Rotating it makes
     * every enrolled authenticator app unreadable: those people sign in with a recovery code or a
     * passkey and set the app up again.
     */
    AUTH_FACTOR_KEY?: string;
    /** Explicit opt-in to the insecure built-in dev secret (only honored in a dev ENVIRONMENT). */
    AUTH_ALLOW_INSECURE_DEV_SECRET?: string;
    AUTH_URL?: string;
    AUTH_COOKIE_NAME?: string;
    ENVIRONMENT?: string;
    OBCF_D1?: D1Database;
    OBCF_KV?: KVNamespace;
    AUTH_DISABLE_CREDENTIALS?: string;
    AUTH_REQUIRE_EMAIL_VERIFIED?: string;
    AUTH_SESSION_MAX_AGE?: string;
    ALLOW_NULL_TENANT?: string;
    MULTI_TENANT_ENABLED?: string;
    APP_ID?: string;
}

/** A user object returned by a successful credentials `authorize` callback. */
export interface AuthorizedUser {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
    emailVerified?: number | null;
}

/** `user.created`: an account exists now. `organizationId` is null when its workspace comes at first sign-in. */
export interface UserCreatedEvent {
    userId: string;
    email: string;
    name: string | null;
    organizationId: string | null;
    method: 'credentials' | 'oauth' | 'magic-link' | 'sso';
    /** Epoch milliseconds. */
    at: number;
}

/** `user.verified`: an account's email went from unverified to verified (once per account). */
export interface UserVerifiedEvent {
    userId: string;
    email: string;
    /** Epoch milliseconds: the stored `emailVerified`. */
    at: number;
}

/**
 * `user.factor.changed`: a sign-in factor was added or removed. For the audit log and a security
 * email. `factor: 'all'` with `change: 'removed'` is an administrator's reset (`resetTwoFactor`).
 */
export interface UserFactorChangedEvent {
    userId: string;
    factor: 'totp' | 'passkey' | 'recovery-codes' | 'all';
    change: 'added' | 'removed' | 'regenerated';
    /** Epoch milliseconds. */
    at: number;
}

/** The bus events `@ottabase/auth` announces through `CreateAuthConfigOptions.emit`. */
export interface AuthEvents {
    'user.created': UserCreatedEvent;
    'user.verified': UserVerifiedEvent;
    'user.factor.changed': UserFactorChangedEvent;
}

/** What `secondFactorRequiredFrom` is asked about (the kernel's `SecondFactorPolicyInput`, same shape). */
export interface SecondFactorPolicyInput {
    userId: string;
    /** The session's active organization, or null when it has none. */
    organizationId: string | null;
    /** How the session signed in (`password`, `oauth:google`, `sso:<id>`...), or null. */
    signInMethod: string | null;
}

export interface CredentialsAuthorizeOptions {
    authorize?: (credentials: { email: string; password: string }) => Promise<AuthorizedUser | null>;
    /** Minimum password length accepted at the credentials endpoint (default: 6). */
    minPasswordLength?: number;
    requireVerifiedEmail?: boolean;
}

/** Options accepted by `handleAuthRequest` / `getSession`. */
export interface CreateAuthConfigOptions extends CredentialsAuthorizeOptions {
    sessionMaxAge?: number;
    disableCredentials?: boolean;
    /**
     * Let an OAuth sign-in take over an existing user with the same email, but only an unclaimed one
     * (no password, no linked sign-in) and only when the provider says the email is verified. For apps
     * that create users ahead of an email invite. Default false: an existing email gets
     * `OAuthAccountNotLinked`.
     */
    oauthClaimsUnclaimedUsers?: boolean;
    /** App path OAuth/magic-link failures redirect to, with `?notice=auth.<code>` appended (default: `/login`). */
    errorPage?: string;
    /**
     * Languages the app ships translations for (`['en', 'fr']`). A new account's `locale` is taken
     * from `Accept-Language` only when its language is in this list; omitted = any language.
     */
    supportedLanguages?: readonly string[];
    /**
     * Epoch ms from which this person must have two-factor sign-in on while working in
     * `organizationId` (the session's ACTIVE organization), or null when nothing requires it.
     * Read when a session snapshot is (re)built: bump the person's profile version when the answer
     * changes for them, or `bumpOrganizationVersion` once when it changes for a whole organization.
     * Once the date passes, a session without two-factor reaches `/api/auth/*` and `/api/users/me`
     * only. A throw fails the sign-in.
     */
    secondFactorRequiredFrom?: (env: AuthEnv, input: SecondFactorPolicyInput) => Promise<number | null>;
    /**
     * Name an authenticator app shows next to the code (`issuer` in the otpauth URI) and the
     * browser shows when a passkey is made. Default: AUTH_URL's host.
     */
    appName?: string;
    /** App path of the second-factor page OAuth and magic-link sign-ins redirect to (default: `/login/two-factor`). */
    twoFactorPage?: string;
    /** Called after a user signs out (session revoked). Use to clear app-level caches. */
    onSignOut?: (userId: string) => Promise<void> | void;
    /**
     * Called on every sign-in (credentials, magic link, OAuth) just before the session is issued.
     * A throw refuses the sign-in with `ACCOUNT_PROVISIONING_FAILED` / `?notice=auth.account-provisioning`,
     * so use it to finish an account (its workspace) and catch anything that is merely best-effort.
     */
    onSignIn?: (params: { userId: string; email?: string | null }) => Promise<void> | void;
    /**
     * Called when `GET /session` finds a signed-in user: the one request every page load makes, so
     * the place to note that an account is in use (sessions last weeks; sign-ins say little). Awaited,
     * so keep it cheap and throttle it; a throw is swallowed and never fails the session read.
     */
    onSession?: (params: { userId: string; email?: string | null }) => Promise<void> | void;
    /**
     * Announces `user.created` (an OAuth or magic-link account) and `user.verified` (an email
     * verified by OAuth or a magic link). Wire it to the app's event bus (README, "Account
     * events"). Best-effort: a throw is logged and never fails the sign-in.
     */
    emit?: <K extends keyof AuthEvents>(env: AuthEnv, name: K, payload: AuthEvents[K]) => Promise<void>;
}
