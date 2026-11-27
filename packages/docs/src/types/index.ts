/** A single documentation page entry */
export interface DocPage {
    /** URL-friendly slug (e.g. "getting-started") */
    slug: string;
    /** Display title */
    title: string;
    /** Raw markdown/MDX content, or a lazily evaluated async function that returns it */
    content: string | (() => Promise<string | { default: string }>);
    /** Optional group/category for sidebar organization */
    group?: string;
    /** Sort order within group (lower = first) */
    order?: number;
    /** Source path for reference */
    sourcePath?: string;
}

/** A group of doc pages in the sidebar */
export interface DocGroup {
    /** Group label */
    label: string;
    /** Sort order (lower = first) */
    order: number;
    /** Pages within this group */
    pages: DocPage[];
}

/** Table of contents heading */
export interface TocItem {
    /** Heading ID for anchor links */
    id: string;
    /** Heading text */
    text: string;
    /** Heading level (2 = h2, 3 = h3) */
    level: number;
}

/** Source definition for docs - a directory or explicit list */
export interface DocsSource {
    /** Label for this source in the sidebar */
    label: string;
    /** Base path prefix for URLs (e.g. "guides") */
    basePath?: string;
    /** Sort order for sources (lower = first) */
    order?: number;
    /** Pre-loaded pages for this source */
    pages: DocPage[];
}

/** Layout theme names (colors come from Brand Kit) */
export type DocsTheme = 'compact' | 'standard' | 'spacious';

/** Code block rendering mode */
export type DocsCodeRenderMode =
    | 'plain' // Inline HTML, no React code block components
    | 'simple' // Built-in: copy button + lang label, no syntax highlighting
    | 'ui-code-highlight'; // Uses @ottabase/ui-code-highlight for uniformity

/** One full-text search result, shown under the sidebar's title filter */
export interface DocsSearchHit {
    /** Page title */
    title: string;
    /** The heading the match sits under; the viewer scrolls to it when it opens the page */
    heading?: string;
    /** Plain-text snippet around the match */
    excerpt?: string;
    /** A page in this viewer (a full slug, as `buildPageSlug` makes it) */
    slug?: string;
    /** Where to read it when the viewer does not have the page; opens in a new tab */
    href?: string;
}

/** Full-text search: resolve the hits for a query. Abort the request when `signal` fires. */
export type DocsSearch = (query: string, signal: AbortSignal) => Promise<DocsSearchHit[]>;

/** Configuration for the docs viewer */
export interface DocsConfig {
    /** Documentation sources. Slugs are relative; the host router owns the URL prefix (see onNavigate). */
    sources: DocsSource[];
    /** Layout theme — 'compact' | 'standard' | 'spacious' */
    theme?: DocsTheme;
    /** Code block rendering: 'simple' or 'ui-code-highlight' (default) */
    codeRenderMode?: DocsCodeRenderMode;
    /**
     * Optional full-text search. The sidebar calls it 400 ms after typing stops, for queries of 3+ characters,
     * and aborts the previous call. Unset: only the instant title filter, and no request leaves the page.
     */
    search?: DocsSearch;
}
