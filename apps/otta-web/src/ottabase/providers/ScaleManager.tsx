/**
 * Scale Manager
 *
 * Applies the scaleAtom value to document.documentElement.style.fontSize
 * so that all rem-based sizing scales proportionally across the app.
 *
 * scale 1.0  → font-size: 100% (16px default)
 * scale 0.75 → font-size: 75%  (12px)
 * scale 1.25 → font-size: 125% (20px)
 *
 * Also persists the scale to localStorage so it survives page reloads.
 */
import { scaleAtom } from '@/ottabase/state/appState';
import { getStorageValue, setStorageValue } from '@ottabase/ui';
import { useAtom } from 'jotai';
import { useEffect } from 'react';

const SCALE_STORAGE_KEY = 'ottabase.ui-scale';

export function ScaleManager(): null {
    const [scale, setScale] = useAtom(scaleAtom);

    // Hydrate from localStorage on mount
    useEffect(() => {
        const stored = getStorageValue<unknown>(SCALE_STORAGE_KEY, null);
        if (typeof stored === 'number' && stored >= 0.5 && stored <= 2) {
            setScale(stored);
        }
    }, [setScale]);

    // Apply scale to document root and persist (the default 1.0 removes the key)
    useEffect(() => {
        const pct = Math.round(scale * 100);
        document.documentElement.style.fontSize = `${pct}%`;
        setStorageValue(SCALE_STORAGE_KEY, scale === 1.0 ? undefined : scale);

        return () => {
            // Reset on unmount (e.g. HMR)
            document.documentElement.style.fontSize = '';
        };
    }, [scale]);

    return null;
}
