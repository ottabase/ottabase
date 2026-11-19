// ============================================================
// @ottabase/forms - FormField Component
// ============================================================
// Auto-renders the correct input based on model field metadata
// ============================================================

import { OttaSelect, type OttaSelectItem } from '@ottabase/ottaselect';
import { FileInput } from '@ottabase/ui/file-input';
import { JsonEditor, type JsonValue } from '@ottabase/ui/json-editor';
import { NumberInput } from '@ottabase/ui/number-input';
import { PasswordInput, passwordRequirements } from '@ottabase/ui/password-input';
import { redactErrorForLog } from '@ottabase/utils/http-errors';
import { sanitizeUrl } from '@ottabase/utils/sanitize';
import { formatDateForUser } from '@ottabase/utils/timezone';
import { clsx } from 'clsx';
import { AlertCircle, Calendar } from 'lucide-react';
import React, { useCallback } from 'react';
import { useFormRequest } from '../hooks/useFormRequest';
import type { FormFieldProps, ModelFieldDescriptor } from '../types';

/**
 * FormField - Renders the appropriate input based on field type
 */
export function FormField({
    name,
    label,
    value,
    onChange,
    field,
    error,
    disabled = false,
    className,
    apiBasePath = '/api/ottaorm',
    onBlur,
}: FormFieldProps) {
    const formConfig = field.formConfig || {};
    const uiConfig = field.uiConfig || {};
    const fieldType = formConfig.fieldType || inferFieldType(field);

    const placeholder = formConfig.placeholder || uiConfig.placeholder || `Enter ${label.toLowerCase()}`;
    const helpText = formConfig.helpText || uiConfig.hint;

    const baseInputClasses = clsx(
        'w-full rounded-lg border bg-background px-3 py-2 text-sm text-foreground transition-colors duration-normal',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-transparent',
        error ? 'border-destructive/60' : 'border-border/60 hover:border-border',
        disabled && 'opacity-50 cursor-not-allowed bg-muted/40',
    );

    // Check if value is an object (not null, not array, not Date, not primitive)
    const isObjectValue = React.useMemo(() => {
        if (value === null || value === undefined) return false;
        if (Array.isArray(value)) return false;
        if (value instanceof Date) return false;
        return typeof value === 'object' && value.constructor === Object;
    }, [value]);

    // Use JSON editor when field is explicitly 'json' or when value is an object
    const useJsonEditor = fieldType === 'json' || (isObjectValue && fieldType !== 'readonly');

    const renderField = () => {
        if (useJsonEditor) {
            return (
                <JsonField
                    name={name}
                    value={value}
                    onChange={onChange}
                    disabled={disabled}
                    placeholder={placeholder || '{}'}
                    rows={formConfig.rows || 6}
                    className={clsx(baseInputClasses, 'resize-y min-h-[150px] font-mono')}
                />
            );
        }

        switch (fieldType) {
            case 'editor':
                return (
                    <JsonField
                        name={name}
                        value={value}
                        onChange={onChange}
                        disabled={disabled}
                        placeholder={placeholder || '{}'}
                        rows={formConfig.rows || 10}
                        className={clsx(baseInputClasses, 'resize-y min-h-[220px] font-mono')}
                    />
                );
            case 'textarea':
                return (
                    <textarea
                        id={name}
                        name={name}
                        value={(value as string) || ''}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder}
                        disabled={disabled}
                        rows={formConfig.rows || 4}
                        className={clsx(baseInputClasses, 'resize-y min-h-[100px]')}
                    />
                );

            case 'number':
                return (
                    <NumberInput
                        id={name}
                        name={name}
                        value={toNumberOrNull(value)}
                        onChange={onChange}
                        placeholder={placeholder}
                        disabled={disabled}
                        min={formConfig.min}
                        max={formConfig.max}
                        step={formConfig.step}
                        decimalScale={field.type === 'integer' ? 0 : undefined}
                        aria-invalid={error ? true : undefined}
                    />
                );

            case 'email':
                return (
                    <input
                        type="email"
                        id={name}
                        name={name}
                        value={(value as string) || ''}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder}
                        disabled={disabled}
                        className={baseInputClasses}
                    />
                );

            case 'password':
                return (
                    <PasswordInput
                        id={name}
                        name={name}
                        value={(value as string) || ''}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder}
                        disabled={disabled}
                        autoComplete="new-password"
                        aria-invalid={error ? true : undefined}
                        requirements={
                            formConfig.showPasswordHints ? passwordRequirements(formConfig.min || 8) : undefined
                        }
                    />
                );

            case 'url':
                return (
                    <input
                        type="url"
                        id={name}
                        name={name}
                        value={(value as string) || ''}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder || 'https://'}
                        disabled={disabled}
                        className={baseInputClasses}
                    />
                );

            case 'tel':
                return (
                    <input
                        type="tel"
                        id={name}
                        name={name}
                        value={(value as string) || ''}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder}
                        disabled={disabled}
                        className={baseInputClasses}
                    />
                );

            case 'date':
                return (
                    <div className="relative">
                        <input
                            type="date"
                            id={name}
                            name={name}
                            value={formatDateValue(value)}
                            onChange={(e) => {
                                if (!e.target.value) {
                                    onChange(null);
                                    return;
                                }
                                const [year, month, day] = e.target.value.split('-').map((v) => Number(v));
                                const utcMillis = Date.UTC(year, (month || 1) - 1, day || 1);
                                onChange(new Date(utcMillis));
                            }}
                            disabled={disabled}
                            className={baseInputClasses}
                        />
                        <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    </div>
                );

            case 'datetime':
                return (
                    <input
                        type="datetime-local"
                        id={name}
                        name={name}
                        value={formatDateTimeValue(value)}
                        onChange={(e) => onChange(e.target.value ? new Date(e.target.value) : null)}
                        disabled={disabled}
                        className={baseInputClasses}
                    />
                );

            case 'time':
                return (
                    <input
                        type="time"
                        id={name}
                        name={name}
                        value={(value as string) || ''}
                        onChange={(e) => onChange(e.target.value)}
                        disabled={disabled}
                        className={baseInputClasses}
                    />
                );

            case 'boolean':
                return (
                    <label className="flex items-center gap-3 cursor-pointer">
                        <input
                            type="checkbox"
                            id={name}
                            name={name}
                            checked={Boolean(value)}
                            onChange={(e) => onChange(e.target.checked)}
                            disabled={disabled}
                            className="h-4 w-4 rounded border-border/60 text-primary focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <span className="text-sm text-foreground">{uiConfig.description || label}</span>
                    </label>
                );

            case 'select':
                return (
                    <SelectField
                        value={value}
                        onChange={onChange}
                        field={field}
                        disabled={disabled}
                        placeholder={placeholder}
                        apiBasePath={apiBasePath}
                        mode="single"
                    />
                );

            case 'multiselect':
                return (
                    <SelectField
                        value={value}
                        onChange={onChange}
                        field={field}
                        disabled={disabled}
                        placeholder={placeholder}
                        apiBasePath={apiBasePath}
                        mode="multiple"
                    />
                );

            case 'file':
            case 'image':
                return (
                    <FileField
                        name={name}
                        value={value}
                        onChange={onChange}
                        disabled={disabled}
                        accept={formConfig.accept || (fieldType === 'image' ? 'image/*' : undefined)}
                        maxSize={formConfig.maxSize}
                        isImage={fieldType === 'image'}
                        uploadEndpoint={formConfig.uploadEndpoint}
                    />
                );

            case 'hidden':
                return <input type="hidden" name={name} value={String(value || '')} />;

            case 'readonly':
                return (
                    <div
                        className={clsx(
                            baseInputClasses,
                            'flex min-h-9 items-center border-transparent bg-muted/40 text-muted-foreground',
                        )}
                    >
                        {formatDisplayValue(value, field)}
                    </div>
                );

            case 'input':
            default:
                return (
                    <input
                        type="text"
                        id={name}
                        name={name}
                        value={(value as string) || ''}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder}
                        disabled={disabled}
                        className={baseInputClasses}
                    />
                );
        }
    };

    // Hidden fields don't need labels
    if (fieldType === 'hidden') {
        return renderField();
    }

    return (
        <div className={clsx('space-y-1.5', className)} onBlur={onBlur}>
            {/* Label */}
            {fieldType !== 'boolean' && (
                <label htmlFor={name} className="block text-sm font-medium text-foreground">
                    {label}
                    {field.validation?.rules?.includes('required') && <span className="ml-1 text-destructive">*</span>}
                </label>
            )}

            {/* Field */}
            {renderField()}

            {/* Help text */}
            {helpText && !error && <p className="text-xs leading-relaxed text-muted-foreground">{helpText}</p>}

            {/* Error */}
            {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
    );
}

