# @ottabase/cf

Framework-agnostic Cloudflare bindings wrapper for TypeScript applications.

## Features

Type-safe wrappers for all major Cloudflare Worker bindings:

- **D1**: Raw SQLite database with query builder
- **KV**: Key-value storage
- **R2**: Object storage
- **Hyperdrive**: Database connection pooling
- **Queues**: Message queue processing
- **Secrets**: Environment variables and secrets management
- **Rate Limiting**: Request throttling and protection
- **Vectorize**: Similarity search over embeddings, namespaced per tenant
- **AI Search**: Managed hybrid search and cited answers over uploaded documents, prefix-scoped, with an idempotent sync
- **Workers AI**: `run()` any model, plus `embed()` and `generateText()`
- **Browser Rendering**: PDF, screenshot, Markdown, links and structured extraction without puppeteer
- **Workflows**: start, inspect and steer durable runs
- **Durable Object alarms**: many named timers over the one alarm
- **Turnstile**: the server check for Cloudflare's bot check on public forms

## Installation

```bash
pnpm add @ottabase/cf
```

## Usage

> **Note:** For database access in Ottabase apps, use `@ottabase/db/drizzle-d1` with `@ottabase/ottaorm` (the standard
> path). The raw D1 client and other helpers in this package are for direct Cloudflare binding access when OttaORM is
> not being used.

### D1 Raw SQL

```typescript
import { createD1Client } from '@ottabase/cf/d1';

const db = createD1Client({ database: env.OBCF_D1 });

// Query with type safety
const result = await db.query<User>('SELECT * FROM users WHERE id = ?', [userId]);

if (result.success) {
    console.log(result.data); // User[]
}

// Execute statements
await db.execute('INSERT INTO users (name, email) VALUES (?, ?)', ['John', 'john@example.com']);

// Batch operations
await db.batch([
    { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Alice'] },
    { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Bob'] },
]);
```

### KV Storage

```typescript
import { createKVClient } from '@ottabase/cf/kv';

const kv = createKVClient({ namespace: env.MY_KV });

// Store JSON data
await kv.putJSON('user:123', { name: 'John', email: 'john@example.com' });

// Retrieve JSON data
const result = await kv.getJSON<User>('user:123');

// With expiration (TTL in seconds)
await kv.putJSON('session:abc', sessionData, { expirationTtl: 3600 });
```

### R2 Storage

```typescript
import { createR2Client } from '@ottabase/cf/r2';

const r2 = createR2Client({ bucket: env.MY_BUCKET });

// Upload file
await r2.put('files/document.pdf', fileBuffer, {
    httpMetadata: {
        contentType: 'application/pdf',
    },
});

// Download file
const result = await r2.get('files/document.pdf');
if (result.success && result.data) {
    const content = await result.data.arrayBuffer();
}

// List objects
const { data } = await r2.list({ prefix: 'files/' });
```

### Rate Limiting

```typescript
import { createRateLimitingClient } from '@ottabase/cf/rate-limiting';

const limiter = createRateLimitingClient({ rateLimiter: env.RATE_LIMITER });

// Check rate limit
const result = await limiter.limit({ key: `user:${userId}` });

if (!result.data.success) {
    return new Response('Too many requests', { status: 429 });
}
```

### Turnstile

The server side of Cloudflare's bot check for forms a stranger can submit. The page renders the widget with
`useTurnstile(action)` from `@ottabase/ui/turnstile`, which sends its token in the `X-Turnstile-Token` header
(`TURNSTILE_HEADER`); the route checks it before doing any work:

```typescript
import { requireHuman } from '@ottabase/cf/turnstile';

// Rate limit first: it is cheap and keeps a flood away from Cloudflare's siteverify.
const denied = await requireHuman(request, {
    secret: env.TURNSTILE_SECRET_KEY, // unset: every request passes, so tests and local runs need nothing
    action: 'register', // the widget's action: a token made for another form is refused
    unreachable: 'refuse', // or 'allow' (logged) where another gate still holds, like password sign-in
});
if (denied) return denied; // 403 TURNSTILE_FAILED, or 503 TURNSTILE_UNAVAILABLE
```

