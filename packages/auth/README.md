# @ottabase/auth

Lightweight, dependency-free authentication for Ottabase apps on Cloudflare Workers + D1. Signed session cookies, PBKDF2
credentials, generic OAuth2/OIDC, magic-link email sign-in, passkeys and two-factor sign-in with an authenticator app,
all built on the Web Crypto API (`crypto.subtle`) that Workers implements natively. No Auth.js, no Node crypto, no
third-party crypto, JWT or WebAuthn library.

## Features

- **Signed session cookie** - Compact HS256 JWT (custom, minimal implementation) + a KV revocation registry, so normal
  sign-out revokes exactly one session immediately
- **PBKDF2-SHA256 passwords** - 100k iterations via `crypto.subtle`, no bcrypt/argon2 native bindings needed
- **CSRF protection** - Double-submit cookie for every state-changing endpoint
- **OAuth2 + PKCE** - One generic Authorization-Code client, five built-in presets: Google, GitHub, Discord, Azure AD,
  Auth0
- **Magic link sign-in** - Short-lived (15 min) passwordless email links, with dev-trap / SMTP / Resend senders
  auto-selected from env vars
- **Passkeys** - WebAuthn sign-in with the device's fingerprint, face or PIN (ES256, RS256, Ed25519)
- **Two-factor sign-in** - Authenticator-app codes (TOTP, RFC 6238) with recovery codes, asked for after every password,
  magic-link and OAuth sign-in; a package can make it mandatory for some people (an organization policy)
- **UI components** - Ready-to-use login/register forms built on `@ottabase/ui`
- **Framework-agnostic client** - Plain `fetch`-based client API and a Jotai-backed React hook

## Installation

```bash
pnpm add @ottabase/auth
```

## Quick Start

Mount the backend router for every `/api/auth/*` path your app doesn't already own:

```typescript
// worker entry point
import { handleAuthRequest } from '@ottabase/auth/backend';

export default {
    async fetch(request: Request, env: Env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/auth/')) {
            return handleAuthRequest(request, env);
        }
        return new Response('OK');
    },
};
```

Read the session anywhere else in the worker:

```typescript
import { getSession } from '@ottabase/auth/backend';

const session = await getSession(request, env);
// session: { user: { id, email, name, image, emailVerified, organizationId, roles, permissions, createdAt }, expires } | null
```

## Route Table

`handleAuthRequest(request, env, options?)` is a small router covering every `/api/auth/*` sub-path that the package
owns. Everything else stays in the host app.

### Owned by `@ottabase/auth` (via `handleAuthRequest`)

| Route                                  | Method  | Description                                                                 |
| -------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `/api/auth/csrf`                       | GET     | Sets the CSRF cookie, returns `{ csrfToken }`                               |
| `/api/auth/session`                    | GET     | Returns the current `Session` or `null`                                     |
| `/api/auth/callback/credentials`       | POST    | `{ email, password, csrfToken }` → `{ success, session }` or `{ error }`    |
| `/api/auth/signin/:provider`           | GET     | `?callbackUrl=` → 302 redirect to the OAuth provider                        |
| `/api/auth/callback/:provider`         | GET     | Exchanges the OAuth code, creates a session, redirects to `callbackUrl`     |
| `/api/auth/signin/email`               | POST    | `{ email, csrfToken, callbackUrl }` → sends a magic link                    |
| `/api/auth/callback/email`             | GET     | Verifies the magic-link token, creates a session, redirects                 |
| `/api/auth/signout`                    | POST    | `{ csrfToken }` → revokes the current session only, clears the cookie       |
| `/api/auth/passkey/options`            | POST    | Sign-in options for a passkey (a single-use challenge)                      |
| `/api/auth/callback/passkey`           | POST    | `{ credential, csrfToken }` → `{ success, session }`                        |
| `/api/auth/two-factor/challenge`       | GET     | `{ pending, methods? }`: is a sign-in waiting, and which ways can finish it |
| `/api/auth/two-factor/challenge`       | POST    | `{ code }` or `{ recoveryCode }` or `{ passkey }` → `{ success, session }`  |
| `/api/auth/two-factor/passkey-options` | POST    | Options to finish a waiting sign-in with a passkey                          |
| `/api/auth/factors/*`                  | various | The signed-in person's authenticator app and passkeys (below)               |

With an authenticator app on the account, the credentials callback answers
`200 { success: false, twoFactorRequired: true }` and sets a pending cookie instead of the session; OAuth and magic-link
callbacks redirect to the second-factor page (`twoFactorPage`, default `/login/two-factor`) instead of `callbackUrl`.
See "Two-factor sign-in and passkeys".

`callbackUrl` must be a relative path (`/profile`). A missing or off-site one falls back to `/`, which is also where the
client helpers send the user when `redirectTo` is omitted.

### Owned by the host app (not part of this package)

These routes live in the app and call `hashPassword` / `verifyPassword` / `getSession` / `revokeAllUserSessions` from
`@ottabase/auth/backend` directly:

| Route                              | Method    |
| ---------------------------------- | --------- |
| `/api/auth/register`               | POST      |
| `/api/auth/verify-email`           | GET       |
| `/api/auth/verify-email/resend`    | POST      |
| `/api/auth/password/reset/request` | POST      |
| `/api/auth/password/reset/confirm` | POST      |
| `/api/auth/password/change`        | POST      |
| `/api/auth/config`                 | GET       |
| `/api/users/me`                    | GET/PATCH |

Register signs the new account in itself when no email verification is required: it checks the CSRF token with
`requireCsrf(request, env, body.csrfToken)` and finishes with `completeSignIn(user, env, request, options)`, the same
tail the credentials callback runs (first-user bootstrap, `onSignIn`, the session cookie stamped with `authAt` = now).
`completeSignIn` returns `{ cookie, session }`, or null when the account could not be finished; answer 500 and set no
cookie then. Its optional fifth argument names the sign-in (`{ signInMethod: 'register' }`), stored on the session.

```typescript
import { completeSignIn, requireCsrf } from '@ottabase/auth/backend';

const rejected = await requireCsrf(request, env, body.csrfToken);
if (rejected) return rejected;
// ... create the user ...
const signedIn = await completeSignIn({ id, email, name, image: null, emailVerified: null }, env, request, options, {
    signInMethod: 'register',
});
if (!signedIn) return errorResponse('Account created, but signing in failed', 500);
return jsonResponse({ success: true, session: signedIn.session }, 200, { headers: { 'Set-Cookie': signedIn.cookie } });
```

