/**
 * OttaDate Demo Page
 *
 * Showcases all @ottabase/ottadate picker variants:
 * - DatePicker (single date)
 * - DateRangePicker
 * - DateTimePicker
 * - FuzzyDateTimePicker
 *
 * Uses the controlled React components from @ottabase/ottadate/react.
 */

import {
    encodeFuzzyDateTime,
    getDefaultRangePresets,
    parseFuzzyInput,
    type DateRange,
    type FuzzyDateTime,
} from '@ottabase/ottadate';
import {
    DatePicker,
    DateRangePicker,
    DateTimePicker,
    FuzzyDateTimeCompact,
    FuzzyDateTimePicker,
} from '@ottabase/ottadate/react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@ottabase/ui';
import { useState } from 'react';
import { DemoPageHeader } from '../DemoPageHeader';
// Styles are imported once at the app level or here
import '@ottabase/ottadate/styles.css';

// Built once: an inline getDefaultRangePresets() would hand the picker a new list every render
const RANGE_PRESETS = getDefaultRangePresets();

// ---------------------------------------------------------------------------
// Demo sections
// ---------------------------------------------------------------------------

function DatePickerDemo() {
    const [value, setValue] = useState<number | string | Date | null>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Date Picker</CardTitle>
                <CardDescription>Single date selection. Returns UTC unix timestamp by default.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <DatePicker placeholder="Pick a date…" value={value} onChange={setValue} />
                <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                    {JSON.stringify({ value, type: typeof value }, null, 2)}
                </pre>
            </CardContent>
        </Card>
    );
}

function DatePickerInlineDemo() {
    const [value, setValue] = useState<number | string | Date | null>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Inline Date Picker</CardTitle>
                <CardDescription>Always-visible calendar, no popover trigger.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <DatePicker inline value={value} onChange={setValue} />
                <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                    {value != null ? `Selected: ${value} (unix)` : 'No date selected'}
                </pre>
            </CardContent>
        </Card>
    );
}

function DateRangeDemo() {
    const [range, setRange] = useState<DateRange>({ start: null, end: null });

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Date Range Picker</CardTitle>
                <CardDescription>
                    Two-calendar layout for start/end selection. Click once for start, again for end.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <DateRangePicker placeholder="Select a date range…" value={range} onChange={setRange} />
                <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                    {JSON.stringify(range, null, 2)}
                </pre>
            </CardContent>
        </Card>
    );
}

/** Date Range with preset sidebar + Apply/Cancel flow */
function DateRangePresetsDemo() {
    const [range, setRange] = useState<DateRange>({ start: null, end: null });

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Date Range — Presets</CardTitle>
                <CardDescription>
                    Sidebar with quick-select presets (Today, Last 7 days, etc.) plus Apply / Cancel flow.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <DateRangePicker
                    placeholder="Pick a range…"
                    presets={RANGE_PRESETS}
                    value={range}
                    onChange={setRange}
                />
                <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                    {JSON.stringify(range, null, 2)}
                </pre>
            </CardContent>
        </Card>
    );
}

function DateTimeDemo() {
    const [value, setValue] = useState<number | string | Date | null>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">DateTime Picker</CardTitle>
                <CardDescription>Calendar with time inputs. Combines date and time selection.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <DateTimePicker
                    placeholder="Select date and time…"
                    showSeconds={false}
                    value={value}
                    onChange={setValue}
                />
                <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                    {value != null
                        ? JSON.stringify(
                              {
                                  unix: value,
                                  readable: new Date((value as number) * 1000).toISOString(),
                              },
                              null,
                              2,
                          )
                        : 'No datetime selected'}
                </pre>
            </CardContent>
        </Card>
    );
}

