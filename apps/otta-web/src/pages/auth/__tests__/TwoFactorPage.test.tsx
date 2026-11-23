import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigate, login, search, getTwoFactorChallenge, submitTwoFactor, isPasskeySupported } = vi.hoisted(() => ({
    navigate: vi.fn(),
    login: vi.fn(),
    search: { callbackUrl: '/admin' as string | undefined, remember: undefined as boolean | undefined },
    getTwoFactorChallenge: vi.fn(),
    submitTwoFactor: vi.fn(),
    isPasskeySupported: vi.fn(() => true),
}));

vi.mock('@/lib/auth', () => ({ useSession: () => ({ login }) }));
vi.mock('@/lib/auth-api', () => ({ getTwoFactorChallenge, submitTwoFactor, isPasskeySupported }));
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigate,
    useSearch: () => search,
    Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
        <a
            href={to}
            {...props}
            onClick={(event) => {
                event.preventDefault();
                props.onClick?.(event);
            }}
        >
            {children}
        </a>
    ),
}));

import { TwoFactorPage } from '../TwoFactorPage';

// The code field (input-otp) probes for password-manager badges; jsdom has no layout.
document.elementFromPoint ??= () => null;

const methods = { totp: true, passkey: true, recoveryCode: true };
const session = { user: { id: 'u1', email: 'a@example.com' }, expires: Date.now() + 60_000 };

async function enterCode(value: string) {
    const input = await screen.findByLabelText('Six-digit code');
    await act(async () => {
        fireEvent.change(input, { target: { value } });
    });
    return input as HTMLInputElement;
}

describe('TwoFactorPage', () => {
    beforeEach(() => {
        navigate.mockReset();
        login.mockReset();
        submitTwoFactor.mockReset();
        getTwoFactorChallenge.mockReset();
        getTwoFactorChallenge.mockResolvedValue({ pending: true, methods });
        search.callbackUrl = '/admin';
        search.remember = undefined;
        sessionStorage.clear();
    });

    it('clears a wrong code and keeps focus in the field, with the error tied to it', async () => {
        submitTwoFactor.mockResolvedValue({
            success: false,
            error: 'That code did not work.',
            code: 'SECOND_FACTOR_INVALID',
        });
        render(<TwoFactorPage />);
        const input = await enterCode('123456');

        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('That code did not work.'));
        expect(submitTwoFactor).toHaveBeenCalledTimes(1);
        expect(input.value).toBe('');
        expect(input.disabled).toBe(false);
        expect(document.activeElement).toBe(input);
        expect(input.getAttribute('aria-describedby')).toBe('two-factor-error');
    });

    it('says an expired sign-in once, and "Sign in again" keeps the destination', async () => {
        getTwoFactorChallenge.mockResolvedValue({ pending: false, methods });
        render(<TwoFactorPage />);

        expect(await screen.findAllByText(/This sign-in has expired/)).toHaveLength(1);
        expect(screen.queryByRole('alert')).toBeNull();
        fireEvent.click(screen.getByText('Sign in again'));
        expect(sessionStorage.getItem('ottabase.auth.returnTo')).toBe('/admin');
    });

    it('turns into the expired state when the code arrives too late', async () => {
        submitTwoFactor.mockResolvedValue({ success: false, error: 'Expired', code: 'SECOND_FACTOR_EXPIRED' });
        render(<TwoFactorPage />);
        await enterCode('123456');

        expect(await screen.findAllByText(/This sign-in has expired/)).toHaveLength(1);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows nothing when the person closes the passkey sheet', async () => {
        submitTwoFactor.mockResolvedValue({ success: false, cancelled: true });
        render(<TwoFactorPage />);
        const passkey = await screen.findByRole('button', { name: /use a passkey/i });
        await act(async () => {
            fireEvent.click(passkey);
        });

        expect(submitTwoFactor).toHaveBeenCalledWith({ passkey: true });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('offers a passkey-only account no code field', async () => {
        getTwoFactorChallenge.mockResolvedValue({
            pending: true,
            methods: { totp: false, passkey: true, recoveryCode: true },
        });
        render(<TwoFactorPage />);

        expect(await screen.findByRole('button', { name: /use a passkey/i })).toBeTruthy();
        expect(screen.queryByLabelText('Six-digit code')).toBeNull();
        expect(screen.queryByText(/authenticator app instead/)).toBeNull();
    });

    it('signs in with the remembered choice and goes to a safe callbackUrl', async () => {
        search.remember = false;
        submitTwoFactor.mockResolvedValue({ success: true, session });
        render(<TwoFactorPage />);
        await enterCode('123456');

        await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/admin', replace: true }));
        expect(login).toHaveBeenCalledWith(session, { remember: false });
    });

    it('falls back to the default page for an unsafe callbackUrl', async () => {
        search.callbackUrl = '//evil.example/steal';
        submitTwoFactor.mockResolvedValue({ success: true, session });
        render(<TwoFactorPage />);
        await enterCode('123456');

        await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/profile', replace: true }));
    });

    it('shows a network failure as an error with "Try again", not as expired', async () => {
        getTwoFactorChallenge.mockResolvedValueOnce({
            pending: false,
            methods: { totp: false, passkey: false, recoveryCode: false },
            error: 'Could not reach the server. Check your connection and try again.',
        });
        render(<TwoFactorPage />);

        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByText(/expired/)).toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        });
        expect(getTwoFactorChallenge).toHaveBeenCalledTimes(2);
        expect(await screen.findByLabelText('Six-digit code')).toBeTruthy();
    });
});
