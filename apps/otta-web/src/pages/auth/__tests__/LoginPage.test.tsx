import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    navigate: vi.fn(),
    login: vi.fn(),
    api: vi.fn(),
    signInWithCredentials: vi.fn(),
    signInWithPasskey: vi.fn(),
    isPasskeySupported: vi.fn(() => true),
}));

vi.mock('@/lib/api', () => ({ api: h.api }));
vi.mock('@/lib/auth', () => ({
    useSession: () => ({ login: h.login, isAuthenticated: false, isInitialized: true, sessionError: null }),
}));
vi.mock('@/lib/auth-api', () => ({
    isPasskeySupported: h.isPasskeySupported,
    requestPasswordReset: vi.fn(),
    sendMagicLink: vi.fn(),
    signInWithCredentials: h.signInWithCredentials,
    signInWithPasskey: h.signInWithPasskey,
    signInWithProvider: vi.fn(),
}));
vi.mock('@/components/UrlNotices', () => ({ useNotice: () => null }));
vi.mock('@/ottabase/config', () => ({ APP_META: { appName: 'Test App' } }));
vi.mock('@ottabase/ui/turnstile', () => ({ useTurnstile: () => ({ widget: null, headers: async () => ({}) }) }));
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => h.navigate,
    Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
        <a href={to} {...props}>
            {children}
        </a>
    ),
}));
// The form itself is the auth package's (tested there); this stub shows what the page hands it.
vi.mock('@ottabase/auth/components', () => ({
    LoginForm: (props: {
        showPasskey?: boolean;
        error?: string;
        onPasskeyLogin?: (o: { rememberMe: boolean }) => void;
        onCredentialsLogin?: (c: { email: string; password: string; rememberMe: boolean }) => Promise<void>;
    }) => (
        <div>
            <span>{props.showPasskey ? 'passkey offered' : 'no passkey'}</span>
            {props.error && <p role="alert">{props.error}</p>}
            <button onClick={() => props.onPasskeyLogin?.({ rememberMe: false })}>passkey</button>
            <button
                onClick={() => void props.onCredentialsLogin?.({ email: 'a@b.c', password: 'pw', rememberMe: false })}
            >
                password
            </button>
        </div>
    ),
}));

import { LoginPage } from '../LoginPage';

const config = (passkeys: boolean) => ({
    socialProviders: [],
    showCredentials: true,
    showMagicLink: false,
    hasSocialProviders: false,
    hasEmailProvider: false,
    authSecretConfigured: true,
    passkeys,
});

async function renderPage() {
    render(<LoginPage />);
    // The form waits for the config, so nothing shifts when it arrives.
    await screen.findByRole('button', { name: 'password' });
}

describe('LoginPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.isPasskeySupported.mockReturnValue(true);
        h.api.mockResolvedValue(config(true));
        sessionStorage.clear();
    });

    it('sends a two-factor account to the second step with its destination and "Remember me"', async () => {
        sessionStorage.setItem('ottabase.auth.returnTo', '/admin');
        h.signInWithCredentials.mockResolvedValue({ success: false, twoFactorRequired: true });
        await renderPage();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'password' }));
        });

        expect(h.navigate).toHaveBeenCalledWith({
            to: '/login/two-factor',
            search: { callbackUrl: '/admin', remember: false },
        });
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('offers a passkey only when the site and the browser can both do them', async () => {
        await renderPage();
        expect(screen.getByText('passkey offered')).toBeTruthy();
    });

    it('hides the passkey when the site cannot do them', async () => {
        h.api.mockResolvedValue(config(false));
        await renderPage();
        expect(screen.getByText('no passkey')).toBeTruthy();
    });

    it('hides the passkey when the browser cannot do them', async () => {
        h.isPasskeySupported.mockReturnValue(false);
        await renderPage();
        expect(screen.getByText('no passkey')).toBeTruthy();
    });

    it('shows nothing when the passkey sheet is closed, and an error when the passkey fails', async () => {
        h.signInWithPasskey.mockResolvedValue({ success: false, cancelled: true });
        await renderPage();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'passkey' }));
        });
        expect(screen.queryByRole('alert')).toBeNull();

        h.signInWithPasskey.mockResolvedValue({ success: false, error: 'Your passkey did not work.' });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'passkey' }));
        });
        expect(screen.getByRole('alert').textContent).toBe('Your passkey did not work.');
    });

    it('signs in with a passkey under the "Remember me" choice', async () => {
        const session = { user: { id: 'u1', email: 'a@b.c' }, expires: Date.now() + 60_000 };
        h.signInWithPasskey.mockResolvedValue({ success: true, session });
        await renderPage();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'passkey' }));
        });

        expect(h.login).toHaveBeenCalledWith(session, { remember: false });
        expect(h.navigate).toHaveBeenCalledWith({ to: '/profile', replace: true });
    });
});
