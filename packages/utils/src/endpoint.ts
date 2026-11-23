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
// The Worker serves it with `endpointHandler(renameSession, async (c, { params, input, auth }) => ...,
// { guard })`: the guard runs first (a 401 before any body is read), `params.id` is typed from the
// path, `input` is the parsed body (a 400 VALIDATION_ERROR with field errors otherwise), and the
// handler returns the declared output (or a Response for an error). The browser calls it with
// `useEndpointQuery` / `useEndpointMutation` from `@ottabase/ottaorm/client`, typed by the same
// declaration. No codegen: the types flow from the shared value. Headless; safe on the edge and
// in the browser.
//
// The input parser is any zod-like schema (`parse`, optionally `safeParse`) or any Standard Schema
// (`~standard.validate`). The browser sends the parser's INPUT type (what goes on the wire, so a
// field with a default may be left out); the handler receives its OUTPUT type (defaults applied).
//
// ============================================================

import { errorResponse } from './http-errors';
import { jsonResponse } from './http-response';

export type EndpointMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// ── Path params ──

type Lower = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm';
type Lower2 = 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
/** The characters of a param name, as the runtime regex `/:([A-Za-z0-9_]+)/` reads them. */
type ParamChar = Lower | Lower2 | Uppercase<Lower | Lower2> | Digit | '_';

/** `'id.json'` → `['id', '.json']`: the name up to the first character outside [A-Za-z0-9_]. */
type TakeParamName<S extends string, Name extends string = ''> = S extends `${infer C}${infer Rest}`
    ? C extends ParamChar
        ? TakeParamName<Rest, `${Name}${C}`>
        : [Name, S]
    : [Name, ''];

type CollectParams<TPath extends string> = TPath extends `${string}:${infer After}`
    ? TakeParamName<After> extends [infer Name extends string, infer Rest extends string]
        ? (Name extends '' ? unknown : { [K in Name]: string }) & CollectParams<Rest>
        : unknown
    : unknown;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** `'/api/posts/:id/tags/:tag'` → `{ id: string; tag: string }`; `'/files/:id.json'` → `{ id: string }`; no params gives `{}`. */
export type PathParams<TPath extends string> = Simplify<CollectParams<TPath>>;

// ── Parsers ──

interface ParseIssue {
    path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
    message: string;
}

/** A zod-like parser: `parse` (throws), and optionally `safeParse` for field errors. */
export interface ZodLikeParser {
    parse(value: unknown): unknown;
    safeParse?(value: unknown): { success: true; data: unknown } | { success: false; error: { issues?: ParseIssue[] } };
}

type StandardResult = { value: unknown; issues?: undefined } | { issues: ReadonlyArray<ParseIssue> };

/** A Standard Schema (valibot, arktype, zod 3.24+ ...): `~standard.validate`, sync or async. */
export interface StandardSchemaParser {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) => StandardResult | Promise<StandardResult>;
        readonly types?: { readonly input: unknown; readonly output: unknown };
    };
}

export type InputParser = ZodLikeParser | StandardSchemaParser;

/** What the parser accepts: what a caller sends (zod `_input`, Standard Schema `types.input`). */
export type ParserInput<P> = P extends { _input: infer I }
    ? I
    : P extends { readonly '~standard': { readonly types?: infer T } }
      ? NonNullable<T> extends { input: infer I }
          ? I
          : unknown
      : P extends { parse(value: unknown): infer O }
        ? O
        : unknown;

/** What the parser produces: what the handler receives (zod `_output`, Standard Schema `types.output`). */
export type ParserOutput<P> = P extends { _output: infer O }
    ? O
    : P extends { readonly '~standard': { readonly types?: infer T } }
      ? NonNullable<T> extends { output: infer O }
          ? O
          : unknown
      : P extends { parse(value: unknown): infer O }
        ? O
        : unknown;

/** The query string a GET input is read from: every value a string, a repeated key an array. */
export type QueryInput = Record<string, string | string[] | undefined>;

// ── Declarations ──

declare const OUTPUT: unique symbol;

/** A phantom marker carrying the response type: `output: returns<{ sessions: Session[] }>()`. */
export interface Returns<T> {
    readonly [OUTPUT]?: T;
}

export function returns<T>(): Returns<T> {
    return {};
}

export interface Endpoint<
    TMethod extends EndpointMethod = EndpointMethod,
    TPath extends string = string,
    TParser extends InputParser | undefined = InputParser | undefined,
    TOutput = unknown,
> {
    readonly method: TMethod;
    readonly path: TPath;
    readonly input?: TParser;
    /** The response type, advisory: `returns<T>()` checks the handler at compile time only. */
    readonly output: Returns<TOutput>;
    /**
     * Optional runtime check of the response: `endpointHandler` parses the handler's result with
     * it (stripping fields it does not declare, for a zod object) and answers 500 when it fails.
     * Without it nothing is stripped: whatever the handler returns is sent.
     */
    readonly outputSchema?: InputParser;
}

/** Any endpoint, for constraints. */
export type AnyEndpoint = Endpoint<EndpointMethod, string, InputParser | undefined, unknown>;