// ============================================================
// Helper Components
// ============================================================

/**
 * JSON field: wraps `@ottabase/ui/json-editor` JsonEditor (Tree + Raw modes,
 * inline editing, live validation). Used for fieldType 'json' and for
 * arbitrary object values (instead of rendering [Object]).
 *
 * Accepts `unknown` from the form system and normalizes it to a JsonValue:
 * - string: try to parse; fall back to wrapping as `{ value: string }` so
 *   the user always has a tree to edit.
 * - null/undefined: empty object.
 * - object/array/primitive: passed through.
 */
function JsonField({
    value,
    onChange,
    disabled,
    className,
}: {
    name: string;
    value: unknown;
    onChange: (value: unknown) => void;
    disabled: boolean;
    placeholder: string;
    rows: number;
    className: string;
}) {
    // Normalize the incoming value so the editor always has something JSON-shaped
    const normalized: JsonValue = React.useMemo(() => {
        if (value === null || value === undefined) return {};
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed === '') return {};
            try {
                return JSON.parse(trimmed) as JsonValue;
            } catch {
                // Invalid JSON string: keep the raw text under a `value` key so
                // users don't lose their input. They can fix it in Raw mode.
                return { value };
            }
        }
        if (typeof value === 'object') return value as JsonValue;
        // Primitive (number/boolean): wrap so root remains an object
        return { value: value as JsonValue };
    }, [value]);

    return (
        <div className={clsx('min-h-[150px]', className)}>
            <JsonEditor
                value={normalized}
                onChange={(next) => onChange(next)}
                readOnly={disabled}
                collapseAtDepth={2}
            />
        </div>
    );
}

