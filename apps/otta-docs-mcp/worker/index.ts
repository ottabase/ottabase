// The Worker entry. The corpus is written by `scripts/build-corpus.mjs` before every build, dev and deploy.
import { redactErrorForLog } from '@ottabase/utils/http-errors';
import corpus from './corpus.generated.json';
import { createApp } from './app';
import type { Corpus } from './corpus';
import type { DocsEnv } from './env';
import { syncDocs } from './semantic';

const docs = corpus as Corpus;
const app = createApp(docs);

export default {
    fetch: (request, env) => app(request, env),
    // The cron (production only) keeps the AI Search instance equal to the bundled corpus. It uploads only pages
    // that changed, so after a deploy the index catches up within one run, and an unchanged run costs three list calls.
    scheduled: (_controller, env, ctx) => {
        ctx.waitUntil(
            syncDocs(docs, env).then(
                (report) =>
                    report &&
                    console.log(
                        JSON.stringify({
                            event: 'docs_sync',
                            revision: docs.revision,
                            uploaded: report.uploaded.length,
                            deleted: report.deleted.length,
                            unchanged: report.unchanged,
                            failed: report.failed,
                        }),
                    ),
                (error) => console.error('otta-docs-mcp: docs sync failed', redactErrorForLog(error)),
            ),
        );
    },
} satisfies ExportedHandler<DocsEnv>;
