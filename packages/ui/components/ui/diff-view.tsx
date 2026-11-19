import * as React from 'react';

import { cn } from '@ottabase/ui/lib/utils';

import { DataList, DataListItem, DataListLabel, DataListValue } from './data-list';

/*
 * A read-only before/after view, three ways:
 *   - two objects  → a field diff: keys added, removed and changed, old → new
 *   - two strings  → a line diff (a built-in LCS, no dependency)
 *   - `parts`      → changes you computed (e.g. the `diff` package's
 *                    diffWords), shown inline
 * Colours come from the tone map (data-tone green/red → --t-fg/--t-bg).
 * Parts: diff-view (data-mode), diff-field (data-change), diff-line
 * (data-change), diff-part.
 */

export type DiffRecord = Record<string, unknown>;
export type DiffChangeType = 'added' | 'removed' | 'changed' | 'unchanged';

export interface FieldChange {
    key: string;
    type: DiffChangeType;
    before?: unknown;
    after?: unknown;
}

export interface LineChange {
    type: Exclude<DiffChangeType, 'changed'>;
    value: string;
}

/** One inline piece, the shape the `diff` package returns: `{ value, added?, removed? }`. */
export interface DiffPart {
    value: string;
    added?: boolean;
    removed?: boolean;
}

function isEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    // A Date has no own keys, so the key walk below would call any two Dates equal
    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
        ka.length === kb.length &&
        ka.every(
            (k) => Object.prototype.hasOwnProperty.call(b, k) && isEqual((a as DiffRecord)[k], (b as DiffRecord)[k]),
        )
    );
}

/** Field-by-field changes between two records, in the order the keys first appear (before, then new keys). */
export function diffFields(before: DiffRecord | null | undefined, after: DiffRecord | null | undefined): FieldChange[] {
    const a = before ?? {};
    const b = after ?? {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.map((key) => {
        const inA = Object.prototype.hasOwnProperty.call(a, key);
        const inB = Object.prototype.hasOwnProperty.call(b, key);
        if (!inA) return { key, type: 'added', after: b[key] };
        if (!inB) return { key, type: 'removed', before: a[key] };
        return { key, type: isEqual(a[key], b[key]) ? 'unchanged' : 'changed', before: a[key], after: b[key] };
    });
}

// ponytail: plain O(n·m) LCS on the lines between the common prefix and suffix; past this many cells it
// falls back to "all removed, then all added". Swap in a Myers diff if big texts need a real line diff.
const MAX_LCS_CELLS = 4_000_000;

/** A text as lines: '' has none, a final newline ends the last line rather than starting an empty one, CRLF = LF. */
const toLines = (text: string) => (text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/));

/** Line changes from `before` to `after`: unchanged lines, removed lines and added lines, in reading order. */
export function diffLines(before: string, after: string): LineChange[] {
    const a = toLines(before);
    const b = toLines(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const head = a.slice(0, start).map((value) => ({ type: 'unchanged' as const, value }));
    const tail = a.slice(endA).map((value) => ({ type: 'unchanged' as const, value }));
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const middle: LineChange[] = [];

    if (midA.length * midB.length > MAX_LCS_CELLS) {
        midA.forEach((value) => middle.push({ type: 'removed', value }));
        midB.forEach((value) => middle.push({ type: 'added', value }));
        return [...head, ...middle, ...tail];
    }

    // lcs[i][j] = length of the longest common subsequence of midA[i..] and midB[j..]
    const lcs = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
        for (let j = midB.length - 1; j >= 0; j--) {
            lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
        if (midA[i] === midB[j]) {
            middle.push({ type: 'unchanged', value: midA[i] });
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            middle.push({ type: 'removed', value: midA[i++] });
        } else {
            middle.push({ type: 'added', value: midB[j++] });
        }
    }
    while (i < midA.length) middle.push({ type: 'removed', value: midA[i++] });
    while (j < midB.length) middle.push({ type: 'added', value: midB[j++] });
    return [...head, ...middle, ...tail];
}

/** A value on one line: strings as they are, everything else as compact JSON. */
export function formatDiffValue(value: unknown): string {
    if (value === undefined) return '—';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

interface DiffViewBaseProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
    /** Shown when nothing changed. Default "No changes". */
    emptyMessage?: React.ReactNode;
    /** Field mode: list unchanged fields too (muted). Default false. */
    showUnchanged?: boolean;
}

export type DiffViewProps = DiffViewBaseProps &
    (
        | { before: string; after: string; parts?: undefined }
        | { before: DiffRecord | null | undefined; after: DiffRecord | null | undefined; parts?: undefined }
        | { parts: DiffPart[]; before?: undefined; after?: undefined }
    );

const ADDED = 'bg-[color:var(--t-bg)] text-[color:var(--t-fg)] no-underline';
const REMOVED = 'bg-[color:var(--t-bg)] text-[color:var(--t-fg)]';

const Added = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <ins data-tone="green" className={cn(ADDED, 'rounded-[3px] px-0.5', className)}>
        {children}
    </ins>
);
const Removed = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <del data-tone="red" className={cn(REMOVED, 'rounded-[3px] px-0.5', className)}>
        {children}
    </del>
);

