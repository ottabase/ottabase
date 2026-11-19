'use client';

import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from '@ottabase/ui/lib/utils';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './input-group';

/** `#abc`, `abc`, `#aabbcc` → `#aabbcc` (lowercase); anything else → null. */
export function normalizeHex(text: string): string | null {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
    if (!match) return null;
    const hex = match[1].toLowerCase();
    return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`;
}

export interface ColorInputProps extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'value' | 'defaultValue' | 'onChange' | 'type'
> {
    /** A hex color (`#rrggbb`), or `null` for none. Pass it to control the field. */
    value?: string | null;
    defaultValue?: string | null;
    /** Called with a normalised `#rrggbb`, or `null` when cleared. */
    onChange?: (value: string | null) => void;
    /** Preset colors shown as a row of buttons under the field. */
    swatches?: string[];
    /** Show a clear button that sets the value to `null`. */
    clearable?: boolean;
    /** Accessible name for the native picker behind the swatch. Default "Pick a color". */
    pickerLabel?: string;
    /** Class for the inner text `<input>`; `className` styles the outer wrapper. */
    inputClassName?: string;
}

/**
 * A hex color field: a swatch (the native color picker sits invisibly on top of it), the hex as editable text,
 * optional preset swatches and an optional clear. Typed text applies once it is a valid hex; leaving the field
 * with an invalid one puts the last good value back. The ref goes to the text input.
 *
 * Theming hooks: data-slot="color-input", "color-input-swatch", "color-input-picker", "color-input-clear",
 * "color-input-swatches", "color-input-preset" (with data-selected).
 */
const ColorInput = React.forwardRef<HTMLInputElement, ColorInputProps>(
    (
        {
            value,
            defaultValue = null,
            onChange,
            swatches,
            clearable = false,
            pickerLabel = 'Pick a color',
            className,
            inputClassName,
            disabled,
            readOnly,
            placeholder = '#000000',
            onBlur,
            ...props
        },
        ref,
    ) => {
        const [inner, setInner] = React.useState<string | null>(() =>
            defaultValue ? normalizeHex(defaultValue) : null,
        );
        const current = value !== undefined ? (value ? (normalizeHex(value) ?? value) : null) : inner;
        const [draft, setDraft] = React.useState<string | null>(null);
        const locked = Boolean(disabled || readOnly);
        const invalid = draft !== null && draft.trim() !== '' && normalizeHex(draft) === null;

        const commit = (next: string | null) => {
            if (value === undefined) setInner(next);
            if (next !== current) onChange?.(next);
        };

        return (
            <div data-slot="color-input" className={cn('space-y-2', className)}>
                <InputGroup data-disabled={disabled ? 'true' : undefined}>
                    <InputGroupAddon>
                        <span
                            data-slot="color-input-swatch"
                            className={cn(
                                'relative block size-5 overflow-hidden rounded-sm border border-input',
                                !current && 'border-dashed',
                            )}
                            style={current ? { background: current } : undefined}
                        >
                            <input
                                type="color"
                                data-slot="color-input-picker"
                                aria-label={pickerLabel}
                                value={normalizeHex(current ?? '') ?? '#000000'}
                                disabled={locked}
                                onChange={(event) => {
                                    setDraft(null);
                                    commit(normalizeHex(event.target.value));
                                }}
                                className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                            />
                        </span>
                    </InputGroupAddon>
                    <InputGroupInput
                        ref={ref}
                        spellCheck={false}
                        autoComplete="off"
                        {...props}
                        placeholder={placeholder}
                        disabled={disabled}
                        readOnly={readOnly}
                        aria-invalid={invalid || props['aria-invalid']}
                        className={cn('font-mono', inputClassName)}
                        value={draft ?? current ?? ''}
                        onChange={(event) => {
                            const text = event.target.value;
                            setDraft(text);
                            const hex = normalizeHex(text);
                            if (hex) commit(hex);
                            else if (text.trim() === '' && clearable) commit(null);
                        }}
                        onBlur={(event) => {
                            setDraft(null);
                            onBlur?.(event);
                        }}
                    />
                    {clearable && current && !locked && (
                        <InputGroupAddon align="inline-end">
                            <InputGroupButton
                                size="icon-xs"
                                data-slot="color-input-clear"
                                aria-label="Clear color"
                                onClick={() => {
                                    setDraft(null);
                                    commit(null);
                                }}
                            >
                                <X aria-hidden />
                            </InputGroupButton>
                        </InputGroupAddon>
                    )}
                </InputGroup>
                {swatches && swatches.length > 0 && (
                    <div data-slot="color-input-swatches" className="flex flex-wrap gap-1.5">
                        {swatches.map((swatch) => {
                            const hex = normalizeHex(swatch) ?? swatch;
                            const selected = hex === current;
                            return (
                                <button
                                    key={swatch}
                                    type="button"
                                    data-slot="color-input-preset"
                                    data-selected={selected}
                                    aria-label={hex}
                                    aria-pressed={selected}
                                    title={hex}
                                    disabled={locked}
                                    onClick={() => {
                                        setDraft(null);
                                        commit(hex);
                                    }}
                                    className={cn(
                                        'size-5 rounded-full border border-input transition duration-fast ease-theme disabled:cursor-not-allowed disabled:opacity-50',
                                        selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                                    )}
                                    style={{ background: hex }}
                                />
                            );
                        })}
                    </div>
                )}
            </div>
        );
    },
);
ColorInput.displayName = 'ColorInput';

export { ColorInput };
