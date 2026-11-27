import type { DocsSource } from '@ottabase/docs';
import { buildPageSlug } from '@ottabase/docs';

/** A page's glob key (`../../packages/queue/README.md`, or `/docs/x.md` inside the root) as a repo path. */
const toRepoPath = (sourcePath: string) => sourcePath.replace(/^\/+/, '').replace(/^(\.\.\/)+/, '');

/**
 * Map a docs search hit's id (a repo path such as `packages/queue/README.md` or `docs/API_PAGINATION.md`) to the
 * slug this viewer gives that page. Read from the pages themselves, so it follows whatever sources the config
 * loads; a path the viewer does not have (`QUICKSTART.md`, a skill) gives `undefined` and the hit links out.
 */
export function createDocsSlugResolver(sources: DocsSource[]): (id: string) => string | undefined {
    const slugs = new Map<string, string>();
    for (const source of sources) {
        for (const page of source.pages) {
            if (page.sourcePath) slugs.set(toRepoPath(page.sourcePath), buildPageSlug(source, page));
        }
    }
    return (id) => slugs.get(id);
}
