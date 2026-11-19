'use client';

import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { cn } from '@ottabase/ui/lib/utils';

import { Button, type ButtonProps } from './button';
import { useClipboard } from './hooks';

export interface CopyButtonProps extends Omit<ButtonProps, 'value' | 'onClick'> {
    /** The text put on the clipboard. */
    value: string;
    /** What is being copied, for the accessible name ("Copy API key") and the toast. Default "text". */
    label?: string;
    /** Also confirm with a toast ("Copied the API key"), and report a failure. Default false: the icon swap is enough. */
    notify?: boolean;
    /** How long the check mark shows, in ms. Default 1500. */
    timeout?: number;
    /** Called after the copy, with whether it worked. */
    onCopied?: (ok: boolean) => void;
}

/**
 * A button that copies `value` and swaps its icon for a check mark. Icon-only by default (`size="icon-sm"`, ghost);
 * pass children for a labelled button ("Copy link").
 */
const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
    (
        {
            value,
            label = 'text',
            notify = false,
            timeout,
            onCopied,
            children,
            variant = 'ghost',
            size,
            className,
            ...props
        },
        ref,
    ) => {
        const { copy, copied } = useClipboard({ timeout });
        const Icon = copied ? Check : Copy;

        return (
            <Button
                ref={ref}
                type="button"
                variant={variant}
                size={size ?? (children ? 'sm' : 'icon-sm')}
                aria-label={children ? undefined : `Copy ${label}`}
                title={children ? undefined : `Copy ${label}`}
                data-slot="copy-button"
                data-copied={copied || undefined}
                className={cn(className)}
                onClick={async () => {
                    const ok = await copy(value);
                    if (notify) {
                        if (ok) toast.success(`Copied the ${label}`);
                        else toast.error('Could not copy: select the text instead');
                    }
                    onCopied?.(ok);
                }}
                {...props}
            >
                <Icon className={cn('size-3.5', copied && 'text-success')} aria-hidden="true" />
                {children}
                {/* Announce the result to screen readers without moving focus */}
                <span className="sr-only" aria-live="polite">
                    {copied ? 'Copied' : ''}
                </span>
            </Button>
        );
    },
);
CopyButton.displayName = 'CopyButton';

export { CopyButton };
