'use client';

import * as React from 'react';
import { Check, Eye, EyeOff, X } from 'lucide-react';

import { cn } from '@ottabase/ui/lib/utils';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './input-group';

export interface PasswordRequirement {
    label: string;
    test: (password: string) => boolean;
}

/** The usual checklist: length, upper and lower case, a digit, a symbol. */
export function passwordRequirements(minLength = 8): PasswordRequirement[] {
    return [
        { label: `At least ${minLength} characters`, test: (p) => p.length >= minLength },
        { label: 'One uppercase letter', test: (p) => /[A-Z]/.test(p) },
        { label: 'One lowercase letter', test: (p) => /[a-z]/.test(p) },
        { label: 'One number', test: (p) => /[0-9]/.test(p) },
        { label: 'One special character', test: (p) => /[^A-Za-z0-9\s]/.test(p) },
    ];
}

export interface PasswordInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
    /**
     * Show a live checklist under the field once something is typed. `true` uses `passwordRequirements(minLength ?? 8)`;
     * pass your own list for other rules. Off by default.
     */
    requirements?: boolean | PasswordRequirement[];
    /** Class for the inner `<input>`; `className` styles the group box. */
    inputClassName?: string;
}

/**
 * A password field with a show/hide toggle (a pressed-state button labelled "Show password") and an opt-in rule
 * checklist. Forwards its ref to the `<input>`.
 *
 * Theming hooks: data-slot="password-input" (the group), "password-input-toggle", "password-requirements",
 * "password-requirement" (with data-met).
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
    (
        { requirements, className, inputClassName, value, defaultValue, onChange, disabled, minLength, ...props },
        ref,
    ) => {
        const [visible, setVisible] = React.useState(false);
        const [inner, setInner] = React.useState(String(defaultValue ?? ''));
        const password = value !== undefined ? String(value ?? '') : inner;
        const listId = React.useId();

        const rules = requirements === true ? passwordRequirements(minLength ?? 8) : requirements || null;
        const showRules = Boolean(rules && rules.length > 0 && password.length > 0);

        const field = (
            <InputGroup
                data-slot="password-input"
                data-disabled={disabled ? 'true' : undefined}
                className={rules ? undefined : className}
            >
                <InputGroupInput
                    ref={ref}
                    autoComplete="current-password"
                    {...props}
                    type={visible ? 'text' : 'password'}
                    value={value}
                    defaultValue={defaultValue}
                    minLength={minLength}
                    disabled={disabled}
                    onChange={(event) => {
                        if (value === undefined) setInner(event.target.value);
                        onChange?.(event);
                    }}
                    aria-describedby={
                        showRules
                            ? [props['aria-describedby'], listId].filter(Boolean).join(' ')
                            : props['aria-describedby']
                    }
                    className={inputClassName}
                />
                <InputGroupAddon align="inline-end">
                    <InputGroupButton
                        size="icon-xs"
                        data-slot="password-input-toggle"
                        aria-label="Show password"
                        aria-pressed={visible}
                        disabled={disabled}
                        onClick={() => setVisible((v) => !v)}
                    >
                        {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                    </InputGroupButton>
                </InputGroupAddon>
            </InputGroup>
        );

        if (!rules) return field;

        return (
            <div className={cn('space-y-2', className)}>
                {field}
                {showRules && (
                    <ul id={listId} data-slot="password-requirements" className="space-y-1 text-xs">
                        {rules.map((rule) => {
                            const met = rule.test(password);
                            return (
                                <li
                                    key={rule.label}
                                    data-slot="password-requirement"
                                    data-met={met}
                                    className={cn(
                                        'flex items-center gap-1',
                                        met ? 'text-success' : 'text-muted-foreground',
                                    )}
                                >
                                    {met ? (
                                        <Check className="size-3" aria-hidden />
                                    ) : (
                                        <X className="size-3" aria-hidden />
                                    )}
                                    <span>{rule.label}</span>
                                    <span className="sr-only">{met ? '(met)' : '(not met)'}</span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        );
    },
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