### Bot checks on the public forms

The package does no bot checking itself; the host app wraps the routes. In otta-web every anonymous form passes
Cloudflare Turnstile after its rate limit (`apps/otta-web/worker/lib/turnstile.ts`), and the three that mail an address
answer once per address per minute:

| Form                   | Route                                   | Action           | Cloudflare unreachable | Mail cooldown |
| ---------------------- | --------------------------------------- | ---------------- | ---------------------- | ------------- |
| Password sign-in       | `POST /api/auth/callback/credentials`   | `signin`         | let through            |               |
| Magic link             | `POST /api/auth/signin/email`           | `signin`         | refused                | yes           |
| Register               | `POST /api/auth/register`               | `register`       | refused                |               |
| Password reset request | `POST /api/auth/password/reset/request` | `password-reset` | refused                | yes           |
| Verification resend    | `POST /api/auth/verify-email/resend`    | `verify-resend`  | refused                | yes           |

A signed-in verification resend (the profile page) skips Turnstile. During a cooldown the route answers exactly as if it
had sent. The browser side is the `headers` option of the client calls and the `botCheck` slot of the components
(below).

## First-user provisioning

`bootstrapFirstUser()` runs before credentials, OAuth, or magic-link session issuance. Exactly one user can atomically
claim the system-scoped `platform_owner` grant. With `MULTI_TENANT_ENABLED` enabled (the default), that owner must also
have an active organization membership and its matching org-scoped `owner` grant. The organization, membership, and
owner grant are written in one transactional D1 batch.

Critical provisioning failures are fail-closed: no session is issued, the platform-owner claim remains bound to its
original user, and the error is surfaced to the sign-in flow. If a request stops after committing the system claim, the
same owner's next sign-in repairs the missing organization; another user cannot take over that claim. Set
`MULTI_TENANT_ENABLED=false` only when the deployment intentionally does not require a personal organization.

Everyone after the first user is the app's to finish, through `onSignIn`. It runs on every credentials, OAuth and
magic-link sign-in, after `bootstrapFirstUser()` and before the session is issued. A throw refuses the sign-in the same
way: credentials answer 500 `ACCOUNT_PROVISIONING_FAILED`, OAuth and magic links redirect to the error page with
`?notice=auth.account-provisioning`, and no session cookie is set. Catch anything in the hook that is only best-effort.

```typescript
const options: CreateAuthConfigOptions = {
    onSignIn: async ({ userId, email }) => {
        await ensureWorkspace(userId, email); // throws: the sign-in is refused
    },
};
```

A session lasts weeks, so sign-ins say little about who still uses the app. `onSession({ userId, email })` is called
when `GET /session` (the request every page load makes) finds a signed-in user. It is awaited, so keep it cheap and
throttle it; a throw is swallowed and never fails the session read. otta-web uses it to emit
`user.seen { userId, email }` on its bus at most once an hour per account per isolate.

## Account events

The handler announces the accounts it creates and verifies through `emit`, which the app wires to its event bus (the
package never imports one). A throw from `emit` is logged and never fails the sign-in.

| Event                 | Payload (`UserCreatedEvent`, `UserVerifiedEvent`)            | When                                                                                                                              |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `user.created`        | `{ userId, email, name, organizationId: null, method, at }`  | An OAuth first sign-in (`method: 'oauth'`, after the identity link) or a magic link that creates the account (`'magic-link'`)     |
| `user.verified`       | `{ userId, email, at }` (`at` is the stored `emailVerified`) | `emailVerified` goes from null to a time: an account created verified, a magic link, an OAuth provider that vouches for the email |
| `user.factor.changed` | `{ userId, factor, change, at }` (`UserFactorChangedEvent`)  | An authenticator app or passkey added or removed, recovery codes regenerated or one used: for an audit trail or a security email  |

`organizationId` is null because the workspace comes later, from `onSignIn`. Accounts the host app creates itself
(credentials sign-up, a bootstrap owner, Pro SSO) and its own verify-email route emit the same events from the app, with
`method` `credentials` or `sso`.

```typescript
import type { CreateAuthConfigOptions } from '@ottabase/auth/backend';
import { events } from '../ottabase/events'; // the app's bus

export function authOptions(env: CloudflareEnv): CreateAuthConfigOptions {
    return {
        // name: 'user.created' | 'user.verified' (AuthEvents)
        emit: async (_env, name, payload) => {
            await events.emit(env, name, payload);
        },
    };
}
```

otta-web wires it in `getAuthOptions` (`worker/lib/auth-utils.ts`) through `emitAccountEvent`, which also sets the
event's actor and swallows a bus failure.

## Two-factor sign-in and passkeys

Both live in one table, `authenticators` (core, from `@ottabase/ottaorm`: list `authenticatorsTable` with the core
tables and `Authenticator` with the core models). Generic CRUD never serves it.

**Two-factor is on** when the person has a confirmed authenticator app OR at least one passkey
(`Authenticator.hasTwoFactor`, `withTwoFactor` for a roster). A policy is satisfied by either.

**One gate.** Password, magic-link and OAuth sign-ins all end in `signInOrChallenge` (`src/sign-in.ts`). An account with
two-factor on gets a 10-minute pending cookie (`ottabase.<APP_ID>.second-factor`, `Path=/api/auth`) instead of a
session: the password callback answers 200 `{ twoFactorRequired: true, code: 'SECOND_FACTOR_REQUIRED' }`, OAuth and
magic links redirect to `/login/two-factor`. `POST /two-factor/challenge` issues the session once a code (if the app is
on), one of the person's passkeys (if any) or a recovery code checks out; `GET /two-factor/challenge` says which
(`{ pending, methods: { totp, passkey, recoveryCode } }`). A passkey sign-in with user verification is two factors
already and never gets the challenge. Sessions minted outside a sign-in (the password-change reissue, SSO through an
identity provider, which owns its MFA) are not challenged.

