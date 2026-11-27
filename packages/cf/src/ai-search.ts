/**
 * AI Search wrapper
 * Managed hybrid search (vectors plus keywords) and cited answers over documents you upload, with an optional name
 * prefix that scopes every read and write, and a `sync` that keeps the index equal to a list of documents.
 *
 * Writing items needs the NAMESPACE binding (`ai_search_namespaces`): the single-instance binding does not implement
 * `items.upload`. Bind a namespace per owner and get the instance with `openAiSearchInstance`, which creates it on
 * first use. Nothing runs locally: without the binding, callers fall back to their own search.
 *
 * @see https://developers.cloudflare.com/ai-search/
 */

import type {
    AiSearchConfig,
    AiSearchInstance,
    AiSearchItemInfo,
    AiSearchNamespace,
    AiSearchOptions,
    AiSearchSearchResponse,
    AiSearchStatsResponse,
    VectorizeVectorMetadataFilter,
} from '@cloudflare/workers-types';
import { attempt, CloudflareError, type Result } from './types';

/**
 * The generation model `ask` uses unless told otherwise. Compared live on 2026-11-27: 3 to 8 s an answer, plain ASCII
 * in code, and it says when the context does not cover a question. `@cf/openai/gpt-oss-120b` took 13 to 27 s and put
 * non-breaking hyphens inside code, which breaks a copied snippet.
 */
export const DEFAULT_ANSWER_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** The custom-metadata field `sync` keeps each document's content hash in. Declare it on the instance. */
export const AI_SEARCH_HASH_FIELD = 'hash';

/** Item names are at most 128 characters, prefix included. */
const MAX_KEY_LENGTH = 128;
/** Metadata filters only see the first 64 bytes of a string, so a longer prefix could not be enforced. */
const MAX_PREFIX_LENGTH = 60;
/** `items.list` pages hold at most 50. */
const LIST_PAGE_SIZE = 50;
/** 2,000 pages of 50 is the 100,000-file ceiling: a guard against a listing that never ends. */
const MAX_LIST_PAGES = 2_000;

export interface AiSearchClientConfig {
    instance: AiSearchInstance;
    /**
     * Scope every item under this name prefix, e.g. `articles/` or `org_<uuid>/`. Writes are stamped with it, and
     * every search carries a folder filter that can never be widened, so a scoped client cannot read outside it.
     */
    prefix?: string;
}

export interface AiSearchDocument {
    /** The item name inside the scope, e.g. `packages/ottaorm/README.md`. Slashes become folders. */
    name: string;
    content: string;
    /** Custom metadata. Every key must be declared on the instance (`custom_metadata`, at most 5 fields). */
    metadata?: Record<string, string | number | boolean>;
}

export interface AiSearchHit {
    /** The item name inside the scope (the prefix removed). */
    name: string;
    /** The matching chunk. */
    text: string;
    /** 0 to 1. Keyword matches score 1. */
    score: number;
    metadata: Record<string, unknown>;
}

export interface AiSearchQueryOptions {
    /** 1 to 50. Default 10. */
    limit?: number;
    /** Minimum score, 0 to 1. The service defaults to 0.4. */
    threshold?: number;
    /** Default `hybrid` when the instance indexes both ways. */
    mode?: 'hybrid' | 'vector' | 'keyword';
    /** Metadata filters, ANDed with the scope. A scoped client refuses a `folder` filter: the scope owns it. */
    filters?: VectorizeVectorMetadataFilter;
}

export interface AiSearchAskOptions extends AiSearchQueryOptions {
    /** A Workers AI model or an AI Gateway provider model. Default {@link DEFAULT_ANSWER_MODEL}. */
    model?: string;
    /** Prepended as the system message. */
    system?: string;
}

export interface AiSearchAnswer {
    answer: string;
    /** The chunks the answer was written from. */
    hits: AiSearchHit[];
    model: string;
}

export interface AiSearchSyncOptions {
    /**
     * An empty list deletes every item in the scope, which is almost always a broken build rather than intent, so it
     * is refused unless this is set.
     */
    allowEmpty?: boolean;
}

export interface AiSearchSyncReport {
    uploaded: string[];
    deleted: string[];
    unchanged: number;
    /** Set when a write failed; the sync stopped there and the next run resumes (it is idempotent). */
    failed?: { name: string; error: string };
}

