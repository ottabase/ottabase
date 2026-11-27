import type { DocGroup, DocPage, DocsSearch, DocsSearchHit, DocsSource, TocItem } from '../types';

/** Extract a title from markdown content (first # heading) */
export function extractTitle(content: string): string {
    // Strip BOM and zero-width chars that may appear at file start
    const clean = content.replace(/^\uFEFF/, '');
    const match = clean.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : 'Untitled';
}

/** Convert a filename to a URL-friendly slug */
export function fileNameToSlug(fileName: string): string {
    return fileName
        .replace(/\.(md|mdx)$/i, '')
        .replace(/README/i, 'index')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/** Common acronyms that should stay fully uppercase in derived titles (slugs are lowercase). */
const TITLE_ACRONYMS = new Set([
    'api',
    'url',
    'id',
    'ui',
    'ux',
    'sdk',
    'cli',
    'http',
    'https',
    'json',
    'html',
    'css',
    'jwt',
    'kv',
    'r2',
    'd1',
    'db',
    'sql',
    'rls',
    'orm',
    'rbac',
    'crud',
    'ssr',
    'spa',
    'seo',
    'cdn',
    'dns',
    'ai',
    'os',
    'pdf',
    'svg',
    'ci',
    'cd',
]);

/** Convert a slug to a display title (acronyms preserved: "api-pagination" → "API Pagination"). */
export function slugToTitle(slug: string): string {
    return slug
        .replace(/-/g, ' ')
        .split(' ')
        .map((word) =>
            TITLE_ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join(' ')
        .replace(/^Index$/, 'Overview');
}

/**
 * The id the renderer gives a heading (before de-duplication): markdown markers stripped, lowercased, dashed.
 * One routine for the renderer, the table of contents and search hits, so all three point at the same element.
 */
export function headingId(text: string): string {
    return text
        .replace(/[*_`\[\]]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, ''); // strip leading/trailing dashes (e.g. from emoji prefixes)
}

/** Extract table of contents from markdown content */
export function extractToc(content: string): TocItem[] {
    const items: TocItem[] = [];
    const lines = content.split('\n');
    const usedIds = new Map<string, number>();
    let inCodeBlock = false;

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;

        const match = line.match(/^(#{2,4})\s+(.+)$/);
        if (match) {
            const level = match[1].length;
            const text = match[2].replace(/[*_`\[\]]/g, '').trim();
            let id = headingId(text);
            // Deduplicate IDs for repeated headings (must match renderMarkdown logic)
            const count = usedIds.get(id) || 0;
            usedIds.set(id, count + 1);
            if (count > 0) id = `${id}-${count}`;
            items.push({ id, text, level });
        }
    }
    return items;
}

/** Organize pages into groups */
export function organizePages(sources: DocsSource[]): DocGroup[] {
    const groupMap = new Map<string, DocGroup>();

    for (const source of sources) {
        const groupLabel = source.label;
        const existing = groupMap.get(groupLabel);

        if (existing) {
            existing.pages.push(...source.pages);
        } else {
            groupMap.set(groupLabel, {
                label: groupLabel,
                order: source.order ?? 0,
                pages: [...source.pages],
            });
        }
    }

    // Sort pages within each group
    for (const group of groupMap.values()) {
        group.pages.sort((a, b) => {
            // index pages first
            if (a.slug === 'index' || a.slug.endsWith('/index')) return -1;
            if (b.slug === 'index' || b.slug.endsWith('/index')) return 1;
            return (a.order ?? 50) - (b.order ?? 50);
        });
    }

    return Array.from(groupMap.values()).sort((a, b) => a.order - b.order);
}

/** Find a page by its slug across all sources */
export function findPageBySlug(sources: DocsSource[], slug: string): DocPage | undefined {
    for (const source of sources) {
        const basePath = source.basePath || '';
        for (const page of source.pages) {
            const fullSlug = basePath ? `${basePath}/${page.slug}` : page.slug;
            if (fullSlug === slug || page.slug === slug) {
                return page;
            }
        }
    }
    return undefined;
}

/** Build a full slug for a page within a source */
export function buildPageSlug(source: DocsSource, page: DocPage): string {
    if (source.basePath) {
        return `${source.basePath}/${page.slug}`;
    }
    return page.slug;
}

/** One hit as a docs search endpoint returns it (`GET <endpoint>?q=…&limit=…` → `{ hits: [...] }`). */
export interface RemoteDocsSearchHit {
    /** Repo path of the page, e.g. `packages/queue/README.md` or `docs/API_PAGINATION.md` */
    id: string;
    title: string;
    heading?: string;
    excerpt?: string;
    /** Where the page can be read outside this viewer */
    url?: string;
}

export interface RemoteDocsSearchOptions {
    /** Hits per query (default 8) */
    limit?: number;
    /** Map a hit's repo path to a page slug in this viewer; `undefined` links the hit to its `url` instead. */
    resolveSlug?: (id: string) => string | undefined;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * A `DocsConfig.search` backed by a docs search endpoint, such as the one `apps/otta-docs-mcp` serves at
 * `/api/search`. The response is untrusted: hits without a string `id` and `title` are dropped, and the UI
 * renders the text as text and sanitises the link. A failed request throws, which the sidebar shows quietly.
 */
export function createRemoteDocsSearch(endpoint: string, options: RemoteDocsSearchOptions = {}): DocsSearch {
    const { limit = 8, resolveSlug } = options;
    return async (query, signal) => {
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        const response = await fetch(`${endpoint}${endpoint.includes('?') ? '&' : '?'}${params}`, { signal });
        if (!response.ok) throw new Error(`Docs search failed (${response.status})`);
        const body = (await response.json()) as { hits?: unknown };
        const hits = Array.isArray(body?.hits)
            ? (body.hits as Partial<Record<keyof RemoteDocsSearchHit, unknown>>[])
            : [];
        return hits.flatMap((hit): DocsSearchHit[] => {
            const id = str(hit?.id);
            const title = str(hit?.title);
            if (!id || !title) return [];
            const slug = resolveSlug?.(id);
            return [
                {
                    title,
                    heading: str(hit.heading),
                    excerpt: str(hit.excerpt),
                    ...(slug ? { slug } : { href: str(hit.url) }),
                },
            ];
        });
    };
}
