// The shared hooks and CopyButton: the behaviour each replaced hand-rolled copy relied on.
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toast } from 'sonner';
import { CopyButton } from '../../components/ui/copy-button';
import {
    getStorageValue,
    mergeRefs,
    parseShortcut,
    setStorageValue,
    useClickOutside,
    useClipboard,
    useDebouncedCallback,
    useDebouncedValue,
    useElementSize,
    useHotkeys,
    useLocalStorage,
    useMediaQuery,
    useMergedRef,
    useReducedMotion,
    useScrollSpy,
} from '../../components/ui/hooks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('parseShortcut', () => {
    it('matches mod as Cmd or Ctrl, exactly', () => {
        expect(parseShortcut('mod+k')(key({ key: 'k', metaKey: true }))).toBe(true);
        expect(parseShortcut('mod+k')(key({ key: 'k', ctrlKey: true }))).toBe(true);
        expect(parseShortcut('mod+k')(key({ key: 'k' }))).toBe(false);
        expect(parseShortcut('/')(key({ key: '/', ctrlKey: true }))).toBe(false);
    });

    it('matches a shifted symbol by its physical key', () => {
        expect(parseShortcut('shift+/')(key({ key: '?', code: 'Slash', shiftKey: true }))).toBe(true);
        expect(parseShortcut('shift+/')(key({ key: '/', code: 'Slash' }))).toBe(false);
    });

    it('matches Shift-uppercased letters and requires alt to match exactly', () => {
        expect(parseShortcut('mod+shift+k')(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBe(true);
        expect(parseShortcut('mod+k')(key({ key: 'k', metaKey: true, altKey: true }))).toBe(false);
    });

    it('rejects an extra Shift on a letter shortcut but tolerates it on a symbol', () => {
        expect(parseShortcut('mod+b')(key({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }))).toBe(false);
        expect(parseShortcut('?')(key({ key: '?', code: 'Slash', shiftKey: true }))).toBe(true);
    });
});

