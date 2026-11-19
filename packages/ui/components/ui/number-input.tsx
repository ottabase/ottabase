'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@ottabase/ui/lib/utils';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './input-group';

export interface NumberInputProps extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max' | 'step' | 'prefix'
> {
    /** The number, or `null` when the field is empty. Pass it to control the field. */
    value?: number | null;
    defaultValue?: number | null;
    /** Called with the number (in range, rounded to `decimalScale`), or `null` when the field is cleared. */
    onChange?: (value: number | null) => void;
    min?: number;
    max?: number;
    /** Arrow keys and the stepper buttons move by this much (Shift: ten times). Default 1. */
    step?: number;
    /** Most digits after the decimal point. `0` means whole numbers only. Default: any. */
    decimalScale?: number;
    /** Allow a minus sign. Default: true unless `min >= 0`. */
    allowNegative?: boolean;
    /** Shown before the number, outside the typed text: `$`, `€`. */
    prefix?: React.ReactNode;
    /** Shown after the number: `%`, `ms`, `px`. */
    suffix?: React.ReactNode;
    /** Group thousands while not editing: `true` uses `,`, a string uses that character. */
    thousandSeparator?: boolean | string;
    /** Bring an out-of-range number into range when the field loses focus. Default true. */
    clampOnBlur?: boolean;
    /** Hide the up/down stepper buttons. */
    hideControls?: boolean;
    /** Class for the inner `<input>`; `className` styles the group box. */
    inputClassName?: string;
}

const decimalsOf = (n: number) => {
    const text = String(n);
    const dot = text.indexOf('.');
    return dot === -1 ? 0 : text.length - dot - 1;
};

const round = (n: number, scale: number) => Number(n.toFixed(Math.min(scale, 100)));

