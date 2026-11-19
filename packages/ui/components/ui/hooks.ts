'use client';

import * as React from 'react';

/**
 * Generic DOM/UI hooks shared by every Ottabase surface. Each one replaces a pattern that used to be hand-rolled in
 * several packages (click-outside listeners, setTimeout debounces, raw localStorage, clipboard state, keydown
 * listeners). All of them are SSR-safe: they touch `window`/`document` only inside effects or event handlers.
 */

/* ---------------------------------------------------------------- clipboard */

export interface UseClipboardOptions {
    /** How long `copied` stays true after a successful copy, in ms. Default 1500. */
    timeout?: number;
}

/** Copy text to the clipboard and expose a short-lived `copied` flag for the "Copied" feedback. */
export function useClipboard({ timeout = 1500 }: UseClipboardOptions = {}) {
    const [copied, setCopied] = React.useState(false);
    const [error, setError] = React.useState<Error | null>(null);
    const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    React.useEffect(() => () => clearTimeout(timer.current), []);

    const reset = React.useCallback(() => {
        clearTimeout(timer.current);
        setCopied(false);
        setError(null);
    }, []);

    const copy = React.useCallback(
        async (text: string): Promise<boolean> => {
            clearTimeout(timer.current);
            try {
                if (!navigator.clipboard) throw new Error('Clipboard API is not available');
                await navigator.clipboard.writeText(text);
                setError(null);
                setCopied(true);
                timer.current = setTimeout(() => setCopied(false), timeout);
                return true;
            } catch (err) {
                setCopied(false);
                setError(err instanceof Error ? err : new Error(String(err)));
                return false;
            }
        },
        [timeout],
    );

    return { copy, copied, error, reset };
}

/* ------------------------------------------------------------ click outside */

type RefLike<T> = React.RefObject<T | null>;

/**
 * Call `handler` when a pointer goes down outside every element in `refs` (a menu and its trigger, say).
 * Pass `enabled: false` while the thing is closed so no listener is attached.
 */
export function useClickOutside<T extends HTMLElement = HTMLElement>(
    refs: RefLike<T> | RefLike<T>[],
    handler: (event: PointerEvent) => void,
    enabled = true,
): void {
    const handlerRef = useLatest(handler);
    const refList = Array.isArray(refs) ? refs : [refs];
    // Refs are stable objects; join them into the dependency list by identity.
    const refsRef = useLatest(refList);

    React.useEffect(() => {
        if (!enabled) return;
        // Pointer events cover mouse, pen and touch; a touchstart listener too would fire twice per tap
        const listener = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            const inside = refsRef.current.some((ref) => ref.current?.contains(target));
            if (!inside) handlerRef.current(event);
        };
        document.addEventListener('pointerdown', listener);
        return () => document.removeEventListener('pointerdown', listener);
    }, [enabled, handlerRef, refsRef]);
}

/* ----------------------------------------------------------------- debounce */

/** The value, settled: it follows `value` only after `delay` ms without a change. */
export function useDebouncedValue<T>(value: T, delay: number): T {
    const [debounced, setDebounced] = React.useState(value);
    React.useEffect(() => {
        const id = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(id);
    }, [value, delay]);
    return debounced;
}

export interface DebouncedFunction<Args extends unknown[]> {
    (...args: Args): void;
    /** Drop the pending call. */
    cancel: () => void;
    /** Run the pending call now, if there is one. */
    flush: () => void;
}

/**
 * A stable function that runs `callback` `delay` ms after the last call. Always calls the latest `callback`, and the
 * pending call is dropped on unmount.
 */
export function useDebouncedCallback<Args extends unknown[]>(
    callback: (...args: Args) => void,
    delay: number,
): DebouncedFunction<Args> {
    const callbackRef = useLatest(callback);
    const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pending = React.useRef<Args | null>(null);

    const debounced = React.useMemo(() => {
        const fn = ((...args: Args) => {
            clearTimeout(timer.current);
            pending.current = args;
            timer.current = setTimeout(() => {
                pending.current = null;
                callbackRef.current(...args);
            }, delay);
        }) as DebouncedFunction<Args>;
        fn.cancel = () => {
            clearTimeout(timer.current);
            pending.current = null;
        };
        fn.flush = () => {
            if (!pending.current) return;
            const args = pending.current;
            fn.cancel();
            callbackRef.current(...args);
        };
        return fn;
    }, [delay, callbackRef]);

    React.useEffect(() => () => debounced.cancel(), [debounced]);
    return debounced;
}

/* ------------------------------------------------------------- localStorage */

const STORAGE_EVENT = 'ottabase:local-storage';

