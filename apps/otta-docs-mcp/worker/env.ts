// ============================================================
// The Worker's bindings, as wrangler.jsonc declares them (keep the two in step)
// ============================================================
// All optional: `wrangler dev` and the tests run with none of them, and every caller falls
// back (keyword search, no answers, no rate limit, no sync). Only the production env binds them.
// ============================================================

import type { AiSearchNamespace, RateLimit } from '@cloudflare/workers-types';

export interface DocsEnv {
    /** AI Search namespace `ottabase-docs`; the corpus lives in its `docs` instance. */
    DOCS_SEARCH?: AiSearchNamespace;
    /** Per-address limit on `/api/search`. */
    SEARCH_LIMIT?: RateLimit;
    /** Per-address limit on `/api/ask`, which runs a model. */
    ASK_LIMIT?: RateLimit;
}