describe('useHotkeys', () => {
    it('fires outside inputs, skips single keys inside them, and still fires mod shortcuts there', () => {
        const slash = vi.fn();
        const modK = vi.fn();
        renderHook(() =>
            useHotkeys([
                ['/', slash],
                ['mod+k', modK],
            ]),
        );
        const input = document.createElement('input');
        document.body.appendChild(input);

        document.dispatchEvent(key({ key: '/', bubbles: true }));
        input.dispatchEvent(key({ key: '/', bubbles: true }));
        input.dispatchEvent(key({ key: 'k', ctrlKey: true, bubbles: true }));

        expect(slash).toHaveBeenCalledTimes(1);
        expect(modK).toHaveBeenCalledTimes(1);
        input.remove();
    });

    it('fires single keys inside inputs with ignoreInEditable: false, and not at all when disabled', () => {
        const escape = vi.fn();
        const { rerender } = renderHook(
            ({ enabled }) => useHotkeys([['escape', escape]], { enabled, ignoreInEditable: false }),
            {
                initialProps: { enabled: true },
            },
        );
        const input = document.createElement('input');
        document.body.appendChild(input);

        input.dispatchEvent(key({ key: 'Escape', bubbles: true }));
        expect(escape).toHaveBeenCalledTimes(1);

        rerender({ enabled: false });
        document.dispatchEvent(key({ key: 'Escape', bubbles: true }));
        expect(escape).toHaveBeenCalledTimes(1);
        input.remove();
    });

    it('calls the latest handler without re-binding', () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = renderHook(({ fn }) => useHotkeys([['k', fn]]), { initialProps: { fn: first } });
        rerender({ fn: second });
        document.dispatchEvent(key({ key: 'k', bubbles: true }));
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});

describe('useClickOutside', () => {
    it('calls the handler for a pointer outside the element only', () => {
        const handler = vi.fn();
        function Box() {
            const ref = React.useRef<HTMLDivElement>(null);
            useClickOutside(ref, handler);
            return (
                <div>
                    <div ref={ref} data-testid="inside" />
                    <div data-testid="outside" />
                </div>
            );
        }
        render(<Box />);
        fireEvent.pointerDown(screen.getByTestId('inside'));
        expect(handler).not.toHaveBeenCalled();
        fireEvent.pointerDown(screen.getByTestId('outside'));
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('treats every ref as inside (menu + trigger) and attaches nothing while disabled', () => {
        const handler = vi.fn();
        function Menu({ open }: { open: boolean }) {
            const trigger = React.useRef<HTMLButtonElement>(null);
            const menu = React.useRef<HTMLDivElement>(null);
            useClickOutside<HTMLElement>([trigger, menu], handler, open);
            return (
                <div>
                    <button ref={trigger} data-testid="trigger" />
                    <div ref={menu} data-testid="menu" />
                    <div data-testid="outside" />
                </div>
            );
        }
        const { rerender } = render(<Menu open />);
        fireEvent.pointerDown(screen.getByTestId('trigger'));
        fireEvent.pointerDown(screen.getByTestId('menu'));
        expect(handler).not.toHaveBeenCalled();

        rerender(<Menu open={false} />);
        fireEvent.pointerDown(screen.getByTestId('outside'));
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('debounce', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('useDebouncedValue settles after the delay', () => {
        const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), { initialProps: { v: 'a' } });
        rerender({ v: 'ab' });
        expect(result.current).toBe('a');
        act(() => vi.advanceTimersByTime(200));
        expect(result.current).toBe('ab');
    });

    it('useDebouncedCallback runs the last call once, and cancel drops it', () => {
        const fn = vi.fn();
        const { result } = renderHook(() => useDebouncedCallback(fn, 100));
        result.current('x');
        result.current('y');
        act(() => vi.advanceTimersByTime(100));
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('y');

        result.current('z');
        result.current.cancel();
        act(() => vi.advanceTimersByTime(100));
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('useDebouncedCallback flushes the pending call now, and drops it on unmount', () => {
        const fn = vi.fn();
        const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 100));
        result.current('now');
        result.current.flush();
        expect(fn).toHaveBeenCalledWith('now');

        result.current('late');
        unmount();
        act(() => vi.advanceTimersByTime(100));
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('useLocalStorage', () => {
    beforeEach(() => localStorage.clear());

    it('stores JSON, syncs hooks on the same key, and removes on undefined', () => {
        const a = renderHook(() => useLocalStorage('prefs', { dense: false }));
        const b = renderHook(() => useLocalStorage('prefs', { dense: false }));

        act(() => a.result.current[1]({ dense: true }));
        expect(JSON.parse(localStorage.getItem('prefs') ?? 'null')).toEqual({ dense: true });
        expect(b.result.current[0]).toEqual({ dense: true });

        act(() => a.result.current[1](undefined));
        expect(localStorage.getItem('prefs')).toBeNull();
        expect(b.result.current[0]).toEqual({ dense: false });
    });

    it('reads an unparsable value as the default', () => {
        localStorage.setItem('theme', 'dark');
        const { result } = renderHook(() => useLocalStorage('theme', 'light'));
        expect(result.current[0]).toBe('light');
        expect(getStorageValue('theme', 'light')).toBe('light');
    });

    it('follows a write from another tab (the storage event)', () => {
        const { result } = renderHook(() => useLocalStorage('density', 'comfortable'));
        localStorage.setItem('density', JSON.stringify('compact'));
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: 'density' }));
        });
        expect(result.current[0]).toBe('compact');
    });

    it('keeps the in-memory value when storage refuses the write', () => {
        const { result } = renderHook(() => useLocalStorage('blocked', 'a'));
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        act(() => result.current[1]('b'));
        spy.mockRestore();
        expect(result.current[0]).toBe('b');
    });

    it('setStorageValue updates mounted hooks', () => {
        const { result } = renderHook(() => useLocalStorage<number>('count', 0));
        act(() => setStorageValue('count', 3));
        expect(result.current[0]).toBe(3);
    });
});

describe('useMediaQuery and useReducedMotion', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('reports the live match and follows change events', () => {
        const listeners = new Set<() => void>();
        const mql = {
            matches: true,
            addEventListener: (_: string, cb: () => void) => listeners.add(cb),
            removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
        };
        const matchMedia = vi.fn(() => mql);
        vi.stubGlobal('matchMedia', matchMedia);

        const { result, unmount } = renderHook(() => useMediaQuery('(max-width: 767px)'));
        expect(result.current).toBe(true);
        mql.matches = false;
        act(() => listeners.forEach((cb) => cb()));
        expect(result.current).toBe(false);
        unmount();
        expect(listeners.size).toBe(0);

        mql.matches = true;
        expect(renderHook(() => useReducedMotion()).result.current).toBe(true);
        expect(matchMedia).toHaveBeenLastCalledWith('(prefers-reduced-motion: reduce)');
    });
});

describe('useElementSize', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('reports the observed content box of the attached element', () => {
        let notify: ((entries: { contentRect: { width: number; height: number } }[]) => void) | undefined;
        const disconnect = vi.fn();
        vi.stubGlobal(
            'ResizeObserver',
            class {
                constructor(cb: typeof notify) {
                    notify = cb;
                }
                observe() {}
                disconnect = disconnect;
            },
        );
        function Box({ onSize }: { onSize: (w: number, h: number) => void }) {
            const { ref, width, height } = useElementSize();
            onSize(width, height);
            return <div ref={ref} />;
        }
        const onSize = vi.fn();
        const { unmount } = render(<Box onSize={onSize} />);
        act(() => notify?.([{ contentRect: { width: 120, height: 40 } }]));
        expect(onSize).toHaveBeenLastCalledWith(120, 40);
        unmount();
        expect(disconnect).toHaveBeenCalled();
    });
});

describe('useScrollSpy', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('observes the matched headings and reports the one that enters view', () => {
        let notify: ((entries: { isIntersecting: boolean; target: Element }[]) => void) | undefined;
        const observed: Element[] = [];
        vi.stubGlobal(
            'IntersectionObserver',
            class {
                constructor(cb: typeof notify) {
                    notify = cb;
                }
                observe(el: Element) {
                    observed.push(el);
                }
                disconnect() {}
            },
        );
        document.body.innerHTML = '<article class="prose"><h2 id="setup">Setup</h2><h2 id="usage">Usage</h2></article>';
        const { result } = renderHook(() => useScrollSpy('.prose h2'));
        expect(observed.map((el) => el.id)).toEqual(['setup', 'usage']);

        act(() => notify?.([{ isIntersecting: true, target: observed[1] }]));
        expect(result.current[0]).toBe('usage');
        document.body.innerHTML = '';
    });
});

