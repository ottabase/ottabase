import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

import { Spinner } from './spinner';

export interface LoadingOverlayProps extends React.HTMLAttributes<HTMLSpanElement> {
    /** Show the overlay. Default true; false renders nothing. */
    visible?: boolean;
    /** Text beside the spinner ("Loading…", "Uploading…"). Without it the spinner stands alone. */
    label?: React.ReactNode;
    /** Blur what is underneath. Default true; false only dims it. */
    blur?: boolean;
}

/**
 * Covers its `relative` parent while something loads: the content stays visible, dimmed and blurred, under a
 * spinner. The root is a `<span>` so it is valid inside a button as well as a div. It is a polite status region;
 * mark the covered region itself with `aria-busy={loading}`.
 */
const LoadingOverlay = React.forwardRef<HTMLSpanElement, LoadingOverlayProps>(
    ({ visible = true, label, blur = true, className, ...props }, ref) => {
        if (!visible) return null;
        return (
            <span
                ref={ref}
                role="status"
                aria-live="polite"
                data-slot="loading-overlay"
                className={cn(
                    'absolute inset-0 z-20 flex items-center justify-center bg-background/60',
                    blur && 'backdrop-blur-[1px]',
                    className,
                )}
                {...props}
            >
                {label ? (
                    <span
                        data-slot="loading-overlay-label"
                        className="inline-flex items-center gap-2 rounded-full bg-background/90 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm ring-1 ring-border"
                    >
                        <Spinner role={undefined} aria-label={undefined} aria-hidden="true" className="size-3.5" />
                        {label}
                    </span>
                ) : (
                    <>
                        <Spinner role={undefined} aria-label={undefined} aria-hidden="true" className="size-5" />
                        <span className="sr-only">Loading</span>
                    </>
                )}
            </span>
        );
    },
);
LoadingOverlay.displayName = 'LoadingOverlay';

export { LoadingOverlay };