It checks that the token is genuine, unused (tokens work once and expire after five minutes), made for that action and
made on the request's hostname (pass `hostname` when the form lives on another one). `verifyTurnstile` returns the
verdict instead of a response (`missing`, `invalid`, `spent`, `action`, `hostname` or `unavailable`).
`TURNSTILE_TEST_KEYS` holds Cloudflare's test site keys, secrets and dummy token; test secrets skip the action and
hostname comparison, since their answers carry sample values. In otta-web, `worker/lib/turnstile.ts` binds this to the
app's env (`guardPublicForm` = the rate limit, then this) and turns checks on only when both `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY` are set.

### Cache Keys (Multi-Tenant KV Scoping)

Type-safe, namespaced cache key builder for Cloudflare KV. Prevents cross-tenant collisions with consistent
`namespace:scope:id` formatting. All scope markers are 3-letter: `org`, `app`, `usr`.

```typescript
import { orgKey, userKey, orgAppUserKey } from '@ottabase/cf/cache-keys';

orgKey('brand', 'acme', 'brandkit'); // brand:org:acme:brandkit
userKey('session', 'user-123', 'active'); // session:usr:user-123:active
orgAppUserKey('rbac', 'acme', 'web', 'user-123', 'perms'); // rbac:org:acme:app:web:usr:user-123:perms
```

| Helper            | Key Pattern                            | Use case                |
| ----------------- | -------------------------------------- | ----------------------- |
| `globalKey`       | `ns:segments`                          | System-wide data        |
| `orgKey`          | `ns:org:{orgId}:segments`              | Tenant data             |
| `userKey`         | `ns:usr:{userId}:segments`             | User data               |
| `appKey`          | `ns:app:{appId}:segments`              | App configuration       |
| `orgAppKey`       | `ns:org:{orgId}:app:{appId}:segments`  | Tenant + app            |
| `orgUserKey`      | `ns:org:{orgId}:usr:{userId}:segments` | User within tenant      |
| `appUserKey`      | `ns:app:{appId}:usr:{userId}:segments` | User within app         |
| `orgAppUserKey`   | `ns:org:…:app:…:usr:…:segments`        | User in tenant's app    |
| `versionedOrgKey` | `ns:org:{orgId}:v{N}:segments`         | O(1) cache invalidation |

See [docs/CACHE_KEYS.md](../../docs/CACHE_KEYS.md) for full documentation.

### KV Read-Through Cache

`withCache` wraps an async fetcher with KV-backed caching — returns cached data on hit, calls the fetcher on miss:

```typescript
import { withCache, invalidateCache, invalidateCacheByPrefix } from '@ottabase/cf/kv-cache';
import { userKey } from '@ottabase/cf/cache-keys';

const profile = await withCache(env.OBCF_KV, userKey('auth', userId, 'profile'), 300, async () => {
    return db.query.users.findFirst({ where: eq(users.id, userId) });
});

// Invalidate single key or by prefix
await invalidateCache(env.OBCF_KV, key);
await invalidateCacheByPrefix(env.OBCF_KV, 'rbac:');
```

### Vectorize

```typescript
import { createVectorizeClient } from '@ottabase/cf/vectorize';

const vectors = createVectorizeClient({ index: env.OBCF_VECTORIZE, namespace: orgId }); // one index, every tenant
await vectors.upsert([{ id: 'doc_1', values: embedding, metadata: { title: 'Pricing' } }]);
const hits = await vectors.query(queryEmbedding, { topK: 5, returnMetadata: 'all' }); // never another tenant's rows
```

### AI Search

Managed hybrid search (vectors plus keywords) and cited answers. Upload documents and AI Search chunks, embeds and
indexes them; `search()` returns chunks and `ask()` has a model answer from them. Bind a **namespace**
(`ai_search_namespaces`): the single-instance binding cannot write items. Nothing runs locally, so keep a fallback for
when the binding is absent.

```jsonc
// wrangler.jsonc: wrangler creates the namespace on deploy if it is missing
"ai_search_namespaces": [{ "binding": "DOCS_SEARCH", "namespace": "my-app-docs" }]
```

