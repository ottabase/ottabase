// ============================================================
// @ottabase/auth - HTTP helpers shared by every auth route
// ============================================================

import { createD1Driver } from '@ottabase/db/drizzle-d1';
import { registerConnection } from '@ottabase/ottaorm';
import { errorResponse } from '@ottabase/utils/http-errors';
import { jsonResponse as utilsJsonResponse } from '@ottabase/utils/http-response';
import { parseCookies } from './cookies';
import { verifyCsrfToken } from './csrf';
import { authCookieBase, isProductionCookieEnv, resolveAuthSecret } from './session-store';
import type { AuthEnv } from './types';

/** The framework's JSON response; `extraHeaders` may carry several `Set-Cookie` (pass a `Headers`). */
export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
    return utilsJsonResponse(data, status, { headers: extraHeaders });
}

export function ensureOrmConnection(env: AuthEnv): void {
    if (!env.OBCF_D1) return;
    registerConnection('default', createD1Driver(env.OBCF_D1));
}

export function resolveFrontendUrl(env: AuthEnv): string {
    // Strip trailing slashes so `${resolveFrontendUrl(env)}${path}` and the OAuth
    // redirect_uri never produce a double slash (which would fail an exact redirect-uri
    // match at the provider and break OAuth).
    return (env.AUTH_URL || 'http://127.0.0.1:3003').replace(/\/+$/, '');
}

/** Only relative, single-leading-slash paths are accepted; anything else falls back, blocking open redirects. */
export function sanitizeCallbackPath(raw: string | null | undefined, fallback = '/'): string {
    if (typeof raw !== 'string' || !raw) return fallback;
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
    try {
        // Parsing against a dummy base rejects anything that smuggles a scheme/host (e.g. "/\evil.com").
        const parsed = new URL(raw, 'http://ottabase.internal');
        if (parsed.origin !== 'http://ottabase.internal') return fallback;
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return fallback;
    }
}

// __Host- pins to the exact host with Path=/ (used for the root-scoped CSRF cookie).
export function csrfCookieName(env: AuthEnv): string {
    return `${isProductionCookieEnv(env) ? '__Host-' : ''}${authCookieBase(env, 'csrf-token')}`;
}

/**
 * Origin allowlist check for state-changing requests: a browser always sends `Origin`
 * on cross-origin (and most same-origin) POSTs, so a present-but-mismatched Origin is
 * rejected as a defense-in-depth backstop to the double-submit CSRF token. A missing
 * Origin (some non-browser clients) falls through to the CSRF-token check.
 */
function isTrustedOrigin(request: Request, env: AuthEnv): boolean {
    const origin = request.headers.get('Origin');
    if (!origin) return true;
    try {
        const submitted = new URL(origin).origin;
        const allowed = new Set<string>([new URL(request.url).origin]);
        try {
            allowed.add(new URL(resolveFrontendUrl(env)).origin);
        } catch {
            // ignore malformed configured URL
        }
        return allowed.has(submitted);
    } catch {
        return false;
    }
}

/**
 * The 403 to return when a state-changing request fails the Origin or CSRF check, else null.
 * Exported for the app's own routes that sign people in (register), so they hold the same line.
 */
export async function requireCsrf(request: Request, env: AuthEnv, submittedToken: unknown): Promise<Response | null> {
    // Defense in depth: reject a mismatched Origin outright before the token check. Its own message, because
    // the usual cause is opening the app on another loopback name (localhost vs 127.0.0.1), not a bad token.
    if (!isTrustedOrigin(request, env)) {
        // Echoed for the developer; capped, since it is whatever the client sent.
        const origin = (request.headers.get('Origin') ?? '').slice(0, 200);
        return errorResponse(`Untrusted origin ${origin}: open the app at its configured URL (AUTH_URL)`, 403, {
            code: 'UNTRUSTED_ORIGIN',
        });
    }
    const cookies = parseCookies(request.headers.get('Cookie'));
    const secret = resolveAuthSecret(env);
    const valid = await verifyCsrfToken(
        cookies[csrfCookieName(env)],
        typeof submittedToken === 'string' ? submittedToken : undefined,
        secret,
    );
    return valid ? null : errorResponse('Invalid or missing CSRF token', 403, { code: 'CSRF_INVALID' });
}