**Sign-in time and method.** Every session a sign-in issues carries `authAt` (when the person proved who they are) and
`signInMethod` (`password`, `magic-link`, `oauth:<provider>`, `passkey`, `register`, `owner`, `sso:<connectionId>`...),
both immutable. A host minting a session itself passes them to `createSessionCookieForUser` (`authAt: Date.now()` for a
sign-in; the old session's values, from `readSessionIdentity`, for a reissue). Without `authAt` a session is never a
recent sign-in.

**Authenticator app (TOTP).** RFC 6238, SHA-1, six digits, 30 seconds, one step of drift either way, one app per person.
The secret is sealed with AES-GCM under `AUTH_FACTOR_KEY` (else `AUTH_SECRET`); each accepted step is stored, so a code
works once. If the key changes, the app cannot be read: the challenge answers 409 `AUTHENTICATOR_UNREADABLE` (not
counted as a guess) and the person uses a recovery code or a passkey, then sets the app up again.

**Recovery codes.** Ten, `xxxx-xxxx-xxxx-xxxx` (80 bits each), handed out when two-factor first turns on: the TOTP
confirm or the first passkey answers with `recoveryCodes`. Shown once, stored as SHA-256 hashes in
`verification_tokens`, single-use, regenerable, deleted when the last factor goes. A recovery code spent on a sign-in
that then fails (the app's `onSignIn` threw) is put back.

**Attempt limits.** Every code and recovery code is counted BEFORE it is checked, as a row in `verification_tokens`
inserted then counted (`VerificationToken.recordAttempts`), so parallel guesses cannot all slip under the limit: more
than five against one pending sign-in, or more than thirty against the account in an hour, answers 429
`TOO_MANY_ATTEMPTS` unchecked. Success clears both. A passkey is never counted or blocked, so a person locked out of
codes can still finish with one. The TOTP setup confirm counts against the account limit too.

**A session confined until two-factor is on is not signed out.** Off `/api/auth/*` and `/api/users/me` (where the person
can switch to another organization) it gets 401s; otta-web marks those `X-Session-Ended: two-factor-setup` (from
`sessionRefusal`, else `isTwoFactorSetupPending`) so its API client keeps the session and the app stays on `/security`
instead of sending the person to the login page.

**Passkeys.** WebAuthn with attestation `none`: ES256, RS256 and Ed25519 keys kept as JWKs, user verification required
at registration and sign-in, discoverable credentials, a signature counter that only moves forward (also between two
racing assertions). At the challenge, a passkey of anyone else is refused before its counter is touched. The relying
party is the host of `AUTH_URL` and the origin its origin, never the request's. Browsers refuse an IP address as a
relying party, so passkeys need the app at a domain over https, or at `localhost` in development
(`AUTH_URL=http://localhost:3003`, not `127.0.0.1`); `passkeysAvailable(env)` says which, and the login config carries
it.

**Changing factors needs a recent sign-in.** Every write under `/factors` requires `authAt` under 15 minutes old
(`RECENT_SIGN_IN_MS`), else `403 REAUTH_REQUIRED`: a stolen cookie cannot add its own passkey or remove the app, and a
password change does not reopen the window. `requireRecentSignIn(request, env, options)` gives a host route the same
check (null, or the 401/403 to send). Removing the last factor while the active organization's policy applies is 409
`TWO_FACTOR_REQUIRED`.

| Route                                | Method        | Body / answer                                                                                                                                                   |
| ------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/factors`                  | GET           | `{ twoFactor: { enabled, totp, totpPending, passkeys, recoveryCodesLeft, requiredFrom }, passkeys: [...], passkeysAvailable, recentSignIn, recentSignInUntil }` |
| `/api/auth/factors/totp`             | POST          | `{ secret, uri }` (show `uri` as a QR code)                                                                                                                     |
| `/api/auth/factors/totp/confirm`     | POST          | `{ code }` to `{ success, recoveryCodes? }` (codes only when two-factor just turned on)                                                                         |
| `/api/auth/factors/totp`             | DELETE        | removes the app; the recovery codes go too when it was the last factor                                                                                          |
| `/api/auth/factors/recovery-codes`   | POST          | a fresh `{ success, recoveryCodes }`                                                                                                                            |
| `/api/auth/factors/passkeys/options` | POST          | creation options for `navigator.credentials.create`                                                                                                             |
| `/api/auth/factors/passkeys`         | POST          | `{ credential, name }` to `{ success, passkey, recoveryCodes? }`                                                                                                |
| `/api/auth/factors/passkeys/:id`     | PATCH, DELETE | `{ name }` / remove (the caller's own only)                                                                                                                     |

Every failure is an `errorResponse` with a stable `code`:

| Code                          | Status  | When                                                                                   |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `SECOND_FACTOR_EXPIRED`       | 401     | no pending sign-in (challenge, its passkey options)                                    |
| `SECOND_FACTOR_INVALID`       | 401     | a wrong code or recovery code, at the challenge or the setup confirm                   |
| `TOO_MANY_ATTEMPTS`           | 429     | over an attempt limit                                                                  |
| `AUTHENTICATOR_UNREADABLE`    | 409     | the app's secret cannot be opened (the sealing key changed)                            |
| `REAUTH_REQUIRED`             | 403     | a factor change without a recent sign-in                                               |
| `TWO_FACTOR_REQUIRED`         | 409     | removing the last factor while a policy applies                                        |
| `PASSKEYS_UNAVAILABLE`        | 400     | the app's address cannot have passkeys                                                 |
| `PASSKEY_REFUSED`             | 401/400 | a passkey that does not check out (sign-in, challenge) / cannot be added               |
| `PASSKEY_EXISTS`              | 409     | that passkey is already added                                                          |
| `ALREADY_ENABLED`             | 409     | an authenticator app is already set up                                                 |
| `NO_PENDING_SETUP`            | 409     | confirm without a started setup                                                        |
| `NOT_ENABLED`                 | 409     | recovery codes asked for while two-factor is off                                       |
| `NOT_FOUND`                   | 404     | no such passkey (of the caller's), no app to remove, no passkey on the pending account |
| `VALIDATION_ERROR`            | 400     | a missing name or proof                                                                |
| `UNAUTHORIZED`                | 401     | no session                                                                             |
| `EMAIL_UNVERIFIED`            | 401     | `requireVerifiedEmail` and the email is not verified                                   |
| `ACCOUNT_PROVISIONING_FAILED` | 500     | the account could not be finished (opaque message, stable code)                        |

The browser side is in `@ottabase/auth/client`: `signInWithPasskey`, `getTwoFactorChallenge`, `submitTwoFactor`,
`getFactors`, `startTotpSetup`, `confirmTotpSetup`, `disableTotp`, `regenerateRecoveryCodes`, `addPasskey`,
`renamePasskey`, `removePasskey`, `isPasskeySupported`. otta-web's pages are `/login/two-factor` and `/security`. Every
call resolves, never throws: a failure is `{ success: false, error, code }`, and no response at all is
`code: 'NETWORK_ERROR'` (for `getTwoFactorChallenge`, an `error` beside `pending: false`, so a page can tell "offline"
from "expired"). A passkey ceremony the person closed comes back as `{ cancelled: true }` with nothing to show; a
refusal by the browser, a timeout, or `InvalidStateError` on create (the device already has a passkey here) comes back
with an `error` (`isPasskeyCancelled` holds the rule). `addPasskey()` names the passkey for the browser and device
(`defaultPasskeyName()`, for example "Safari on iPhone") unless given a name, and returns `recoveryCodes` when that
first passkey turned two-factor on.

In React, `useFactors()` from `@ottabase/auth/react` reads `GET /factors` on mount and returns
`{ data, error, pending, reload }`; call `reload()` after each change.

```typescript
import { signInWithCredentials } from '@ottabase/auth/client';

const result = await signInWithCredentials({ email, password });
if (result.twoFactorRequired) navigate({ to: '/login/two-factor', search: { callbackUrl: '/dashboard' } });
```

**Resetting it for someone else.** `resetTwoFactor(userId, env, options)` from `@ottabase/auth/backend` removes ALL of a
person's factors (authenticator app, passkeys, recovery codes), refreshes their sessions and announces
`user.factor.changed { factor: 'all', change: 'removed' }`, for an administrator helping a member who lost their device.
It checks nothing: the caller decides who may do it, and should hold its own request to `requireRecentSignIn`.

**Requiring it.** `secondFactorRequiredFrom(env, { userId, organizationId, signInMethod })` returns the time from which
a person must have two-factor on while working in `organizationId`, the session's ACTIVE organization (or null), so a
policy of one organization never confines someone working in another. It is read when the session snapshot is built.
When the answer changes for one person, bump their profile version (`bumpProfileVersion`); when it changes for a whole
organization, call `bumpOrganizationVersion(organizationId, env)` once, and every live session in it re-reads its
snapshot on its next request. Once the time passes, `getSession` returns null for that session everywhere except
`/api/auth/*` and `/api/users/me`, and the session read carries `twoFactorSetupRequired: true` so the app shows its
setup page. A throw fails the sign-in closed; a failed refresh keeps the previous snapshot. Apps built on Ottabase wire
it from the package registry (`auth.secondFactorRequiredFrom` on a manifest), so an organization policy package needs no
auth code.

## Session Model

The session cookie (`ottabase.<APP_ID>.session-token` by default, `ottabase.session-token` without `APP_ID`, overridable
via `AUTH_COOKIE_NAME`) is a signed, self-contained JWT carrying only **identity** claims: `sub`, `jti`, `email`,
`name`, `image`, `emailVerified`, `organizationId`, `createdAt`, `cms` (creation time in ms), `authAt` (last real
sign-in in ms, absent for a session minted without one), `signInMethod`, `profileVersion`, `iat`, `exp`. The potentially
large / frequently-changing **authorization snapshot** (`roles`, `permissions`) is deliberately kept **out of the
cookie** and stored in the per-session KV registry record instead, so the cookie can never approach the ~4KB browser
limit no matter how many permissions a user has, and revoked roles don't linger in a signed token for the session's
whole lifetime. `getSession()` merges the identity claims with the snapshot into the returned `user`.

In production the cookie is `Secure` and uses the `__Host-` name prefix (pinned to the host, `Path=/`, no `Domain`) so
it can't be tossed/shadowed by a sibling subdomain; in an explicit dev environment over plain HTTP the prefix and
`Secure` are dropped so local development still works.

Verifying a request is the JWT signature/expiry check plus **one parallel batch of KV reads** (bulk-revocation marker,
per-session sign-out tombstone, registry snapshot, the profile-version counter, and the version counter of the
organization the session was issued in; a session that has switched organization since reads its current one's with one
more KV read). There's no database read on the hot path unless a profile-version or organization-version bump flags the
snapshot stale (refreshed once from D1, then the registry record is rewritten so later requests skip the read) or a
freshly-issued session's registry record hasn't propagated yet (see the grace window below; without D1 such a session is
refused, since there is no snapshot to judge it by).

**`OBCF_KV` is required.** Session verification consults KV on every request and fails _closed_: if `OBCF_KV` isn't
bound, or a KV read errors, `getSession` returns `null` rather than trusting an unverifiable token. Deploying without
`OBCF_KV` bound means no one can stay signed in.

Revocation is a **deny-list**, which is the correct primitive under KV's eventual consistency:

- **Single-session revocation** (normal sign-out) writes a per-session tombstone `auth:usr:<userId>:revoked-jti:<jti>`
  and drops the registry snapshot. The tombstone is honored on every request (even inside the grace window), so sign-out
  wins.
- **All-sessions revocation** (password change/reset) writes a bulk `auth:usr:<userId>:revoked` key with a "revoked
  since &lt;ms&gt;" value; any session created strictly _before_ that millisecond is rejected. Millisecond granularity +
  the strict comparison mean a session reissued in the same second as a revoke-all (e.g. staying signed in after a
  password change) is **not** wrongly killed.

**KV eventual-consistency grace window:** the per-session registry snapshot is written at one colo at sign-in; a request
landing on another colo before it propagates would otherwise be rejected. Within a short issued-at grace window (~120s)
a _missing_ registry record is tolerated and self-healed from D1, so a just-signed-in user is never bounced. Both
deny-list checks still apply inside the window, so this never weakens revocation.

```typescript
import { revokeSession, revokeAllUserSessions } from '@ottabase/auth/backend';

// Sign-out: revoke just this session (handleAuthRequest does this automatically on POST /api/auth/signout)
await revokeSession(userId, jti, env);

// Password change/reset: invalidate every session for the user
await revokeAllUserSessions(userId, env);
```

Pure, I/O-free helpers for reading a `Session` are in `@ottabase/auth/session`:

```typescript
import { isAuthenticated, requireAuth, getUserId, getUserEmail, hasVerifiedEmail } from '@ottabase/auth/session';

const session = await getSession(request, env);
if (isAuthenticated(session)) {
    console.log(session.user.id);
}

const required = requireAuth(session); // throws if not authenticated
const userId = getUserId(session); // string | null
const verified = hasVerifiedEmail(session); // boolean
```

### The user's own sessions

Every registry record carries KV **key metadata** (under 1 KB, returned by `list()` without a read): created and expiry
times, a device summary (`Chrome on Windows`), a masked IP (`203.0.113.x`), `City, CC` from Cloudflare's geolocation and
an optional name. `createSessionCookieForUser` fills the device facts from the request; `createSessionForUser` takes
them as `input.device`. Rewrites of the record (a profile-version refresh, the grace-window self-heal) carry the
metadata along.

```typescript
import {
    listUserSessions,
    readSessionIdentity,
    renameUserSession,
    revokeOtherUserSessions,
    revokeUserSessionById,
} from '@ottabase/auth/backend';

const me = await readSessionIdentity(request, env); // { userId, jti, createdMs, authAt, signInMethod }, no KV read
const sessions = await listUserSessions(me.userId, env, me.jti); // newest first, `current` marked
await renameUserSession(me.userId, sessions[0].id, 'Work laptop', env);
await revokeUserSessionById(me.userId, sessions[1].id, env);
await revokeOtherUserSessions(me.userId, me.jti, env); // tombstones every other jti; the current one survives
```

Sessions are addressed by an **opaque id**, an HMAC of the jti under `AUTH_SECRET`. The helpers map it back by listing
the caller's own keys, so a request can never reach another user's session; raw jtis never leave the server. KV `list`
is eventually consistent (about a minute), so a just-opened session may be missing briefly. Expired records vanish
through their TTL, so there is no "expired" state to show. There is no "last active" (a write per request).

`describeUserAgent`, `maskIp` and `describeRequestDevice` are exported for other surfaces that show device facts.

`purgeUserSessions(userId, env)` signs the user out everywhere and deletes every session record, device facts included:
what an erasure needs, since a "revoked since" marker alone leaves the records until their TTL.

`wasSessionRevoked(request, env)` answers why a request with a validly signed cookie failed: true when its jti was
tombstoned (revoked from another session) or it predates a "revoked since" marker (password change). Call it only on a
request that already failed authentication; it costs two KV reads. Cheaper first: `sessionRefusal(request)` returns what
`getSession` already concluded about that same `Request` object (`'revoked'`, `'two-factor-setup'`, null for no reason
worth telling, `undefined` when `getSession` never saw it), so a 401 handler probes only on `undefined`.

### Locale and timezone defaults for new accounts

`requestLocaleDefaults(request, supportedLanguages?)` reads Cloudflare's `request.cf.timezone` and the best
`Accept-Language` tag (restricted to the languages the app ships when a list is given). The OAuth and magic-link
handlers apply it on `User.create`; pass `supportedLanguages` in `CreateAuthConfigOptions`. The session snapshot and
`SessionUser` carry `timezone` and `locale`, so emails, digests and cron can format for the person without a D1 read.

## Password Hashing

`hashPassword` / `verifyPassword` (from `@ottabase/auth/backend`) use PBKDF2-SHA256 with 100,000 iterations via
`crypto.subtle`. Stored format: `pbkdf2$iterations$saltBase64$hashBase64`.

```typescript
import { hashPassword, verifyPassword } from '@ottabase/auth/backend';

const passwordHash = await hashPassword(password);
const valid = await verifyPassword(password, passwordHash);
```

## CSRF Protection

CSRF uses a double-submit cookie. `GET /api/auth/csrf` sets an HttpOnly cookie (`ottabase.<APP_ID>.csrf-token`,
`__Host-` prefixed in production) containing `token.hmac(token)` and returns the plain `token` in the JSON body.
State-changing endpoints (credentials sign-in, magic-link send, sign-out, and the app's register route) require the
client to echo that token back in the request body; the server re-derives the HMAC from the cookie and compares. As
defense-in-depth the server also rejects any request whose `Origin` header is present but not in the allowlist
(same-origin or the configured `AUTH_URL`), so a cross-site request is refused even before the token check. The two
failures answer 403 with different errors: `Untrusted origin <origin>: …` for the Origin (locally, usually `localhost`
against an `AUTH_URL` on `127.0.0.1`, which the browser treats as another site) and `Invalid or missing CSRF token` for
the token. The client API handles the token automatically:

```typescript
import { getCsrfToken, signInWithCredentials } from '@ottabase/auth/client';

const csrfToken = await getCsrfToken(); // also called internally by signInWithCredentials/sendMagicLink/registerWithCredentials/signOut
await signInWithCredentials({ email, password });
```

## OAuth Providers

One generic OAuth2 Authorization-Code + PKCE (S256) client (`src/providers/oauth-client.ts`) drives all five presets;
each preset is just endpoint/scope/claim-mapping data. Providers are enabled purely by which env vars are set —
`autoConfigureProviders(env)` returns every configured provider, `getConfiguredProvider(id, env)` looks up one by id
(used internally by `handleAuthRequest`).

### Enabling a provider (Google & GitHub in 3 steps)

Enabling OAuth is **env-var only — no code changes**. The login page auto-renders a button for every provider whose
credentials are present (`getLoginConfig` / `GET /api/auth/config` detect them).

1. **Create an OAuth app** in the provider's console and copy its client id + secret:
    - **Google** — Google Cloud Console → APIs & Services → Credentials → _OAuth client ID_ (Web application).
    - **GitHub** — Settings → Developer settings → OAuth Apps → _New OAuth App_.
2. **Set the callback / redirect URI** in that console (must match exactly, including scheme + host):
    ```
    https://your-domain.com/api/auth/callback/google     # or /github, /discord, /azure-ad, /auth0
    ```
    Also set `AUTH_URL` (your public origin, used to build this redirect URI) and `AUTH_SECRET`.
3. **Set the credential env vars** (Cloudflare secrets / `.dev.vars`) — the button then appears automatically:
    ```
    GOOGLE_CLIENT_ID=...      GOOGLE_CLIENT_SECRET=...
    GITHUB_CLIENT_ID=...      GITHUB_CLIENT_SECRET=...
    ```

Sign-in (`GET /api/auth/signin/google`) and the callback are handled by `handleAuthRequest`; from the client call
`signInWithProvider('google')`. The per-provider env vars and ids are listed below.

For every provider, register this redirect URI with the provider:

```
https://your-domain.com/api/auth/callback/<provider>
```

| Provider | id         | Required env vars                                                    |
| -------- | ---------- | -------------------------------------------------------------------- |
| Google   | `google`   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                           |
| GitHub   | `github`   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                           |
| Discord  | `discord`  | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`                         |
| Azure AD | `azure-ad` | `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID` |
| Auth0    | `auth0`    | `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_ISSUER`             |

Starting sign-in and handling the callback are both handled by `handleAuthRequest`:

```
GET /api/auth/signin/google?callbackUrl=/dashboard   -> 302 to Google
GET /api/auth/callback/google?code=...&state=...     -> creates session, 302 to callbackUrl
```

From the client:

```typescript
import { signInWithProvider } from '@ottabase/auth/client';

await signInWithProvider('google', { redirectTo: '/dashboard' });
```

`autoConfigureProviders` / `getConfiguredProvider` are exported from `@ottabase/auth/providers` (or the package root) if
you need to introspect configured providers yourself:

```typescript
import { autoConfigureProviders } from '@ottabase/auth/providers';

const providers = autoConfigureProviders(env); // OAuthProviderConfig[]
```

On first sign-in, an OAuth account is only linked to an **existing** user if that user already signed in via the same
provider before; if the email matches an existing account that has never used this provider, the callback fails with
`OAuthAccountNotLinked` rather than silently linking (this would otherwise let anyone claim an OAuth identity with a
matching email hijack an existing account).

The one opt-in exception is `oauthClaimsUnclaimedUsers: true` (in `CreateAuthConfigOptions`; apps set it from
`features.authBehavior.oauthClaimsUnclaimedUsers`). It is for apps that create a user row ahead of an email invite: an
OAuth sign-in may take over that row when nobody has claimed it yet (no password, no linked sign-in) **and** the
provider says the email is verified. Anything else still gets `OAuthAccountNotLinked`.

The `accounts` row created on first sign-in is an **identity link only** (`provider` + `providerAccountId` → `userId`).
The provider's access, refresh and id tokens are used once, to fetch the profile during the callback, and are **not
persisted** — nothing in the framework reads them back, so storing them would be a plaintext credential column with no
consumer. For the same reason the presets request identity scopes only — Google asks for no offline access and does not
force the consent screen.

**Login and data access are separate.** Sign-in proves who the user is and nothing more. An app that reads provider data
on the user's behalf (for example Gmail for an analytics feature) adds a separate "connect" flow with its own scopes,
consent and encrypted token storage. It never widens sign-in scopes, so users who never use that feature never see its
consent screen.

## Magic Link (Passwordless Email)

`POST /api/auth/signin/email` sends a short-lived (15 minute) sign-in link, distinct from the app's own 24-hour
email-verification links. `GET /api/auth/callback/email` verifies the token, creates a session, and redirects.

Tokens are stored **hashed** (SHA-256) at rest — only the plaintext lives in the emailed link — so a database read leak
can't be replayed to mint a session. Consumption is a single atomic `DELETE ... RETURNING`, so a link is strictly
single-use even under concurrent clicks, and the link origin is derived from the configured `AUTH_URL` rather than the
request `Host` (no host-header poisoning). Sending a new link invalidates any prior outstanding one for that address.

`resolveMagicLinkSender(env)` (from `@ottabase/auth/providers`) picks a sender using this priority order:

1. **Local KV dev-email-trap** - if `DEV_EMAIL_TRAP_ENABLED` is set and `OBCF_KV` is bound
2. **SMTP** - via `@ottabase/email`'s Nodemailer mailer, if `EMAIL_SERVER` + `EMAIL_FROM` are set
3. **Resend** - if `EMAIL_RESEND_API_KEY` is set

```typescript
import { resolveMagicLinkSender } from '@ottabase/auth/providers';

const sender = resolveMagicLinkSender(env); // MagicLinkSender | null
```

From the client:

```typescript
import { sendMagicLink } from '@ottabase/auth/client';

await sendMagicLink(email, { redirectTo: '/dashboard' });
```

## Client API

Framework-agnostic, `fetch`-based, JSON end-to-end (`@ottabase/auth/client`):

```typescript
import {
    signInWithCredentials,
    signInWithProvider,
    sendMagicLink,
    registerWithCredentials,
    getSession,
    signOut,
    getCsrfToken,
    requestEmailVerification,
    verifyEmail,
    requestPasswordReset,
    resetPassword,
    changePassword,
} from '@ottabase/auth/client';

await signInWithCredentials({ email, password }, { redirect: false });
await signInWithProvider('github', { redirectTo: '/dashboard' });
await sendMagicLink(email, { redirectTo: '/dashboard' });

// Requires the host app's /api/auth/register endpoint. Signs the account in unless email
// verification is required: `session` is set and the cookie is already there.
const { session, requiresEmailVerification } = await registerWithCredentials({ name, email, password, referralCode });

const result = await getSession(); // SessionFetchResult; retries transient 502/503/504 responses
if (result.state === 'authenticated') {
    console.log(result.session.user);
} else if (result.state === 'unavailable') {
    // Do not treat network/5xx/invalid JSON as logout.
    console.error(result.message);
}
await signOut({ redirectTo: '/login' });

// Requires the host app's own routes (see route table above)
await requestEmailVerification(email);
await verifyEmail(token, email);
await requestPasswordReset(email);
await resetPassword({ email, token, password });
await changePassword({ currentPassword, newPassword });
```

The calls behind public forms (`signInWithCredentials`, `sendMagicLink`, `registerWithCredentials`,
`requestPasswordReset`, `requestEmailVerification`) take `headers` in their options, merged into the request. A form's
bot check goes there, read once per submit right before the call:

```tsx
import { useTurnstile } from '@ottabase/ui/turnstile';

const human = useTurnstile('password-reset');
// ... {human.widget} inside the form, above its submit button ...
await requestPasswordReset(email, { headers: await human.headers() });
```

## React Hooks

`useSession()` (from `@ottabase/auth/react`) is a side-effect-free, Jotai-backed reader for the shared session state.
Mount `useSessionBootstrap()` exactly once near the application root to initialize that state from
`GET /api/auth/session`; components and route guards then consume the cached result without triggering a request on
every mount:

```typescript
import { useSession, useSessionBootstrap } from '@ottabase/auth/react';

function SessionBootstrap() {
    useSessionBootstrap();
    return null;
}

function App() {
    return (
        <>
            <SessionBootstrap />
            <Routes />
        </>
    );
}

function MyComponent() {
    const { user, isAuthenticated, isInitialized, sessionError, logout, refreshSession } = useSession();

    if (!isInitialized) return <Loading />;
    if (sessionError) return <Retry onClick={refreshSession} />;

    if (!isAuthenticated) return <LoginPrompt />;
    return (
        <div>
            <h1>Welcome {user?.name}</h1>
            <button onClick={logout}>Sign Out</button>
        </div>
    );
}
```

Call `refreshSession()` explicitly after a successful mutation that can change the current user's identity, active
organization, roles, or permissions. Explicit refreshes always start a causally newer request, so a response that began
before the mutation cannot overwrite the new snapshot. A real anonymous response clears the session; network, upstream,
and malformed-response failures set `sessionError` while retaining the last confirmed snapshot. Logout and API-level 401
handlers should call `invalidateAuthSession()`, which clears persisted auth state and notifies the root so app and
tenant query caches can be cleared together.

`updateUser(partialUser)` always merges into the atom's current confirmed session, including when it is called by an
async handler that was created before `refreshSession()` completed. This makes the supported
`await refreshSession(); updateUser({ clientOnlyField })` sequence safe: the local field is added without restoring a
stale pre-refresh identity or authorization snapshot.

## Login Config Helpers (pure)

The env-driven login-config helpers live on their own **dependency-free** subpath, `@ottabase/auth/config`. It imports
nothing from the UI components — not even types, since a type-only import still pulls the file into a Worker type-check
— so a worker/edge route (e.g. `GET /api/auth/config`) can decide which sign-in methods to show without ever loading
shadcn or lucide. The `SocialProvider` type is declared here too:

```typescript
import {
    getLoginConfig,
    getConfiguredSocialProviders,
    isCredentialsConfigured,
    isEmailProviderConfigured,
} from '@ottabase/auth/config';

const config = getLoginConfig(env);
// { socialProviders, showCredentials, showMagicLink, hasSocialProviders, hasEmailProvider }
```

- `getConfiguredSocialProviders(env)` - social providers with credentials configured
- `isEmailProviderConfigured(env)` - true if the dev trap, SMTP, or Resend is configured
- `isCredentialsConfigured(env)` - true unless `AUTH_DISABLE_CREDENTIALS` is set
- `getLoginConfig(env)` - all of the above combined into one config object

## UI Components

Framework-agnostic React components built on `@ottabase/ui` (`@ottabase/auth/components`). This is the package's
**only** rendered-UI subpath: `@ottabase/ui` and `lucide-react` are declared as **optional** peer dependencies and are
pulled in **only** when you import from here — the pure subpaths (`.`, `./react`, `./config`, `./backend`, …) stay free
of them. The components take plain callback props, so you wire them to `@ottabase/auth/client` yourself.

```typescript
import { LoginForm } from '@ottabase/auth/components';
import { getLoginConfig } from '@ottabase/auth/config';
import { signInWithCredentials, signInWithProvider, sendMagicLink } from '@ottabase/auth/client';

// Auto-detect configured providers/methods from env vars (pure helper — no UI deps)
const config = getLoginConfig(process.env);

<LoginForm
    socialProviders={config.socialProviders}
    showCredentials={config.showCredentials}
    showMagicLink={config.showMagicLink}
    onSocialLogin={(id) => signInWithProvider(id)}
    onCredentialsLogin={({ email, password }) => signInWithCredentials({ email, password })}
    onMagicLinkSend={(email) => sendMagicLink(email)}
    title="Welcome back"
/>
```

Individual pieces are also exported: `CredentialsForm`, `MagicLinkForm`, `RegisterForm`, `SocialLoginButtons` +
`SocialLoginDivider`.

`showPasskey` with `onPasskeyLogin` puts "Sign in with a passkey" first in the card, above the "or" divider. The
callback gets the form's "Remember me" choice (`{ rememberMe }`), which `LoginForm` holds for both. Pass `showPasskey`
once the login config is known (`passkeys` in `LoginConfig`) and `isPasskeySupported()` is true, so nothing shifts.

`LoginForm`, `CredentialsForm`, `MagicLinkForm` and `RegisterForm` take a `botCheck` node rendered inside the form,
above the submit button. `LoginForm` hands its one node to whichever method is showing, so one widget covers password
and magic link:

```tsx
const human = useTurnstile('signin'); // from @ottabase/ui/turnstile

<LoginForm
    botCheck={human.widget}
    onCredentialsLogin={async ({ email, password }) => {
        await signInWithCredentials({ email, password }, { headers: await human.headers() });
    }}
    onMagicLinkSend={async (email) => {
        await sendMagicLink(email, { headers: await human.headers() });
    }}
/>;
```

## Environment Variables

| Variable                                                | Required                                      | Purpose                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                                           | Yes (fails closed without it)                 | HMAC secret (>= 16 chars, 32+ recommended) for session JWTs, CSRF tokens, OAuth state/PKCE cookies                                                                                                                                                        |
| `AUTH_FACTOR_KEY`                                       | No (defaults to `AUTH_SECRET`)                | Key authenticator-app secrets are sealed under. Rotating it (or `AUTH_SECRET` while this is unset) makes every enrolled app unreadable: those people answer `AUTHENTICATOR_UNREADABLE`, sign in with a recovery code or passkey, and set the app up again |
| `AUTH_ALLOW_INSECURE_DEV_SECRET`                        | No (local dev only)                           | `"true"` permits the built-in insecure dev secret, only honored when `ENVIRONMENT` is a dev value                                                                                                                                                         |
| `CORS_ALLOWED_ORIGINS`                                  | No                                            | Comma-separated extra origins allowed for credentialed CORS (same-origin + `AUTH_URL` always allowed)                                                                                                                                                     |
| `AUTH_URL`                                              | No                                            | Frontend origin used for redirects + OAuth `redirect_uri` (defaults to `http://127.0.0.1:3003`)                                                                                                                                                           |
| `AUTH_COOKIE_NAME`                                      | No                                            | Overrides the session cookie name (default `ottabase.<APP_ID>.session-token`)                                                                                                                                                                             |
| `AUTH_DISABLE_CREDENTIALS`                              | No                                            | `"true"`/`"1"` disables `POST /api/auth/callback/credentials`                                                                                                                                                                                             |
| `AUTH_REQUIRE_EMAIL_VERIFIED`                           | No                                            | `"true"`/`"1"` rejects credentials sign-in for unverified users                                                                                                                                                                                           |
| `AUTH_SESSION_MAX_AGE`                                  | No                                            | Session lifetime in seconds (default 30 days)                                                                                                                                                                                                             |
| `GOOGLE_CLIENT_ID` / `_SECRET`                          | For Google OAuth                              |                                                                                                                                                                                                                                                           |
| `GITHUB_CLIENT_ID` / `_SECRET`                          | For GitHub OAuth                              |                                                                                                                                                                                                                                                           |
| `DISCORD_CLIENT_ID` / `_SECRET`                         | For Discord OAuth                             |                                                                                                                                                                                                                                                           |
| `AZURE_AD_CLIENT_ID` / `_SECRET` / `AZURE_AD_TENANT_ID` | For Azure AD OAuth                            |                                                                                                                                                                                                                                                           |
| `AUTH0_CLIENT_ID` / `_SECRET` / `AUTH0_ISSUER`          | For Auth0 OAuth                               |                                                                                                                                                                                                                                                           |
| `EMAIL_RESEND_API_KEY`                                  | For Resend magic links                        |                                                                                                                                                                                                                                                           |
| `EMAIL_SERVER` / `EMAIL_FROM`                           | For SMTP magic links                          |                                                                                                                                                                                                                                                           |
| `DEV_EMAIL_TRAP_ENABLED`                                | For local dev email capture (needs `OBCF_KV`) |                                                                                                                                                                                                                                                           |

`AUTH_SECRET` resolution **fails closed**: it is required unless **both** `ENVIRONMENT` is an explicit dev value
(`development`/`dev`/`test`/`local`) **and** `AUTH_ALLOW_INSECURE_DEV_SECRET=true` are set, in which case a built-in
insecure default is used with a warning. An unset or unknown `ENVIRONMENT` is treated as production, so a real deploy
that forgets `AUTH_SECRET` throws instead of silently signing every token with a publicly-known constant. (Deploy with
the production wrangler environment, so dev vars never reach production: `otta deploy` does, `env.production` unless the
app's `cloudflare-config.json` or `--env` says otherwise.)

## Accessibility, SSR & performance

- **Accessibility** — the bundled UI components (`LoginForm`, etc.) build on `@ottabase/ui` primitives, so labels,
  focus, and error semantics come from there.
- **SSR** — server routes read identity via `getSession(request, env)` (fails closed without KV). On the **client**,
  `useSession()` fetches `/api/auth` on mount with an optimistic value from `localStorage`, so auth-gated UI can briefly
  flash the logged-out (or stale) state before the session resolves. Unlike theme/brand (which are edge-hydrated to
  avoid FOUC), there is **no edge-injected session yet** — gate on `isAuthenticated` and render a stable loading state
  rather than assuming the first paint is correct.
- **Performance** — session reads prefer the mutable KV registry snapshot over re-hitting D1; a per-user
  `profile:version` bump is what forces a re-read (see [Session Model](#session-model)), so a profile edit reflects on
  the next request without re-issuing the cookie. Password hashing is PBKDF2 via Web Crypto (no native deps, edge-safe).

## Architecture

```
@ottabase/auth
├── crypto.ts            Web Crypto primitives: PBKDF2 hashing, HMAC-SHA256, base64url, SHA-256
├── jwt.ts                Minimal HS256-only compact JWT (sign/verify)
├── cookies.ts            Cookie serialize/parse helpers
├── csrf.ts                Double-submit CSRF cookie pair + verification
├── session-store.ts      Session creation/verification, KV revocation registry
├── session.ts             Pure Session helpers (isAuthenticated, requireAuth, ...)
├── bootstrap.ts           First-user platform_owner-role + personal-organization bootstrap
├── backend-handler.ts     handleAuthRequest router + credentials/OAuth/magic-link handlers
├── providers/
│   ├── oauth-client.ts    Generic Authorization-Code + PKCE client
│   ├── presets.ts         Google/GitHub/Discord/Azure AD/Auth0 endpoint + claim-mapping data
│   ├── email.ts           Magic-link senders (dev trap / Nodemailer / Resend)
│   └── types.ts           Shared provider types
├── client-api.ts          fetch-based frontend client
├── react-hooks.ts         useSession + useSessionBootstrap (Jotai-backed)
└── components/            Framework-agnostic login/register UI (@ottabase/ui) — the `./components` subpath
    └── helpers.ts         Pure, type-only env→login-config helpers — the `./config` subpath (no UI deps)
```

### Subpath purity

Every subpath is strictly pure **or** UI-only — never mixed. `@ottabase/ui` and `lucide-react` are optional peer
dependencies that only `@ottabase/auth/components` pulls in:

| Subpath                                                                         | Rendered UI? | Notable deps                                    |
| ------------------------------------------------------------------------------- | ------------ | ----------------------------------------------- |
| `.`, `./providers`, `./session`, `./backend`, `./client`, `./react`, `./config` | No (pure)    | none of the UI packages                         |
| `./components`                                                                  | Yes          | `@ottabase/ui`, `lucide-react` (optional peers) |

DB access goes through the existing OttaORM models (`User`, `Account`, `VerificationToken`, `OrganizationMember` from
`@ottabase/ottaorm/models`) — there is no hand-rolled adapter layer. Every cryptographic primitive runs on
`crypto.subtle`, which Cloudflare Workers implements natively, so the package has no runtime dependency on Node crypto
or any third-party crypto/JWT library.

## License

MIT
