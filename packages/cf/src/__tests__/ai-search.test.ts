import { describe, expect, it, vi } from 'vitest';
import {
    AI_SEARCH_HASH_FIELD,
    contentHash,
    createAiSearchClient,
    DEFAULT_ANSWER_MODEL,
    openAiSearchInstance,
} from '../ai-search';

interface FakeItem {
    id: string;
    key: string;
    status: string;
    metadata: Record<string, unknown> | null;
    content: string;
}

/**
 * An in-memory instance that behaves like the service did when probed: upload is an upsert keyed by name, metadata
 * reads back only once indexed, list pages hold at most 50 and `search` is a substring match on the key.
 */
function fakeInstance(options: { indexImmediately?: boolean } = {}) {
    const items = new Map<string, FakeItem>();
    let next = 0;
    const instance = {
        items: {
            upload: vi.fn(async (key: string, content: string, opts?: { metadata?: Record<string, unknown> }) => {
                const prior = items.get(key);
                const item: FakeItem = {
                    id: prior?.id ?? `id${next++}`,
                    key,
                    content,
                    status: options.indexImmediately === false ? 'queued' : 'completed',
                    metadata: options.indexImmediately === false ? null : { ...opts?.metadata },
                };
                items.set(key, item);
                return { id: item.id, key, status: item.status };
            }),
            list: vi.fn(async (params: { page?: number; per_page?: number; search?: string } = {}) => {
                const all = [...items.values()].filter((item) => !params.search || item.key.includes(params.search));
                const per = Math.min(params.per_page ?? 20, 50);
                const page = params.page ?? 1;
                return {
                    result: all.slice((page - 1) * per, page * per),
                    result_info: { count: 0, page, per_page: per, total_count: all.length },
                };
            }),
            delete: vi.fn(async (id: string) => {
                for (const [key, item] of items) if (item.id === id) items.delete(key);
            }),
        },
        search: vi.fn(async (_request: any): Promise<any> => ({ search_query: 'q', chunks: [] })),
        chatCompletions: vi.fn(async (_request: any): Promise<any> => undefined),
        stats: vi.fn(async () => ({ completed: items.size })),
    };
    return { instance: instance as any, items, raw: instance };
}

const chunk = (key: string, text = 'text', score = 0.8) => ({
    id: key,
    type: 'text',
    score,
    text,
    item: { key, metadata: { kind: 'guide' } },
});

describe('AiSearchClient: construction and scope', () => {
    it('requires an instance', () => {
        expect(() => createAiSearchClient({ instance: undefined as any })).toThrow(/instance is required/);
    });

    it('rejects a prefix that cannot be enforced', () => {
        const { instance } = fakeInstance();
        expect(() => createAiSearchClient({ instance, prefix: 'docs' })).toThrow(/must end with/);
        expect(() => createAiSearchClient({ instance, prefix: '/docs/' })).toThrow(/must end with/);
        expect(() => createAiSearchClient({ instance, prefix: `${'x'.repeat(61)}/` })).toThrow(/longer than/);
    });

    it('stamps the prefix on writes and nests scopes', async () => {
        const { instance, items } = fakeInstance();
        const client = createAiSearchClient({ instance, prefix: 'kb/' }).scoped('org_1/');
        const written = await client.upsert({ name: 'a.md', content: 'hello' });
        expect(written.success).toBe(true);
        expect([...items.keys()]).toEqual(['kb/org_1/a.md']);
    });

    it('refuses names that are not files or that run past 128 characters', async () => {
        const { instance } = fakeInstance();
        const client = createAiSearchClient({ instance });
        expect((await client.upsert({ name: '', content: 'x' })).success).toBe(false);
        expect((await client.upsert({ name: 'dir/', content: 'x' })).success).toBe(false);
        expect((await client.upsert({ name: 'a'.repeat(129), content: 'x' })).success).toBe(false);
    });
});