function readStorage<T>(key: string, fallback: T): T {
    if (typeof window === 'undefined') return fallback;
    let raw: string | null;
    try {
        raw = window.localStorage.getItem(key);
    } catch {
        return fallback;
    }
    if (raw === null) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

/** Read a JSON value from localStorage outside React. Returns `fallback` on the server, when missing, unparsable or blocked. */
export function getStorageValue<T>(key: string, fallback: T): T {
    return readStorage(key, fallback);
}

/** Write (or with `undefined`, remove) a JSON value in localStorage outside React. Hooks on the same key update. */
export function setStorageValue<T>(key: string, value: T | undefined): void {
    if (typeof window === 'undefined') return;
    try {
        if (value === undefined) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Private mode or quota: nothing was written, so do not make hooks re-read (they keep their in-memory value).
        return;
    }
    window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: key }));
}

/**
 * State persisted in localStorage as JSON, synced across hooks on the same key and across tabs.
 * Setting `undefined` removes the key; a missing or unparsable value reads as `defaultValue`.
 */
export function useLocalStorage<T>(
    key: string,
    defaultValue: T,
): [T, (value: T | undefined | ((prev: T) => T | undefined)) => void] {
    const [value, setValue] = React.useState<T>(() => readStorage(key, defaultValue));
    const defaultRef = useLatest(defaultValue);
    const valueRef = useLatest(value);

    React.useEffect(() => {
        setValue(readStorage(key, defaultRef.current));
        const sync = (event: Event) => {
            const changedKey = event instanceof StorageEvent ? event.key : (event as CustomEvent<string>).detail;
            if (changedKey === key || changedKey === null) setValue(readStorage(key, defaultRef.current));
        };
        window.addEventListener('storage', sync);
        window.addEventListener(STORAGE_EVENT, sync);
        return () => {
            window.removeEventListener('storage', sync);
            window.removeEventListener(STORAGE_EVENT, sync);
        };
    }, [key, defaultRef]);

    const set = React.useCallback(
        (next: T | undefined | ((prev: T) => T | undefined)) => {
            const resolved = typeof next === 'function' ? (next as (prev: T) => T | undefined)(valueRef.current) : next;
            setValue(resolved === undefined ? defaultRef.current : resolved);
            setStorageValue(key, resolved);
        },
        [key, valueRef, defaultRef],
    );

    return [value, set];
}

/* ------------------------------------------------------------------ hotkeys */

/** Physical-key codes (US layout) for symbol keys, used when Shift changes `e.key` ('/' → '?'). */
const SYMBOL_CODES: Record<string, string> = {
    '/': 'Slash',
    '.': 'Period',
    ',': 'Comma',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    '-': 'Minus',
    '=': 'Equal',
    '`': 'Backquote',
};

function codeFor(key: string): string | undefined {
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return SYMBOL_CODES[key];
}

/**
 * Compile a shortcut such as `'mod+k'`, `'/'`, `'shift+/'` or `'escape'` into a KeyboardEvent matcher.
 * `mod` is Cmd or Ctrl. Mod and Alt must match exactly, so `'/'` does not fire on Ctrl+/. Shift must match exactly
 * for letters and digits (`'mod+b'` does not fire on Cmd+Shift+B); a symbol tolerates it, since `'?'` needs Shift.
 */
export function parseShortcut(shortcut: string): (e: KeyboardEvent) => boolean {
    const parts = shortcut
        .toLowerCase()
        .split('+')
        .map((s) => s.trim());
    const mod = parts.includes('mod');
    const shift = parts.includes('shift');
    const alt = parts.includes('alt');
    const key = parts.find((part) => part !== 'mod' && part !== 'shift' && part !== 'alt');
    const code = key ? codeFor(key) : undefined;

    return (e: KeyboardEvent) => {
        if (!key) return false;
        if (mod !== (e.metaKey || e.ctrlKey) || alt !== e.altKey) return false;
        if (shift ? !e.shiftKey : e.shiftKey && /^[a-z0-9]$/.test(key)) return false;
        if (e.key.toLowerCase() === key) return true;
        // With Shift held, `e.key` is the shifted character ('?' for '/'); match the physical key.
        return shift && code !== undefined && e.code === code;
    };
}

/** True when the event comes from a text field, where single-key shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export type HotkeyHandler = (event: KeyboardEvent) => void;

export interface UseHotkeysOptions {
    /** Attach the listener at all. Default true. */
    enabled?: boolean;
    /**
     * Skip shortcuts while focus is in an input, textarea, select or contenteditable. Default true; shortcuts with
     * `mod` still fire there (Cmd+K from a search box is expected to work).
     */
    ignoreInEditable?: boolean;
    /** Call `preventDefault()` on a matched event. Default true. */
    preventDefault?: boolean;
    /** Listen on this target instead of `document`. */
    target?: Document | HTMLElement | Window | null;
}

