import { isEditableTarget, parseShortcut } from '@ottabase/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { Spotlight } from './Spotlight';
import { SpotlightContext } from './context';
import type { SpotlightConfig } from './types';

export interface SpotlightProviderProps extends SpotlightConfig {
    children: React.ReactNode;
}

export function SpotlightProvider({
    children,
    enabled = true,
    shortcuts = ['/'],
    onSearch,
    renderResult,
    renderLoading,
    renderEmpty,
    renderError,
    placeholder,
    emptyMessage,
    loadingMessage,
    errorMessage,
    maxResults,
    searchDebounceMs,
    minQueryLength,
    onQueryChange,
    onResultSelect,
    onOpenChange,
    defaultResults,
}: SpotlightProviderProps) {
    const [open, setOpen] = useState(false);

    const toggle = useCallback(() => {
        setOpen((prev) => !prev);
    }, []);

    // Keyboard shortcut handling
    useEffect(() => {
        if (!enabled) return;

        const handlers = shortcuts.map((shortcut) => ({
            shortcut,
            check: parseShortcut(shortcut),
        }));

        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't trigger if user is typing in an input/textarea/select/contenteditable
            if (isEditableTarget(e.target)) return;

            for (const { check } of handlers) {
                if (check(e)) {
                    e.preventDefault();
                    toggle();
                    break;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [enabled, shortcuts, toggle]);

    const contextValue = React.useMemo(
        () => ({
            open,
            setOpen,
            toggle,
        }),
        [open, toggle],
    );

    return (
        <SpotlightContext.Provider value={contextValue}>
            {children}
            <Spotlight
                open={open}
                onOpenChange={(newOpen) => {
                    setOpen(newOpen);
                    onOpenChange?.(newOpen);
                }}
                onSearch={onSearch}
                renderResult={renderResult}
                renderLoading={renderLoading}
                renderEmpty={renderEmpty}
                renderError={renderError}
                placeholder={placeholder}
                emptyMessage={emptyMessage}
                loadingMessage={loadingMessage}
                errorMessage={errorMessage}
                maxResults={maxResults}
                searchDebounceMs={searchDebounceMs}
                minQueryLength={minQueryLength}
                onQueryChange={onQueryChange}
                onResultSelect={onResultSelect}
                defaultResults={defaultResults}
            />
        </SpotlightContext.Provider>
    );
}