const DiffView = React.forwardRef<HTMLDivElement, DiffViewProps>(
    ({ before, after, parts, emptyMessage = 'No changes', showUnchanged = false, className, ...props }, ref) => {
        const empty = (
            <p data-slot="diff-view-empty" className="text-xs italic text-muted-foreground">
                {emptyMessage}
            </p>
        );

        // Inline parts, computed by the caller
        if (parts) {
            const changed = parts.some((part) => part.added || part.removed);
            return (
                <div
                    ref={ref}
                    data-slot="diff-view"
                    data-mode="inline"
                    className={cn('whitespace-pre-wrap break-words', className)}
                    {...props}
                >
                    {changed
                        ? parts.map((part, index) =>
                              part.added ? (
                                  <Added key={index}>{part.value}</Added>
                              ) : part.removed ? (
                                  <Removed key={index}>{part.value}</Removed>
                              ) : (
                                  <span key={index} data-slot="diff-part">
                                      {part.value}
                                  </span>
                              ),
                          )
                        : parts.length
                          ? parts.map((part) => part.value).join('')
                          : empty}
                </div>
            );
        }

        // Two strings: a line diff
        if (typeof before === 'string' || typeof after === 'string') {
            const lines = diffLines(typeof before === 'string' ? before : '', typeof after === 'string' ? after : '');
            const changed = lines.some((line) => line.type !== 'unchanged');
            return (
                <div
                    ref={ref}
                    data-slot="diff-view"
                    data-mode="lines"
                    className={cn('overflow-x-auto rounded-md border border-border font-mono text-xs', className)}
                    {...props}
                >
                    {changed ? (
                        lines.map((line, index) => {
                            const Line = line.type === 'added' ? 'ins' : line.type === 'removed' ? 'del' : 'div';
                            return (
                                <Line
                                    key={index}
                                    data-slot="diff-line"
                                    data-change={line.type}
                                    data-tone={
                                        line.type === 'added' ? 'green' : line.type === 'removed' ? 'red' : undefined
                                    }
                                    className={cn(
                                        'flex whitespace-pre-wrap break-all px-2 py-px no-underline',
                                        line.type !== 'unchanged' && 'bg-[color:var(--t-bg)] text-[color:var(--t-fg)]',
                                    )}
                                >
                                    <span aria-hidden="true" className="w-4 shrink-0 select-none opacity-70">
                                        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                                    </span>
                                    {line.type !== 'unchanged' ? (
                                        <span className="sr-only">{`${line.type}: `}</span>
                                    ) : null}
                                    <span className="min-w-0">{line.value || ' '}</span>
                                </Line>
                            );
                        })
                    ) : (
                        <div className="p-2">{empty}</div>
                    )}
                </div>
            );
        }

        // Two records: a field diff
        const fields = diffFields(before, after).filter((field) => showUnchanged || field.type !== 'unchanged');
        if (!fields.some((field) => field.type !== 'unchanged')) {
            return (
                <div ref={ref} data-slot="diff-view" data-mode="fields" className={className} {...props}>
                    {empty}
                </div>
            );
        }
        return (
            <div ref={ref} data-slot="diff-view" data-mode="fields" className={cn('min-w-0', className)} {...props}>
                <DataList size="sm">
                    {fields.map((field) => (
                        <DataListItem key={field.key} data-slot="diff-field" data-change={field.type}>
                            <DataListLabel className="font-mono">{field.key}</DataListLabel>
                            <DataListValue
                                className={cn(
                                    'break-all font-mono',
                                    field.type === 'unchanged' && 'text-muted-foreground',
                                )}
                            >
                                {field.type === 'added' ? (
                                    <Added>{formatDiffValue(field.after)}</Added>
                                ) : field.type === 'removed' ? (
                                    <Removed>{formatDiffValue(field.before)}</Removed>
                                ) : field.type === 'changed' ? (
                                    <>
                                        <Removed>{formatDiffValue(field.before)}</Removed>
                                        <span aria-hidden="true" className="mx-1 text-muted-foreground">
                                            →
                                        </span>
                                        <span className="sr-only"> changed to </span>
                                        <Added>{formatDiffValue(field.after)}</Added>
                                    </>
                                ) : (
                                    formatDiffValue(field.after)
                                )}
                            </DataListValue>
                        </DataListItem>
                    ))}
                </DataList>
            </div>
        );
    },
);
DiffView.displayName = 'DiffView';

export { DiffView };