function SelectField({
    value,
    onChange,
    field,
    disabled,
    placeholder,
    apiBasePath,
    mode,
}: {
    value: unknown;
    onChange: (value: unknown) => void;
    field: ModelFieldDescriptor;
    disabled: boolean;
    placeholder: string;
    apiBasePath: string;
    mode: 'single' | 'multiple';
}) {
    const formConfig = field.formConfig || {};
    const relationship = formConfig.relationship;
    const staticOptions = formConfig.options;
    const [fetchError, setFetchError] = React.useState<string | null>(null);
    const request = useFormRequest();
    const requestSequenceRef = React.useRef(0);
    const abortControllerRef = React.useRef<AbortController | null>(null);
    const latestLoadRef = React.useRef<Promise<OttaSelectItem[]> | null>(null);

    React.useEffect(() => {
        return () => {
            requestSequenceRef.current += 1;
            abortControllerRef.current?.abort();
        };
    }, []);

    // Convert value to OttaSelectItem format
    const normalizedValue = React.useMemo(() => {
        if (!value) return null;

        if (mode === 'single') {
            if (typeof value === 'object' && value !== null) {
                return value as OttaSelectItem;
            }
            // If just an ID, we need to find the full item or create a placeholder
            return { id: String(value), name: String(value) };
        }

        if (Array.isArray(value)) {
            return value.map((v) => {
                if (typeof v === 'object' && v !== null) return v as OttaSelectItem;
                return { id: String(v), name: String(v) };
            });
        }

        return null;
    }, [value, mode]);

    // Create fetch function for relationship fields with error handling
    const fetchCollection = useCallback(
        async (searchQuery: string) => {
            if (!relationship) return [];

            const sequence = requestSequenceRef.current + 1;
            requestSequenceRef.current = sequence;
            abortControllerRef.current?.abort();
            const controller = new AbortController();
            abortControllerRef.current = controller;
            setFetchError(null);

            const endpoint = relationship.endpoint || `${apiBasePath}/${relationship.entity}`;
            const params = new URLSearchParams();

            if (searchQuery) {
                params.set('search', searchQuery);
            }

            if (relationship.where) {
                params.set('where', JSON.stringify(relationship.where));
            }

            const loadPromise = (async (): Promise<OttaSelectItem[]> => {
                const url = params.toString() ? `${endpoint}?${params}` : endpoint;
                const data = await request<Record<string, unknown> | Record<string, unknown>[]>(url, {
                    signal: controller.signal,
                });
                const responseData = data as Record<string, unknown>;
                const items = responseData[relationship.entity] || responseData.data || data;

                if (!Array.isArray(items)) {
                    throw new Error(`Invalid response format for ${relationship.entity}`);
                }

                // Spread server fields first so configured canonical identifiers
                // cannot be overwritten by a differently named raw id/name field.
                return items.map((item: Record<string, unknown>) => ({
                    ...item,
                    id: String(item[relationship.valueField || 'id']),
                    name: String(item[relationship.labelField || 'name'] || item.label || item.title || item.id),
                }));
            })();

            const safeLoadPromise = loadPromise.catch((error: unknown) => {
                if (sequence !== requestSequenceRef.current || controller.signal.aborted) {
                    return [];
                }

                const errorMsg = error instanceof Error ? error.message : 'Network error';
                setFetchError(`Failed to load options: ${errorMsg}`);
                console.error(`[OttaForms] Fetch error for ${relationship.entity}:`, redactErrorForLog(error));
                return [];
            });
            latestLoadRef.current = safeLoadPromise;

            const items = await safeLoadPromise;
            if (sequence !== requestSequenceRef.current && latestLoadRef.current) {
                // OttaSelect does not sequence async completions itself. Returning
                // the newest result from stale calls prevents an older request from
                // overwriting the latest search results.
                return latestLoadRef.current;
            }

            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null;
            }
            return items;
        },
        [relationship, apiBasePath, request],
    );

    const handleChange = useCallback(
        (selected: OttaSelectItem | OttaSelectItem[] | null) => {
            if (mode === 'single') {
                // Return just the ID for single select (or full object if needed)
                onChange(selected ? (selected as OttaSelectItem).id : null);
            } else {
                // Return array of IDs for multiselect
                onChange(selected ? (selected as OttaSelectItem[]).map((s) => s.id) : []);
            }
        },
        [mode, onChange],
    );

    return (
        <div className="space-y-1">
            <OttaSelect
                mode={mode}
                value={normalizedValue}
                onChange={handleChange}
                items={staticOptions}
                fetchCollection={relationship ? fetchCollection : undefined}
                placeholder={placeholder}
                disabled={disabled}
                searchable={true}
            />
            {fetchError && (
                <div className="flex items-center gap-1 text-xs text-destructive">
                    <AlertCircle className="h-3 w-3" />
                    <span>{fetchError}</span>
                </div>
            )}
        </div>
    );
}

