// ============================================================
// The HTTP API and the AI Search path: hybrid hits mapped onto the corpus, the keyword
// fallback, cited answers, rate limits, CORS, and the sync the cron runs.
// ============================================================

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../worker/app';
import type { DocsEnv } from '../worker/env';
import { docsDocuments, excerptOf, headingAnchor, syncDocs } from '../worker/semantic';
import { corpus } from './fixture';

const ORIGIN = 'https://mcp.test';

/** A chunk as AI Search returns it: the item key is the doc id. */
const chunk = (key: string, text: string, score = 0.7) => ({
    id: `${key}#0`,
    type: 'text',
    score,
    text,
    item: { key, metadata: { kind: 'package' } },
});

/** A namespace binding whose `docs` instance answers with the given chunks. */
function fakeSearchEnv(options: { chunks?: unknown[]; fail?: boolean; answer?: string } = {}) {
    const instance = {
        search: vi.fn(async () => {
            if (options.fail) throw new Error('AiSearchInternalError');
            return { search_query: 'q', chunks: options.chunks ?? [] };
        }),
        chatCompletions: vi.fn(async () => ({
            choices: [{ message: { role: 'assistant', content: options.answer ?? 'Use initRLS().' } }],
            chunks: options.chunks ?? [],
        })),
    };
    const namespace = { get: vi.fn(() => instance) };
    return { env: { DOCS_SEARCH: namespace as any } satisfies DocsEnv, instance, namespace };
}

const limiter = (success: boolean) => ({ limit: vi.fn(async () => ({ success })) }) as any;

