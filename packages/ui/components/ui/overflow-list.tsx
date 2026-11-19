'use client';

import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

import { useElementSize } from './hooks';
import { CountBadge } from './status';

/*
 * One line of items (chips, tags, avatars) that shows as many as fit and folds
 * the rest into "+N". Items are measured in an invisible copy of the row, so
 * real widths count, not guesses; a ResizeObserver re-fits on resize. Until the
 * row has a width (server render, tests) every item shows. Parts:
 * overflow-list, overflow-list-item, overflow-list-overflow. Set the gap with a
 * class (`gap-2`); the measurement reads it back.
 */

export interface OverflowListProps<T> extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    /** What stands in for the hidden items. Default: a CountBadge "+N". */
    renderOverflow?: (hidden: T[]) => React.ReactNode;
    /** Items shown even when they do not fit (the row clips them). Default 0. */
    minVisible?: number;
}

/**
 * How many items fit in `available` px: all of them when the whole row fits, otherwise as many as fit beside the
 * overflow marker (never fewer than `minVisible`).
 */
export function fitCount(
    widths: number[],
    overflowWidth: number,
    gap: number,
    available: number,
    minVisible = 0,
): number {
    const total = widths.reduce((sum, width, index) => sum + width + (index ? gap : 0), 0);
    if (total <= available) return widths.length;
    let used = overflowWidth;
    let count = 0;
    for (const width of widths) {
        // Each item brings its own width and the gap before the next element
        if (used + width + gap > available) break;
        used += width + gap;
        count++;
    }
    return Math.min(widths.length, Math.max(minVisible, count));
}

const defaultOverflow = (hidden: unknown[]) => <CountBadge>{`+${hidden.length}`}</CountBadge>;

export function OverflowList<T>({
    items,
    renderItem,
    renderOverflow = defaultOverflow,
    minVisible = 0,
    className,
    ...props
}: OverflowListProps<T>) {
    const { ref, width } = useElementSize<HTMLDivElement>();
    const measureRef = React.useRef<HTMLDivElement>(null);
    const [visibleCount, setVisibleCount] = React.useState(items.length);

    React.useLayoutEffect(() => {
        const layer = measureRef.current;
        if (!layer || !width) {
            setVisibleCount(items.length);
            return;
        }
        const nodes = Array.from(layer.children) as HTMLElement[];
        const widths = nodes.slice(0, items.length).map((node) => node.getBoundingClientRect().width);
        const overflowWidth = nodes[items.length]?.getBoundingClientRect().width ?? 0;
        const gap = parseFloat(getComputedStyle(layer).columnGap) || 0;
        setVisibleCount(fitCount(widths, overflowWidth, gap, width, minVisible));
        // The renderers are deps too: a new renderer can change the widths
    }, [width, items, renderItem, renderOverflow, minVisible]);

    const shown = items.slice(0, visibleCount);
    const hidden = items.slice(visibleCount);
    const wrap = (item: T, index: number) => (
        <div key={index} data-slot="overflow-list-item" className="flex shrink-0">
            {renderItem(item, index)}
        </div>
    );

    return (
        <div
            ref={ref}
            data-slot="overflow-list"
            data-overflowing={hidden.length > 0 || undefined}
            className={cn('relative flex min-w-0 items-center gap-1 overflow-hidden', className)}
            {...props}
        >
            {shown.map(wrap)}
            {hidden.length > 0 ? (
                <div data-slot="overflow-list-overflow" className="flex shrink-0">
                    {renderOverflow(hidden)}
                </div>
            ) : null}
            {/* The measuring row: every item plus the widest marker, invisible and out of the accessibility tree */}
            {width > 0 ? (
                <div
                    ref={measureRef}
                    aria-hidden="true"
                    inert
                    className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center"
                    style={{ columnGap: 'inherit' }}
                >
                    {items.map(wrap)}
                    <div className="flex shrink-0">{renderOverflow(items)}</div>
                </div>
            ) : null}
        </div>
    );
}
