import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    defineEndpoint,
    endpointHandler,
    endpointQuery,
    endpointUrl,
    matchEndpointPath,
    returns,
    type EndpointCall,
    type EndpointInput,
    type EndpointOutput,
    type PathParams,
    type StandardSchemaParser,
    type ZodLikeParser,
} from '../endpoint';

/** A parser with zod's safeParse shape (and its `_input`/`_output` phantoms), so the test needs no zod. */
function nameParser() {
    return {
        parse: (value: unknown) => value as { name: string },
        safeParse: (value: unknown) => {
            const name = (value as { name?: unknown })?.name;
            return typeof name === 'string' && name.trim().length > 0 && name.length <= 40
                ? { success: true as const, data: { name: name.trim() } }
                : {
                      success: false as const,
                      error: { issues: [{ path: ['name'], message: 'Name must be 1 to 40 characters' }] },
                  };
        },
    } satisfies ZodLikeParser;
}

/** What zod gives a field with a default: optional on the wire, present once parsed. */
const withDefault = {
    parse: (value: unknown) => ({ limit: 20, ...(value as object) }) as { limit: number; q: string },
} as {
    parse(value: unknown): { limit: number; q: string };
    _input: { limit?: number; q: string };
    _output: { limit: number; q: string };
};

/** A Standard Schema (valibot, arktype ...): async validate, field issues. */
const standardTitle: StandardSchemaParser & {
    readonly '~standard': { readonly types?: { input: { title?: string }; output: { title: string } } };
} = {
    '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => {
            const title = (value as { title?: unknown }).title ?? 'Untitled';
            return typeof title === 'string'
                ? { value: { title } }
                : { issues: [{ path: [{ key: 'title' }], message: 'Title must be text' }] };
        },
    },
};

const rename = defineEndpoint({
    method: 'PATCH',
    path: '/api/posts/:postId/tags/:tag',
    input: nameParser(),
    output: returns<{ ok: true; name: string }>(),
});
const list = defineEndpoint({ method: 'GET', path: '/api/posts', output: returns<{ ids: string[] }>() });

const ctx = (url: string, init?: RequestInit, params?: Record<string, string>) => ({
    req: new Request(url, init),
    params,
});

describe('types', () => {
    it('reads the params from the path and the output from the declaration', () => {
        expectTypeOf<PathParams<'/api/posts/:postId/tags/:tag'>>().toEqualTypeOf<{ postId: string; tag: string }>();
        // A param name stops at the first character outside [A-Za-z0-9_], as the runtime reads it.
        expectTypeOf<PathParams<'/files/:id.json'>>().toEqualTypeOf<{ id: string }>();
        expectTypeOf<PathParams<'/a/:from-:to'>>().toEqualTypeOf<{ from: string; to: string }>();
        expectTypeOf<keyof PathParams<'/api/posts'>>().toEqualTypeOf<never>();
        expectTypeOf<EndpointOutput<typeof rename>>().toEqualTypeOf<{ ok: true; name: string }>();
        expectTypeOf<EndpointCall<typeof rename>>().toMatchTypeOf<{
            params: { postId: string; tag: string };
            input: { name: string };
        }>();
        expectTypeOf(rename.method).toEqualTypeOf<'PATCH'>();
    });

    it('sends the parser input type and hands the handler its output type', () => {
        const search = defineEndpoint({
            method: 'POST',
            path: '/api/search',
            input: withDefault,
            output: returns<1>(),
        });
        // The caller may leave out a defaulted field...
        expectTypeOf<EndpointCall<typeof search>['input']>().toEqualTypeOf<{ limit?: number; q: string }>();
        // ...and the handler always sees it.
        expectTypeOf<EndpointInput<typeof search>>().toEqualTypeOf<{ limit: number; q: string }>();

        const titled = defineEndpoint({ method: 'PUT', path: '/t', input: standardTitle, output: returns<1>() });
        expectTypeOf<EndpointCall<typeof titled>['input']>().toEqualTypeOf<{ title?: string } | undefined>();
        expectTypeOf<EndpointInput<typeof titled>>().toEqualTypeOf<{ title: string }>();
    });

    it('refuses a GET input that is not a query string, and an optional path param', () => {
        defineEndpoint({
            method: 'GET',
            path: '/q',
            input: { parse: (value: unknown) => value as { q: string; tags?: string[] } },
            output: returns<1>(),
        });
        expect(() =>
            // @ts-expect-error a GET input is the query string: no numbers
            defineEndpoint({
                method: 'GET',
                path: '/q',
                input: { parse: (value: unknown) => value as { page: number } },
                output: returns<1>(),
            }),
        ).not.toThrow();
        expect(() =>
            // @ts-expect-error optional params are not supported
            defineEndpoint({ method: 'GET', path: '/posts/:id?', output: returns<1>() }),
        ).toThrow('optional params');
    });
});

