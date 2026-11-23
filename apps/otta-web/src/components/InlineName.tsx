/**
 * A name that edits in place: click it, type, and it saves on Enter or when focus leaves.
 * Escape puts the old name back. Shared by /sessions (session names) and /security (passkeys).
 */
import { Spinner } from '@ottabase/ui';
import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export const INLINE_NAME_MAX_LENGTH = 40;

export function InlineName({
    value,
    placeholder,
    onSave,
    label,
    disabled,
    pending,
}: {
    /** The saved name; null shows the placeholder. */
    value: string | null;
    placeholder: string;
    onSave: (name: string) => void;
    /** What is being named, for screen readers: "Session name", "Passkey name". */
    label: string;
    disabled?: boolean;
    /** A save is in flight: shows a spinner and blocks another edit. */
    pending?: boolean;
}) {
    const shown = value ?? placeholder;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(shown);
    const inputRef = useRef<HTMLInputElement>(null);
    // Escape and Enter end the edit before the blur that follows; the blur must not save again.
    const done = useRef(false);

    useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);
    useEffect(() => setDraft(shown), [shown]);

    const finish = (save: boolean) => {
        if (done.current) return;
        done.current = true;
        setEditing(false);
        const next = draft.trim();
        if (save && next && next !== shown) onSave(next);
        else setDraft(shown);
    };

    if (editing) {
        return (
            <input
                ref={inputRef}
                value={draft}
                maxLength={INLINE_NAME_MAX_LENGTH}
                aria-label={label}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => finish(true)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') finish(true);
                    if (e.key === 'Escape') finish(false);
                }}
                className="h-7 w-full rounded-md bg-background px-2 text-sm font-medium ring-1 ring-border focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
        );
    }
    return (
        <button
            type="button"
            disabled={disabled || pending}
            onClick={() => {
                done.current = false;
                setEditing(true);
            }}
            className="group inline-flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-foreground disabled:cursor-not-allowed"
            title="Rename"
            aria-label={`Rename ${shown}`}
        >
            <span className="truncate">{shown}</span>
            {pending ? (
                <Spinner className="h-3 w-3 shrink-0" />
            ) : (
                <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
        </button>
    );
}
