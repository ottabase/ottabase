'use client';

import * as React from 'react';
import { AlertCircle, Loader2, Upload, X } from 'lucide-react';

import { cn } from '@ottabase/ui/lib/utils';
import { useMergedRef } from './hooks';

export interface FileInputProps extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'value' | 'defaultValue' | 'onChange' | 'type' | 'placeholder'
> {
    /** Called with the picked files once they pass `maxSize`. */
    onChange?: (files: File[]) => void;
    /** Largest accepted file, in bytes. A bigger pick is refused with a message. */
    maxSize?: number;
    /** Preview a picked image file inside the box. */
    imagePreview?: boolean;
    /**
     * An image URL to preview (an already-saved value, say). When passed, it replaces the automatic preview of the
     * picked file; pass `null` for none. Sanitise untrusted URLs first.
     */
    previewUrl?: string | null;
    /** Called by the remove button; the button only shows when this is set and something is picked or previewed. */
    onClear?: () => void;
    /** Busy state (an upload in flight): shows a spinner and blocks picking. */
    loading?: boolean;
    /** Text in the empty box. Default "Click to choose a file". */
    placeholder?: React.ReactNode;
    /** Extra line under the placeholder. Default: the `accept` list. */
    hint?: React.ReactNode;
    /** An error from outside (a failed upload); shown in place of the size message. */
    error?: string | null;
    /** Class for the outer wrapper. */
    className?: string;
}

/** `1.5 MB`-style size for a byte count. */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A click-to-choose file box. The native input sits inside the `<label>` (visually hidden, still focusable), so
 * keyboard and screen-reader users get the platform picker; the box shows the focus ring. `accept`, `multiple`,
 * `name` and `disabled` go to the native input, which also receives the ref.
 *
 * Theming hooks: data-slot="file-input", "file-input-trigger", "file-input-preview", "file-input-files",
 * "file-input-clear", "file-input-error".
 */
const FileInput = React.forwardRef<HTMLInputElement, FileInputProps>(
    (
        {
            onChange,
            maxSize,
            imagePreview = false,
            previewUrl,
            onClear,
            loading = false,
            placeholder = 'Click to choose a file',
            hint,
            error,
            className,
            accept,
            disabled,
            ...props
        },
        ref,
    ) => {
        const inputRef = React.useRef<HTMLInputElement>(null);
        const mergedRef = useMergedRef(ref, inputRef);
        const [files, setFiles] = React.useState<File[]>([]);
        const [sizeError, setSizeError] = React.useState<string | null>(null);
        const [localUrl, setLocalUrl] = React.useState<string | null>(null);

        React.useEffect(() => {
            if (!imagePreview || previewUrl !== undefined) return;
            const image = files.find((file) => file.type.startsWith('image/'));
            if (!image) return setLocalUrl(null);
            const url = URL.createObjectURL(image);
            setLocalUrl(url);
            return () => URL.revokeObjectURL(url);
        }, [files, imagePreview, previewUrl]);

        const preview = previewUrl !== undefined ? previewUrl : imagePreview ? localUrl : null;
        const blocked = Boolean(disabled || loading);
        const shownError = error || sizeError;

        const clear = () => {
            setFiles([]);
            setSizeError(null);
            if (inputRef.current) inputRef.current.value = '';
            onClear?.();
        };

        return (
            <div
                data-slot="file-input"
                data-disabled={blocked ? 'true' : undefined}
                className={cn('space-y-2', className)}
            >
                <div className="relative">
                    <label
                        data-slot="file-input-trigger"
                        className={cn(
                            'flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-input bg-muted/40 px-4 py-8 text-center transition duration-fast ease-theme hover:bg-muted/70 has-[:focus-visible]:border-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40',
                            preview && 'p-2',
                            shownError && 'border-destructive',
                            blocked && 'cursor-not-allowed opacity-50 hover:bg-muted/40',
                        )}
                    >
                        <input
                            ref={mergedRef}
                            {...props}
                            type="file"
                            accept={accept}
                            disabled={blocked}
                            aria-invalid={shownError ? true : props['aria-invalid']}
                            className="sr-only"
                            onChange={(event) => {
                                const picked = Array.from(event.target.files ?? []);
                                if (picked.length === 0) return;
                                const tooBig = maxSize ? picked.find((file) => file.size > maxSize) : undefined;
                                if (tooBig && maxSize) {
                                    setSizeError(`${tooBig.name} is larger than ${formatFileSize(maxSize)}`);
                                    event.target.value = '';
                                    return;
                                }
                                setSizeError(null);
                                setFiles(picked);
                                onChange?.(picked);
                            }}
                        />
                        {loading ? (
                            <>
                                <Loader2 className="mb-2 size-6 animate-spin text-muted-foreground" aria-hidden />
                                <span className="text-sm text-muted-foreground">Uploading…</span>
                            </>
                        ) : preview ? (
                            <img
                                data-slot="file-input-preview"
                                src={preview}
                                alt="Preview"
                                className="mx-auto max-h-48 rounded-md"
                            />
                        ) : (
                            <>
                                <Upload className="mb-2 size-6 text-muted-foreground" aria-hidden />
                                <span className="text-sm text-muted-foreground">{placeholder}</span>
                                {(hint ?? accept) && (
                                    <span className="mt-1 text-xs text-faint-foreground">
                                        {hint ?? `Accepted: ${accept}`}
                                    </span>
                                )}
                                {files.length > 0 && (
                                    <ul
                                        data-slot="file-input-files"
                                        className="mt-2 space-y-0.5 text-xs text-foreground"
                                    >
                                        {files.map((file) => (
                                            <li key={`${file.name}:${file.size}`}>
                                                {file.name}{' '}
                                                <span className="text-muted-foreground">
                                                    ({formatFileSize(file.size)})
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </>
                        )}
                    </label>
                    {onClear && !blocked && (preview || files.length > 0) && (
                        <button
                            type="button"
                            data-slot="file-input-clear"
                            aria-label="Remove file"
                            onClick={clear}
                            className="absolute right-3 top-3 rounded-full bg-card p-1.5 text-muted-foreground ring-1 ring-border transition duration-fast ease-theme hover:text-destructive"
                        >
                            <X className="size-3.5" aria-hidden />
                        </button>
                    )}
                </div>
                {shownError && (
                    <p
                        data-slot="file-input-error"
                        role="alert"
                        className="flex items-center gap-1 text-xs text-destructive"
                    >
                        <AlertCircle className="size-3.5" aria-hidden />
                        <span>{shownError}</span>
                    </p>
                )}
            </div>
        );
    },
);
FileInput.displayName = 'FileInput';

export { FileInput };
