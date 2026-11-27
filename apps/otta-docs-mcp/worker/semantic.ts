// ============================================================
// AI Search over the docs: the hourly sync, hybrid search, and cited answers
// ============================================================
// The corpus bundled into this Worker is also kept in an AI Search instance (`docs` in the
// `ottabase-docs` namespace). `syncDocs` runs on the cron and makes the instance hold exactly
// the bundled pages, uploading only the ones that changed. Search asks the instance first
// (meaning plus keywords) and falls back to the build-time keyword index when the binding is
// absent (dev, tests), when the service fails, or when it finds nothing.
// ============================================================

import type { AiSearchConfig } from '@cloudflare/workers-types';
import {
    createAiSearchClient,
    DEFAULT_ANSWER_MODEL,
    openAiSearchInstance,
    type AiSearchClient,
    type AiSearchDocument,
    type AiSearchHit,
    type AiSearchSyncReport,
} from '@ottabase/cf/ai-search';
import { redactErrorForLog } from '@ottabase/utils/http-errors';
import { sourceUrl, type Corpus, type CorpusDoc, type DocKind } from './corpus';
import type { DocsEnv } from './env';
import { search, type DocsIndex, type SearchHit, type SearchOptions } from './search';

export const DOCS_INSTANCE: AiSearchConfig = {
    id: 'docs',
    index_method: { vector: true, keyword: true },
    custom_metadata: [
        { field_name: 'kind', data_type: 'text' },
        { field_name: 'hash', data_type: 'text' },
    ],
    // Sections run short; smaller chunks give excerpts that point at the right part of a page. The overlap is a
    // percentage (the service refuses more than 30), and overlapping text is billed again at ingestion.
    chunk_size: 512,
    chunk_overlap: 10,
    ai_search_model: DEFAULT_ANSWER_MODEL,
};

export type SearchEngine = 'ai-search' | 'keyword';

export interface DocsSearchResult {
    engine: SearchEngine;
    hits: SearchHit[];
}

const EXCERPT_CHARS = 240;

/** The instance as a client, or null when the Worker has no binding (dev, tests). No network call. */
export function docsClient(env: DocsEnv): AiSearchClient | null {
    return env.DOCS_SEARCH ? createAiSearchClient({ instance: env.DOCS_SEARCH.get(DOCS_INSTANCE.id) }) : null;
}

/** What the instance holds: every page under its id, filterable by kind. */
export function docsDocuments(corpus: Corpus): AiSearchDocument[] {
    return corpus.docs.map((doc) => ({ name: doc.id, content: doc.body, metadata: { kind: doc.kind } }));
}

