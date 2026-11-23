import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigate, rememberReturnPath, session } = vi.hoisted(() => ({
    navigate: vi.fn(),
    rememberReturnPath: vi.fn(),
    session: {
        isAuthenticated: true,
        isInitialized: false,
        isLoading: false,
        sessionError: null as { state: 'unavailable'; message: string } | null,
        refreshSession: vi.fn(),
        user: { id: 'user-1', email: 'owner@example.com', permissions: ['org:admin'] },
    },
}));

vi.mock('@/lib/auth', () => ({
    isPlatformAdmin: () => false,
    useSession: () => session,
}));

vi.mock('@/lib/auth-redirect', () => ({ rememberReturnPath }));

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigate,
    Navigate: ({ to }: { to: string }) => <span>navigate to {to}</span>,
}));

vi.mock('@ottabase/ui', () => ({
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button {...props}>{children}</button>
    ),
    Spinner: () => <span>spinner</span>,
}));

import { ProtectedRoute } from '../ProtectedRoute';

describe('ProtectedRoute', () => {
    beforeEach(() => {
        navigate.mockReset();
        rememberReturnPath.mockReset();
        session.isAuthenticated = true;
        session.isInitialized = false;
        session.isLoading = false;
        session.sessionError = null;
        session.user = { id: 'user-1', email: 'owner@example.com', permissions: ['org:admin'] };
    });

    it('waits for the root bootstrap instead of refreshing when an admin route mounts', async () => {
        const { rerender } = render(
            <ProtectedRoute requiredPermissions={['org:admin']}>
                <div>Admin content</div>
            </ProtectedRoute>,
        );

        expect(screen.getByText('Checking authentication...')).toBeTruthy();
        expect(navigate).not.toHaveBeenCalled();

        session.isInitialized = true;
        rerender(
            <ProtectedRoute requiredPermissions={['org:admin']}>
                <div>Admin content</div>
            </ProtectedRoute>,
        );

        await waitFor(() => expect(screen.getByText('Admin content')).toBeTruthy());
        expect(navigate).not.toHaveBeenCalled();
    });

    it('does not redirect when the auth service is unavailable', async () => {
        session.isAuthenticated = false;
        session.isInitialized = true;
        session.sessionError = { state: 'unavailable', message: 'Network down' };

        render(
            <ProtectedRoute>
                <div>Private content</div>
            </ProtectedRoute>,
        );

        expect(screen.getByText('Unable to verify your session')).toBeTruthy();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('never mounts a protected page while a two-factor policy confines the session', () => {
        session.isInitialized = true;
        session.user = { ...session.user, twoFactorSetupRequired: true } as typeof session.user;
        const mounted = vi.fn();
        function Page() {
            mounted();
            return <div>Admin content</div>;
        }

        render(
            <ProtectedRoute requiredPermissions={['org:admin']}>
                <Page />
            </ProtectedRoute>,
        );

        expect(mounted).not.toHaveBeenCalled();
        expect(screen.getByText('navigate to /security')).toBeTruthy();
    });

    it('renders /security itself while confined, where two-factor gets turned on', () => {
        session.isInitialized = true;
        session.user = { ...session.user, twoFactorSetupRequired: true } as typeof session.user;

        render(
            <ProtectedRoute allowWhileConfined>
                <div>Security page</div>
            </ProtectedRoute>,
        );

        expect(screen.getByText('Security page')).toBeTruthy();
    });
});
