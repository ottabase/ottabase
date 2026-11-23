// ============================================================
// The signed-in person's own sessions: one declaration per route, shared by both sides
// ============================================================
// The Worker serves these with `endpointHandler` (worker/routes/me-sessions.ts) and the
// /sessions page calls them with `useEndpointQuery` / `useEndpointMutation`. A change to a path,
// an input or a response shape is a type error on whichever side has not caught up.
// ============================================================

import type { SessionSummary } from '@ottabase/auth/backend';
import { defineEndpoint, returns } from '@ottabase/utils/endpoint';
import { z } from 'zod';

/** Every device signed in to this account, newest first, the current one marked. */
export const listSessions = defineEndpoint({
    method: 'GET',
    path: '/api/users/me/sessions',
    output: returns<{ sessions: SessionSummary[] }>(),
});

/** Name a session ("Work laptop"). */
export const renameSession = defineEndpoint({
    method: 'PATCH',
    path: '/api/users/me/sessions/:id',
    input: z.object({
        name: z.string().trim().min(1, 'Name must be 1 to 40 characters').max(40, 'Name must be 1 to 40 characters'),
    }),
    output: returns<{ session: SessionSummary }>(),
});

/** Revoke one session; revoking the current one is a sign-out (`signedOut`). */
export const revokeSession = defineEndpoint({
    method: 'DELETE',
    path: '/api/users/me/sessions/:id',
    output: returns<{ revoked?: boolean; signedOut?: boolean }>(),
});

/** Sign out every other session; `revoked` is how many. */
export const revokeOtherSessions = defineEndpoint({
    method: 'POST',
    path: '/api/users/me/sessions/revoke-others',
    output: returns<{ revoked: number }>(),
});
