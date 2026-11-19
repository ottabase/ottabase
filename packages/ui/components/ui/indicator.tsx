import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

import type { Tone } from './status-language';

/*
 * A dot or a count pinned to a corner of its child (an avatar, an icon, a
 * button). The mark reads the tone map like LiveDot and CountBadge do
 * (data-tone → --t-solid) and is ringed in the surface colour so it stays
 * legible over any child. Parts: indicator (the wrapper), indicator-mark.
 */

export type IndicatorPosition = 'top-end' | 'top-start' | 'bottom-end' | 'bottom-start';

export interface IndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
    /** Content of the mark ("New", "+3"). Without `label` or `count` the mark is a dot. */
    label?: React.ReactNode;
    /** A number for the mark; above `max` it shows "99+". Zero hides the mark unless `showZero`. */
    count?: number;
    /** Highest count shown as is. Default 99. */
    max?: number;
    showZero?: boolean;
    /** Corner of the child. Default top-end (top-right in LTR). */
    position?: IndicatorPosition;
    /** Tone of the mark. Default brand. */
    tone?: Tone;
    /** Pulse the mark (a live process). Stays still under prefers-reduced-motion. */
    processing?: boolean;
    /** Hide the mark, keep the child. */
    disabled?: boolean;
    /** Pixels to move the mark in from the corner, for round children. Default 0 (centred on the corner). */
    offset?: number;
    /** Screen-reader text for the mark, e.g. "3 unread". A dot has no text of its own. */
    indicatorLabel?: string;
}

const POSITION_CLASS: Record<IndicatorPosition, string> = {
    'top-end': '-translate-y-1/2 translate-x-1/2 rtl:-translate-x-1/2',
    'top-start': '-translate-y-1/2 -translate-x-1/2 rtl:translate-x-1/2',
    'bottom-end': 'translate-y-1/2 translate-x-1/2 rtl:-translate-x-1/2',
    'bottom-start': 'translate-y-1/2 -translate-x-1/2 rtl:translate-x-1/2',
};

/** What the mark shows: null hides it, '' is a dot. */
export function indicatorContent({
    label,
    count,
    max = 99,
    showZero = false,
}: Pick<IndicatorProps, 'label' | 'count' | 'max' | 'showZero'>): React.ReactNode | null {
    if (label !== undefined && label !== null && label !== false) return label;
    if (count === undefined) return '';
    if (count <= 0 && !showZero) return null;
    return count > max ? `${max}+` : String(count);
}

const Indicator = React.forwardRef<HTMLSpanElement, IndicatorProps>(
    (
        {
            label,
            count,
            max,
            showZero,
            position = 'top-end',
            tone = 'brand',
            processing = false,
            disabled = false,
            offset = 0,
            indicatorLabel,
            className,
            children,
            ...props
        },
        ref,
    ) => {
        const content = disabled ? null : indicatorContent({ label, count, max, showZero });
        const isDot = content === '';
        const [vertical, horizontal] = position.split('-') as ['top' | 'bottom', 'start' | 'end'];
        const place: React.CSSProperties = {
            [vertical]: offset,
            [horizontal === 'end' ? 'insetInlineEnd' : 'insetInlineStart']: offset,
        };

        return (
            <span ref={ref} data-slot="indicator" className={cn('relative inline-flex w-fit', className)} {...props}>
                {children}
                {content !== null ? (
                    <span
                        data-slot="indicator-mark"
                        data-tone={tone}
                        data-position={position}
                        data-processing={processing || undefined}
                        style={place}
                        className={cn(
                            'pointer-events-none absolute z-10 inline-flex items-center justify-center rounded-full bg-[color:var(--t-solid)] ring-2 ring-background',
                            isDot
                                ? 'size-2.5'
                                : 'h-5 min-w-5 px-1.5 text-[11px] font-bold tabular-nums leading-none text-background',
                            POSITION_CLASS[position],
                        )}
                    >
                        {processing ? (
                            <span
                                aria-hidden="true"
                                className="absolute inset-0 rounded-full bg-[color:var(--t-solid)] opacity-60 motion-safe:animate-ping motion-reduce:hidden"
                            />
                        ) : null}
                        {isDot ? null : (
                            // With an indicatorLabel the label is what a screen reader hears, not the bare number
                            <span className="relative" aria-hidden={indicatorLabel ? true : undefined}>
                                {content}
                            </span>
                        )}
                        {indicatorLabel ? <span className="sr-only">{indicatorLabel}</span> : null}
                    </span>
                ) : null}
            </span>
        );
    },
);
Indicator.displayName = 'Indicator';

export { Indicator };
