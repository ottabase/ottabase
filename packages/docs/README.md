# @ottabase/docs

Minimal, reusable documentation viewer for Markdown files. Clean layout with left navigation, content area, and right
table of contents. Colors from Brand Kit; layout themes control spacing and density.

## Features

- Markdown rendering (headings, code blocks, tables, lists, links, images)
- Left sidebar with an instant title filter and grouped navigation
- Optional full-text search (`search`): debounced, abortable, a hit opens its page at the matching heading
- Right table of contents with scroll tracking
- Responsive with mobile drawer navigation
- Dark mode via Brand Kit
- Previous/Next page navigation
- Three layout themes: `compact`, `standard`, `spacious` (colors from Brand Kit) with subtle sidebar switcher
- Enhanced code blocks with copy-to-clipboard
- Extensible — CSS custom properties and composable config for easy customization
- Zero required runtime dependencies (only React peer dep)

## Installation

```bash
pnpm add @ottabase/docs
```

## Imports

The package splits along a UI boundary so the `.` barrel pulls in zero rendered React:

- `@ottabase/docs` — pure, tree-shakeable helpers and types: `buildPageSlug`, `createRemoteDocsSearch`, `extractTitle`,
  `extractToc`, `fileNameToSlug`, `findPageBySlug`, `organizePages`, `slugToTitle`, the `useDocs` hook, and all type
  re-exports.
- `@ottabase/docs/react` — rendered components: `DocsLayout`, `DocsSidebar`, `MarkdownRenderer`, `TableOfContents` (this
  is the only entry that value-imports `@ottabase/ui-code-highlight` and `@ottabase/ui`, optional peers needed only
  here).

## Quick Start

```tsx
import { useState } from 'react';
import { DocsLayout } from '@ottabase/docs/react';
import { buildPageSlug, extractTitle, slugToTitle, fileNameToSlug, useDocs } from '@ottabase/docs';
import '@ottabase/docs/styles.css';

const config = {
    theme: 'standard', // 'compact' | 'standard' | 'spacious'
    codeRenderMode: 'ui-code-highlight', // 'plain' | 'simple' | 'ui-code-highlight' (default)
    sources: [
        {
            label: 'Guides',
            basePath: 'guides',
            pages: [{ slug: 'getting-started', title: 'Getting Started', content: '# Getting Started\n...' }],
        },
    ],
};

function DocsPage() {
    const [activeSlug, setActiveSlug] = useState('guides/getting-started');
    return <DocsLayout config={config} activeSlug={activeSlug} onNavigate={setActiveSlug} />;
}
```

## Loading Markdown with Vite

Use `import.meta.glob` to load `.md` files at build time:

```typescript
import { createDocsSource, createPackageSource } from './docs.config';

// Load guides from a docs/ directory
const guidesModules = import.meta.glob('/../../docs/*.md', {
    eager: true,
    query: '?raw',
    import: 'default',
});
const guides = createDocsSource('Guides', guidesModules, { basePath: 'guides' });

// Load package READMEs (toggle on/off)
const packageModules = import.meta.glob('/../../packages/*/README.md', {
    eager: true,
    query: '?raw',
    import: 'default',
});
const packages = createPackageSource(packageModules, { prefix: '@ottabase/' });

const config = { sources: [guides, packages], theme: 'standard', codeRenderMode: 'ui-code-highlight' };
```

## Configuration

```typescript
interface DocsConfig {
    theme?: 'compact' | 'standard' | 'spacious'; // Layout theme
    codeRenderMode?: 'plain' | 'simple' | 'ui-code-highlight'; // Code block rendering
    sources: DocsSource[]; // Documentation sources
    search?: (query: string, signal: AbortSignal) => Promise<DocsSearchHit[]>; // Optional full-text search
}
```

## Full-text search

The sidebar's filter matches page titles instantly. Give the config a `search` and the sidebar also lists **Found in the
text**: hits from your search backend, under the filtered pages. It calls `search` 400 ms after typing stops, only for
queries of 3+ characters, and aborts the previous call, so a metered backend sees one request per pause, not one per
keystroke. Without `search` nothing changes and no request leaves the page.

```typescript
interface DocsSearchHit {
    title: string; // Page title
    heading?: string; // Heading the match sits under: the page opens scrolled to it
    excerpt?: string; // Plain-text snippet
    slug?: string; // A page in this viewer (full slug, e.g. 'packages/queue'), opened through onNavigate
    href?: string; // Otherwise, where to read it: opens in a new tab
}
```