describe('endpointUrl, endpointQuery and matchEndpointPath', () => {
    it('fills and encodes the params, and refuses a missing one', () => {
        expect(endpointUrl(rename, { postId: 'p 1', tag: 'a/b' })).toBe('/api/posts/p%201/tags/a%2Fb');
        expect(() => endpointUrl(rename, { postId: 'p1' })).toThrow('needs the "tag" param');
        expect(endpointUrl(list)).toBe('/api/posts');
    });

    it('repeats the key of a string[] in the query string', () => {
        expect(endpointQuery({ tag: ['a', 'b'], q: 'x', none: undefined })).toBe('tag=a&tag=b&q=x');
    });

    it('reads the params back off a pathname, ignoring one trailing slash', () => {
        expect(matchEndpointPath(rename.path, '/api/posts/p%201/tags/x')).toEqual({ postId: 'p 1', tag: 'x' });
        expect(matchEndpointPath(rename.path, '/api/posts/p1/tags/x/')).toEqual({ postId: 'p1', tag: 'x' });
        expect(matchEndpointPath('/files/:id.json', '/files/42.json')).toEqual({ id: '42' });
        expect(matchEndpointPath(rename.path, '/api/posts/p1')).toBeNull();
        expect(matchEndpointPath(rename.path, '/api/posts/%E0%A4%A/tags/x')).toBeNull();
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
                { postId: 'p1', tag: 't1' },
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

    it('runs the guard first: an anonymous caller with an invalid body gets 401, no field errors', async () => {
        const handler = endpointHandler(rename, async (_c, { auth }) => ({ ok: true as const, name: auth.userId }), {
            guard: (c: { req: Request }) =>
                c.req.headers.get('authorization') === 'yes'
                    ? { userId: 'u1' }
                    : new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401 }),
        });
        const anonymous = await handler(
            ctx('https://app.test/api/posts/p/tags/t', { method: 'PATCH', body: '{"name":""}' }),
        );
        expect(anonymous.status).toBe(401);
        expect(await anonymous.json()).toEqual({ code: 'UNAUTHORIZED' });

        const signedIn = await handler(
            ctx('https://app.test/api/posts/p/tags/t', {
                method: 'PATCH',
                headers: { authorization: 'yes' },
                body: '{"name":"x"}',
            }),
        );
        expect(await signedIn.json()).toEqual({ ok: true, name: 'u1' });
    });

    it('reads params off the URL when the router gave none, 404s a path that does not match, passes a Response through', async () => {
        const seen: unknown[] = [];
        const tagged = endpointHandler(
            rename,
            async (_c, { params }) => {
                seen.push(params);
                return new Response('nope', { status: 409 });
            },
            { headers: { 'Cache-Control': 'private, no-store' } },
        );
        const response = await tagged(
            ctx('https://app.test/api/posts/p9/tags/t9/', { method: 'PATCH', body: '{"name":"x"}' }),
        );
        expect(response.status).toBe(409);
        // A returned Response gets the headers it lacks.
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(seen).toEqual([{ postId: 'p9', tag: 't9' }]);

        const missing = await tagged(ctx('https://app.test/api/elsewhere', { method: 'PATCH', body: '{"name":"x"}' }));
        expect(missing.status).toBe(404);
        const badEncoding = await tagged(
            ctx('https://app.test/api/posts/%E0%A4%A/tags/t', { method: 'PATCH', body: '{"name":"x"}' }),
        );
        expect(badEncoding.status).toBe(404);
    });

    it('reads a GET input off the query string, a repeated key as a string[]', async () => {
        const query = defineEndpoint({
            method: 'GET',
            path: '/api/search',
            input: { parse: (value: unknown) => value as { q: string; tag?: string | string[] } },
            output: returns<{ q: string; tag?: string | string[] }>(),
        });
        const search = endpointHandler(query, async (_c, { input }) => input);
        expect(await (await search(ctx('https://app.test/api/search?q=hello&tag=a&tag=b'))).json()).toEqual({
            q: 'hello',
            tag: ['a', 'b'],
        });
    });

    it('validates a Standard Schema input, async', async () => {
        const titled = defineEndpoint({ method: 'PUT', path: '/t', input: standardTitle, output: returns<string>() });
        const handler = endpointHandler(titled, async (_c, { input }) => input.title);
        expect(await (await handler(ctx('https://app.test/t', { method: 'PUT', body: '{}' }))).json()).toBe('Untitled');
        const invalid = await handler(ctx('https://app.test/t', { method: 'PUT', body: '{"title":1}' }));
        expect(await invalid.json()).toMatchObject({ fieldErrors: { title: ['Title must be text'] } });
    });

    it('leaves the body unread when the endpoint takes no input, and sends no body for 204', async () => {
        const revoke = defineEndpoint({ method: 'DELETE', path: '/api/x/:id', output: returns<null>() });
        const handler = endpointHandler(revoke, async () => null, {
            status: 204,
            headers: { 'Cache-Control': 'no-store' },
        });
        const request = new Request('https://app.test/api/x/1', { method: 'DELETE', body: 'not json at all' });
        const response = await handler({ req: request });
        expect(response.status).toBe(204);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.text()).toBe('');
        expect(request.bodyUsed).toBe(false);
    });

    it('strips undeclared fields when the endpoint declares an output parser', async () => {
        const me = defineEndpoint({
            method: 'GET',
            path: '/api/me',
            output: returns<{ id: string }>(),
            outputSchema: { parse: (value: unknown) => ({ id: (value as { id: string }).id }) },
        });
        const handler = endpointHandler(me, async () => ({ id: 'u1', passwordHash: 'secret' }) as { id: string });
        expect(await (await handler(ctx('https://app.test/api/me'))).json()).toEqual({ id: 'u1' });
    });
});