describe('AiSearchClient: search and ask', () => {
    it('forces the folder range of the scope into every search and strips the prefix from hits', async () => {
        const { instance, raw } = fakeInstance();
        raw.search.mockResolvedValueOnce({ search_query: 'q', chunks: [chunk('kb/a.md'), chunk('other/b.md')] });
        const client = createAiSearchClient({ instance, prefix: 'kb/' });

        const result = await client.search('queue retry', { limit: 99, filters: { kind: 'guide' } });

        const request = raw.search.mock.calls[0]![0];
        expect(request.query).toBe('queue retry');
        expect(request.ai_search_options.retrieval).toMatchObject({
            max_num_results: 50,
            return_on_failure: false,
            filters: { kind: 'guide', folder: { $gte: 'kb/', $lt: 'kb0' } },
        });
        // The chunk outside the scope is dropped even though the service returned it.
        expect(result).toEqual({
            success: true,
            data: [{ name: 'a.md', text: 'text', score: 0.8, metadata: { kind: 'guide' } }],
        });
    });

    it('does not let a scoped caller replace the folder filter', async () => {
        const { instance, raw } = fakeInstance();
        const client = createAiSearchClient({ instance, prefix: 'kb/' });
        const result = await client.search('x', { filters: { folder: 'other/' } });
        expect(result.success).toBe(false);
        expect(raw.search).not.toHaveBeenCalled();
    });

    it('sends no folder filter when unscoped', async () => {
        const { instance, raw } = fakeInstance();
        await createAiSearchClient({ instance }).search('x');
        expect(raw.search.mock.calls[0]![0].ai_search_options.retrieval.filters).toBeUndefined();
    });

    it('turns a thrown search into a failed Result', async () => {
        const { instance, raw } = fakeInstance();
        raw.search.mockRejectedValueOnce(new Error('AiSearchInternalError'));
        const result = await createAiSearchClient({ instance }).search('x');
        expect(result.success).toBe(false);
    });

    it('asks with the default model, a system message and the scope, and returns the answer with its hits', async () => {
        const { instance, raw } = fakeInstance();
        raw.chatCompletions.mockResolvedValueOnce({
            choices: [{ message: { role: 'assistant', content: '  Use the rate limiter.  ' } }],
            chunks: [chunk('kb/limits.md')],
        });
        const client = createAiSearchClient({ instance, prefix: 'kb/' });

        const result = await client.ask('How do I limit requests?', { system: 'Answer from the docs.' });

        const request = raw.chatCompletions.mock.calls[0]![0];
        expect(request.model).toBe(DEFAULT_ANSWER_MODEL);
        expect(request.messages).toEqual([
            { role: 'system', content: 'Answer from the docs.' },
            { role: 'user', content: 'How do I limit requests?' },
        ]);
        expect(request.ai_search_options.retrieval.filters).toEqual({ folder: { $gte: 'kb/', $lt: 'kb0' } });
        expect(result.success && result.data).toEqual({
            answer: 'Use the rate limiter.',
            hits: [{ name: 'limits.md', text: 'text', score: 0.8, metadata: { kind: 'guide' } }],
            model: DEFAULT_ANSWER_MODEL,
        });
    });
});

describe('AiSearchClient: items', () => {
    it('upserts with the content hash in the metadata', async () => {
        const { instance, raw } = fakeInstance();
        await createAiSearchClient({ instance }).upsert({
            name: 'a.md',
            content: 'hello',
            metadata: { kind: 'guide' },
        });
        const hash = await contentHash({ content: 'hello', metadata: { kind: 'guide' } });
        expect(raw.items.upload).toHaveBeenCalledWith('a.md', 'hello', {
            metadata: { kind: 'guide', [AI_SEARCH_HASH_FIELD]: hash },
        });
    });

    it('removes by exact name, not by the substring the service matches', async () => {
        const { instance, items } = fakeInstance();
        const client = createAiSearchClient({ instance });
        await client.upsert({ name: 'docs/a.md', content: '1' });
        await client.upsert({ name: 'docs/a.md.bak', content: '2' });

        expect(await client.remove('docs/a.md')).toEqual({ success: true, data: true });
        expect([...items.keys()]).toEqual(['docs/a.md.bak']);
        expect(await client.remove('docs/missing.md')).toEqual({ success: true, data: false });
    });

    it('lists every page and only the scope', async () => {
        const { instance } = fakeInstance();
        const root = createAiSearchClient({ instance });
        for (let i = 0; i < 120; i++) await root.upsert({ name: `kb/${i}.md`, content: String(i) });
        await root.upsert({ name: 'elsewhere/kb/x.md', content: 'x' });

        const listed = await root.scoped('kb/').list();
        expect(listed.success && listed.data.length).toBe(120);
    });
});

