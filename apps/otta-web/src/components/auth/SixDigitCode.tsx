/**
 * The six-digit authenticator code field. It stays enabled while a code is checked, so a wrong
 * code can be cleared without losing focus; callers guard re-entry themselves. `errorId` points
 * at the visible error so screen readers hear it with the field.
 */
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@ottabase/ui';
import type { Ref } from 'react';

export function SixDigitCode({
    value,
    onChange,
    onComplete,
    inputRef,
    errorId,
    autoFocus,
}: {
    value: string;
    onChange: (value: string) => void;
    onComplete: (value: string) => void;
    inputRef?: Ref<HTMLInputElement>;
    /** Id of the error shown for the last code, if any. */
    errorId?: string;
    autoFocus?: boolean;
}) {
    return (
        <InputOTP
            ref={inputRef}
            maxLength={6}
            value={value}
            onChange={onChange}
            onComplete={onComplete}
            autoFocus={autoFocus}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Six-digit code"
            aria-describedby={errorId}
            aria-invalid={errorId ? true : undefined}
        >
            <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((index) => (
                    <InputOTPSlot key={index} index={index} />
                ))}
            </InputOTPGroup>
        </InputOTP>
    );
}
