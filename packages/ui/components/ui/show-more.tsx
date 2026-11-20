'use client';

import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

import { Button } from './button';
import { useElementSize } from './hooks';

/*
 * Long content clamped to `maxHeight` with a fade, and a "Show more" /
 * "Show less" toggle that appears only when the content is taller than that.
 * (Not "Spoiler": @ottabase/ottarenderer already has a blur-to-reveal
 * Spoiler.) Parts: show-more,
 * show-more-content, show-more-toggle; data-state="expanded|collapsed".
 */

export interface ShowMoreProps extends React.HTMLAttributes<HTMLDivElement> {
    /** Height of the collapsed content, in px. Default 120. */
    maxHeight?: number;
    /** Controlled open state. */
    expanded?: boolean;
    defaultExpanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    /** Toggle text while collapsed. Default "Show more". */
    showLabel?: React.ReactNode;
    /** Toggle text while expanded. Default "Show less". */
    hideLabel?: React.ReactNode;
}

const ShowMore = React.forwardRef<HTMLDivElement, ShowMoreProps>(
    (
        {
            maxHeight = 120,
            expanded: expandedProp,
            defaultExpanded = false,
            onExpandedChange,
            showLabel = 'Show more',
            hideLabel = 'Show less',
            className,
            children,
            ...props
        },
        ref,
    ) => {
        const [innerExpanded, setInnerExpanded] = React.useState(defaultExpanded);
        const expanded = expandedProp ?? innerExpanded;
        const { ref: contentRef, height } = useElementSize<HTMLDivElement>();
        const contentId = React.useId();
        // The inner node is never clamped, so its height is the content's full height
        const overflows = height > maxHeight;
        const clamped = overflows && !expanded;

        const toggle = () => {
            const next = !expanded;
            if (expandedProp === undefined) setInnerExpanded(next);
            onExpandedChange?.(next);
        };

        return (
            <div
                ref={ref}
                data-slot="show-more"
                data-state={expanded ? 'expanded' : 'collapsed'}
                className={cn('flex flex-col items-start gap-1', className)}
                {...props}
            >
                <div
                    id={contentId}
                    data-slot="show-more-content"
                    className={cn(
                        'w-full overflow-hidden',
                        // A mask, not a gradient overlay, so the fade works on any surface
                        clamped && '[mask-image:linear-gradient(to_bottom,black_55%,transparent)]',
                    )}
                    style={clamped ? { maxHeight } : undefined}
                >
                    <div ref={contentRef}>{children}</div>
                </div>
                {overflows ? (
                    <Button
                        type="button"
                        variant="link"
                        size="sm"
                        data-slot="show-more-toggle"
                        aria-expanded={expanded}
                        aria-controls={contentId}
                        className="h-auto px-0 py-0.5"
                        onClick={toggle}
                    >
                        {expanded ? hideLabel : showLabel}
                    </Button>
                ) : null}
            </div>
        );
    },
);
ShowMore.displayName = 'ShowMore';

export { ShowMore };
