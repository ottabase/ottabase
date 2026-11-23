import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    navigate: vi.fn(),
    logout: vi.fn(async () => undefined),
    refreshSession: vi.fn(async () => ({ state: 'anonymous' })),
    rememberReturnPath: vi.fn(),
    reload: vi.fn(async () => ({ success: true })),
    factors: { current: null as unknown },
    user: { current: { id: 'u1', email: 'a@example.com' } as Record<string, unknown> },
    api: {
        addPasskey: vi.fn(),
        confirmTotpSetup: vi.fn(),
        disableTotp: vi.fn(),
        isPasskeySupported: vi.fn(() => true),
        regenerateRecoveryCodes: vi.fn(),
        removePasskey: vi.fn(),
        renamePasskey: vi.fn(),
        startTotpSetup: vi.fn(),
        changePassword: vi.fn(),
    },
    toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/auth', () => ({
    useSession: () => ({ user: h.user.current, logout: h.logout, refreshSession: h.refreshSession }),
}));
vi.mock('@/lib/auth-api', () => h.api);
vi.mock('@/lib/auth-redirect', () => ({ rememberReturnPath: h.rememberReturnPath }));
vi.mock('@/ottabase/config', () => ({ APP_META: { appName: 'Test App' } }));
vi.mock('@ottabase/auth/react', () => ({
    invalidateAuthSession: vi.fn(),
    useFactors: () => ({ data: h.factors.current, error: null, pending: false, reload: h.reload }),
}));
vi.mock('@ottabase/ui', async (original) => ({ ...(await original<object>()), toast: h.toast }));
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => h.navigate,
    Link: ({
        to,
        children,
        activeProps: _active,
        ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & {
        to: string;
        activeProps?: unknown;
    }) => (
        <a href={to} {...props}>
            {children}
        </a>
    ),
}));

import { SecurityPage } from '../SecurityPage';

document.elementFromPoint ??= () => null;

function factors(overrides: { twoFactor?: Record<string, unknown>; [key: string]: unknown } = {}) {
    const { twoFactor, ...rest } = overrides;
    return {
        twoFactor: {
            enabled: true,
            totp: true,
            totpPending: false,
            passkeys: 0,
            recoveryCodesLeft: 7,
            requiredFrom: null,
            ...twoFactor,
        },
        passkeys: [],
        passkeysAvailable: true,
        recentSignIn: true,
        recentSignInUntil: null,
        ...rest,
    };
}

const CODES = ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'];

describe('SecurityPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.user.current = { id: 'u1', email: 'a@example.com' };
        h.api.isPasskeySupported.mockReturnValue(true);
    });

    it('locks every change until the person signs in again', () => {
        h.factors.current = factors({ recentSignIn: false, twoFactor: { enabled: false, totp: false } });
        render(<SecurityPage />);

        expect(screen.getByText('To change these, sign in again first.')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Set up' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Add a passkey' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('"Sign in again" remembers /security, then signs out', async () => {
        h.factors.current = factors({ recentSignIn: false });
        render(<SecurityPage />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
        });

        expect(h.rememberReturnPath).toHaveBeenCalledWith('/security');
        expect(h.rememberReturnPath.mock.invocationCallOrder[0]).toBeLessThan(h.logout.mock.invocationCallOrder[0]);
        expect(h.navigate).toHaveBeenCalledWith({ to: '/login', replace: true });
    });

    it('re-reads on REAUTH_REQUIRED without a toast: the alert says what to do', async () => {
        h.factors.current = factors({ twoFactor: { enabled: false, totp: false } });
        h.api.startTotpSetup.mockResolvedValue({ success: false, error: 'Sign in again', code: 'REAUTH_REQUIRED' });
        render(<SecurityPage />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
        });

        expect(h.reload).toHaveBeenCalled();
        expect(h.toast.error).not.toHaveBeenCalled();
    });

    it('shows new recovery codes once, focused, with nothing competing, until dismissed', async () => {
        h.factors.current = factors({
            twoFactor: { passkeys: 1 },
            passkeys: [{ id: 'p1', name: 'Laptop', createdAt: 1, lastUsedAt: null, transports: [] }],
        });
        h.api.regenerateRecoveryCodes.mockResolvedValue({ success: true, recoveryCodes: CODES });
        render(<SecurityPage />);
        fireEvent.click(screen.getByRole('button', { name: 'New codes' }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Make new codes' }));
        });

        const region = await screen.findByRole('region', { name: 'Save your recovery codes' });
        expect(region.textContent).toContain('aaaa-bbbb-cccc-dddd');
        expect(document.activeElement?.id).toBe('recovery-codes-title');
        expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'New codes' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull();
        // No factor can be turned off or removed while the codes are up, so stale codes never outlive one.
        expect((screen.getByRole('button', { name: 'Remove Laptop' }) as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'I have saved them' }));
        expect(screen.queryByRole('region', { name: 'Save your recovery codes' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    });

    it('shows the codes that come with the first passkey', async () => {
        h.factors.current = factors({ twoFactor: { enabled: false, totp: false, recoveryCodesLeft: 0 } });
        h.api.addPasskey.mockResolvedValue({
            success: true,
            passkey: { id: 'p1', name: 'Chrome' },
            recoveryCodes: CODES,
        });
        render(<SecurityPage />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));
        });

        expect(await screen.findByRole('region', { name: 'Save your recovery codes' })).toBeTruthy();
    });

    it('keeps the last factor when the organization requires two-factor', () => {
        h.factors.current = factors({ twoFactor: { requiredFrom: Date.now() - 1_000 } });
        render(<SecurityPage />);

        expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
        expect(screen.getByText('Required by your organization')).toBeTruthy();
    });

    it('lets the app go when a passkey still covers the policy', () => {
        h.factors.current = factors({
            twoFactor: { requiredFrom: Date.now() - 1_000, passkeys: 1 },
            passkeys: [{ id: 'p1', name: 'Laptop', createdAt: 1, lastUsedAt: null, transports: [] }],
        });
        render(<SecurityPage />);

        expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove Laptop' })).toBeTruthy();
    });

    it('says when two-factor will be required, ahead of time', () => {
        h.factors.current = factors({
            twoFactor: { enabled: false, totp: false, requiredFrom: Date.now() + 86_400_000 },
        });
        render(<SecurityPage />);

        expect(screen.getByRole('status').textContent).toMatch(/Two-factor sign-in will be required from/);
    });

    it('shows a wrong first code next to the field and keeps focus there', async () => {
        h.factors.current = factors({ twoFactor: { enabled: false, totp: false } });
        h.api.startTotpSetup.mockResolvedValue({ success: true, secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
        h.api.confirmTotpSetup.mockResolvedValue({
            success: false,
            error: 'That code did not work.',
            code: 'SECOND_FACTOR_INVALID',
        });
        render(<SecurityPage />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
        });
        const input = (await screen.findByLabelText('Six-digit code')) as HTMLInputElement;
        await act(async () => {
            fireEvent.change(input, { target: { value: '123456' } });
        });

        await waitFor(() => expect(screen.getByText('That code did not work.')).toBeTruthy());
        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
        expect(input.getAttribute('aria-describedby')).toBe('setup-code-error');
        expect(screen.getByRole('link', { name: 'Open in authenticator app' }).getAttribute('href')).toBe(
            'otpauth://totp/x',
        );
    });
});
