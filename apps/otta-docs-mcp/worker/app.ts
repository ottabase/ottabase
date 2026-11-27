// ============================================================
// The Worker's routes: `/mcp` (the server), `/api/search` and `/api/ask` (the HTTP API),
// `/` (the page for people), `/health`
// ============================================================
// Stateless: the SDK's handler builds a fresh server per request, over lookup
// structures an isolate opens on its first request and keeps. The corpus arrives indexed.
//
// Open on purpose. The docs are public and the tools only read, so there is no auth, no
// Origin or Host check (Claude's own requests fail a strict one) and any site may call it.
// `/mcp` has no rate limit: all of Claude's traffic arrives from one address range, so a
// per-address limit would throttle every Claude user together (add a WAF rule if it is ever
// abused). The HTTP API is called from browsers, one address per person, so it is limited per
// address when the production bindings are there: answers run a model and searches are metered.
// ============================================================

import { createMcpHandler } from '@modelcontextprotocol/server';
import { errorResponse, redactErrorForLog } from '@ottabase/utils/http-errors';
import { jsonResponse } from '@ottabase/utils/http-response';
import type { RateLimit } from '@cloudflare/workers-types';
import { DOC_KINDS, type Corpus, type DocKind } from './corpus';
import type { DocsEnv } from './env';
import { landingPage } from './landing';
import { openIndex, type DocsIndex } from './search';
import { askDocs, hitUrl, searchDocs } from './semantic';
import { createDocsServer } from './server';

/** Browser-based clients (the MCP Inspector, a web app) call cross-origin. Nothing here is private. */
function cors(request: Request): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') ?? '*',
        'Access-Control-Expose-Headers': 'MCP-Protocol-Version, Mcp-Session-Id, Retry-After',
        'Access-Control-Max-Age': '86400',
    };
}

function withCors(request: Request, response: Response): Response {
    const open = new Response(response.body, response);
    for (const [name, value] of Object.entries(cors(request))) open.headers.set(name, value);
    return open;
}

const MAX_QUERY = 200;
const MAX_QUESTION = 500;

/** False when the address is over its limit. No binding (dev, tests) means no limit. */
async function allowed(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
    if (!limiter) return true;
    const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await limiter.limit({ key });
    return success;
}

const tooMany = () =>
    errorResponse('Too many requests. Wait a minute and try again.', 429, {
        code: 'RATE_LIMITED',
        headers: { 'Retry-After': '60' },
    });

const kindOf = (value: unknown): DocKind | undefined =>
    typeof value === 'string' && (DOC_KINDS as readonly string[]).includes(value) ? (value as DocKind) : undefined;

/** `GET /api/search?q=&kind=&limit=`: the best sections, each with a link to read it. */
async function apiSearch(request: Request, url: URL, index: DocsIndex, env: DocsEnv): Promise<Response> {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query.length < 2 || query.length > MAX_QUERY) {
        return errorResponse(`Pass a query of 2 to ${MAX_QUERY} characters as ?q=`, 400, { code: 'BAD_QUERY' });
    }
    const kindParam = url.searchParams.get('kind');
    const kind = kindOf(kindParam);
    if (kindParam && !kind) {
        return errorResponse(`kind is one of ${DOC_KINDS.join(', ')}`, 400, { code: 'BAD_KIND' });
    }
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '8', 10);
    if (!(await allowed(env.SEARCH_LIMIT, request))) return tooMany();

    const { engine, hits } = await searchDocs(index, env, query, { kind, limit: Number.isFinite(limit) ? limit : 8 });
    return jsonResponse({ query, engine, hits: hits.map((hit) => ({ ...hit, url: hitUrl(hit) })) });
}

/** `POST /api/ask` with `{ question, kind? }`: a short answer written from the docs, with the pages it read. */
async function apiAsk(request: Request, index: DocsIndex, env: DocsEnv): Promise<Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return errorResponse('Send JSON: { "question": "..." }', 400, { code: 'BAD_JSON' });
    }
    const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const question = typeof fields.question === 'string' ? fields.question.trim() : '';
    if (question.length < 3 || question.length > MAX_QUESTION) {
        return errorResponse(`Ask a question of 3 to ${MAX_QUESTION} characters`, 400, { code: 'BAD_QUESTION' });
    }
    if (!env.DOCS_SEARCH) {
        return errorResponse('Answers are not available here. Use /api/search.', 503, {
            code: 'ASK_UNAVAILABLE',
            exposure: 'public',
        });
    }
    if (!(await allowed(env.ASK_LIMIT, request))) return tooMany();

    try {
        const answered = await askDocs(index, env, question, kindOf(fields.kind));
        if (!answered) throw new Error('no AI Search binding');
        return jsonResponse({
            question,
            answer: answered.answer,
            sources: answered.sources.map((source) => ({ ...source, url: hitUrl(source) })),
            model: answered.model,
        });
    } catch (error) {
        console.error('otta-docs-mcp: ask failed', redactErrorForLog(error));
        return errorResponse('The answer service failed. Try again, or use /api/search.', 503, {
            code: 'ASK_FAILED',
            exposure: 'public',
        });
    }
}

export function createApp(corpus: Corpus): (request: Request, env?: DocsEnv) => Promise<Response> {
    let index: DocsIndex | undefined;
    const docs = () => (index ??= openIndex(corpus));

    // One handler per env object. A Worker's env is the same object on every request of an isolate, so in
    // production this is built once; the tests pass a different env to exercise the AI Search path.
    let mcp: { env: DocsEnv; handler: ReturnType<typeof createMcpHandler> } | undefined;
    const mcpFor = (env: DocsEnv) => {
        if (mcp?.env !== env) {
            const handler = createMcpHandler(
                () => createDocsServer(docs(), (query, options) => searchDocs(docs(), env, query, options)),
                // Never the request: a tool argument is the user's words.
                { onerror: (error) => console.error('otta-docs-mcp: handler error', redactErrorForLog(error)) },
            );
            mcp = { env, handler };
        }
        return mcp.handler;
    };

    return async (request, env = {}) => {
        const url = new URL(request.url);

        if (url.pathname === '/mcp') {
            if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
            return withCors(request, await mcpFor(env).fetch(request));
        }

        if (url.pathname === '/api/search' || url.pathname === '/api/ask') {
            if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
            const wanted = url.pathname === '/api/search' ? 'GET' : 'POST';
            if (request.method !== wanted) {
                return withCors(request, errorResponse('Method not allowed', 405, { code: 'METHOD_NOT_ALLOWED' }));
            }
            const response =
                url.pathname === '/api/search'
                    ? await apiSearch(request, url, docs(), env)
                    : await apiAsk(request, docs(), env);
            return withCors(request, response);
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return errorResponse('Method not allowed', 405, { code: 'METHOD_NOT_ALLOWED' });
        }
        if (url.pathname === '/health') {
            return jsonResponse({
                ok: true,
                docs: corpus.docs.length,
                generatedAt: corpus.generatedAt,
                revision: corpus.revision,
                search: env.DOCS_SEARCH ? 'ai-search' : 'keyword',
            });
        }
        if (url.pathname === '/') {
            return new Response(landingPage(url.origin, corpus), {
                headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
            });
        }
        return errorResponse('Not found', 404, { code: 'NOT_FOUND' });
    };
}
