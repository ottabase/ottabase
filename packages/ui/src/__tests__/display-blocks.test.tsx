// DataList, LoadingOverlay, Indicator, Highlight, ShowMore, OverflowList, TableOfContents and DiffView.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataList, DataListItem, DataListLabel, DataListValue } from '../../components/ui/data-list';
import { DiffView, diffFields, diffLines } from '../../components/ui/diff-view';
import { Highlight, highlightChunks } from '../../components/ui/highlight';
import { Indicator, indicatorContent } from '../../components/ui/indicator';
import { LoadingOverlay } from '../../components/ui/loading-overlay';
import { OverflowList, fitCount } from '../../components/ui/overflow-list';
import { ShowMore } from '../../components/ui/show-more';
import { TableOfContents } from '../../components/ui/table-of-contents';

const OriginalResizeObserver = globalThis.ResizeObserver;
afterEach(() => {
    globalThis.ResizeObserver = OriginalResizeObserver;
});

/** A ResizeObserver that reports `width` × `height` for whatever it observes. */
const measureAs = (height: number, width = 300) => {
    globalThis.ResizeObserver = class {
        constructor(private callback: ResizeObserverCallback) {}
        observe() {
            this.callback(
                [{ contentRect: { width, height } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
            );
        }
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
};

describe('<DataList>', () => {
    it('is a <dl> of dt/dd pairs with its orientation stamped', () => {
        render(
            <DataList orientation="vertical" aria-label="Facts">
                <DataListItem>
                    <DataListLabel>Release</DataListLabel>
                    <DataListValue>1.4.2</DataListValue>
                </DataListItem>
            </DataList>,
        );
        const list = screen.getByLabelText('Facts');
        expect(list.tagName).toBe('DL');
        expect(list).toHaveAttribute('data-orientation', 'vertical');
        expect(screen.getByText('Release').tagName).toBe('DT');
        expect(screen.getByText('1.4.2').tagName).toBe('DD');
    });
});

describe('<LoadingOverlay>', () => {
    it('is a status region while visible and renders nothing when not', () => {
        const { rerender } = render(<LoadingOverlay label="Uploading…" />);
        expect(screen.getByRole('status')).toHaveTextContent('Uploading…');
        // The spinner inside is decoration, so there is one status, not two
        expect(screen.getAllByRole('status')).toHaveLength(1);
        rerender(<LoadingOverlay visible={false} />);
        expect(screen.queryByRole('status')).toBeNull();
        rerender(<LoadingOverlay />);
        expect(screen.getByRole('status')).toHaveTextContent('Loading');
    });
});

describe('<Indicator>', () => {
    it('caps counts at max, hides zero and falls back to a dot', () => {
        expect(indicatorContent({ count: 120 })).toBe('99+');
        expect(indicatorContent({ count: 5, max: 9 })).toBe('5');
        expect(indicatorContent({ count: 0 })).toBeNull();
        expect(indicatorContent({ count: 0, showZero: true })).toBe('0');
        expect(indicatorContent({})).toBe('');
        expect(indicatorContent({ label: 'New', count: 3 })).toBe('New');
    });

    it('pins the mark to its child and drops it when disabled', () => {
        const { container, rerender } = render(
            <Indicator count={3} tone="red" position="bottom-start" processing indicatorLabel="3 unread">
                <button type="button">Inbox</button>
            </Indicator>,
        );
        const mark = container.querySelector('[data-slot="indicator-mark"]')!;
        expect(mark).toHaveAttribute('data-tone', 'red');
        expect(mark).toHaveAttribute('data-position', 'bottom-start');
        expect(mark).toHaveAttribute('data-processing');
        expect(screen.getByText('3 unread')).toHaveClass('sr-only');
        rerender(
            <Indicator count={3} disabled>
                <button type="button">Inbox</button>
            </Indicator>,
        );
        expect(container.querySelector('[data-slot="indicator-mark"]')).toBeNull();
        expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    });
});

describe('<Highlight>', () => {
    it('marks every case-insensitive match and escapes regex characters', () => {
        expect(highlightChunks('Hello world', 'O')).toEqual([
            { text: 'Hell', match: false },
            { text: 'o', match: true },
            { text: ' w', match: false },
            { text: 'o', match: true },
            { text: 'rld', match: false },
        ]);
        const { container } = render(<Highlight highlight={['c++', 'go']}>C++ and Go (or c++)</Highlight>);
        const marks = [...container.querySelectorAll('mark')].map((mark) => mark.textContent);
        expect(marks).toEqual(['C++', 'Go', 'c++']);
        expect(container.textContent).toBe('C++ and Go (or c++)');
    });

    it('treats every regex character literally and prefers the longest term', () => {
        // Unescaped, '.*' would match the whole string and '(' would throw
        expect(highlightChunks('a.*b (x)', ['.*', '('])).toEqual([
            { text: 'a', match: false },
            { text: '.*', match: true },
            { text: 'b ', match: false },
            { text: '(', match: true },
            { text: 'x)', match: false },
        ]);
        expect(highlightChunks('react', ['re', 'react', ''])).toEqual([{ text: 'react', match: true }]);
    });

    it('leaves the text alone for an empty query', () => {
        const { container } = render(<Highlight highlight="  ">plain</Highlight>);
        expect(container.querySelector('mark')).toBeNull();
        expect(container.textContent).toBe('plain');
    });
});

describe('<ShowMore>', () => {
    it('shows the toggle only when the content is taller than maxHeight', () => {
        measureAs(50);
        render(<ShowMore maxHeight={100}>short</ShowMore>);
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('clamps, then expands and collapses', () => {
        measureAs(400);
        const onExpandedChange = vi.fn();
        const { container } = render(
            <ShowMore maxHeight={100} onExpandedChange={onExpandedChange}>
                long
            </ShowMore>,
        );
        const content = container.querySelector<HTMLElement>('[data-slot="show-more-content"]')!;
        expect(content.style.maxHeight).toBe('100px');
        const toggle = screen.getByRole('button', { name: 'Show more' });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).toHaveAttribute('aria-controls', content.id);
        fireEvent.click(toggle);
        expect(onExpandedChange).toHaveBeenCalledWith(true);
        expect(content.style.maxHeight).toBe('');
        fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
        expect(content.style.maxHeight).toBe('100px');
    });

    it('follows a controlled expanded prop, only reporting clicks', () => {
        measureAs(400);
        const onExpandedChange = vi.fn();
        const { container } = render(
            <ShowMore maxHeight={100} expanded onExpandedChange={onExpandedChange}>
                long
            </ShowMore>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
        expect(onExpandedChange).toHaveBeenCalledWith(false);
        // The parent did not change the prop, so it stays open
        expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
        expect(container.querySelector<HTMLElement>('[data-slot="show-more-content"]')!.style.maxHeight).toBe('');
    });
});

describe('<OverflowList>', () => {
    it('fits as many items as the width allows beside the overflow marker', () => {
        // Everything fits: 3 × 40 + 2 gaps of 4 = 128
        expect(fitCount([40, 40, 40], 30, 4, 128)).toBe(3);
        // Not all: 30 (marker) + 40 + 4 + 40 + 4 = 118 ≤ 120, a third would not fit
        expect(fitCount([40, 40, 40], 30, 4, 120)).toBe(2);
        expect(fitCount([200, 40], 30, 4, 100)).toBe(0);
        expect(fitCount([200, 40], 30, 4, 100, 1)).toBe(1);
        // minVisible never exceeds the items there are; nothing in, nothing out
        expect(fitCount([200], 30, 4, 100, 5)).toBe(1);
        expect(fitCount([], 30, 4, 100)).toBe(0);
    });

    it('folds what does not fit into the overflow marker once measured', () => {
        // Row 130px wide; every item and the marker measure 40px, no gap: marker + 2 items = 120 fit, a third would not
        measureAs(20, 130);
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 40 } as DOMRect);
        try {
            const { container } = render(
                <OverflowList items={['a', 'b', 'c', 'd', 'e']} renderItem={(item) => <span>{item}</span>} />,
            );
            const row = container.querySelector('[data-slot="overflow-list"]')!;
            const shown = [...row.querySelectorAll(':scope > [data-slot="overflow-list-item"]')].map(
                (node) => node.textContent,
            );
            expect(shown).toEqual(['a', 'b']);
            expect(row).toHaveAttribute('data-overflowing');
            expect(row.querySelector(':scope > [data-slot="overflow-list-overflow"]')).toHaveTextContent('+3');
            // The measuring copy is out of the accessibility tree
            expect(screen.getAllByText('c')).toHaveLength(1);
            expect(screen.getByText('c').closest('[aria-hidden="true"]')).not.toBeNull();
        } finally {
            rect.mockRestore();
        }
    });

    it('shows every item until the row has been measured', () => {
        render(<OverflowList items={['a', 'b', 'c']} renderItem={(item) => <span>{item}</span>} />);
        expect(screen.getByText('a')).toBeInTheDocument();
        expect(screen.getByText('c')).toBeInTheDocument();
        expect(screen.queryByText(/^\+/)).toBeNull();
    });
});

describe('<TableOfContents>', () => {
    const items = [
        { id: 'intro', label: 'Intro', depth: 2 },
        { id: 'setup', label: 'Setup', depth: 3 },
    ];

    it('links each heading, indents by depth and marks the active one', () => {
        render(<TableOfContents items={items} activeId="setup" title="On this page" aria-label="On this page" />);
        const nav = screen.getByRole('navigation', { name: 'On this page' });
        expect(nav).toBeInTheDocument();
        const intro = screen.getByRole('link', { name: 'Intro' });
        const setup = screen.getByRole('link', { name: 'Setup' });
        expect(intro).toHaveAttribute('href', '#intro');
        expect(intro.style.getPropertyValue('--toc-depth')).toBe('0');
        expect(setup.style.getPropertyValue('--toc-depth')).toBe('1');
        expect(setup).toHaveAttribute('aria-current', 'location');
        expect(intro).not.toHaveAttribute('aria-current');
    });

    it('scrolls to the heading on click and reports it', () => {
        const heading = document.createElement('h2');
        heading.id = 'intro';
        heading.scrollIntoView = vi.fn();
        document.body.appendChild(heading);
        const onItemClick = vi.fn();
        render(<TableOfContents items={items} onItemClick={onItemClick} />);
        act(() => {
            fireEvent.click(screen.getByRole('link', { name: 'Intro' }));
        });
        expect(heading.scrollIntoView).toHaveBeenCalled();
        expect(onItemClick).toHaveBeenCalledWith('intro');
        // Uncontrolled: the clicked entry becomes active
        expect(screen.getByRole('link', { name: 'Intro' })).toHaveAttribute('aria-current', 'location');
        // The address points at the section, without a router navigation
        expect(window.location.hash).toBe('#intro');
        heading.remove();
    });

    it('keeps a controlled activeId over clicks, and leaves modified clicks to the browser', () => {
        const onItemClick = vi.fn();
        render(<TableOfContents items={items} activeId="setup" onItemClick={onItemClick} />);
        fireEvent.click(screen.getByRole('link', { name: 'Intro' }));
        expect(onItemClick).toHaveBeenCalledWith('intro');
        expect(screen.getByRole('link', { name: 'Setup' })).toHaveAttribute('aria-current', 'location');
        expect(screen.getByRole('link', { name: 'Intro' })).not.toHaveAttribute('aria-current');
        onItemClick.mockClear();
        // fireEvent returns false when the default was prevented
        expect(fireEvent.click(screen.getByRole('link', { name: 'Setup' }), { ctrlKey: true })).toBe(true);
        expect(onItemClick).not.toHaveBeenCalled();
    });

    it('renders nothing without items', () => {
        const { container } = render(<TableOfContents items={[]} />);
        expect(container.firstChild).toBeNull();
    });
});

describe('<DiffView>', () => {
    it('diffs fields: added, removed, changed, nested values compared deeply', () => {
        expect(
            diffFields(
                { name: 'Old', tags: ['a'], gone: 1, same: { x: 1 } },
                { name: 'New', tags: ['a'], same: { x: 1 }, role: 'admin' },
            ),
        ).toEqual([
            { key: 'name', type: 'changed', before: 'Old', after: 'New' },
            { key: 'tags', type: 'unchanged', before: ['a'], after: ['a'] },
            { key: 'gone', type: 'removed', before: 1 },
            { key: 'same', type: 'unchanged', before: { x: 1 }, after: { x: 1 } },
            { key: 'role', type: 'added', after: 'admin' },
        ]);
    });

    it('diffs lines with an LCS, keeping order', () => {
        expect(diffLines('a\nb\nc\nd', 'a\nc\nx\nd')).toEqual([
            { type: 'unchanged', value: 'a' },
            { type: 'removed', value: 'b' },
            { type: 'unchanged', value: 'c' },
            { type: 'added', value: 'x' },
            { type: 'unchanged', value: 'd' },
        ]);
        expect(diffLines('same', 'same')).toEqual([{ type: 'unchanged', value: 'same' }]);
    });

    it('line diff edges: empty text has no lines, final newline and CRLF are not changes', () => {
        expect(diffLines('', '')).toEqual([]);
        expect(diffLines('', 'a')).toEqual([{ type: 'added', value: 'a' }]);
        expect(diffLines('a\nb', '')).toEqual([
            { type: 'removed', value: 'a' },
            { type: 'removed', value: 'b' },
        ]);
        expect(diffLines('a\n', 'a')).toEqual([{ type: 'unchanged', value: 'a' }]);
        expect(diffLines('a\r\nb\r\n', 'a\nb\n')).toEqual([
            { type: 'unchanged', value: 'a' },
            { type: 'unchanged', value: 'b' },
        ]);
        // A blank line in the middle is still a line
        expect(diffLines('a\n\nb', 'a\nb')).toEqual([
            { type: 'unchanged', value: 'a' },
            { type: 'removed', value: '' },
            { type: 'unchanged', value: 'b' },
        ]);
    });

    it('falls back to removed-then-added past the LCS ceiling instead of hanging', () => {
        const before = Array.from({ length: 2001 }, (_, i) => `old ${i}`).join('\n');
        const after = Array.from({ length: 2001 }, (_, i) => `new ${i}`).join('\n');
        const lines = diffLines(before, after);
        expect(lines).toHaveLength(4002);
        expect(lines[0]).toEqual({ type: 'removed', value: 'old 0' });
        expect(lines[2001]).toEqual({ type: 'added', value: 'new 0' });
    });

    it('field diff edges: missing records, Dates compared by time', () => {
        expect(diffFields(null, { a: 1 })).toEqual([{ key: 'a', type: 'added', after: 1 }]);
        expect(diffFields({ a: 1 }, undefined)).toEqual([{ key: 'a', type: 'removed', before: 1 }]);
        const [same] = diffFields({ at: new Date(0) }, { at: new Date(0) });
        expect(same.type).toBe('unchanged');
        const [moved] = diffFields({ at: new Date(0) }, { at: new Date(1000) });
        expect(moved.type).toBe('changed');
        expect(diffFields({ list: [1, 2] }, { list: { 0: 1, 1: 2 } })[0].type).toBe('changed');
    });

    it('renders a field diff with old → new and hides unchanged fields', () => {
        const { container } = render(<DiffView before={{ name: 'Old', keep: 1 }} after={{ name: 'New', keep: 1 }} />);
        expect(container.querySelector('[data-mode="fields"]')).not.toBeNull();
        expect(screen.getByText('Old').tagName).toBe('DEL');
        expect(screen.getByText('New').tagName).toBe('INS');
        expect(screen.queryByText('keep')).toBeNull();
    });

    it('renders a line diff, inline parts and an empty state', () => {
        const { container, rerender } = render(<DiffView before={'one\ntwo'} after={'one\nthree'} />);
        expect(container.querySelector('[data-change="removed"]')).toHaveTextContent('two');
        expect(container.querySelector('[data-change="added"]')).toHaveTextContent('three');
        rerender(
            <DiffView parts={[{ value: 'Hello ' }, { value: 'old', removed: true }, { value: 'new', added: true }]} />,
        );
        expect(screen.getByText('old').tagName).toBe('DEL');
        expect(screen.getByText('new').tagName).toBe('INS');
        rerender(<DiffView before={{ a: 1 }} after={{ a: 1 }} emptyMessage="Nothing changed" />);
        expect(screen.getByText('Nothing changed')).toBeInTheDocument();
    });
});