/** Bind keyboard shortcuts, e.g. `useHotkeys([['mod+k', open], ['escape', close]])`. */
export function useHotkeys(
    hotkeys: [shortcut: string, handler: HotkeyHandler][],
    { enabled = true, ignoreInEditable = true, preventDefault = true, target }: UseHotkeysOptions = {},
): void {
    const hotkeysRef = useLatest(hotkeys);
    // Only the shortcut strings change the compiled matchers
    const signature = hotkeys.map(([shortcut]) => shortcut).join('|');

    React.useEffect(() => {
        if (!enabled) return;
        const el: Document | HTMLElement | Window = target ?? document;
        const matchers = signature.split('|').map((shortcut) => ({
            check: parseShortcut(shortcut),
            withMod: shortcut.toLowerCase().includes('mod'),
        }));
        const listener = (event: Event) => {
            const e = event as KeyboardEvent;
            matchers.forEach((matcher, index) => {
                if (!matcher.check(e)) return;
                if (ignoreInEditable && !matcher.withMod && isEditableTarget(e.target)) return;
                if (preventDefault) e.preventDefault();
                hotkeysRef.current[index]?.[1](e);
            });
        };
        el.addEventListener('keydown', listener);
        return () => el.removeEventListener('keydown', listener);
    }, [enabled, ignoreInEditable, preventDefault, target, signature, hotkeysRef]);
}

/* ------------------------------------------------------------- media query */

/**
 * Whether a CSS media query matches, e.g. `useMediaQuery('(max-width: 767px)')`. Returns `initialValue` on the server
 * and the first render, then the live value.
 */
export function useMediaQuery(query: string, initialValue = false): boolean {
    const [matches, setMatches] = React.useState(initialValue);
    React.useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mql = window.matchMedia(query);
        const onChange = () => setMatches(mql.matches);
        onChange();
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, [query]);
    return matches;
}

/** True when the user asked the OS for reduced motion. */
export function useReducedMotion(): boolean {
    return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/* ------------------------------------------------------------- element size */

/** Track an element's content box. Attach `ref` to the element; width and height are 0 until it is measured. */
export function useElementSize<T extends HTMLElement = HTMLDivElement>() {
    const [node, setNode] = React.useState<T | null>(null);
    const [size, setSize] = React.useState({ width: 0, height: 0 });

    React.useEffect(() => {
        if (!node || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect)
                setSize((prev) =>
                    prev.width === rect.width && prev.height === rect.height
                        ? prev
                        : { width: rect.width, height: rect.height },
                );
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [node]);

    // A callback ref, so the hook notices an element that mounts later
    const ref = React.useCallback((el: T | null) => setNode(el), []);
    return { ref, width: size.width, height: size.height };
}

/* --------------------------------------------------------------- merge refs */

type PossibleRef<T> = React.Ref<T> | undefined;

/** Point several refs (callback or object) at one element. */
export function mergeRefs<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
    return (node: T | null) => {
        for (const ref of refs) {
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
        }
    };
}

/** `mergeRefs` as a stable callback ref, for a forwarded ref plus a local one. */
export function useMergedRef<T>(...refs: PossibleRef<T>[]): React.RefCallback<T> {
    const refsRef = useLatest(refs);
    return React.useCallback((node: T | null) => mergeRefs(...refsRef.current)(node), [refsRef]);
}

/* --------------------------------------------------------------- scroll spy */

export interface UseScrollSpyOptions {
    /** Passed to IntersectionObserver. Default `'-80px 0px -70% 0px'`: a heading counts once it nears the top. */
    rootMargin?: string;
    /** Re-scan for headings when this changes (the page or document being shown). */
    rescanKey?: unknown;
}

/**
 * The id of the heading currently in view, for a table of contents. `selector` picks the observed elements, e.g.
 * `'.prose h2, .prose h3'`; each needs an `id`.
 */
export function useScrollSpy(
    selector: string,
    { rootMargin = '-80px 0px -70% 0px', rescanKey }: UseScrollSpyOptions = {},
): [activeId: string | null, setActiveId: (id: string | null) => void] {
    const [activeId, setActiveId] = React.useState<string | null>(null);

    React.useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting && entry.target.id) setActiveId(entry.target.id);
                }
            },
            { rootMargin, threshold: 0 },
        );
        document.querySelectorAll(selector).forEach((el) => observer.observe(el));
        return () => observer.disconnect();
    }, [selector, rootMargin, rescanKey]);

    return [activeId, setActiveId];
}

/* ------------------------------------------------------------------ helpers */

/** A ref that always holds the latest value, so effects can read it without re-subscribing. */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
    const ref = React.useRef(value);
    // Updated during render on purpose: listeners read it after the commit
    ref.current = value;
    return ref;
}