/** The number a piece of typed text means: `null` for empty/incomplete text, `NaN` for nonsense. */
export function parseNumberInput(text: string, separator = ''): number | null {
    const cleaned = (separator ? text.split(separator).join('') : text).replace(/\s/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
    return Number(cleaned);
}

/** A number as the field shows it at rest: rounded to `decimalScale`, thousands grouped by `separator`. */
export function formatNumberInput(value: number | null | undefined, decimalScale?: number, separator = ''): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    const text = String(decimalScale === undefined ? value : round(value, decimalScale));
    if (!separator) return text;
    const [int, frac] = text.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
    return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/**
 * A number field: typed freely as text (`inputMode="decimal"`), so it can show a prefix, suffix and grouped
 * thousands. The text the person types stays while they edit; a number in range applies as it is typed, and
 * leaving the field (or Enter) clamps anything else into range. ArrowUp/ArrowDown step (Shift: ×10).
 *
 * `name` goes on a hidden input holding the plain number, so a native form posts `1234.5`, never `$1,234.50`.
 *
 * Theming hooks: data-slot="number-input" (the group), "number-input-control" on the field,
 * "number-input-increment" / "number-input-decrement" on the steppers.
 */
const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
    (
        {
            value,
            defaultValue = null,
            onChange,
            min,
            max,
            step = 1,
            decimalScale,
            allowNegative,
            prefix,
            suffix,
            thousandSeparator,
            clampOnBlur = true,
            hideControls = false,
            className,
            inputClassName,
            name,
            disabled,
            readOnly,
            onBlur,
            onKeyDown,
            ...props
        },
        ref,
    ) => {
        const [inner, setInner] = React.useState<number | null>(defaultValue);
        const current = value !== undefined ? value : inner;
        // The text being typed; null while the field shows the formatted value
        const [draft, setDraft] = React.useState<string | null>(null);

        const separator = thousandSeparator === true ? ',' : thousandSeparator || '';
        const negativeOk = allowNegative ?? !(min !== undefined && min >= 0);
        const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);
        const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

        const commit = (next: number | null) => {
            if (value === undefined) setInner(next);
            if (next !== current) onChange?.(next);
        };

        const settle = () => {
            if (draft === null) return;
            setDraft(null);
            const parsed = parseNumberInput(draft, separator);
            if (parsed === null) return commit(null);
            if (Number.isNaN(parsed)) return;
            const rounded = decimalScale === undefined ? parsed : round(parsed, decimalScale);
            commit(clampOnBlur ? clamp(rounded) : rounded);
        };

        const stepBy = (direction: 1 | -1, multiplier = 1) => {
            if (disabled || readOnly) return;
            const typed = draft === null ? current : parseNumberInput(draft, separator);
            const base = typed === null || Number.isNaN(typed) ? (min ?? 0) : typed;
            const precision = Math.max(decimalsOf(step), decimalsOf(base));
            let next = clamp(round(base + direction * step * multiplier, precision));
            if (decimalScale !== undefined) next = round(next, decimalScale);
            setDraft(null);
            commit(next);
        };

        // Characters the field accepts while typing: digits, one dot, a leading minus, the separator
        const allowed = new RegExp(
            `^${negativeOk ? '-?' : ''}[\\d${separator ? separator.replace(/[\\\]^-]/g, '\\$&') : ''}]*${
                decimalScale === 0 ? '' : `(\\.\\d${decimalScale === undefined ? '*' : `{0,${decimalScale}}`})?`
            }$`,
        );

        const atMax = current !== null && max !== undefined && current >= max;
        const atMin = current !== null && min !== undefined && current <= min;
        const locked = Boolean(disabled || readOnly);

        return (
            <InputGroup data-slot="number-input" data-disabled={disabled ? 'true' : undefined} className={className}>
                {prefix !== undefined && (
                    <InputGroupAddon data-slot="number-input-prefix">
                        <InputGroupText>{prefix}</InputGroupText>
                    </InputGroupAddon>
                )}
                <InputGroupInput
                    ref={ref}
                    {...props}
                    type="text"
                    inputMode={decimalScale === 0 ? 'numeric' : 'decimal'}
                    autoComplete="off"
                    role="spinbutton"
                    aria-valuemin={min}
                    aria-valuemax={max}
                    aria-valuenow={current ?? undefined}
                    data-slot="number-input-control"
                    className={cn('tabular-nums', inputClassName)}
                    disabled={disabled}
                    readOnly={readOnly}
                    value={draft ?? formatNumberInput(current, decimalScale, separator)}
                    onChange={(event) => {
                        const text = event.target.value;
                        if (!allowed.test(text)) return;
                        setDraft(text);
                        const parsed = parseNumberInput(text, separator);
                        if (parsed === null) commit(null);
                        else if (!Number.isNaN(parsed) && inRange(parsed)) commit(parsed);
                    }}
                    onBlur={(event) => {
                        settle();
                        onBlur?.(event);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            stepBy(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey ? 10 : 1);
                        } else if (event.key === 'Enter') {
                            settle();
                        }
                        onKeyDown?.(event);
                    }}
                />
                {suffix !== undefined && (
                    <InputGroupAddon align="inline-end" data-slot="number-input-suffix">
                        <InputGroupText>{suffix}</InputGroupText>
                    </InputGroupAddon>
                )}
                {!hideControls && (
                    <div
                        data-slot="number-input-controls"
                        className="order-last flex h-full flex-col self-stretch border-l border-input"
                    >
                        <button
                            type="button"
                            tabIndex={-1}
                            aria-label="Increment"
                            data-slot="number-input-increment"
                            disabled={locked || atMax}
                            onClick={() => stepBy(1)}
                            className="flex flex-1 items-center justify-center px-1.5 text-muted-foreground transition duration-fast ease-theme hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                        >
                            <ChevronUp className="size-3" aria-hidden />
                        </button>
                        <button
                            type="button"
                            tabIndex={-1}
                            aria-label="Decrement"
                            data-slot="number-input-decrement"
                            disabled={locked || atMin}
                            onClick={() => stepBy(-1)}
                            className="flex flex-1 items-center justify-center border-t border-input px-1.5 text-muted-foreground transition duration-fast ease-theme hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                        >
                            <ChevronDown className="size-3" aria-hidden />
                        </button>
                    </div>
                )}
                {name && <input type="hidden" name={name} value={current ?? ''} disabled={disabled} />}
            </InputGroup>
        );
    },
);
NumberInput.displayName = 'NumberInput';

export { NumberInput };
