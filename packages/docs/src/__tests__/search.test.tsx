import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsLayout } from '../components/DocsLayout';
import type { DocsConfig, DocsSearch, DocsSearchHit } from '../types';
import { createRemoteDocsSearch } from '../utils';

const sources: DocsConfig['sources'] = [
    {
        label: 'Guides',
        basePath: 'guides',
        pages: [{ slug: 'intro', title: 'Intro', content: '# Intro\n\n## Getting around\n\nHello.' }],
    },
    {
        label: 'Packages',
        basePath: 'packages',
        pages: [
            {
                slug: 'queue',
                title: '@ottabase/queue',
                content: '# @ottabase/queue\n\n## Usage\n\nSend.\n\n## Dead Letter Queue (DLQ)\n\nRetries.',
            },
        ],
    },
];

const dlqHit: DocsSearchHit = {
    title: '@ottabase/queue',
    heading: 'Dead Letter Queue (DLQ)',
    excerpt: 'Failed messages land in the DLQ.',
    slug: 'packages/queue',
};

/** A host that routes like a real one: onNavigate moves activeSlug. */
function Host({ config, onNavigate }: { config: DocsConfig; onNavigate?: (slug: string) => void }) {
    const [slug, setSlug] = useState('guides/intro');
    return (
        <DocsLayout
            config={config}
            activeSlug={slug}
            onNavigate={(next) => {
                onNavigate?.(next);
                setSlug(next);
            }}
        />
    );
}

const typeQuery = (value: string) =>
    fireEvent.change(screen.getByRole('textbox', { name: /search documentation/i }), { target: { value } });

const settle = (ms = 400) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('DocsSidebar full-text search', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // jsdom implements neither; the layout scrolls on page change and to a hit's heading.
        window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
        Element.prototype.scrollIntoView = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows no text hits when config.search is not set', async () => {
        render(<Host config={{ sources }} />);
        typeQuery('queue');
        await settle();
        expect(screen.queryByText('Found in the text')).not.toBeInTheDocument();
    });

    it('searches once typing pauses, only for 3+ characters', async () => {
        const search = vi.fn<DocsSearch>().mockResolvedValue([dlqHit]);
        render(<Host config={{ sources, search }} />);

        typeQuery('qu');
        await settle();
        expect(search).not.toHaveBeenCalled();

        typeQuery('que');
        typeQuery('queu');
        await settle(399);
        typeQuery('queue');
        await settle(399);
        expect(search).not.toHaveBeenCalled();
        await settle(1);

        expect(search).toHaveBeenCalledTimes(1);
        expect(search.mock.calls[0]![0]).toBe('queue');
        expect(screen.getByText('Found in the text')).toBeInTheDocument();
        expect(screen.getByText('@ottabase/queue › Dead Letter Queue (DLQ)')).toBeInTheDocument();
        expect(screen.getByText('Failed messages land in the DLQ.')).toBeInTheDocument();
    });

    it('aborts the previous request when the query changes', async () => {
        const signals: AbortSignal[] = [];
        const search = vi.fn<DocsSearch>((_query, signal) => {
            signals.push(signal);
            return new Promise<DocsSearchHit[]>(() => {}); // never settles
        });
        render(<Host config={{ sources, search }} />);

        typeQuery('queue');
        await settle();
        expect(signals).toHaveLength(1);
        expect(signals[0]!.aborted).toBe(false);

        typeQuery('queues');
        expect(signals[0]!.aborted).toBe(true);
        await settle();
        expect(signals).toHaveLength(2);

        typeQuery('');
        expect(signals[1]!.aborted).toBe(true);
        expect(screen.queryByText('Found in the text')).not.toBeInTheDocument();
    });

    it('does not re-search when the host rebuilds the config on every render', async () => {
        const search = vi.fn<DocsSearch>().mockResolvedValue([]);
        const { rerender } = render(<DocsLayout config={{ sources, search }} activeSlug="guides/intro" />);
        typeQuery('queue');
        await settle();
        rerender(<DocsLayout config={{ sources, search: (q, s) => search(q, s) }} activeSlug="guides/intro" />);
        await settle();
        expect(search).toHaveBeenCalledTimes(1);
    });

    it('says so quietly when nothing matches or the search fails', async () => {
        const search = vi.fn<DocsSearch>().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('429'));
        render(<Host config={{ sources, search }} />);

        typeQuery('zzzz');
        await settle();
        expect(screen.getByText('No matches in the text.')).toBeInTheDocument();

        typeQuery('zzzzz');
        await settle();
        expect(screen.getByText('Text search is unavailable right now.')).toBeInTheDocument();
    });

    it('opens a page hit through onNavigate and scrolls to its heading', async () => {
        const onNavigate = vi.fn();
        const search = vi.fn<DocsSearch>().mockResolvedValue([dlqHit]);
        render(<Host config={{ sources, search }} onNavigate={onNavigate} />);

        typeQuery('dead letter');
        await settle();
        fireEvent.click(screen.getByRole('button', { name: /Dead Letter Queue \(DLQ\)/ }));
        await settle(0);

        expect(onNavigate).toHaveBeenCalledWith('packages/queue');
        const heading = document.getElementById('dead-letter-queue-dlq');
        expect(heading).not.toBeNull();
        expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0]).toBe(heading);
    });

    it('waits for a lazily loaded page before scrolling to the heading', async () => {
        let loadQueue: (markdown: string) => void = () => {};
        const lazySources: DocsConfig['sources'] = [
            sources[0]!,
            {
                ...sources[1]!,
                pages: [
                    {
                        slug: 'queue',
                        title: '@ottabase/queue',
                        content: () => new Promise<string>((resolve) => (loadQueue = resolve)),
                    },
                ],
            },
        ];
        const search = vi.fn<DocsSearch>().mockResolvedValue([dlqHit]);
        render(<Host config={{ sources: lazySources, search }} />);

        typeQuery('dead letter');
        await settle();
        fireEvent.click(screen.getByRole('button', { name: /Dead Letter Queue \(DLQ\)/ }));
        await settle(0);
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

        await act(async () => loadQueue('# @ottabase/queue\n\n## Usage\n\n## Dead Letter Queue (DLQ)\n\nRetries.'));

        const heading = document.getElementById('dead-letter-queue-dlq');
        expect(heading).not.toBeNull();
        expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
        expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0]).toBe(heading);
    });

    it('links a hit the viewer does not have to its href in a new tab, sanitised', async () => {
        const search = vi.fn<DocsSearch>().mockResolvedValue([
            { title: 'Quickstart', href: 'https://github.com/ottabase/ottabase/blob/main/QUICKSTART.md' },
            { title: 'Evil', href: 'javascript:alert(1)' },
        ]);
        render(<Host config={{ sources, search }} />);

        typeQuery('quickstart');
        await settle();

        const link = screen.getByRole('link', { name: 'Quickstart' });
        expect(link).toHaveAttribute('href', 'https://github.com/ottabase/ottabase/blob/main/QUICKSTART.md');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(screen.getByRole('link', { name: 'Evil' })).toHaveAttribute('href', '#');
    });
});

