import { ApiError } from '@ottabase/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toastError } = vi.hoisted(() => ({
    toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
    toast: {
        error: toastError,
    },
}));

import { globalStore, isAuthenticatedAtom } from '@/ottabase/state/appState';
import { api, reportApiError } from '../api';
import { SESSION_REFRESH_EVENT } from '../auth';

describe('reportApiError', () => {
    beforeEach(() => {
        toastError.mockReset();
    });

    it('presents a terminal 403 through the app toast boundary', () => {
        reportApiError(
            new ApiError({
                error: 'Forbidden',
                code: 'FORBIDDEN',
                status: 403,
            }),
        );

        expect(toastError).toHaveBeenCalledTimes(1);
        expect(toastError).toHaveBeenCalledWith('Access denied', {
            description: 'Your account does not have permission to perform this action.',
        });
    });

    it('does not duplicate validation errors that forms present locally', () => {
        reportApiError(
            new ApiError({
                error: 'Validation failed',
                code: 'VALIDATION_ERROR',
                status: 422,
            }),
        );

        expect(toastError).not.toHaveBeenCalled();
    });

    it('sends a revoked session to /login with the session-revoked notice, an expired one with session-expired', () => {
        const original = window.location;
        const fake = { pathname: '/admin', href: '/admin' };
        Object.defineProperty(window, 'location', { value: fake, writable: true, configurable: true });
        try {
            const revokedResponse = new Response(null, { status: 401, headers: { 'X-Session-Ended': 'revoked' } });
            globalStore.set(isAuthenticatedAtom, true);
            reportApiError(new ApiError({ error: 'Unauthorized', status: 401 }, revokedResponse));
            expect(fake.href).toBe('/login?notice=session-revoked');

            fake.href = '/admin';
            globalStore.set(isAuthenticatedAtom, true);
            reportApiError(new ApiError({ error: 'Unauthorized', status: 401 }, new Response(null, { status: 401 })));
            expect(fake.href).toBe('/login?notice=session-expired');
        } finally {
            Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
        }
    });

    it('keeps a session a two-factor policy confines: no sign-out, no trip to /login', () => {
        const original = window.location;
        const fake = { pathname: '/admin', href: '/admin' };
        Object.defineProperty(window, 'location', { value: fake, writable: true, configurable: true });
        try {
            globalStore.set(isAuthenticatedAtom, true);
            const confined = new Response(null, { status: 401, headers: { 'X-Session-Ended': 'two-factor-setup' } });
            reportApiError(new ApiError({ error: 'Unauthorized', status: 401 }, confined));
            expect(fake.href).toBe('/admin');
            expect(globalStore.get(isAuthenticatedAtom)).toBe(true);
        } finally {
            Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
        }
    });

    it('re-reads the session once when requests meet a confined session, and never signs out', async () => {
        const original = window.location;
        const fake = { pathname: '/admin', href: '/admin' };
        Object.defineProperty(window, 'location', { value: fake, writable: true, configurable: true });
        const refreshes = vi.fn();
        window.addEventListener(SESSION_REFRESH_EVENT, refreshes);
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json', 'X-Session-Ended': 'two-factor-setup' },
                    }),
            ),
        );
        try {
            globalStore.set(isAuthenticatedAtom, true);
            // A burst of failing requests (one query presents its own error) asks for one session read.
            const failures = await Promise.allSettled([api('/api/posts'), api('/api/tags'), api('/api/users')]);
            expect(failures.every((outcome) => outcome.status === 'rejected')).toBe(true);
            for (const outcome of failures) reportApiError((outcome as PromiseRejectedResult).reason);

            expect(refreshes).toHaveBeenCalledTimes(1);
            expect(fake.href).toBe('/admin');
            expect(globalStore.get(isAuthenticatedAtom)).toBe(true);
            expect(toastError).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener(SESSION_REFRESH_EVENT, refreshes);
            vi.unstubAllGlobals();
            Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
        }
    });
});