Hit text renders as text and `href` goes through `sanitizeUrl`, so hits from a remote service are safe to show. Clicking
a `slug` hit calls `onNavigate(slug)` and, once that page has rendered, scrolls to the heading whose id the renderer
derives from `heading` (a repeated heading lands on its first occurrence). `DocsSidebar` used on its own passes that id
as a second argument, `onNavigate(slug, headingId)`, for you to scroll to.

`createRemoteDocsSearch(endpoint, { limit, resolveSlug })` builds a `search` for an endpoint that answers
`GET <endpoint>?q=<query>&limit=<n>` with `{ hits: [{ id, title, heading?, excerpt?, url? }] }`, where `id` is the
page's repo path. Ottabase's own docs are served that way at `https://mcp.ottabase.com/api/search`
(`apps/otta-docs-mcp`). `resolveSlug` maps an `id` to a page this viewer has; a hit it returns `undefined` for links to
its `url`. A failed request (a `429` included) shows a quiet one-line notice.

```tsx
import { useState } from 'react';
import { buildPageSlug, createRemoteDocsSearch, type DocsConfig, type DocsSource } from '@ottabase/docs';
import { DocsLayout } from '@ottabase/docs/react';
import '@ottabase/docs/styles.css';

const sources: DocsSource[] = [
    {
        label: 'Packages',
        basePath: 'packages',
        pages: [
            {
                slug: 'queue',
                title: '@ottabase/queue',
                content: '# @ottabase/queue\n\n## Dead Letter Queue (DLQ)\n\nFailed messages land here.',
                sourcePath: 'packages/queue/README.md',
            },
        ],
    },
];

// Repo path → this viewer's slug, read from the pages themselves.
const slugByPath = new Map(
    sources.flatMap((source) => source.pages.map((page) => [page.sourcePath, buildPageSlug(source, page)] as const)),
);

const config: DocsConfig = {
    sources,
    search: createRemoteDocsSearch('https://mcp.ottabase.com/api/search', {
        limit: 8,
        resolveSlug: (id) => slugByPath.get(id),
    }),
};

export function DocsPage() {
    const [activeSlug, setActiveSlug] = useState('packages/queue');
    return <DocsLayout config={config} activeSlug={activeSlug} onNavigate={setActiveSlug} />;
}
```

Any other backend works the same way: `search` is just `(query, signal) => Promise<DocsSearchHit[]>`; pass `signal` to
your request so a superseded query is cancelled. The sidebar keeps the latest `search` without re-running it when only
the function's identity changes, so a config rebuilt on each render does not cost extra requests.

## Layout Themes

Three layout themes (colors come from Brand Kit):

| Theme      | Layout                                         |
| ---------- | ---------------------------------------------- |
| `compact`  | Narrow sidebar & content, tight spacing, dense |
| `standard` | Balanced widths, comfortable spacing (default) |
| `spacious` | Wide content, generous whitespace, larger type |

Set via config: `{ theme: 'standard' }` (default before user choice). A subtle switcher (− · +) at the bottom of the
sidebar lets users change layout at runtime; selection persists in `localStorage` under `ottabase.docs.theme`. Colors
use `--background`, `--primary`, `--muted`, etc. from Brand Kit.

## Responsive Behavior

- Desktop: left sidebar + content + right TOC (when available)
- Tablet (`<=1100px`): TOC is hidden; content area remains fluid with reduced heading scale
- Mobile (`<=768px`): sidebar becomes a drawer below the app header, opened via the Menu button

The layout uses `--otta-docs-header-height` (default `3.5rem`) to offset sticky sidebars and mobile drawer height:

```css
--otta-docs-header-height: 3.5rem;
```

Override this variable when integrating into apps with a different header height.

## Code Render Modes

| Mode                          | Description                                                                |
| ----------------------------- | -------------------------------------------------------------------------- |
| `plain`                       | Inline HTML, no copy buttons or syntax highlighting                        |
| `simple`                      | Copy button + language label, no syntax highlighting                       |
| `ui-code-highlight` (default) | Uses @ottabase/ui-code-highlight for highlight.js + copy (install as peer) |

## CSS Custom Properties

Layout vars (override per theme):

```css
--otta-docs-sidebar-width: 240px;
--otta-docs-toc-width: 200px;
--otta-docs-content-max-width: 720px;
--otta-docs-radius: 3px;
```