describe('createRemoteDocsSearch', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('calls the endpoint with q and limit and maps hits to slugs or links', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    query: 'dead letter',
                    engine: 'ai-search',
                    hits: [
                        {
                            id: 'packages/queue/README.md',
                            title: '@ottabase/queue',
                            heading: 'Dead Letter Queue (DLQ)',
                            excerpt: 'Failed messages…',
                            url: 'https://github.com/ottabase/ottabase/blob/main/packages/queue/README.md#dlq',
                        },
                        { id: 'QUICKSTART.md', title: 'Quickstart', url: 'https://example.com/QUICKSTART.md' },
                        { id: 42, title: { nope: true } },
                    ],
                }),
                { status: 200 },
            ),
        );
        vi.stubGlobal('fetch', fetchMock);

        const search = createRemoteDocsSearch('https://docs.example.com/api/search', {
            resolveSlug: (id) => (id === 'packages/queue/README.md' ? 'packages/queue' : undefined),
        });
        const controller = new AbortController();
        const hits = await search('dead letter', controller.signal);

        expect(fetchMock).toHaveBeenCalledWith('https://docs.example.com/api/search?q=dead+letter&limit=8', {
            signal: controller.signal,
        });
        expect(hits).toEqual([
            {
                title: '@ottabase/queue',
                heading: 'Dead Letter Queue (DLQ)',
                excerpt: 'Failed messages…',
                slug: 'packages/queue',
            },
            { title: 'Quickstart', heading: undefined, excerpt: undefined, href: 'https://example.com/QUICKSTART.md' },
        ]);
    });

    it('throws on a non-OK answer (rate limited)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
        const search = createRemoteDocsSearch('https://docs.example.com/api/search', { limit: 3 });
        await expect(search('queue', new AbortController().signal)).rejects.toThrow('429');
    });
});
