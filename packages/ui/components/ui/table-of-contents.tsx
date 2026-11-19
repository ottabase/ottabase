'use client';

import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

import { useReducedMotion, useScrollSpy } from './hooks';

/*
 * An "On this page" list of links to headings. The active entry is yours to
 * pass (`activeId`), or the component follows the scroll itself when given a
 * `selector` for the headings (useScrollSpy). A click scrolls smoothly (unless
 * the OS asks for reduced motion) and replaces the URL hash without a router
 * navigation; modified clicks open the link as usual. Parts: toc,
 * toc-title, toc-list, toc-item (data-depth), toc-link (data-active,
 * aria-current); each link carries `--toc-depth` (0 for the shallowest item)
 * for indenting. `unstyled` drops the Tailwind look so a package's own CSS can
 * style the parts.
 */

export interface TableOfContentsItem {
    /** The heading's element id. */
    id: string;
    label: React.ReactNode;
    /** Heading level (2 for h2, …). Indentation is relative to the shallowest item. Default 1. */
    depth?: number;
}

export interface TableOfContentsProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
    items: TableOfContentsItem[];
    /** The active entry, controlled. Leave undefined to follow the scroll through `selector`. */
    activeId?: string | null;
    /** CSS selector for the headings to observe, e.g. `'.prose h2, .prose h3'`. */
    selector?: string;
    /** Re-scan the headings when this changes (the page or the document shown). */
    rescanKey?: unknown;
    /** IntersectionObserver root margin for the scroll spy. */
    rootMargin?: string;
    /** Called after a click scrolled to the heading. */
    onItemClick?: (id: string) => void;
    /** A small heading above the list, e.g. "On this page". */
    title?: React.ReactNode;
    /** Drop the default classes; keep the parts and data attributes. */
    unstyled?: boolean;
}

const TableOfContents = React.forwardRef<HTMLElement, TableOfContentsProps>(
    (
        {
            items,
            activeId,
            selector,
            rescanKey,
            rootMargin,
            onItemClick,
            title,
            unstyled = false,
            className,
            'aria-label': ariaLabel = 'Table of contents',
            ...props
        },
        ref,
    ) => {
        // `:not(*)` matches nothing, so the spy stays idle without a selector
        const [spyId, setSpyId] = useScrollSpy(selector || ':not(*)', { rootMargin, rescanKey });
        const reducedMotion = useReducedMotion();
        const current = activeId === undefined ? spyId : activeId;
        const minDepth = items.reduce((min, item) => Math.min(min, item.depth ?? 1), Infinity);

        if (items.length === 0) return null;

        const go = (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
            // Ctrl/Cmd/Shift/middle click keeps the browser's own behaviour (new tab, new window)
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            // Handle the jump here so a client router never sees the #hash as a navigation
            event.preventDefault();
            setSpyId(id);
            document
                .getElementById(id)
                ?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
            // The address still points at the section (shareable, reload lands there); the router's state is kept
            window.history.replaceState(window.history.state, '', `#${id}`);
            onItemClick?.(id);
        };

        return (
            <nav
                ref={ref}
                aria-label={ariaLabel}
                data-slot="toc"
                className={cn(!unstyled && 'text-sm', className)}
                {...props}
            >
                {title ? (
                    <p
                        data-slot="toc-title"
                        className={cn(
                            !unstyled && 'mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground',
                        )}
                    >
                        {title}
                    </p>
                ) : null}
                <ol data-slot="toc-list" className={cn(!unstyled && 'm-0 flex list-none flex-col p-0')}>
                    {items.map((item, index) => {
                        const depth = item.depth ?? 1;
                        const active = current === item.id;
                        return (
                            <li key={`${item.id}-${index}`} data-slot="toc-item" data-depth={depth}>
                                <a
                                    href={`#${item.id}`}
                                    data-slot="toc-link"
                                    data-active={active || undefined}
                                    aria-current={active ? 'location' : undefined}
                                    style={{ '--toc-depth': depth - minDepth } as React.CSSProperties}
                                    className={cn(
                                        !unstyled &&
                                            'block border-l-2 border-transparent py-1 pe-2 ps-[calc(var(--toc-depth)*0.75rem+0.75rem)] text-muted-foreground no-underline transition-colors hover:text-foreground data-[active]:border-primary data-[active]:text-foreground',
                                    )}
                                    onClick={(event) => go(event, item.id)}
                                >
                                    {item.label}
                                </a>
                            </li>
                        );
                    })}
                </ol>
            </nav>
        );
    },
);
TableOfContents.displayName = 'TableOfContents';

export { TableOfContents };