describe('mergeRefs', () => {
    it('sets object and callback refs', () => {
        const objectRef = React.createRef<HTMLDivElement>();
        const callback = vi.fn();
        const node = document.createElement('div');
        mergeRefs(objectRef, callback)(node);
        expect(objectRef.current).toBe(node);
        expect(callback).toHaveBeenCalledWith(node);
    });

    it('useMergedRef points a forwarded ref and a local ref at the element', () => {
        const forwarded = React.createRef<HTMLDivElement>();
        let local: React.RefObject<HTMLDivElement | null> | undefined;
        function Box() {
            const own = React.useRef<HTMLDivElement>(null);
            local = own;
            return <div ref={useMergedRef(forwarded, own)} data-testid="box" />;
        }
        render(<Box />);
        expect(forwarded.current).toBe(screen.getByTestId('box'));
        expect(local?.current).toBe(screen.getByTestId('box'));
    });
});

describe('useClipboard and CopyButton', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    beforeEach(() => {
        writeText.mockClear();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    it('useClipboard reports copied, then resets after the timeout', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useClipboard({ timeout: 500 }));
        await act(async () => {
            await result.current.copy('hello');
        });
        expect(writeText).toHaveBeenCalledWith('hello');
        expect(result.current.copied).toBe(true);
        act(() => vi.advanceTimersByTime(500));
        expect(result.current.copied).toBe(false);
        vi.useRealTimers();
    });

    it('useClipboard reports an error when the clipboard rejects', async () => {
        writeText.mockRejectedValueOnce(new Error('denied'));
        const { result } = renderHook(() => useClipboard());
        await act(async () => {
            expect(await result.current.copy('x')).toBe(false);
        });
        expect(result.current.error?.message).toBe('denied');
    });

    it('CopyButton copies its value and names itself after the label', async () => {
        render(<CopyButton value="sk_live_123" label="API key" />);
        const button = screen.getByRole('button', { name: 'Copy API key' });
        expect(button).toHaveAttribute('title', 'Copy API key');
        await act(async () => {
            fireEvent.click(button);
        });
        expect(writeText).toHaveBeenCalledWith('sk_live_123');
        expect(button).toHaveAttribute('data-copied', 'true');
        expect(toast.success).not.toHaveBeenCalled();
    });

    it('CopyButton with notify toasts the result, and reports a failure', async () => {
        vi.mocked(toast.success).mockClear();
        vi.mocked(toast.error).mockClear();
        const onCopied = vi.fn();
        render(<CopyButton value="abc" label="user ID" notify onCopied={onCopied} />);
        const button = screen.getByRole('button', { name: 'Copy user ID' });

        await act(async () => {
            fireEvent.click(button);
        });
        expect(toast.success).toHaveBeenCalledWith('Copied the user ID');
        expect(onCopied).toHaveBeenLastCalledWith(true);

        writeText.mockRejectedValueOnce(new Error('denied'));
        await act(async () => {
            fireEvent.click(button);
        });
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(onCopied).toHaveBeenLastCalledWith(false);
        expect(button).not.toHaveAttribute('data-copied');
    });
});