/** Make the instance equal the bundled corpus. A no-op (three list calls) when nothing changed. */
export async function syncDocs(corpus: Corpus, env: DocsEnv): Promise<AiSearchSyncReport | null> {
    if (!env.DOCS_SEARCH) return null;
    const opened = await openAiSearchInstance(env.DOCS_SEARCH, DOCS_INSTANCE);
    if (!opened.success) throw opened.error;
    const synced = await createAiSearchClient({ instance: opened.data }).sync(docsDocuments(corpus));
    if (!synced.success) throw synced.error;
    return synced.data;
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
export function headingAnchor(heading: string): string {
    return heading
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
}

/** Where a person reads a hit: the page on GitHub, at its section when the hit has one. */
export function hitUrl(hit: Pick<SearchHit, 'id' | 'title' | 'heading'>): string {
    const anchor = hit.heading && hit.heading !== hit.title ? `#${headingAnchor(hit.heading)}` : '';
    return `${sourceUrl(hit.id)}${anchor}`;
}

/** The heading of the section a chunk was cut from, found by its first full line. */
function headingOf(index: DocsIndex, doc: CorpusDoc, text: string): string {
    const sections = index.sectionsOf.get(doc.id) ?? [];
    const line = text
        .split('\n')
        .map((each) => each.trim())
        .find((each) => each.length >= 12);
    const at = line ? doc.body.indexOf(line.slice(0, 80)) : -1;
    if (at === -1) return doc.title;
    let heading = doc.title;
    for (const section of sections) {
        if (section.start > at) break;
        heading = section.heading;
    }
    return heading;
}

/** A chunk as one line of plain-ish text, at most about 240 characters. */
export function excerptOf(text: string): string {
    // Markdown a reader should not see: heading marks (`## Retry`), table rule rows (`|---|:--|`), and the
    // pipes of a table row (`| Prop | Type |` reads as `Prop · Type`).
    const flat = text
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
        .replace(/```[\w-]*/g, ' ')
        .replace(/^[ \t]*\|[ \t:|-]*-[ \t:|-]*$/gm, '')
        .replace(/^[ \t]*\|(.*)$/gm, (_, row: string) =>
            row
                .split(/(?<!\\)\|/) // `\|` is a pipe inside a cell
                .map((cell) => cell.replace(/\\\|/g, '|').trim())
                .filter(Boolean)
                .join(' · '),
        )
        .replace(/\s+/g, ' ')
        .trim();
    return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

/** AI Search chunks as the same hits the keyword search returns: known pages only, at most two per page. */
export function hitsFromChunks(index: DocsIndex, chunks: AiSearchHit[], limit: number): SearchHit[] {
    const perDoc = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const chunk of chunks) {
        const doc = index.byId.get(chunk.name);
        if (!doc) continue; // an item from a newer or older corpus than this Worker's
        const seen = perDoc.get(doc.id) ?? 0;
        if (seen >= 2) continue;
        perDoc.set(doc.id, seen + 1);
        hits.push({
            id: doc.id,
            kind: doc.kind,
            title: doc.title,
            heading: headingOf(index, doc, chunk.text),
            excerpt: excerptOf(chunk.text),
            score: Math.round(chunk.score * 100) / 100,
        });
        if (hits.length === limit) break;
    }
    return hits;
}

/** Hybrid search when bound, the keyword index otherwise or when it fails or finds nothing. */
export async function searchDocs(
    index: DocsIndex,
    env: DocsEnv,
    query: string,
    options: SearchOptions = {},
): Promise<DocsSearchResult> {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
    const client = docsClient(env);
    if (client) {
        // More chunks than hits: several can come from one page, and only two per page are kept.
        const found = await client.search(query, {
            limit: Math.min(limit * 3, 30),
            filters: options.kind ? { kind: options.kind } : undefined,
        });
        if (found.success) {
            const hits = hitsFromChunks(index, found.data, limit);
            if (hits.length > 0) return { engine: 'ai-search', hits };
        } else {
            // Never the query: it is the user's words.
            console.error('otta-docs-mcp: AI Search failed, using the keyword index', redactErrorForLog(found.error));
        }
    }
    return { engine: 'keyword', hits: search(index, query, { kind: options.kind, limit }) };
}

const ASK_SYSTEM = [
    'You answer questions about Ottabase, an open source framework for building SaaS apps on Cloudflare Workers,',
    'using only the documentation excerpts you are given.',
    'Lead with the answer. Use at most 120 words, plus at most one short code block when it helps.',
    'Write code in plain ASCII.',
    'Name the package or page a fact comes from (for example @ottabase/queue).',
    'If the excerpts do not answer the question, say so plainly and suggest what to search for instead.',
    'Never invent APIs, options, commands or package names.',
].join(' ');

export interface DocsAnswer {
    answer: string;
    sources: Array<Pick<SearchHit, 'id' | 'kind' | 'title' | 'heading'>>;
    model: string;
}

/** A model's answer from the best chunks, with the pages it read. Null when the Worker has no binding. */
export async function askDocs(
    index: DocsIndex,
    env: DocsEnv,
    question: string,
    kind?: DocKind,
): Promise<DocsAnswer | null> {
    const client = docsClient(env);
    if (!client) return null;
    const asked = await client.ask(question, {
        system: ASK_SYSTEM,
        limit: 8,
        filters: kind ? { kind } : undefined,
    });
    if (!asked.success) throw asked.error;
    // Two chunks of one section are one source to a reader.
    const seen = new Set<string>();
    const sources = hitsFromChunks(index, asked.data.hits, 6).flatMap(({ id, kind: each, title, heading }) => {
        const key = `${id}#${heading}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ id, kind: each, title, heading }];
    });
    return { answer: asked.data.answer, sources, model: asked.data.model };
}