/**
 * Declaration mistakes refused at compile time, as a missing second argument named after the
 * mistake (a check inside the first argument's type would stop TypeScript inferring the parser):
 * a GET input that is not a query string (every field string | string[] | undefined), and an
 * optional path param (`:id?` reads as a param named `id` followed by a literal `?`).
 */
type DefinitionErrors<TMethod, TPath extends string, TParser> = TPath extends `${string}:${string}?${string}`
    ? [optionalPathParamsAreNotSupported: never]
    : TMethod extends 'GET'
      ? [TParser] extends [undefined]
          ? []
          : ParserInput<TParser> extends QueryInput
            ? []
            : [getInputMustBeQueryStrings: never]
      : [];

const OPTIONAL_PARAM = /:[A-Za-z0-9_]+\?/;

export function defineEndpoint<
    TMethod extends EndpointMethod,
    TPath extends string,
    TOutput,
    TParser extends InputParser | undefined = undefined,
>(
    definition: {
        method: TMethod;
        path: TPath;
        input?: TParser;
        output: Returns<TOutput>;
        outputSchema?: InputParser;
    },
    ..._invalid: DefinitionErrors<TMethod, TPath, TParser>
): Endpoint<TMethod, TPath, TParser, TOutput> {
    if (OPTIONAL_PARAM.test(definition.path)) {
        throw new Error(`[endpoint] ${definition.path}: optional params (:id?) are not supported`);
    }
    return definition as Endpoint<TMethod, TPath, TParser, TOutput>;
}

type ParserOf<E> = E extends Endpoint<EndpointMethod, string, infer P, unknown> ? P : never;

export type EndpointOutput<E> =
    E extends Endpoint<EndpointMethod, string, InputParser | undefined, infer O> ? O : never;
/** The parsed input the handler receives (the parser's output type). */
export type EndpointInput<E> = [ParserOf<E>] extends [undefined] ? undefined : ParserOutput<NonNullable<ParserOf<E>>>;
/** The input a caller sends (the parser's input type: a defaulted field may be left out). */
export type EndpointWireInput<E> = [ParserOf<E>] extends [undefined]
    ? undefined
    : ParserInput<NonNullable<ParserOf<E>>>;
export type EndpointParams<E> =
    E extends Endpoint<EndpointMethod, infer P, InputParser | undefined, unknown> ? PathParams<P> : never;

/** What a call carries: `params` when the path has any, `input` when the endpoint takes one (optional when every field is). */
export type EndpointCall<E> = (keyof EndpointParams<E> extends never
    ? { params?: Record<never, never> }
    : { params: EndpointParams<E> }) &
    ([EndpointWireInput<E>] extends [undefined]
        ? { input?: undefined }
        : Record<never, never> extends EndpointWireInput<E>
          ? { input?: EndpointWireInput<E> }
          : { input: EndpointWireInput<E> });

/** The path with its `:params` filled in, each URI-encoded. Throws on a missing param: a bug, not a 404. */
export function endpointUrl(endpoint: { method: string; path: string }, params: Record<string, string> = {}): string {
    return endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
        const value = params[name];
        if (typeof value !== 'string' || value === '') {
            throw new Error(`[endpoint] ${endpoint.method} ${endpoint.path} needs the "${name}" param`);
        }
        return encodeURIComponent(value);
    });
}

/** A GET input as a query string: a string[] value repeats its key. Undefined values are left out. */
export function endpointQuery(input: QueryInput | undefined): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(input ?? {})) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
    }
    return search.toString();
}

/**
 * Path params by name, read off a concrete pathname against the endpoint's pattern (one trailing
 * slash ignored). Null when it does not match or a segment is not valid percent-encoding.
 */
export function matchEndpointPath(path: string, pathname: string): Record<string, string> | null {
    const names: string[] = [];
    const pattern = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
        names.push(name);
        return '([^/]+)';
    });
    const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    const match = new RegExp(`^${pattern}$`).exec(trimmed);
    if (!match) return null;
    try {
        return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    } catch {
        return null;
    }
}

const issueKey = (issue: ParseIssue) =>
    issue.path && issue.path.length > 0
        ? issue.path.map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.')
        : '_';

function fieldErrorsOf(issues: ReadonlyArray<ParseIssue>): Record<string, string[]> {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of issues) (fieldErrors[issueKey(issue)] ??= []).push(issue.message);
    return fieldErrors;
}

/** A value run through a parser: `{ ok, value }`, or the field errors of a 400. */
export async function runParser(
    parser: InputParser | undefined,
    raw: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; fieldErrors: Record<string, string[]> }> {
    if (!parser) return { ok: true, value: raw };
    if ('~standard' in parser && typeof parser['~standard']?.validate === 'function' && !('parse' in parser)) {
        const result = await parser['~standard'].validate(raw);
        return result.issues
            ? { ok: false, fieldErrors: fieldErrorsOf(result.issues) }
            : { ok: true, value: result.value };
    }
    const zodLike = parser as ZodLikeParser;
    if (zodLike.safeParse) {
        const result = zodLike.safeParse(raw);
        return result.success
            ? { ok: true, value: result.data }
            : { ok: false, fieldErrors: fieldErrorsOf(result.error.issues ?? []) };
    }
    try {
        return { ok: true, value: zodLike.parse(raw) };
    } catch (error) {
        return { ok: false, fieldErrors: { _: [error instanceof Error ? error.message : 'Invalid input'] } };
    }
}