/** SHA-256 of the content and its metadata, hex: what `sync` compares to skip unchanged documents. */
export async function contentHash(doc: Pick<AiSearchDocument, 'content' | 'metadata'>): Promise<string> {
    const metadata = Object.entries(doc.metadata ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const bytes = new TextEncoder().encode(`${JSON.stringify(metadata)}\n${doc.content}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function checkPrefix(prefix: string): string {
    if (prefix === '') return prefix;
    if (!prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('//')) {
        throw new CloudflareError(
            `AI Search prefix "${prefix}" must end with "/" and not start with one`,
            'AI_SEARCH_BAD_PREFIX',
        );
    }
    if (new TextEncoder().encode(prefix).length > MAX_PREFIX_LENGTH) {
        throw new CloudflareError(`AI Search prefix is longer than ${MAX_PREFIX_LENGTH} bytes`, 'AI_SEARCH_BAD_PREFIX');
    }
    return prefix;
}

/**
 * The folder range that holds a prefix and everything under it. `folder` is the item's directory with a trailing
 * slash, and `0` is the character after `/`, so `[p/, p0)` holds `p/` and `p/any/depth/` but not `pq/`.
 */
function folderRange(prefix: string): VectorizeVectorMetadataFilter {
    return { folder: { $gte: prefix, $lt: `${prefix.slice(0, -1)}0` } };
}

const ITEM_IN_FLIGHT = new Set(['queued', 'running']);

/** AI Search over one instance, optionally scoped to a name prefix. */
export class AiSearchClient {
    private readonly instance: AiSearchInstance;
    private readonly prefix: string;

    constructor(config: AiSearchClientConfig) {
        if (!config.instance) {
            throw new CloudflareError('AI Search instance is required', 'AI_SEARCH_MISSING_BINDING');
        }
        this.instance = config.instance;
        this.prefix = checkPrefix(config.prefix ?? '');
    }

    /** A client for a narrower scope on the same instance: `scoped('org_1/')` under `kb/` reads only `kb/org_1/`. */
    scoped(prefix: string): AiSearchClient {
        return new AiSearchClient({ instance: this.instance, prefix: `${this.prefix}${checkPrefix(prefix)}` });
    }

    private key(name: string): string {
        if (!name || name.startsWith('/') || name.endsWith('/')) {
            throw new CloudflareError(`AI Search item name "${name}" is not a file name`, 'AI_SEARCH_BAD_NAME');
        }
        const key = `${this.prefix}${name}`;
        if (key.length > MAX_KEY_LENGTH) {
            throw new CloudflareError(
                `AI Search item name is longer than ${MAX_KEY_LENGTH} characters: ${key}`,
                'AI_SEARCH_BAD_NAME',
            );
        }
        return key;
    }

    private retrieval(options: AiSearchQueryOptions): AiSearchOptions {
        if (this.prefix && options.filters && 'folder' in options.filters) {
            throw new CloudflareError('A scoped AI Search client owns the folder filter', 'AI_SEARCH_SCOPE_FILTER');
        }
        const filters = this.prefix ? { ...options.filters, ...folderRange(this.prefix) } : options.filters;
        return {
            retrieval: {
                retrieval_type: options.mode,
                max_num_results: Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 50),
                match_threshold: options.threshold,
                filters,
                // Fail loudly: an empty answer would hide an outage from a caller that has a fallback.
                return_on_failure: false,
            },
        };
    }

    /** Chunks to hits, dropping any whose key sits outside the scope (fail closed if a filter ever misses). */
    private hits(chunks: AiSearchSearchResponse['chunks']): AiSearchHit[] {
        return chunks.flatMap((chunk) =>
            chunk.item.key.startsWith(this.prefix)
                ? [
                      {
                          name: chunk.item.key.slice(this.prefix.length),
                          text: chunk.text,
                          score: chunk.score,
                          metadata: chunk.item.metadata ?? {},
                      },
                  ]
                : [],
        );
    }

    /** The chunks that best match `query`. No model runs. */
    search(query: string, options: AiSearchQueryOptions = {}): Promise<Result<AiSearchHit[], Error>> {
        return attempt(async () => {
            const response = await this.instance.search({ query, ai_search_options: this.retrieval(options) });
            return this.hits(response.chunks);
        });
    }

    /** An answer written by a model from the best chunks, with those chunks. Generation is billed to Workers AI. */
    ask(question: string, options: AiSearchAskOptions = {}): Promise<Result<AiSearchAnswer, Error>> {
        return attempt(async () => {
            const model = options.model ?? DEFAULT_ANSWER_MODEL;
            const messages = [
                ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
                { role: 'user' as const, content: question },
            ];
            const response = await this.instance.chatCompletions({
                messages,
                model,
                ai_search_options: this.retrieval(options),
            });
            // Search can drop a chunk from outside the scope; an answer cannot, because the model has already read
            // it. So an answer written from anything outside the scope is refused, never returned.
            if ((response.chunks ?? []).some((chunk) => !chunk.item.key.startsWith(this.prefix))) {
                throw new CloudflareError('AI Search answered from outside the client scope', 'AI_SEARCH_SCOPE_LEAK');
            }
            return {
                answer: response.choices[0]?.message.content?.trim() ?? '',
                hits: this.hits(response.chunks ?? []),
                model,
            };
        });
    }

    /** Insert or replace one document (an upload of an existing name overwrites it). Indexing is asynchronous. */
    upsert(doc: AiSearchDocument): Promise<Result<AiSearchItemInfo, Error>> {
        return attempt(async () => {
            const key = this.key(doc.name);
            const hash = await contentHash(doc);
            return this.instance.items.upload(key, doc.content, {
                metadata: { ...doc.metadata, [AI_SEARCH_HASH_FIELD]: hash },
            });
        });
    }

    /** Delete one document by name. `false` when there was none. */
    remove(name: string): Promise<Result<boolean, Error>> {
        return attempt(async () => {
            const key = this.key(name);
            const found = await this.instance.items.list({ search: key, per_page: LIST_PAGE_SIZE });
            const item = found.result.find((each) => each.key === key);
            if (!item) return false;
            await this.instance.items.delete(item.id);
            return true;
        });
    }

    /** Every item in the scope, all pages. */
    list(): Promise<Result<AiSearchItemInfo[], Error>> {
        return attempt(() => this.listAll());
    }

    private async listAll(): Promise<AiSearchItemInfo[]> {
        const items: AiSearchItemInfo[] = [];
        for (let page = 1; page <= MAX_LIST_PAGES; page++) {
            const response = await this.instance.items.list({
                page,
                per_page: LIST_PAGE_SIZE,
                // A substring match: it narrows the listing, and the prefix check below makes it exact.
                search: this.prefix || undefined,
            });
            items.push(...response.result.filter((item) => item.key.startsWith(this.prefix)));
            const total = response.result_info?.total_count ?? 0;
            if (response.result.length < LIST_PAGE_SIZE || page * LIST_PAGE_SIZE >= total) break;
        }
        return items;
    }

    /**
     * Make the scope hold exactly `docs`: upload what is new or changed, delete what is no longer listed, leave the
     * rest. Each document's hash rides in its metadata, so an unchanged run uploads nothing (ingestion is billed by
     * the token). An item still indexing is left for the next run. Writes stop at the first failure (a rate limit,
     * a subrequest ceiling) and the next run carries on from there.
     */
    sync(docs: AiSearchDocument[], options: AiSearchSyncOptions = {}): Promise<Result<AiSearchSyncReport, Error>> {
        return attempt(async () => {
            if (docs.length === 0 && !options.allowEmpty) {
                throw new CloudflareError(
                    'Refusing to sync an empty list: it would delete the whole scope',
                    'AI_SEARCH_SYNC_EMPTY',
                );
            }
            const wanted = new Map<string, AiSearchDocument>();
            for (const doc of docs) {
                const key = this.key(doc.name);
                if (wanted.has(key))
                    throw new CloudflareError(`Duplicate document name: ${doc.name}`, 'AI_SEARCH_DUPLICATE_NAME');
                wanted.set(key, doc);
            }

            const existing = new Map((await this.listAll()).map((item) => [item.key, item]));
            const report: AiSearchSyncReport = { uploaded: [], deleted: [], unchanged: 0 };

            for (const [key, doc] of wanted) {
                const hash = await contentHash(doc);
                const item = existing.get(key);
                if (item && (item.metadata?.[AI_SEARCH_HASH_FIELD] === hash || ITEM_IN_FLIGHT.has(item.status))) {
                    report.unchanged += 1;
                    continue;
                }
                try {
                    await this.instance.items.upload(key, doc.content, {
                        metadata: { ...doc.metadata, [AI_SEARCH_HASH_FIELD]: hash },
                    });
                } catch (error) {
                    report.failed = { name: doc.name, error: error instanceof Error ? error.message : String(error) };
                    return report;
                }
                report.uploaded.push(doc.name);
            }

            for (const [key, item] of existing) {
                if (wanted.has(key)) continue;
                const name = key.slice(this.prefix.length);
                try {
                    await this.instance.items.delete(item.id);
                } catch (error) {
                    report.failed = { name, error: error instanceof Error ? error.message : String(error) };
                    return report;
                }
                report.deleted.push(name);
            }
            return report;
        });
    }

    /** Item counts by indexing status, and storage. */
    stats(): Promise<Result<AiSearchStatsResponse, Error>> {
        return attempt(() => this.instance.stats());
    }
}

export function createAiSearchClient(config: AiSearchClientConfig): AiSearchClient {
    return new AiSearchClient(config);
}

// The binding reports these as plain messages, not typed errors (verified 2026-11-27).
const isNotFound = (error: unknown) =>
    error instanceof Error && /not_found|NotFound/.test(`${error.name} ${error.message}`);
const isDuplicate = (error: unknown) => error instanceof Error && /already_exist/.test(error.message);

/**
 * The instance `config.id` in a namespace binding, created with `config` when it does not exist yet. One `info()`
 * call when it exists: call it from a sync or setup path, not per search (`namespace.get(id)` costs nothing).
 */
export function openAiSearchInstance(
    namespace: AiSearchNamespace,
    config: AiSearchConfig,
): Promise<Result<AiSearchInstance, Error>> {
    return attempt(async () => {
        const instance = namespace.get(config.id);
        try {
            await instance.info();
            return instance;
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        try {
            return await namespace.create(config);
        } catch (error) {
            // Another isolate created it between the two calls.
            if (isDuplicate(error)) return namespace.get(config.id);
            throw error;
        }
    });
}
