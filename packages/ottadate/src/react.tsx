/**
 * @ottabase/ottadate/react — controlled React components over the vanilla pickers.
 *
 * Each component mounts its vanilla picker into a div on the client, pushes new `value`s
 * through the instance setter, and rebuilds the picker only when an option the picker
 * reads once at creation changes (timezone, inline, minDate, maxDate, presets on/off).
 * Import '@ottabase/ottadate/styles.css' once in the app.
 */

import { useEffect, useRef, useState } from 'react';
import type {
    DatePickerOptions,
    DateRangePickerOptions,
    DateTimePickerOptions,
    FuzzyDateTimePickerOptions,
    OttaDateConfig,
    PickerInstance,
} from './core/types';
import { createDatePicker } from './pickers/DatePicker';
import { createDateRangePicker } from './pickers/DateRangePicker';
import { createDateTimePicker } from './pickers/DateTimePicker';
import { createFuzzyDateTimeCompact } from './pickers/FuzzyDateTimeCompact';
import { createFuzzyDateTimePicker } from './pickers/FuzzyDateTimePicker';

type BaseOptions = OttaDateConfig & { value?: unknown; onChange?: (value: never) => void };

/** Attributes forwarded to the picker's trigger button (the root element when inline). */
const TRIGGER_ATTRS = [
    'id',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-invalid',
    'aria-required',
] as const;

type TriggerAttrs = {
    id?: string;
    'aria-label'?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
    'aria-required'?: boolean;
};

export type OttaDatePickerProps<O extends BaseOptions> = Omit<O, 'value' | 'onChange'> &
    TriggerAttrs & {
        /** Controlled value. Omit it to leave the picker uncontrolled. */
        value?: O['value'];
        onChange?: O['onChange'];
        /** Class for the wrapper div the picker mounts into */
        className?: string;
        /** Renders a hidden input carrying the controlled value, for native form posts */
        name?: string;
    };

export type DatePickerProps = OttaDatePickerProps<DatePickerOptions>;
export type DateRangePickerProps = OttaDatePickerProps<DateRangePickerOptions>;
export type DateTimePickerProps = OttaDatePickerProps<DateTimePickerOptions>;
export type FuzzyDateTimePickerProps = OttaDatePickerProps<FuzzyDateTimePickerOptions>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Options the vanilla pickers read once at creation; a change rebuilds the picker. */
function structuralKey(o: OttaDateConfig & { presets?: unknown[] }): string {
    const time = (d?: number | Date) => (d instanceof Date ? d.getTime() : d);
    return JSON.stringify([o.timezone, o.inline, time(o.minDate), time(o.maxDate), Boolean(o.presets?.length)]);
}

/** Shallow, with arrays compared item by item so inline `resolutions={[...]}` stays stable. */
function sameOption(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
    return a === b;
}

function toFormValue(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
}

function definePicker<O extends BaseOptions>(
    create: (container: HTMLElement, options: O) => PickerInstance,
    displayName: string,
) {
    function Picker(props: OttaDatePickerProps<O>) {
        const { value, onChange, className, name, ...rest } = props;
        const attrs: Record<string, unknown> = {};
        const options: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(rest)) {
            if ((TRIGGER_ATTRS as readonly string[]).includes(key)) attrs[key] = v;
            // The vanilla pickers spread options over their defaults, so an explicit undefined would erase one.
            else if (v !== undefined) options[key] = v;
        }
        // Always sent, so turning `disabled` off reaches a live picker.
        options.disabled = Boolean(options.disabled);

        const containerRef = useRef<HTMLDivElement>(null);
        const instanceRef = useRef<PickerInstance | null>(null);
        const appliedRef = useRef<Record<string, unknown>>({});
        const latest = useRef({ value, onChange, options });
        // The value the picker last showed or emitted. `value` is pushed only when it differs from this, so a
        // parent render mid-pick (half a range, picker not yet emitted) never wipes the draft.
        const shownRef = useRef<unknown>(value);
        // Each pick is a fresh object, so it always re-renders: the value effect can snap back to `value`
        // if the parent ignored onChange, and an uncontrolled picker's hidden input gets the pick.
        const [picked, setPicked] = useState<{ value: unknown }>();
        const key = structuralKey(options);

        useEffect(() => {
            latest.current = { value, onChange, options };
        });

        useEffect(() => {
            const { value: initial, options: initialOptions } = latest.current;
            const instance = create(containerRef.current!, {
                ...initialOptions,
                ...(initial !== undefined && { value: initial }),
                onChange: (next: unknown) => {
                    shownRef.current = next;
                    (latest.current.onChange as ((v: unknown) => void) | undefined)?.(next);
                    setPicked({ value: next });
                },
            } as unknown as O);
            instanceRef.current = instance;
            appliedRef.current = initialOptions;
            shownRef.current = initial;
            return () => {
                instance.destroy();
                instanceRef.current = null;
            };
        }, [key]);

        useEffect(() => {
            const instance = instanceRef.current;
            if (!instance) return;

            const changed = Object.keys(options).filter((k) => !sameOption(appliedRef.current[k], options[k]));
            if (changed.length) instance.setOptions(Object.fromEntries(changed.map((k) => [k, options[k]])));
            appliedRef.current = options;

            if (value !== undefined) {
                if (!same(shownRef.current, value)) instance.setValue(value);
                shownRef.current = value;
            }

            const target = instance.element.querySelector('.ottadate-trigger') ?? instance.element;
            for (const attr of TRIGGER_ATTRS) {
                const v = attrs[attr];
                if (v === undefined || v === false) target.removeAttribute(attr);
                else target.setAttribute(attr, String(v));
            }
            if (target === instance.element) return;
            if (options.disabled) target.setAttribute('aria-disabled', 'true');
            else target.removeAttribute('aria-disabled');
        });

        return (
            <>
                <div ref={containerRef} className={className} />
                {name ? (
                    <input type="hidden" name={name} value={toFormValue(value !== undefined ? value : picked?.value)} />
                ) : null}
            </>
        );
    }
    Picker.displayName = displayName;
    return Picker;
}

/** Single date. Value: UTC unix seconds by default (ISO / Date per `timestampFormat`). */
export const DatePicker = definePicker<DatePickerOptions>(createDatePicker, 'DatePicker');
/** Start/end range, with optional preset sidebar (`presets={getDefaultRangePresets()}`). */
export const DateRangePicker = definePicker<DateRangePickerOptions>(createDateRangePicker, 'DateRangePicker');
/** Date plus time (`showSeconds`, `use12Hour`, `minuteStep`). */
export const DateTimePicker = definePicker<DateTimePickerOptions>(createDateTimePicker, 'DateTimePicker');
/** Approximate date with resolution, part-of-period and "roughly" ("Late May 2010"). */
export const FuzzyDateTimePicker = definePicker<FuzzyDateTimePickerOptions>(
    createFuzzyDateTimePicker,
    'FuzzyDateTimePicker',
);
/** Same value as FuzzyDateTimePicker, as sentence-style selects ("Summer · 1998"). */
export const FuzzyDateTimeCompact = definePicker<FuzzyDateTimePickerOptions>(
    createFuzzyDateTimeCompact,
    'FuzzyDateTimeCompact',
);
