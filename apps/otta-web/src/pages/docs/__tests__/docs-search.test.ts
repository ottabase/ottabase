import type { DocsSource } from '@ottabase/docs';
import { describe, expect, it, vi } from 'vitest';
import { createDocsSlugResolver } from '../docs-search';

const page = (slug: string, sourcePath: string) => ({ slug, title: slug, content: '', sourcePath });

// Shaped like docs.config.ts builds them: Vite keys files outside the app root as `../../<repo path>`.
const sources: DocsSource[] = [
    {
        label: 'Guides',
        basePath: 'guides',
        pages: [page('index', '../../docs/README.md'), page('api-pagination', '../../docs/API_PAGINATION.md')],
    },
    {
        label: 'Packages',
        basePath: 'packages',
        pages: [page('queue', '../../packages/queue/README.md'), page('docs', '/../../packages/docs/README.md')],
    },
];

describe('createDocsSlugResolver', () => {
    const resolve = createDocsSlugResolver(sources);

    it('maps a package README to its package page', () => {
        expect(resolve('packages/queue/README.md')).toBe('packages/queue');
        expect(resolve('packages/docs/README.md')).toBe('packages/docs');
    });

    it('maps docs/*.md to the guides slug the config gives it', () => {
        expect(resolve('docs/API_PAGINATION.md')).toBe('guides/api-pagination');
        expect(resolve('docs/README.md')).toBe('guides/index');
    });

    it('leaves pages the viewer does not have unresolved, so the hit links out', () => {
        expect(resolve('README.md')).toBeUndefined();
        expect(resolve('QUICKSTART.md')).toBeUndefined();
        expect(resolve('.claude/skills/ottabase-update/SKILL.md')).toBeUndefined();
        expect(resolve('packages/pro/vault/README.md')).toBeUndefined();
    });
});

describe('docsConfig', () => {
    it('resolves hits against the pages the real globs load', async () => {
        const { docsConfig } = await import('../docs.config');
        const resolve = createDocsSlugResolver(docsConfig.sources);
        expect(resolve('packages/queue/README.md')).toBe('packages/queue');
        expect(resolve('docs/API_PAGINATION.md')).toBe('guides/api-pagination');
    });

    it('has a search only when VITE_DOCS_SEARCH_URL is set', async () => {
        vi.stubEnv('VITE_DOCS_SEARCH_URL', '');
        vi.resetModules();
        expect((await import('../docs.config')).docsConfig.search).toBeUndefined();

        vi.stubEnv('VITE_DOCS_SEARCH_URL', 'https://docs.example.com/api/search');
        vi.resetModules();
        expect(typeof (await import('../docs.config')).docsConfig.search).toBe('function');
        vi.unstubAllEnvs();
    });
});
