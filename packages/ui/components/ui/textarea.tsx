import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    /**
     * Grow with the content (CSS `field-sizing: content`, no JS measuring). Browsers without field-sizing keep a
     * fixed-height textarea.
     */
    autosize?: boolean;
    /** With `autosize`: the smallest height, in lines. */
    minRows?: number;
    /** With `autosize`: the tallest it grows, in lines, before it scrolls. */
    maxRows?: number;
}

// py-2 (1rem) plus the 1px border top and bottom, so `n` rows means n lines of text
const rowsHeight = (rows: number) => `calc(${rows}lh + 1rem + 2px)`;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, autosize = false, minRows, maxRows, style, ...props }, ref) => {
        return (
            <textarea
                data-slot="textarea"
                data-autosize={autosize ? 'true' : undefined}
                className={cn(
                    'flex min-h-[88px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm leading-normal text-foreground shadow-xs transition duration-fast ease-theme placeholder:text-faint-foreground hover:border-faint-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-faint-foreground aria-[invalid=true]:border-destructive',
                    autosize && 'field-sizing-content resize-none',
                    className,
                )}
                style={
                    autosize && (minRows || maxRows)
                        ? {
                              ...(minRows ? { minHeight: rowsHeight(minRows) } : null),
                              ...(maxRows ? { maxHeight: rowsHeight(maxRows) } : null),
                              ...style,
                          }
                        : style
                }
                ref={ref}
                {...props}
            />
        );
    },
);
Textarea.displayName = 'Textarea';

export { Textarea };
