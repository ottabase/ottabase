import { sanitizeUrl } from '@ottabase/utils/sanitize';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { DocGroup, DocsConfig, DocsSearch, DocsSearchHit, DocsTheme } from '../types';
import { buildPageSlug, headingId, organizePages } from '../utils';

interface DocsSidebarProps {
    config: DocsConfig;
    activeSlug?: string;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    /** `headingId` is set when a full-text hit should open its page at that heading. */
    onNavigate: (slug: string, headingId?: string) => void;
    currentTheme?: DocsTheme;
    onThemeChange?: (theme: DocsTheme) => void;
    className?: string;
}

const THEMES: { theme: DocsTheme; label: string; symbol: string }[] = [
    { theme: 'compact', label: 'Compact', symbol: '−' },
    { theme: 'standard', label: 'Standard', symbol: '·' },
    { theme: 'spacious', label: 'Spacious', symbol: '+' },
];

/** Full-text search is metered: wait for a real query and for typing to stop. */
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 400;

interface RemoteSearchState {
    status: 'idle' | 'loading' | 'done' | 'error';
    hits: DocsSearchHit[];
}

const IDLE: RemoteSearchState = { status: 'idle', hits: [] };

/** Debounced `config.search`: one call per pause in typing, the previous one aborted. */
function useRemoteSearch(search: DocsSearch | undefined, query: string): RemoteSearchState {
    const [state, setState] = useState<RemoteSearchState>(IDLE);
    // Held in a ref so a config rebuilt on every render does not re-fire the (metered) search.
    const searchRef = useRef(search);
    searchRef.current = search;
    const enabled = Boolean(search);

    useEffect(() => {
        if (!enabled || query.length < SEARCH_MIN_CHARS) {
            setState(IDLE);
            return;
        }
        // Keep the previous hits on screen while the next query settles, so the list does not flicker.
        setState((prev) => ({ status: 'loading', hits: prev.hits }));
        const controller = new AbortController();
        const timer = setTimeout(() => {
            const run = searchRef.current;
            if (!run) return;
            run(query, controller.signal).then(
                (hits) => {
                    if (!controller.signal.aborted) setState({ status: 'done', hits });
                },
                () => {
                    // An aborted call is a superseded query, not a failure.
                    if (!controller.signal.aborted) setState({ status: 'error', hits: [] });
                },
            );
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [enabled, query]);

    return state;
}

export const DocsSidebar = memo(function DocsSidebar({
    config,
    activeSlug,
    searchQuery,
    onSearchChange,
    onNavigate,
    currentTheme,
    onThemeChange,
    className = '',
}: DocsSidebarProps) {
    const groups = useMemo<DocGroup[]>(() => {
        const all = organizePages(config.sources);
        if (!searchQuery.trim()) return all;

        const query = searchQuery.toLowerCase();
        return all
            .map((group) => ({
                ...group,
                pages: group.pages.filter((page) => page.title.toLowerCase().includes(query)),
            }))
            .filter((group) => group.pages.length > 0);
    }, [config.sources, searchQuery]);

    const remote = useRemoteSearch(config.search, searchQuery.trim());
    const showRemote = remote.status !== 'idle';
    const remoteHits = remote.hits.filter((hit) => hit.slug || hit.href);

    const getFullSlug = (page: { slug: string }) => {
        for (const source of config.sources) {
            const found = source.pages.find((p) => p.slug === page.slug);
            if (found) return buildPageSlug(source, found);
        }
        return page.slug;
    };

    return (
        <aside className={`otta-docs-sidebar ${className}`}>
            {/* Search */}
            <div className="otta-docs-sidebar-search">
                <div className="otta-docs-search-wrap">
                    <input
                        type="text"
                        placeholder="Search docs..."
                        aria-label="Search documentation"
                        value={searchQuery}
                        onChange={(e) => onSearchChange(e.target.value)}
                        className="otta-docs-search-input"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            className="otta-docs-search-clear"
                            aria-label="Clear search"
                            onClick={() => onSearchChange('')}
                        >
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                                <path
                                    d="M1 1l10 10M11 1L1 11"
                                    stroke="currentColor"
                                    strokeWidth="1.75"
                                    strokeLinecap="round"
                                />
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            {/* Navigation groups */}
            <nav className="otta-docs-sidebar-nav">
                {groups.map((group) => (
                    <div key={group.label} className="otta-docs-nav-group">
                        <p className="otta-docs-nav-group-label">{group.label}</p>
                        <ul className="otta-docs-nav-list">
                            {group.pages.map((page) => {
                                const fullSlug = getFullSlug(page);
                                const isActive = activeSlug === fullSlug || activeSlug === page.slug;
                                return (
                                    <li key={page.slug}>
                                        <button
                                            type="button"
                                            className={`otta-docs-nav-link ${isActive ? 'otta-docs-nav-active' : ''}`}
                                            onClick={() => onNavigate(fullSlug)}
                                        >
                                            {page.title}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ))}

                {/* Full-text hits (config.search), under the title matches */}
                {showRemote && (
                    <div
                        className="otta-docs-nav-group otta-docs-search-results"
                        aria-live="polite"
                        aria-busy={remote.status === 'loading'}
                    >
                        <p className="otta-docs-nav-group-label">Found in the text</p>
                        {remoteHits.length > 0 ? (
                            <ul className="otta-docs-nav-list">
                                {remoteHits.map((hit, i) => {
                                    const label = (
                                        <>
                                            <span className="otta-docs-search-hit-title">
                                                {hit.title}
                                                {hit.heading && hit.heading !== hit.title ? ` › ${hit.heading}` : ''}
                                            </span>
                                            {hit.excerpt && (
                                                <span className="otta-docs-search-hit-excerpt">{hit.excerpt}</span>
                                            )}
                                        </>
                                    );
                                    return (
                                        <li key={`${hit.slug ?? hit.href}-${i}`}>
                                            {hit.slug ? (
                                                <button
                                                    type="button"
                                                    className="otta-docs-nav-link otta-docs-search-hit"
                                                    onClick={() =>
                                                        onNavigate(
                                                            hit.slug!,
                                                            hit.heading ? headingId(hit.heading) : undefined,
                                                        )
                                                    }
                                                >
                                                    {label}
                                                </button>
                                            ) : (
                                                <a
                                                    href={sanitizeUrl(hit.href)}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="otta-docs-nav-link otta-docs-search-hit"
                                                >
                                                    {label}
                                                </a>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <p className="otta-docs-search-status">
                                {remote.status === 'loading'
                                    ? 'Searching…'
                                    : remote.status === 'error'
                                      ? 'Text search is unavailable right now.'
                                      : 'No matches in the text.'}
                            </p>
                        )}
                    </div>
                )}
            </nav>

            {/* Subtle layout switcher (compact / standard / spacious) */}
            {currentTheme != null && onThemeChange && (
                <div className="otta-docs-theme-switcher" role="group" aria-label="Layout density">
                    {THEMES.map(({ theme, label, symbol }) => (
                        <button
                            key={theme}
                            type="button"
                            title={label}
                            aria-pressed={currentTheme === theme}
                            className={`otta-docs-theme-btn ${currentTheme === theme ? 'otta-docs-theme-btn-active' : ''}`}
                            onClick={() => onThemeChange(theme)}
                        >
                            {symbol}
                        </button>
                    ))}
                </div>
            )}
        </aside>
    );
});
