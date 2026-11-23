/**
 * The signed-in user's own sessions (the /sessions page). Each route is declared once in
 * `ottabase/endpoints/sessions.ts` and served here with `endpointHandler`, so the page and the
 * Worker share the paths, the input rules and the response types.
 *
 * - `GET    /api/users/me/sessions`                 list, newest first, `current` marked
 * - `PATCH  /api/users/me/sessions/:id { name }`    rename (1 to 40 chars)
 * - `DELETE /api/users/me/sessions/:id`             revoke; the current one signs out (cookie cleared)
 * - `POST   /api/users/me/sessions/revoke-others`   revoke every other session
 *
 * Ids are opaque HMACs of the jti; the helpers map them back by listing the caller's own keys,
 * so no request can ever reach another user's session.
 */
import {
    buildClearSessionCookie,
    getSession,
    listUserSessions,
    readSessionIdentity,
    renameUserSession,
    revokeOtherUserSessions,
    revokeSession as revokeOwnSession,
    revokeUserSessionById,
    sessionPublicId,
} from '@ottabase/auth/backend';
import { endpointHandler } from '@ottabase/utils/endpoint';
import { errorResponse, redactErrorForLog } from '@ottabase/utils/http-errors';
import { jsonResponse } from '@ottabase/utils/http-response';
import { listSessions, renameSession, revokeOtherSessions, revokeSession } from '../../ottabase/endpoints/sessions';
import type { WorkerCtx } from '../lib/api-context';
import { getAuthOptions } from '../lib/auth-utils';

const NO_STORE = { headers: { 'Cache-Control': 'private, no-store' } };
const PUBLIC_ID = /^[A-Za-z0-9_-]{16,32}$/;
const notFound = () => errorResponse('Session not found', 404, { code: 'SESSION_NOT_FOUND' });

async function requireIdentity(c: WorkerCtx) {
    const session = await getSession(c.req, c.env as never, getAuthOptions(c.env));
    const identity = await readSessionIdentity(c.req, c.env as never);
    if (!session?.user?.id || !identity || identity.userId !== session.user.id) {
        return errorResponse('Unauthorized', 401, { code: 'UNAUTHORIZED' });
    }
    return identity;
}

export const meSessionsList = endpointHandler(
    listSessions,
    async (c: WorkerCtx) => {
        const identity = await requireIdentity(c);
        if (identity instanceof Response) return identity;
        try {
            return { sessions: await listUserSessions(identity.userId, c.env as never, identity.jti) };
        } catch (error) {
            console.error(JSON.stringify({ event: 'me_sessions_list_failed', error: redactErrorForLog(error) }));
            return errorResponse('Could not list sessions', 500, { code: 'SESSIONS_UNAVAILABLE' });
        }
    },
    NO_STORE,
);

export const meSessionRename = endpointHandler(
    renameSession,
    async (c: WorkerCtx, { params, input }) => {
        const identity = await requireIdentity(c);
        if (identity instanceof Response) return identity;
        if (!PUBLIC_ID.test(params.id)) return notFound();
        const renamed = await renameUserSession(identity.userId, params.id, input.name, c.env as never);
        if (!renamed) return notFound();
        return {
            session: { ...renamed, current: params.id === (await sessionPublicId(identity.jti, c.env as never)) },
        };
    },
    NO_STORE,
);

export const meSessionRevoke = endpointHandler(
    revokeSession,
    async (c: WorkerCtx, { params }) => {
        const identity = await requireIdentity(c);
        if (identity instanceof Response) return identity;
        if (!PUBLIC_ID.test(params.id)) return notFound();
        const options = getAuthOptions(c.env);

        // Revoking the current session is a sign-out: tombstone it and clear the cookie.
        if (params.id === (await sessionPublicId(identity.jti, c.env as never))) {
            await revokeOwnSession(identity.userId, identity.jti, c.env as never, options);
            return jsonResponse({ signedOut: true }, 200, {
                headers: { ...NO_STORE.headers, 'Set-Cookie': buildClearSessionCookie(c.env as never, c.req) },
            });
        }

        const revoked = await revokeUserSessionById(identity.userId, params.id, c.env as never, options);
        return revoked ? { revoked: true } : notFound();
    },
    NO_STORE,
);

export const meSessionsRevokeOthers = endpointHandler(
    revokeOtherSessions,
    async (c: WorkerCtx) => {
        const identity = await requireIdentity(c);
        if (identity instanceof Response) return identity;
        const revoked = await revokeOtherUserSessions(
            identity.userId,
            identity.jti,
            c.env as never,
            getAuthOptions(c.env),
        );
        return { revoked };
    },
    NO_STORE,
);
