// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getFactors } = vi.hoisted(() => ({ getFactors: vi.fn() }));
vi.mock('../client-factors', async (original) => ({
    ...(await original<typeof import('../client-factors')>()),
    getFactors,
}));

import { LoginForm } from '../components';
import { useFactors } from '../react-hooks';

const noop = async () => undefined;

// The Remember me checkbox (Radix) measures itself.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
    getFactors.mockReset();
});

describe('LoginForm passkey option', () => {
    it('sits first in the card, above the "or" divider, and only when asked for', () => {
        const { container, rerender } = render(
            <LoginForm showPasskey onPasskeyLogin={() => undefined} onCredentialsLogin={noop} />,
        );
        const text = container.textContent ?? '';
        expect(text.indexOf('Sign in with a passkey')).toBeGreaterThan(-1);
        expect(text.indexOf('Sign in with a passkey')).toBeLessThan(text.indexOf('or'));
        expect(text.indexOf('or')).toBeLessThan(text.indexOf('Email'));

        rerender(<LoginForm showPasskey={false} onPasskeyLogin={() => undefined} onCredentialsLogin={noop} />);
        expect(screen.queryByText('Sign in with a passkey')).toBeNull();
    });

    it('hands the passkey button the same "Remember me" choice as the password form', () => {
        const onPasskeyLogin = vi.fn();
        render(<LoginForm showPasskey onPasskeyLogin={onPasskeyLogin} onCredentialsLogin={noop} />);

        fireEvent.click(screen.getByRole('button', { name: /passkey/i }));
        expect(onPasskeyLogin).toHaveBeenLastCalledWith({ rememberMe: true });

        fireEvent.click(screen.getByRole('checkbox', { name: 'Remember me' }));
        fireEvent.click(screen.getByRole('button', { name: /passkey/i }));
        expect(onPasskeyLogin).toHaveBeenLastCalledWith({ rememberMe: false });
    });
});

describe('useFactors', () => {
    const summary = {
        twoFactor: {
            enabled: false,
            totp: false,
            totpPending: false,
            passkeys: 0,
            recoveryCodesLeft: 0,
            requiredFrom: null,
        },
        passkeys: [],
        passkeysAvailable: true,
        recentSignIn: true,
        recentSignInUntil: null,
    };

    it('reads on mount, keeps the data, and reads again on reload', async () => {
        getFactors.mockResolvedValue({ success: true, ...summary });
        const { result } = renderHook(() => useFactors());
        expect(result.current.pending).toBe(true);
        await waitFor(() => expect(result.current.pending).toBe(false));
        expect(result.current.data).toEqual(summary);
        expect(result.current.error).toBeNull();

        getFactors.mockResolvedValue({ success: false, error: 'offline' });
        await act(() => result.current.reload());
        await waitFor(() => expect(result.current.error).toBe('offline'));
        expect(result.current.data).toEqual(summary);
        expect(getFactors).toHaveBeenCalledTimes(2);
    });
});
