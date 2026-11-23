// ============================================================
// @ottabase/utils/endpoint: one typed contract for a route, shared by Worker and browser
// ============================================================
//
// A route is declared once, in a module both sides import:
//
//     export const renameSession = defineEndpoint({
//         method: 'PATCH',
//         path: '/api/users/me/sessions/:id',
//         input: z.object({ name: z.string().trim().min(1).max(40) }),
//         output: returns<{ session: SessionSummary }>(),
//     });
//
// The Worker serves it with `endpointHandler(renameSession, async (c, { params, input }) => ...)`:
// `params.id` is typed from the path, `input` is the parsed body (a 400 VALIDATION_ERROR with
// field errors otherwise), and the handler must return the declared output (or a Response for
// an error). The browser calls it with `useEndpointQuery` / `useEndpointMutation` from
// `@ottabase/ottaorm/client`, typed by the same declaration. No codegen: the types flow from
// the shared value. Headless; safe on the edge and in the browser.
//
// ============================================================

import { errorResponse } from './http-errors';
import { jsonResponse } from './http-response';

export type EndpointMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `'/api/posts/:id/tags/:tag'` → `{ id: string; tag: string }`; a path without params gives `{}`. */
export type PathParams<TPath extends string> = TPath extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & PathParams<`/${Rest}`>
    : TPath extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : Record<never, never>;

/** Anything with `parse` (a zod schema, say); `safeParse` gives field errors. */
export interface InputParser<T> {
    parse(value: unknown): T;
    safeParse?(value: unknown): { success: true; data: T } | { success: false; error: { issues?: ParseIssue[] } };
}

interface ParseIssue {
    path?: ReadonlyArray<PropertyKey>;
    message: string;
}

declare const OUTPUT: unique symbol;

/** A phantom marker carrying the response type: `output: returns<{ sessions: Session[] }>()`. */
export interface Returns<T> {
    readonly [OUTPUT]?: T;
}

export function returns<T>(): Returns<T> {
    return {};
}

export interface Endpoint<TPath extends string = string, TInput = undefined, TOutput = unknown> {
    readonly method: EndpointMethod;
    readonly path: TPath;
    readonly input?: InputParser<TInput>;
    readonly output: Returns<TOutput>;
}

export function defineEndpoint<TPath extends string, TOutput, TInput = undefined>(definition: {
    method: EndpointMethod;
    path: TPath;
    input?: InputParser<TInput>;
    output: Returns<TOutput>;
}): Endpoint<TPath, TInput, TOutput> {
    return definition;
}

export type EndpointOutput<E> = E extends Endpoint<string, unknown, infer O> ? O : never;
export type EndpointInput<E> = E extends Endpoint<string, infer I, unknown> ? I : never;
export type EndpointParams<E> = E extends Endpoint<infer P, unknown, unknown> ? PathParams<P> : never;

/** What a call carries: `params` when the path has any, `input` when the endpoint takes one. */
export type EndpointCall<E> = (keyof EndpointParams<E> extends never
    ? { params?: Record<never, never> }
    : { params: EndpointParams<E> }) &
    ([EndpointInput<E>] extends [undefined] ? { input?: undefined } : { input: EndpointInput<E> });

/** The path with its `:params` filled in, each URI-encoded. Throws on a missing param: a bug, not a 404. */
export function endpointUrl<E extends Endpoint<string, unknown, unknown>>(
    endpoint: E,
    params: Record<string, string> = {},
): string {
    return endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
        const value = params[name];
        if (typeof value !== 'string' || value === '') {
            throw new Error(`[endpoint] ${endpoint.method} ${endpoint.path} needs the "${name}" param`);
        }
        return encodeURIComponent(value);
    });
}

/** Path params by name, read off a concrete pathname against the endpoint's pattern; null when it does not match. */
export function matchEndpointPath(path: string, pathname: string): Record<string, string> | null {
    const names: string[] = [];
    const pattern = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?:([A-Za-z0-9_]+)/g, (_m, name: string) => {
        names.push(name);
        return '([^/]+)';
    });
    const match = new RegExp(`^${pattern}$`).exec(pathname);
    if (!match) return null;
    return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
}

/** The input parsed by the endpoint's parser: `{ ok, value }` or the field errors of a 400. */
export function parseEndpointInput<TInput>(
    endpoint: { input?: InputParser<TInput> },
    raw: unknown,
): { ok: true; value: TInput } | { ok: false; fieldErrors: Record<string, string[]> } {
    if (!endpoint.input) return { ok: true, value: undefined as TInput };
    const parser = endpoint.input;
    if (parser.safeParse) {
        const result = parser.safeParse(raw);
        if (result.success) return { ok: true, value: result.data };
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of result.error.issues ?? []) {
            const key = issue.path && issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
            (fieldErrors[key] ??= []).push(issue.message);
        }
        return { ok: false, fieldErrors };
    }
    try {
        return { ok: true, value: parser.parse(raw) };
    } catch (error) {
        return { ok: false, fieldErrors: { _: [error instanceof Error ? error.message : 'Invalid input'] } };
    }
}

/** The slice of a router's context the handler needs: the request and the path params. */
export interface EndpointRequestContext {
    req: Request;
    params?: Record<string, string>;
}

/**
 * A route handler for an endpoint. Reads the input (the query string for GET, the JSON body
 * otherwise), answers 400 `VALIDATION_ERROR` with field errors when it does not parse, then hands
 * the typed params and input to `handler`. A returned value is sent as JSON (with `headers`); a
 * returned Response (an error, a cookie) goes out as is.
 */
export function endpointHandler<E extends Endpoint<string, unknown, unknown>, C extends EndpointRequestContext>(
    endpoint: E,
    handler: (
        c: C,
        call: { params: EndpointParams<E>; input: EndpointInput<E> },
    ) => Promise<EndpointOutput<E> | Response> | EndpointOutput<E> | Response,
    options: { headers?: HeadersInit; status?: number } = {},
): (c: C) => Promise<Response> {
    return async (c) => {
        let raw: unknown;
        if (endpoint.method === 'GET') {
            const query: Record<string, string> = {};
            new URL(c.req.url).searchParams.forEach((value, key) => {
                query[key] = value;
            });
            raw = query;
        } else {
            const text = await c.req.text();
            try {
                raw = text ? JSON.parse(text) : {};
            } catch {
                return errorResponse('The body is not JSON', 400, { code: 'INVALID_JSON' });
            }
        }
        const parsed = parseEndpointInput(endpoint as Endpoint<string, EndpointInput<E>, unknown>, raw);
        if (!parsed.ok) {
            return errorResponse('Validation failed', 400, {
                code: 'VALIDATION_ERROR',
                fieldErrors: parsed.fieldErrors,
            });
        }
        const params = (c.params ??
            matchEndpointPath(endpoint.path, new URL(c.req.url).pathname) ??
            {}) as EndpointParams<E>;
        const result = await handler(c, { params, input: parsed.value });
        if (result instanceof Response) return result;
        return jsonResponse(result, options.status ?? 200, { headers: options.headers });
    };
}
