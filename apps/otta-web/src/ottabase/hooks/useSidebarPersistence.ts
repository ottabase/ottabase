/**
 * Hook to persist sidebar state to localStorage
 * Loads sidebar state on mount and saves on changes
 */
import { useEffect } from 'react';
import { useAtom } from 'jotai';
import { getStorageValue, setStorageValue } from '@ottabase/ui';
import { sidebarStateAtom, type SidebarState } from '@/ottabase/state/appState';

const STORAGE_KEY = 'ottabase.sidebar-state';

export function useSidebarPersistence(): void {
    const [sidebarState, setSidebarState] = useAtom(sidebarStateAtom);

    // Load from localStorage on mount (blocked storage or a corrupt value keeps the default)
    useEffect(() => {
        const stored = getStorageValue<SidebarState | null>(STORAGE_KEY, null);
        if (stored && typeof stored === 'object') setSidebarState(stored);
    }, [setSidebarState]);

    // Save to localStorage whenever state changes
    useEffect(() => {
        setStorageValue(STORAGE_KEY, sidebarState);
    }, [sidebarState]);
}