/**
 * File/image field: `@ottabase/ui` FileInput for picking, size checks and the preview; this keeps the upload to
 * `uploadEndpoint` (when set) and the blob URL of a picked image.
 */
function FileField({
    name,
    value,
    onChange,
    disabled,
    accept,
    maxSize,
    isImage,
    uploadEndpoint,
}: {
    name: string;
    value: unknown;
    onChange: (value: unknown) => void;
    disabled: boolean;
    accept?: string;
    maxSize?: number;
    isImage: boolean;
    /** Custom upload endpoint (e.g. /api/files) */
    uploadEndpoint?: string;
}) {
    const localPreviewRef = React.useRef<string | null>(null);
    const uploadControllerRef = React.useRef<AbortController | null>(null);
    const mountedRef = React.useRef(true);
    const [localPreview, setLocalPreview] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [uploading, setUploading] = React.useState(false);
    const request = useFormRequest();

    const clearLocalPreview = useCallback(() => {
        if (localPreviewRef.current) {
            URL.revokeObjectURL(localPreviewRef.current);
            localPreviewRef.current = null;
        }
        setLocalPreview(null);
    }, []);

    const serverPreview = React.useMemo(() => {
        if (!isImage || typeof value !== 'string' || !value) return null;
        const sanitized = sanitizeUrl(value);
        return sanitized === '#' ? null : sanitized;
    }, [isImage, value]);

    React.useEffect(() => {
        // React StrictMode runs an extra setup/cleanup cycle in development.
        // Reset this flag in setup so a later upload can always leave its
        // loading state after the component's real mount.
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            uploadControllerRef.current?.abort();
            if (localPreviewRef.current) {
                URL.revokeObjectURL(localPreviewRef.current);
                localPreviewRef.current = null;
            }
        };
    }, []);

    const handleFiles = async (files: File[]) => {
        const file = files[0];
        if (!file) return;

        setError(null);

        // Show preview for images
        if (isImage) {
            clearLocalPreview();
            const objectUrl = URL.createObjectURL(file);
            localPreviewRef.current = objectUrl;
            setLocalPreview(objectUrl);
        }

        if (!uploadEndpoint) {
            // No upload endpoint - just pass the File object
            onChange(file);
            return;
        }

        uploadControllerRef.current?.abort();
        const controller = new AbortController();
        uploadControllerRef.current = controller;
        setUploading(true);

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('name', file.name);

            const result = await request<unknown>(uploadEndpoint, {
                method: 'POST',
                body: formData,
                signal: controller.signal,
            });
            onChange(getUploadLocation(result));
        } catch (err) {
            if (controller.signal.aborted) return;
            setError(err instanceof Error ? err.message : 'Upload failed');
            console.error('[OttaForms] File upload error:', redactErrorForLog(err));
            clearLocalPreview();
        } finally {
            if (uploadControllerRef.current === controller) {
                uploadControllerRef.current = null;
            }
            if (mountedRef.current) {
                setUploading(false);
            }
        }
    };

    return (
        <FileInput
            id={name}
            name={name}
            accept={accept}
            maxSize={maxSize}
            disabled={disabled}
            loading={uploading}
            error={error}
            previewUrl={isImage ? localPreview || serverPreview : null}
            placeholder={`Click to upload ${isImage ? 'an image' : 'a file'}`}
            hint={
                uploadEndpoint
                    ? `${accept ? `Accepted: ${accept}. ` : ''}Files will be uploaded automatically`
                    : undefined
            }
            onChange={(files) => void handleFiles(files)}
            onClear={() => {
                clearLocalPreview();
                setError(null);
                onChange(null);
            }}
        />
    );
}