const get = (app: ReturnType<typeof createApp>, path: string, env?: DocsEnv) =>
    app(new Request(`${ORIGIN}${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env);
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, env?: DocsEnv) =>
    app(
        new Request(`${ORIGIN}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        env,
    );

describe('GET /api/search', () => {
    it('answers from the keyword index when there is no binding, with links and CORS', async () => {
        const response = await get(createApp(corpus), '/api/search?q=row%20level%20security');
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        const body = (await response.json()) as any;
        expect(body.engine).toBe('keyword');
        expect(body.hits[0]).toMatchObject({
            id: 'packages/ottaorm/README.md',
            heading: 'Row level security',
            url: 'https://github.com/ottabase/ottabase/blob/main/packages/ottaorm/README.md#row-level-security',
        });
    });

    it('maps AI Search chunks to sections of the corpus, at most two per page', async () => {
        const { env, instance } = fakeSearchEnv({
            chunks: [
                chunk(
                    'packages/ottaorm/README.md',
                    'Row level security scopes every query to the tenant. Call `initRLS()` once at startup.',
                ),
                chunk('packages/ottaorm/README.md', 'Load a relationship with the record: `with("author")`.'),
                chunk('packages/ottaorm/README.md', 'belongsTo, hasMany, hasOne and belongsToMany.'),
                chunk('packages/gone/README.md', 'A page this Worker does not have.'),
                chunk('packages/queue/README.md', '## Retry\n\nA failed job is retried with exponential backoff.'),
            ],
        });
        const response = await get(createApp(corpus), '/api/search?q=keep%20tenants%20apart&kind=package&limit=5', env);
        const body = (await response.json()) as any;

        expect(body.engine).toBe('ai-search');
        expect(body.hits.map((hit: any) => [hit.id, hit.heading])).toEqual([
            ['packages/ottaorm/README.md', 'Row level security'],
            ['packages/ottaorm/README.md', 'Eager loading'],
            ['packages/queue/README.md', 'Retry'],
        ]);
        expect(body.hits[2].url).toMatch(/packages\/queue\/README\.md#retry$/);
        // Heading marks are dropped from the excerpt.
        expect(body.hits[2].excerpt).toBe('Retry A failed job is retried with exponential backoff.');
        // The kind narrows the instance's search; more chunks are asked for than hits are returned.
        expect(instance.search).toHaveBeenCalledWith(
            expect.objectContaining({
                query: 'keep tenants apart',
                ai_search_options: expect.objectContaining({
                    retrieval: expect.objectContaining({ max_num_results: 15, filters: { kind: 'package' } }),
                }),
            }),
        );
    });

    it('falls back to the keyword index when AI Search fails or finds nothing', async () => {
        const failing = fakeSearchEnv({ fail: true });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const a = (await (await get(createApp(corpus), '/api/search?q=retry', failing.env)).json()) as any;
        expect(a.engine).toBe('keyword');
        expect(a.hits[0].id).toBe('packages/queue/README.md');
        expect(error).toHaveBeenCalled();
        error.mockRestore();

        const empty = fakeSearchEnv({ chunks: [] });
        const b = (await (await get(createApp(corpus), '/api/search?q=retry', empty.env)).json()) as any;
        expect(b.engine).toBe('keyword');
    });

    it('refuses a missing or oversized query and an unknown kind', async () => {
        const app = createApp(corpus);
        expect((await get(app, '/api/search?q=a')).status).toBe(400);
        expect((await get(app, `/api/search?q=${'x'.repeat(201)}`)).status).toBe(400);
        expect((await get(app, '/api/search?q=retry&kind=blog')).status).toBe(400);
    });

    it('answers 429 with Retry-After when the address is over its limit', async () => {
        const response = await get(createApp(corpus), '/api/search?q=retry', { SEARCH_LIMIT: limiter(false) });
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('60');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('answers a preflight and refuses other methods', async () => {
        const app = createApp(corpus);
        const preflight = await app(new Request(`${ORIGIN}/api/search`, { method: 'OPTIONS' }));
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
        expect((await post(app, '/api/search', {})).status).toBe(405);
    });
});

describe('POST /api/ask', () => {
    it('is unavailable without the binding', async () => {
        const response = await post(createApp(corpus), '/api/ask', { question: 'How do I scope queries?' });
        expect(response.status).toBe(503);
        expect(((await response.json()) as any).code).toBe('ASK_UNAVAILABLE');
    });

    it('returns the answer and the pages it read, with links', async () => {
        const { env, instance } = fakeSearchEnv({
            answer: 'Call `initRLS()` once at startup (@ottabase/ottaorm).',
            chunks: [
                chunk(
                    'packages/ottaorm/README.md',
                    'Row level security scopes every query to the tenant. Call `initRLS()` once at startup.',
                ),
                // A second chunk of the same section: one source, not two.
                chunk('packages/ottaorm/README.md', 'Row level security scopes every query to the tenant.'),
            ],
        });
        const response = await post(
            createApp(corpus),
            '/api/ask',
            { question: 'How do I scope queries to a tenant?' },
            env,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        expect(body).toMatchObject({
            question: 'How do I scope queries to a tenant?',
            answer: 'Call `initRLS()` once at startup (@ottabase/ottaorm).',
        });
        expect(body.sources.map((source: any) => [source.id, source.heading])).toEqual([
            ['packages/ottaorm/README.md', 'Row level security'],
        ]);
        expect(body.sources[0].url).toMatch(/#row-level-security$/);
        const request = (instance.chatCompletions.mock.calls[0] as any[])[0];
        expect(request.messages[0].role).toBe('system');
        expect(request.messages[1]).toEqual({ role: 'user', content: 'How do I scope queries to a tenant?' });
    });

    it('refuses bad input and answers 503 when the model call fails', async () => {
        const app = createApp(corpus);
        const { env, instance } = fakeSearchEnv();
        expect((await post(app, '/api/ask', 'not json', env)).status).toBe(400);
        expect((await post(app, '/api/ask', { question: 'hi' }, env)).status).toBe(400);
        expect((await post(app, '/api/ask', { question: 'x'.repeat(501) }, env)).status).toBe(400);
        expect((await get(app, '/api/ask', env)).status).toBe(405);

        instance.chatCompletions.mockRejectedValueOnce(new Error('upstream'));
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = await post(app, '/api/ask', { question: 'How do queues retry?' }, env);
        expect(failed.status).toBe(503);
        expect(((await failed.json()) as any).code).toBe('ASK_FAILED');
        error.mockRestore();
    });

    it('is limited per address', async () => {
        const { env } = fakeSearchEnv();
        const response = await post(
            createApp(corpus),
            '/api/ask',
            { question: 'How do queues retry?' },
            { ...env, ASK_LIMIT: limiter(false) },
        );
        expect(response.status).toBe(429);
    });
});

describe('search_docs over MCP with AI Search bound', () => {
    it('returns the hybrid hits', async () => {
        const { env } = fakeSearchEnv({
            chunks: [chunk('packages/queue/README.md', 'A failed job is retried with exponential backoff.')],
        });
        const app = createApp(corpus);
        const client = new Client({ name: 'otta-docs-mcp-test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
                fetch: (input, init) => app(new Request(input, init), env),
            }),
        );
        const result = await client.callTool({
            name: 'search_docs',
            arguments: { query: 'what happens when a job fails' },
        });
        const text = (result.content as Array<{ text: string }>).map((part) => part.text).join('\n');
        expect(text).toContain('@ottabase/queue > Retry');
        expect(text).toContain('id: packages/queue/README.md');
        await client.close();
    });
});

describe('health', () => {
    it('says which search is in use', async () => {
        const plain = (await (await get(createApp(corpus), '/health')).json()) as any;
        expect(plain.search).toBe('keyword');
        const bound = (await (await get(createApp(corpus), '/health', fakeSearchEnv().env)).json()) as any;
        expect(bound.search).toBe('ai-search');
    });
});

describe('the sync', () => {
    it('lists every page under its id with its kind', () => {
        const documents = docsDocuments(corpus);
        expect(documents).toHaveLength(corpus.docs.length);
        expect(documents[0]).toEqual({
            name: corpus.docs[0]!.id,
            content: corpus.docs[0]!.body,
            metadata: { kind: 'start' },
        });
    });

    it('does nothing without the binding', async () => {
        expect(await syncDocs(corpus, {})).toBeNull();
    });

    it('creates the instance on first run and uploads every page, then nothing', async () => {
        const items = new Map<string, any>();
        const instance = {
            info: vi.fn().mockRejectedValueOnce(new Error('ai_search_not_found')),
            items: {
                list: vi.fn(async () => ({ result: [...items.values()], result_info: { total_count: items.size } })),
                upload: vi.fn(async (key: string, _content: string, opts: any) => {
                    items.set(key, { id: key, key, status: 'completed', metadata: opts.metadata });
                    return {};
                }),
                delete: vi.fn(),
            },
        };
        const namespace = { get: vi.fn(() => instance), create: vi.fn(async () => instance) };
        const env = { DOCS_SEARCH: namespace as any };

        const first = await syncDocs(corpus, env);
        expect(namespace.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'docs' }));
        expect(first?.uploaded).toHaveLength(corpus.docs.length);

        instance.info.mockResolvedValue({ id: 'docs' });
        const second = await syncDocs(corpus, env);
        expect(second).toEqual({ uploaded: [], deleted: [], unchanged: corpus.docs.length });
    });
});

describe('excerptOf', () => {
    it('drops heading marks and table rules, and reads a table row as cells', () => {
        expect(excerptOf("## Props\n\n| Prop | Type |\n| --- | :-- |\n| `size` | `'sm' \\| 'lg'` |")).toBe(
            "Props Prop · Type `size` · `'sm' | 'lg'`",
        );
    });

    it('drops code fence marks', () => {
        expect(excerptOf('Send (server)\n\n```ts\nimport { resolveAppMailer } from "x";\n```')).toBe(
            'Send (server) import { resolveAppMailer } from "x";',
        );
    });

    it('cuts a long chunk with an ellipsis', () => {
        const long = excerptOf('word '.repeat(100));
        expect(long.endsWith('…')).toBe(true);
        expect(long.length).toBe(241);
    });
});

describe('headingAnchor', () => {
    it('matches GitHub anchors', () => {
        expect(headingAnchor('Row level security')).toBe('row-level-security');
        expect(headingAnchor('`withCache()` & friends')).toBe('withcache--friends');
        expect(headingAnchor('1. Package: Export schema')).toBe('1-package-export-schema');
    });
});
