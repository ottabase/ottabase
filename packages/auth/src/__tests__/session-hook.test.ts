import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthEnv } from '../types';

const getSession = vi.fn();
vi.mock('../session-store', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../session-store')>()),
    getSession: (...args: unknown[]) => getSession(...args),
}));

const { handleAuthRequest } = await import('../backend-handler');

const env = { AUTH_SECRET: 'test-secret-at-least-32-chars-long!!', ENVIRONMENT: 'test', OBCF_D1: {} } as AuthEnv;
const read = () => new Request('https://app.example.com/api/auth/session');
const session = { user: { id: 'u1', email: 'ada@example.com' }, expires: '2099-01-01T00:00:00.000Z' };

describe('onSession', () => {
    beforeEach(() => getSession.mockReset());

    it('hears of a session read that found a user, and of nothing else', async () => {
        const onSession = vi.fn();
        getSession.mockResolvedValueOnce(null);
        await handleAuthRequest(read(), env, { onSession });
        expect(onSession).not.toHaveBeenCalled();

        getSession.mockResolvedValueOnce(session);
        const response = await handleAuthRequest(read(), env, { onSession });
        expect(onSession).toHaveBeenCalledWith({ userId: 'u1', email: 'ada@example.com' });
        expect(await response.json()).toEqual(session);
    });

    it('never fails the session read', async () => {
        getSession.mockResolvedValueOnce(session);
        const response = await handleAuthRequest(read(), env, {
            onSession: () => {
                throw new Error('bookkeeping is down');
            },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(session);
    });
});