```typescript
import { createAiSearchClient, openAiSearchInstance } from '@ottabase/cf/ai-search';

// Get the instance, or create it on first use (hybrid index, filterable `kind`, and the `hash` sync keeps).
const opened = await openAiSearchInstance(env.DOCS_SEARCH, {
    id: 'docs',
    index_method: { vector: true, keyword: true },
    custom_metadata: [
        { field_name: 'kind', data_type: 'text' },
        { field_name: 'hash', data_type: 'text' },
    ],
});
if (!opened.success) throw opened.error;
const search = createAiSearchClient({ instance: opened.data });

// Make the index hold exactly these documents: changed ones upload, gone ones delete, unchanged ones cost nothing.
const report = await search.sync([{ name: 'guides/queues.md', content: markdown, metadata: { kind: 'guide' } }]);

// Per request, `namespace.get(id)` is free: no network call until a method runs.
const docs = createAiSearchClient({ instance: env.DOCS_SEARCH.get('docs') });
const hits = await docs.search('how do retries work', { limit: 5, filters: { kind: 'guide' } });
const answer = await docs.ask('How do I retry a failed message?', { system: 'Answer only from the context.' });

// A scoped client stamps its prefix on writes and forces a folder filter on reads: it cannot see outside it.
const articles = docs.scoped('articles/');
```

- `upsert`, `remove`, `list` and `sync` write and read items; an upload of an existing name replaces it.
- `sync` refuses an empty list (it would empty the scope) unless `{ allowEmpty: true }`, skips items still indexing, and
  stops at the first failed write so the next run resumes. Ingestion is billed by the token, so never re-upload
  unchanged documents: `sync` is how.
- `ask` generates with `DEFAULT_ANSWER_MODEL` (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), billed to Workers AI. For a
  tenant's corpus, retrieve with `search` and generate through `@ottabase/ottaai` so the tenant's key pays.
- Scopes fail closed: `search` drops any chunk from outside the client's prefix, and `ask` refuses the whole answer
  (`AI_SEARCH_SCOPE_LEAK`), because the model has already read it.
- Queries are metered (1,000 a month included per account): search on submit, not on every keystroke.

### Workers AI

```typescript
import { createAiClient } from '@ottabase/cf/ai';

const ai = createAiClient({ ai: env.OBCF_AI, gateway: { id: 'my-gateway' } });
const embeddings = await ai.embed(['first chunk', 'second chunk']); // number[][] in input order
const answer = await ai.generateText('Summarise this ticket', { system: 'Be brief.' });
const raw = await ai.run('@cf/openai/whisper', { audio: bytes }); // anything else
```

For provider routing, customer keys and spend tracking use `@ottabase/ottaai`; this is the raw binding.

### Browser Rendering

```typescript
import { createBrowserClient } from '@ottabase/cf/browser';

const browser = createBrowserClient({ browser: env.OBCF_BROWSER });
const pdf = await browser.pdf({ html: invoiceHtml }, { pdfOptions: { format: 'a4', printBackground: true } });
const md = await browser.markdown({ url: 'https://example.com/docs' }); // what you feed a model
const data = await browser.json({ url }, { prompt: 'Extract the product name and price' });
```

Quick actions only; for a scripted session use `@cloudflare/puppeteer` against the same binding.

### Workflows

```typescript
import { createWorkflowsClient } from '@ottabase/cf/workflows';

const onboarding = createWorkflowsClient<{ userId: string }>({ workflow: env.ONBOARDING });
await onboarding.start({ userId }, { id: `onboarding-${userId}` }); // the id makes it idempotent
await onboarding.status(id);
await onboarding.sendEvent(id, 'email.verified');
```

### Durable Object alarms

```typescript
import { AlarmQueue } from '@ottabase/cf/durable-alarms';

class Ticket extends DurableObject {
    private alarms = new AlarmQueue<{ kind: 'sla' | 'reminder' }>(this.ctx.storage);
    async open() {
        await this.alarms.schedule('sla', Date.now() + 4 * 3_600_000, { kind: 'sla' });
        await this.alarms.schedule('reminder', Date.now() + 86_400_000, { kind: 'reminder' });
    }
    async alarm() {
        for (const due of await this.alarms.due()) await this.handle(due); // re-armed for the rest
    }
}
```

## Complete Documentation

For setup instructions, configuration, and Next.js integration, see the
[Cloudflare Features Documentation](../../docs/cloudflare-features.md).

## License

MIT