describe('AiSearchClient: sync', () => {
    const docs = [
        { name: 'a.md', content: 'alpha', metadata: { kind: 'guide' } },
        { name: 'b.md', content: 'beta', metadata: { kind: 'package' } },
    ];

    it('uploads new documents, then uploads nothing on an unchanged run', async () => {
        const { instance, raw } = fakeInstance();
        const client = createAiSearchClient({ instance, prefix: 'docs/' });

        const first = await client.sync(docs);
        expect(first).toEqual({ success: true, data: { uploaded: ['a.md', 'b.md'], deleted: [], unchanged: 0 } });

        raw.items.upload.mockClear();
        const second = await client.sync(docs);
        expect(second).toEqual({ success: true, data: { uploaded: [], deleted: [], unchanged: 2 } });
        expect(raw.items.upload).not.toHaveBeenCalled();
    });

    it('re-uploads a document whose content or metadata changed, and deletes one no longer listed', async () => {
        const { instance, items } = fakeInstance();
        const client = createAiSearchClient({ instance, prefix: 'docs/' });
        await client.sync(docs);

        const result = await client.sync([{ name: 'a.md', content: 'alpha', metadata: { kind: 'skill' } }]);
        expect(result).toEqual({ success: true, data: { uploaded: ['a.md'], deleted: ['b.md'], unchanged: 0 } });
        expect([...items.keys()]).toEqual(['docs/a.md']);
    });

    it('never touches items outside its scope', async () => {
        const { instance, items } = fakeInstance();
        await createAiSearchClient({ instance }).upsert({ name: 'other/keep.md', content: 'keep' });
        await createAiSearchClient({ instance, prefix: 'docs/' }).sync(docs);
        expect(items.has('other/keep.md')).toBe(true);
    });

    it('leaves an item that is still indexing for the next run', async () => {
        const { instance, raw } = fakeInstance({ indexImmediately: false });
        const client = createAiSearchClient({ instance });
        await client.sync(docs);
        raw.items.upload.mockClear();

        const result = await client.sync(docs);
        expect(result.success && result.data.unchanged).toBe(2);
        expect(raw.items.upload).not.toHaveBeenCalled();
    });

    it('re-uploads an item that failed to index', async () => {
        const { instance, items } = fakeInstance();
        const client = createAiSearchClient({ instance });
        await client.sync(docs);
        items.get('a.md')!.status = 'error';
        items.get('a.md')!.metadata = null;

        const result = await client.sync(docs);
        expect(result.success && result.data.uploaded).toEqual(['a.md']);
    });

    it('refuses an empty list unless asked, so a broken build cannot wipe the index', async () => {
        const { instance, items } = fakeInstance();
        const client = createAiSearchClient({ instance });
        await client.sync(docs);

        expect((await client.sync([])).success).toBe(false);
        expect(items.size).toBe(2);
        expect(await client.sync([], { allowEmpty: true })).toEqual({
            success: true,
            data: { uploaded: [], deleted: ['a.md', 'b.md'], unchanged: 0 },
        });
    });

    it('refuses duplicate names', async () => {
        const { instance } = fakeInstance();
        const result = await createAiSearchClient({ instance }).sync([docs[0]!, docs[0]!]);
        expect(result.success).toBe(false);
    });

    it('stops at the first failed write and reports it, so the next run resumes', async () => {
        const { instance, raw } = fakeInstance();
        raw.items.upload.mockRejectedValueOnce(new Error('item_write_rate_limited'));
        const result = await createAiSearchClient({ instance }).sync(docs);
        expect(result).toEqual({
            success: true,
            data: {
                uploaded: [],
                deleted: [],
                unchanged: 0,
                failed: { name: 'a.md', error: 'item_write_rate_limited' },
            },
        });
        expect(raw.items.upload).toHaveBeenCalledTimes(1);
    });
});

describe('openAiSearchInstance', () => {
    const config = { id: 'docs', index_method: { vector: true, keyword: true } };

    it('returns the instance when it exists', async () => {
        const existing = { info: vi.fn(async () => ({ id: 'docs' })) };
        const namespace = { get: vi.fn(() => existing), create: vi.fn() };
        const result = await openAiSearchInstance(namespace as any, config);
        expect(result).toEqual({ success: true, data: existing });
        expect(namespace.create).not.toHaveBeenCalled();
    });

    it('creates the instance when the service says it is not found', async () => {
        const created = { id: 'created' };
        const namespace = {
            get: vi.fn(() => ({
                info: vi.fn().mockRejectedValue(new Error('AiSearchNotFoundError: ai_search_not_found')),
            })),
            create: vi.fn(async () => created),
        };
        const result = await openAiSearchInstance(namespace as any, config);
        expect(result).toEqual({ success: true, data: created });
        expect(namespace.create).toHaveBeenCalledWith(config);
    });

    it('takes the existing instance when another isolate created it first', async () => {
        const later = { id: 'later' };
        const namespace = {
            get: vi
                .fn()
                .mockReturnValueOnce({ info: vi.fn().mockRejectedValue(new Error('ai_search_not_found')) })
                .mockReturnValueOnce(later),
            create: vi.fn().mockRejectedValue(new Error('AiSearchError: ai_search_with_this_name_already_exist')),
        };
        expect(await openAiSearchInstance(namespace as any, config)).toEqual({ success: true, data: later });
    });

    it('passes any other error on', async () => {
        const namespace = {
            get: vi.fn(() => ({ info: vi.fn().mockRejectedValue(new Error('AiSearchInternalError')) })),
            create: vi.fn(),
        };
        const result = await openAiSearchInstance(namespace as any, config);
        expect(result.success).toBe(false);
        expect(namespace.create).not.toHaveBeenCalled();
    });
});