// ============================================================
// Utility Functions
// ============================================================

/** A form value as a number for NumberInput: numbers pass, numeric strings parse, anything else is empty. */
function toNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number') return Number.isNaN(value) ? null : value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}

function getUploadLocation(result: unknown): string {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Upload response must be an object containing url, key, or path');
    }

    const response = result as Record<string, unknown>;
    for (const field of ['url', 'key', 'path'] as const) {
        const value = response[field];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    throw new Error('Upload response is missing a valid url, key, or path');
}

/**
 * Infer field type from model field descriptor
 */
function inferFieldType(field: ModelFieldDescriptor): string {
    // Use explicit formConfig.fieldType if provided
    if (field.formConfig?.fieldType) {
        return field.formConfig.fieldType;
    }

    // Infer from base type
    switch (field.type) {
        case 'boolean':
            return 'boolean';
        case 'number':
        case 'integer':
        case 'float':
            return 'number';
        case 'date':
            return 'date';
        case 'datetime':
            return 'datetime';
        case 'json':
            return 'json';
        case 'array':
            return 'multiselect';
        case 'id':
            return field.primaryKey ? 'readonly' : 'input';
        default:
            return 'input';
    }
}

/**
 * Format date value for input[type="date"]
 */
function formatDateValue(value: unknown): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value as string);
    if (isNaN(date.getTime())) return '';
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Format datetime value for input[type="datetime-local"]
 */
function formatDateTimeValue(value: unknown): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value as string);
    if (isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Format value for display in readonly fields
 */
function formatDisplayValue(value: unknown, field: ModelFieldDescriptor): string {
    if (value === null || value === undefined) return '-';

    switch (field.type) {
        case 'boolean':
            return value ? 'Yes' : 'No';
        case 'date':
            return formatDateForUser(value as string, 'date') || String(value);
        case 'datetime':
            return formatDateForUser(value as string, 'datetime') || String(value);
        case 'json':
            return JSON.stringify(value, null, 2);
        case 'array':
            return Array.isArray(value) ? value.join(', ') : String(value);
        default:
            return String(value);
    }
}

export default FormField;
