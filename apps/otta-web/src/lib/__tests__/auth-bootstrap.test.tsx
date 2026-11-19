import { renderHook } from '@testing-library/react';
import { Provider } from 'jotai';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { globalStore, organizationIdAtom } from '@/ottabase/state/appState';

// Mutable so a test can sign someone in; hoisted for the vi.mock factory
const { sessionState } = vi.hoisted(() => ({
    sessionState: {
        session: null,
        user: null as Record<string, unknown> | null,
        isAuthenticated: false,
        isInitialized: true,
        isLoading: false,
        sessionError: null,
        login: vi.fn(),
        logout: vi.fn(),
        updateUser: vi.fn(),
        refreshSession: () => {},
    },
}));

vi.mock('@ottabase/auth/react', () => {
    return {
        AUTH_SESSION_INVALIDATED_EVENT: 'ottabase:auth-session-invalidated',
        AUTH_STORAGE_KEY: 'ottabase.auth-session',
        useSession: () => sessionState,
        useSessionBootstrap: () => sessionState,
    };
});

import { useSessionBootstrap } from '../auth';

const CURRENT_ORG_KEY = 'ottabase.current-org-id';
const wrapper = ({ children }: { children: ReactNode }) => <Provider store={globalStore}>{children}</Provider>;

describe('useSessionBootstrap', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionState.user = null;
        sessionState.isAuthenticated = false;
    });

    it('can own app auth state without requiring a QueryClient', () => {
        expect(() => renderHook(() => useSessionBootstrap(), { wrapper })).not.toThrow();
    });

    it('reads the remembered org as JSON when the session has none, and writes it back as JSON', () => {
        localStorage.setItem(CURRENT_ORG_KEY, JSON.stringify('org_1'));
        sessionState.user = { id: 'u1' };
        sessionState.isAuthenticated = true;

        renderHook(() => useSessionBootstrap(), { wrapper });

        expect(globalStore.get(organizationIdAtom)).toBe('org_1');
        expect(localStorage.getItem(CURRENT_ORG_KEY)).toBe(JSON.stringify('org_1'));
    });

    it('stores the session org as JSON, and removes the key when signed out', () => {
        sessionState.user = { id: 'u1', activeOrganizationId: 'org_2' };
        sessionState.isAuthenticated = true;
        const { unmount } = renderHook(() => useSessionBootstrap(), { wrapper });
        expect(localStorage.getItem(CURRENT_ORG_KEY)).toBe(JSON.stringify('org_2'));
        unmount();

        sessionState.user = null;
        sessionState.isAuthenticated = false;
        renderHook(() => useSessionBootstrap(), { wrapper });
        expect(localStorage.getItem(CURRENT_ORG_KEY)).toBeNull();
    });
});
