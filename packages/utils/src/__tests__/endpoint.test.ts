import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    defineEndpoint,
    endpointHandler,
    endpointUrl,
    matchEndpointPath,
    returns,
    type EndpointCall,
    type EndpointOutput,
    type InputParser,
    type PathParams,
} from '../endpoint';

/** A parser with zod's safeParse shape, so the test needs no zod. */
const nameInput: InputParser<{ name: string }> = {
    parse: (value) => value as { name: string },
    safeParse: (value) => {
        const name = (value as { name?: unknown })?.name;
        return typeof name === 'string' && name.trim().length > 0 && name.length <= 40
            ? { success: true, data: { name: name.trim() } }
            : { success: false, error: { issues: [{ path: ['name'], message: 'Name must be 1 to 40 characters' }] } };
    },
};

const rename = defineEndpoint({
    method: 'PATCH',
    path: '/api/posts/:postId/tags/:tag',
    input: nameInput,
    output: returns<{ ok: true; name: string }>(),
});
const list = defineEndpoint({ method: 'GET', path: '/api/posts', output: returns<{ ids: string[] }>() });

const ctx = (url: string, init?: RequestInit, params?: Record<string, string>) => ({
    req: new Request(url, init),
    params,
});

describe('types', () => {
    it('reads the params from the path and the output from the declaration', () => {
        expectTypeOf<PathParams<'/api/posts/:postId/tags/:tag'>>().toEqualTypeOf<
            { postId: string } & { tag: string }
        >();
        expectTypeOf<keyof PathParams<'/api/posts'>>().toEqualTypeOf<never>();
        expectTypeOf<EndpointOutput<typeof rename>>().toEqualTypeOf<{ ok: true; name: string }>();
        expectTypeOf<EndpointCall<typeof rename>>().toMatchTypeOf<{
            params: { postId: string; tag: string };
            input: { name: string };
        }>();
    });
});

describe('endpointUrl and matchEndpointPath', () => {
    it('fills and encodes the params, and refuses a missing one', () => {
        expect(endpointUrl(rename, { postId: 'p 1', tag: 'a/b' })).toBe('/api/posts/p%201/tags/a%2Fb');
        expect(() => endpointUrl(rename, { postId: 'p1' })).toThrow('needs the "tag" param');
        expect(endpointUrl(list)).toBe('/api/posts');
    });

    it('reads the params back off a pathname', () => {
        expect(matchEndpointPath(rename.path, '/api/posts/p%201/tags/x')).toEqual({ postId: 'p 1', tag: 'x' });
        expect(matchEndpointPath(rename.path, '/api/posts/p1')).toBeNull();
    });
});

describe('endpointHandler', () => {
    it('hands the handler typed params and parsed input, and sends the result as JSON', async () => {
        const handler = endpointHandler(
            rename,
            async (_c, { params, input }) => ({
                ok: true as const,
                name: `${params.postId}:${params.tag}:${input.name}`,
            }),
            { headers: { 'Cache-Control': 'private, no-store' } },
        );
        const response = await handler(
            ctx(
                'https://app.test/api/posts/p1/tags/t1',
                { method: 'PATCH', body: JSON.stringify({ name: '  Hello ' }) },
                {
                    postId: 'p1',
                    tag: 't1',
                },
            ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(await response.json()).toEqual({ ok: true, name: 'p1:t1:Hello' });
    });

    it('answers 400 with field errors, or for a body that is not JSON, before the handler runs', async () => {
        let ran = false;
        const handler = endpointHandler(rename, async () => {
            ran = true;
            return { ok: true as const, name: '' };
        });
        const invalid = await handler(
            ctx('https://app.test/api/posts/p/tags/t', { method: 'PATCH', body: '{"name":""}' }),
        );
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({
            code: 'VALIDATION_ERROR',
            fieldErrors: { name: ['Name must be 1 to 40 characters'] },
        });
        const garbled = await handler(ctx('https://app.test/api/posts/p/tags/t', { method: 'PATCH', body: '{nope' }));
        expect(garbled.status).toBe(400);
        expect(ran).toBe(false);
    });

    it('reads params off the URL when the router gave none, the query for GET, and passes a Response through', async () => {
        const seen: unknown[] = [];
        const tagged = endpointHandler(rename, async (_c, { params }) => {
            seen.push(params);
            return new Response('nope', { status: 404 });
        });
        const response = await tagged(
            ctx('https://app.test/api/posts/p9/tags/t9', { method: 'PATCH', body: '{"name":"x"}' }),
        );
        expect(response.status).toBe(404);
        expect(seen).toEqual([{ postId: 'p9', tag: 't9' }]);

        const query = defineEndpoint({
            method: 'GET',
            path: '/api/search',
            input: { parse: (value) => value as { q: string } },
            output: returns<{ q: string }>(),
        });
        const search = endpointHandler(query, async (_c, { input }) => ({ q: input.q }));
        expect(await (await search(ctx('https://app.test/api/search?q=hello'))).json()).toEqual({ q: 'hello' });
    });
});