function FuzzyDateTimeDemo() {
    const [fuzzy, setFuzzy] = useState<FuzzyDateTime | null>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Fuzzy DateTime Picker</CardTitle>
                <CardDescription>
                    For dates you only partially remember. Each step asks "when in X?" — name the sub-unit, pick a part
                    chip (early/mid/late, seasons, day-parts), or stop. Precision is derived from how deep you go, and
                    the stored value carries a queryable [earliest, latest] interval. Every change applies immediately.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <FuzzyDateTimePicker placeholder="Select an approximate date…" value={fuzzy} onChange={setFuzzy} />
                {fuzzy && (
                    <div className="space-y-2">
                        <div className="rounded-lg bg-background p-3 text-center text-sm italic ring-1 ring-border">
                            "{fuzzy.label}"
                        </div>
                        <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                            {JSON.stringify(fuzzy, null, 2)}
                        </pre>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function FuzzyDateTimeInlineDemo() {
    const [fuzzy, setFuzzy] = useState<FuzzyDateTime | null>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Fuzzy DateTime (Inline, Decades)</CardTitle>
                <CardDescription>
                    Inline "memory mode": decade opt-in via resolutions, capped at day. Try "Early 1990s", "Summer
                    1998", or "Late May 2010" — part chips are the coarse answer to each "when in X?" step, and the ~
                    toggle marks the whole thing as rough.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <FuzzyDateTimePicker
                    inline
                    resolutions={['decade', 'year', 'month', 'day']}
                    value={fuzzy}
                    onChange={setFuzzy}
                />
                {fuzzy && (
                    <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                        {JSON.stringify(fuzzy, null, 2)}
                    </pre>
                )}
            </CardContent>
        </Card>
    );
}

function FuzzyCompactDemo() {
    const [fuzzy, setFuzzy] = useState<FuzzyDateTime | null>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Fuzzy DateTime (Compact)</CardTitle>
                <CardDescription>
                    Sentence-style native selects that read like the stored label — "Summer · 1998", "Late · May ·
                    2010". "Sometime" is the no-part state; "Any month" / "Any day" stay coarse; the ~ chip marks it
                    rough. Space-efficient for forms and sidebars; auto-applies on change.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <FuzzyDateTimeCompact
                    placeholder="FuzzyDateTime"
                    className="max-w-xs"
                    value={fuzzy}
                    onChange={setFuzzy}
                />
                {fuzzy && (
                    <div className="space-y-2">
                        <div className="rounded-lg bg-background p-3 text-center text-sm italic ring-1 ring-border">
                            "{fuzzy.label}"
                        </div>
                        <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                            {JSON.stringify(fuzzy, null, 2)}
                        </pre>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function FuzzyCompactInlineDemo() {
    const [fuzzy, setFuzzy] = useState<FuzzyDateTime | null>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Fuzzy Compact (Inline)</CardTitle>
                <CardDescription>
                    Inline compact mode capped at day resolution. Minimal footprint for embedded forms.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <FuzzyDateTimeCompact
                    inline
                    resolutions={['year', 'month', 'day']}
                    className="max-w-xs"
                    value={fuzzy}
                    onChange={setFuzzy}
                />
                {fuzzy && (
                    <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                        {JSON.stringify(fuzzy, null, 2)}
                    </pre>
                )}
            </CardContent>
        </Card>
    );
}

/** Type-to-parse: free-text memories → FuzzyDateTime via parseFuzzyInput */
function FuzzyParseDemo() {
    const [input, setInput] = useState('early 90s');
    const parsed = parseFuzzyInput(input);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Type a Memory (parseFuzzyInput)</CardTitle>
                <CardDescription>
                    Free-text front-end to the same vocabulary — try "early 90s", "summer 98", "late may 2010", "21 july
                    2026 9pm", "1996ish", "last night". Strict: anything unrecognized returns null instead of guessing.
                    The full fuzzy picker embeds this as its quick-entry field.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="early 90s · summer 98 · 21 jul 2010…"
                    className="max-w-sm"
                />
                {parsed ? (
                    <div className="space-y-2">
                        <div className="rounded-lg bg-background p-3 text-center text-sm italic ring-1 ring-border">
                            "{parsed.label}" <span className="not-italic text-muted-foreground">·</span>{' '}
                            <code className="not-italic text-xs text-muted-foreground">
                                {encodeFuzzyDateTime(parsed)}
                            </code>
                        </div>
                        <pre className="overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                            {JSON.stringify(parsed, null, 2)}
                        </pre>
                    </div>
                ) : (
                    <div className="rounded-lg bg-background p-3 text-sm text-muted-foreground ring-1 ring-border">
                        {input.trim() ? 'Could not parse that memory.' : 'Type something…'}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function ControlledDemo() {
    const [value, setValue] = useState<number | string | Date | null>(null);
    const [disabled, setDisabled] = useState(false);
    const [log, setLog] = useState<string[]>([]);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-[0.9375rem] font-semibold">Controlled value</CardTitle>
                <CardDescription>
                    The React components are controlled: state outside the picker drives it, and every pick comes back
                    through onChange.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="flex items-start gap-4">
                    <DatePicker
                        className="flex-1"
                        aria-label="Controlled date"
                        disabled={disabled}
                        value={value}
                        onChange={(v) => {
                            setValue(v);
                            setLog((prev) => [...prev.slice(-4), `onChange: ${v}`]);
                        }}
                    />
                    <div className="flex flex-col gap-2 flex-shrink-0">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                // Jan 1 2025 00:00 UTC
                                setValue(1735689600);
                                setLog((prev) => [...prev.slice(-4), 'value = 1735689600 (Jan 1 2025)']);
                            }}
                        >
                            Set Jan 1, 2025
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setValue(null)}>
                            Clear
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setDisabled((d) => !d)}>
                            {disabled ? 'Enable' : 'Disable'}
                        </Button>
                    </div>
                </div>
                <pre className="max-h-32 overflow-auto rounded-lg bg-background p-3 font-mono text-xs ring-1 ring-border">
                    {log.length ? log.join('\n') : 'Interact with the buttons above…'}
                </pre>
            </CardContent>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Main demo page
// ---------------------------------------------------------------------------

export function OttaDateDemoPage() {
    return (
        <div className="space-y-8 max-w-4xl">
            <DemoPageHeader
                title="OttaDate"
                description="Framework-agnostic date picker with range, datetime, and fuzzy date support. All values are UTC unix timestamps by default."
            />

            {/* Date Picker */}
            <DatePickerDemo />

            {/* Inline Date Picker */}
            <DatePickerInlineDemo />

            {/* Date Range Picker */}
            <DateRangeDemo />

            {/* Date Range with Presets */}
            <DateRangePresetsDemo />

            {/* DateTime Picker */}
            <DateTimeDemo />

            {/* Fuzzy DateTime Picker */}
            <FuzzyDateTimeDemo />

            {/* Fuzzy Inline with Limited Options */}
            <FuzzyDateTimeInlineDemo />

            {/* Fuzzy Compact (dropdown-based) */}
            <FuzzyCompactDemo />

            {/* Fuzzy Compact Inline */}
            <FuzzyCompactInlineDemo />

            {/* Type-to-parse */}
            <FuzzyParseDemo />

            {/* Controlled value */}
            <ControlledDemo />
        </div>
    );
}
