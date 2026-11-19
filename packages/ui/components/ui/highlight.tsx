import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

export interface HighlightProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
    /** The text to search in. */
    children: string;
    /** What to pick out, matched case-insensitively. Several terms work; empty ones are ignored. */
    highlight: string | string[];
    /** Classes for each `<mark>`, e.g. `bg-transparent font-semibold` in a picker list. */
    highlightClassName?: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split `text` into `{ text, match }` chunks around every case-insensitive occurrence of the terms. */
export function highlightChunks(text: string, highlight: string | string[]): { text: string; match: boolean }[] {
    const terms = (Array.isArray(highlight) ? highlight : [highlight]).map((term) => term.trim()).filter(Boolean);
    if (!terms.length || !text) return [{ text, match: false }];
    // Longest first, so "react" wins over "re" where both match at one spot
    const pattern = terms
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
    // A capture group keeps the matches in split()'s output, at the odd indexes
    return text
        .split(new RegExp(`(${pattern})`, 'gi'))
        .map((chunk, index) => ({ text: chunk, match: index % 2 === 1 }))
        .filter((chunk) => chunk.text !== '');
}

/** Text with every match of `highlight` wrapped in `<mark>`. Plain text in, so nothing needs sanitizing. */
const Highlight = React.forwardRef<HTMLSpanElement, HighlightProps>(
    ({ children, highlight, highlightClassName, className, ...props }, ref) => (
        <span ref={ref} data-slot="highlight" className={className} {...props}>
            {highlightChunks(children, highlight).map((chunk, index) =>
                chunk.match ? (
                    <mark
                        key={index}
                        data-slot="highlight-mark"
                        className={cn(
                            'rounded-[2px] bg-[hsl(var(--warning-soft))] text-foreground',
                            highlightClassName,
                        )}
                    >
                        {chunk.text}
                    </mark>
                ) : (
                    <React.Fragment key={index}>{chunk.text}</React.Fragment>
                ),
            )}
        </span>
    ),
);
Highlight.displayName = 'Highlight';

export { Highlight };