/** The slice of a router's context the handler needs: the request and the path params. */
export interface EndpointRequestContext {
    req: Request;
    params?: Record<string, string>;
}

export interface EndpointHandlerOptions<C, G> {
    /**
     * Runs first, before the path is matched or the body read: return a Response (a 401) to stop
     * there, or a value (the caller's identity) that reaches the handler as `call.auth`.
     */
    guard?: (c: C) => Promise<G | Response> | G | Response;
    /** Set on the response when it does not already carry the header (a returned Response included). */
    headers?: HeadersInit;
    /** The success status. 204 sends no body. */
    status?: number;
}

/** A copy of `response` with each of `headers` it lacks (a fetched Response's own headers are immutable). */
function withHeaders(response: Response, headers: HeadersInit | undefined): Response {
    if (!headers) return response;
    const extra: Array<[string, string]> = [];
    new Headers(headers).forEach((value, name) => {
        if (!response.headers.has(name)) extra.push([name, value]);
    });
    if (extra.length === 0) return response;
    const merged = new Headers(response.headers);
    for (const [name, value] of extra) merged.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

/** The query string as a record: a repeated key becomes a string[]. */
function readQuery(url: URL): QueryInput {
    const query: Record<string, string | string[]> = {};
    url.searchParams.forEach((value, key) => {
        const seen = query[key];
        query[key] = seen === undefined ? value : Array.isArray(seen) ? [...seen, value] : [seen, value];
    });
    return query;
}

/**
 * A route handler for an endpoint, in this order:
 *
 * 1. `guard` (when given): a Response stops here, a value becomes `call.auth`.
 * 2. Path params from the router, else read off the URL; no match (or bad encoding) is a 404.
 * 3. The input, only when the endpoint declares one: the query string for GET (a repeated key is a
 *    string[]), the JSON body otherwise. A body that is not JSON, or does not parse, is a 400.
 * 4. `handler`. A returned value is checked by `outputSchema` (when declared) and sent as JSON with
 *    `status` (204: no body) and `headers`; a returned Response goes out as is, plus any of
 *    `headers` it lacks.
 */
export function endpointHandler<E extends AnyEndpoint, C extends EndpointRequestContext, G = undefined>(
    endpoint: E,
    handler: (
        c: C,
        call: { params: EndpointParams<E>; input: EndpointInput<E>; auth: G },
    ) => Promise<EndpointOutput<E> | Response> | EndpointOutput<E> | Response,
    options: EndpointHandlerOptions<C, G> = {},
): (c: C) => Promise<Response> {
    return async (c) => {
        const respond = (response: Response) => withHeaders(response, options.headers);

        let auth = undefined as G;
        if (options.guard) {
            const guarded = await options.guard(c);
            if (guarded instanceof Response) return respond(guarded);
            auth = guarded;
        }

        const url = new URL(c.req.url);
        const params = c.params ?? matchEndpointPath(endpoint.path, url.pathname);
        if (!params) return respond(errorResponse('Not found', 404, { code: 'NOT_FOUND' }));

        let input: unknown = undefined;
        if (endpoint.input) {
            let raw: unknown;
            if (endpoint.method === 'GET') {
                raw = readQuery(url);
            } else {
                const text = await c.req.text();
                try {
                    raw = text ? JSON.parse(text) : {};
                } catch {
                    return respond(errorResponse('The body is not JSON', 400, { code: 'INVALID_JSON' }));
                }
            }
            const parsed = await runParser(endpoint.input, raw);
            if (!parsed.ok) {
                return respond(
                    errorResponse('Validation failed', 400, {
                        code: 'VALIDATION_ERROR',
                        fieldErrors: parsed.fieldErrors,
                    }),
                );
            }
            input = parsed.value;
        }

        const result = await handler(c, {
            params: params as EndpointParams<E>,
            input: input as EndpointInput<E>,
            auth,
        });
        if (result instanceof Response) return respond(result);

        let body: unknown = result;
        if (endpoint.outputSchema) {
            const checked = await runParser(endpoint.outputSchema, result);
            if (!checked.ok) {
                console.error(
                    JSON.stringify({
                        event: 'endpoint_output_invalid',
                        endpoint: `${endpoint.method} ${endpoint.path}`,
                        fields: Object.keys(checked.fieldErrors),
                    }),
                );
                return respond(errorResponse('Invalid response', 500, { code: 'INVALID_RESPONSE' }));
            }
            body = checked.value;
        }
        const status = options.status ?? 200;
        if (status === 204) return new Response(null, { status: 204, headers: options.headers });
        return jsonResponse(body, status, { headers: options.headers });
    };
}
