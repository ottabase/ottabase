import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    addPasskey,
    defaultPasskeyName,
    fromB64url,
    getTwoFactorChallenge,
    isPasskeyCancelled,
    PASSKEY_EXISTS,
    PASSKEY_FAILED,
    result,
    submitTwoFactor,
    toB64url,
} from '../client-factors';

const named = (name: string) => Object.assign(new Error(name), { name });

/** A fetch that answers /csrf and then each path from `routes` (status + JSON body). */
function serve(routes: Record<string, { status?: number; body: unknown } | Error>) {
    const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/csrf')) return new Response(JSON.stringify({ csrfToken: 'token' }), { status: 200 });
        const path = url.replace('/api/auth', '');
        const route = routes[path];
        if (!route) throw new Error(`unexpected ${url}`);
        if (route instanceof Error) throw route;
        return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('base64url', () => {
    it('round-trips every padding length, including the + and / alphabet', () => {
        for (let length = 0; length <= 7; length++) {
            const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + 251) % 256);
            const encoded = toB64url(bytes.buffer);
            expect(encoded).not.toMatch(/[+/=]/);
            expect(new Uint8Array(fromB64url(encoded))).toEqual(bytes);
        }
        expect(toB64url(Uint8Array.from([251, 255, 191]).buffer)).toBe('-_-_');
        expect(toB64url(null)).toBe('');
    });
});

describe('isPasskeyCancelled', () => {
    it('is a cancel for an abort, or a NotAllowedError after the sheet showed and before the timeout', () => {
        expect(isPasskeyCancelled(named('AbortError'), 10)).toBe(true);
        expect(isPasskeyCancelled(named('NotAllowedError'), 3_000, 60_000)).toBe(true);
    });

    it('is a failure for an instant refusal, a timeout, or anything else', () => {
        expect(isPasskeyCancelled(named('NotAllowedError'), 20, 60_000)).toBe(false);
        expect(isPasskeyCancelled(named('NotAllowedError'), 60_000, 60_000)).toBe(false);
        expect(isPasskeyCancelled(named('InvalidStateError'), 3_000)).toBe(false);
        expect(isPasskeyCancelled(named('SecurityError'), 3_000)).toBe(false);
        expect(isPasskeyCancelled('NotAllowedError', 3_000)).toBe(false);
    });
});

describe('result', () => {
    it('fails for no response, an error status, and a 200 that carries an error', () => {
        expect(result({ status: 0, error: 'offline', code: 'NETWORK_ERROR' })).toEqual({
            success: false,
            error: 'offline',
            code: 'NETWORK_ERROR',
        });
        expect(result({ status: 403, error: 'Sign in again', code: 'REAUTH_REQUIRED' })).toMatchObject({
            success: false,
            code: 'REAUTH_REQUIRED',
        });
        expect(result({ status: 409 })).toMatchObject({ success: false, error: 'Something went wrong. Try again.' });
        expect(result({ status: 200, error: 'nope' })).toMatchObject({ success: false, error: 'nope' });
    });

    it('passes the data through on success, without the status', () => {
        expect(result({ status: 200, recoveryCodes: ['a'] })).toEqual({ success: true, recoveryCodes: ['a'] });
    });
});

describe('submitTwoFactor with a passkey', () => {
    it('forwards the code when nothing is pending any more', async () => {
        serve({
            '/two-factor/passkey-options': {
                status: 401,
                body: { error: 'This sign-in has expired.', code: 'SECOND_FACTOR_EXPIRED' },
            },
        });
        const outcome = await submitTwoFactor({ passkey: true });
        expect(outcome).toEqual({ success: false, error: 'This sign-in has expired.', code: 'SECOND_FACTOR_EXPIRED' });
    });

    it('reports a closed passkey sheet as cancelled, with no error to show', async () => {
        serve({ '/two-factor/passkey-options': { body: { challenge: 'AAAA', timeout: 60_000 } } });
        vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => Promise.reject(named('AbortError'))) } });
        const outcome = await submitTwoFactor({ passkey: true });
        expect(outcome).toEqual({ success: false, cancelled: true });
    });

    it('says the passkey did not work when the browser refuses at once', async () => {
        serve({ '/two-factor/passkey-options': { body: { challenge: 'AAAA', timeout: 60_000 } } });
        vi.stubGlobal('navigator', {
            credentials: { get: vi.fn(async () => Promise.reject(named('NotAllowedError'))) },
        });
        const outcome = await submitTwoFactor({ passkey: true });
        expect(outcome).toEqual({ success: false, error: PASSKEY_FAILED });
    });
});

describe('addPasskey', () => {
    it('says so when this device already has a passkey for the account', async () => {
        serve({
            '/factors/passkeys/options': {
                body: { challenge: 'AAAA', user: { id: 'AAAA', name: 'a', displayName: 'a' }, timeout: 60_000 },
            },
        });
        vi.stubGlobal('navigator', {
            userAgent: '',
            credentials: { create: vi.fn(async () => Promise.reject(named('InvalidStateError'))) },
        });
        expect(await addPasskey('Laptop')).toEqual({ success: false, error: PASSKEY_EXISTS });
    });
});

describe('getTwoFactorChallenge', () => {
    it('reads the methods that can finish the sign-in', async () => {
        serve({
            '/two-factor/challenge': {
                body: { pending: true, methods: { totp: false, passkey: true, recoveryCode: true } },
            },
        });
        expect(await getTwoFactorChallenge()).toEqual({
            pending: true,
            methods: { totp: false, passkey: true, recoveryCode: true },
        });
    });

    it('tells a network failure apart from an expired sign-in', async () => {
        serve({ '/two-factor/challenge': new TypeError('Failed to fetch') });
        const state = await getTwoFactorChallenge();
        expect(state.pending).toBe(false);
        expect(state.error).toMatch(/could not reach the server/i);
    });
});

describe('defaultPasskeyName', () => {
    it('names the browser and the device, iOS before macOS', () => {
        const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1';
        expect(defaultPasskeyName(ipad)).toBe('Safari on iPad');
        expect(
            defaultPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Safari/604.1'),
        ).toBe('Chrome on iPhone');
        expect(
            defaultPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) FxiOS/121.0 Safari/605.1'),
        ).toBe('Firefox on iPhone');
        expect(
            defaultPasskeyName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) EdgiOS/120.0 Safari/605.1'),
        ).toBe('Edge on iPhone');
        expect(
            defaultPasskeyName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'),
        ).toBe('Safari on Mac');
        expect(defaultPasskeyName('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0')).toBe(
            'Edge on Windows',
        );
        expect(defaultPasskeyName('')).toBe('Passkey');
    });
});
