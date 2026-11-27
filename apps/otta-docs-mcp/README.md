# otta-docs-mcp

The Ottabase documentation as a remote [Model Context Protocol](https://modelcontextprotocol.io) server. An assistant
connected to it (Claude, Claude Code, Cursor, anything that speaks MCP) can search and read the framework's docs while
it helps someone build.

It is Ottabase's own server, at `https://mcp.ottabase.com/mcp`. An app built on Ottabase does not need this Worker; it
is in the repository because the docs are, and as a small worked example of a stateless MCP server on Workers.

- **Read-only, no auth.** Three tools, each annotated `readOnlyHint`. No account, no key, no state.
- **Same docs as `llms.txt`.** The corpus is built from the pages `pnpm docs:llms` indexes (the start-here pages,
  `docs/`, every package README) plus the agent skills in `.claude/skills`, so the two never list different docs.
- **Hybrid search, with a fallback.** In production the docs also live in a Cloudflare AI Search instance, so a question
  phrased nothing like the docs still finds the right section (meaning plus keywords). A word index built at build time
  is bundled too: dev, the tests and any AI Search failure use it, at about a millisecond of CPU a search.
- **An HTTP API for people.** `/api/search` and `/api/ask` (a short answer written from the docs, with its sources)
  power the search on ottabase.com and the demo's docs page.

## Connect

| Client           | How                                                                              |
| ---------------- | -------------------------------------------------------------------------------- |
| Claude           | Customize → Connectors → add a custom connector → `https://mcp.ottabase.com/mcp` |
| Claude Code      | `claude mcp add --transport http ottabase-docs https://mcp.ottabase.com/mcp`     |
| Any other client | A remote server at that URL, HTTP transport                                      |

Then ask something the docs answer: "How do I add row level security to a model in Ottabase?"

## Tools

| Tool          | Arguments                  | Returns                                                                               |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| `search_docs` | `query`, `kind?`, `limit?` | The best-matching sections: document id, heading, an excerpt, a source link           |
| `get_doc`     | `id`, `section?`           | One page as Markdown. A long page returns an outline; ask for one section by heading  |
| `list_docs`   | `kind?`                    | Every page by group, with ids and titles; one group with summaries when `kind` is set |

A document id is the page's path in the repository (`packages/ottaorm/README.md`). `get_doc` also takes a package name
(`ottaorm`), a skill name or a file name. `kind` is `start`, `guide`, `package` or `skill`.

A wrong argument is answered with what to try next: the sections a page has, the pages closest to a mistyped id. Those
are ordinary results, not `isError`: the assistant reads them and carries on, and the connector directory counts an
`isError` result as a failed call in a listing's health.

## Routes

| Path          | What                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| `/mcp`        | The server. Streamable HTTP, the 2026-07-28 revision and stateless 2025-era clients       |
| `/`           | A page for people: what this is, how to connect, the tools, privacy                       |
| `/api/search` | `GET ?q=&kind=&limit=`: the best sections as JSON, each with a GitHub link at its heading |
| `/api/ask`    | `POST { question }`: an answer written from the docs, with the pages it read              |
| `/health`     | `{ ok, docs, generatedAt, revision, search }` (`search` is `ai-search` or `keyword`)      |

## How it is built

```text
scripts/build-corpus.mjs   reads the docs, cuts them into sections, indexes the words
        ↓ worker/corpus.generated.json (git-ignored, about 2 MB)
worker/index.ts            bundles it; worker/app.ts routes; worker/server.ts registers the tools
worker/search.ts           scores sections from the postings (the fallback)
worker/semantic.ts         AI Search: the cron's sync, hybrid search, answers (@ottabase/cf/ai-search)
```

`build-corpus.mjs` reads only the paths it names (the ones above). Nothing is globbed from elsewhere, so a private or
git-ignored file in a checkout cannot reach the public server; a test asserts the id of every page.

### Search: AI Search first, the keyword index behind it

In production the Worker binds the AI Search namespace `ottabase-docs` (`DOCS_SEARCH` in `wrangler.jsonc`; types in
`worker/env.ts`). A cron every 15 minutes runs `syncDocs`: it creates the `docs` instance on first run (hybrid index,
custom metadata `kind` and `hash`) and makes it hold exactly the bundled pages, each under its id. Only pages whose
content changed are uploaded (ingestion is billed by the token), so a deploy is indexed within the quarter hour and an
unchanged run costs three list calls.

`search_docs` and `/api/search` ask the instance first and map each chunk back to its page and section, at most two hits
per page. They fall back to the bundled keyword index when there is no binding (dev, tests), when AI Search fails, or
when it finds nothing; `engine` in the API response says which answered.

The keyword index: rarer words count more, a word in the heading or the page title counts extra, sections that hold
every word win, and the exact phrase is a bonus. A word of up to three letters must stand alone (`pro` is not
`provider`); a longer one also matches inside others (`upload` in `ottaupload`, `queue` in `queues`).

### The HTTP API

```bash
curl 'https://mcp.ottabase.com/api/search?q=how+do+I+retry+a+failed+job&limit=3'
curl -X POST https://mcp.ottabase.com/api/ask -H 'content-type: application/json' \
     -d '{"question":"How do I add row level security to a model?"}'
```

- `GET /api/search?q=` (2 to 200 characters), optional `kind` (`start`, `guide`, `package`, `skill`) and `limit` (1 to
  10, default 8) → `{ query, engine, hits: [{ id, kind, title, heading, excerpt, score, url }] }`.
- `POST /api/ask` with `{ question }` (3 to 500 characters) →
  `{ question, answer, sources: [{ id, kind, title, heading, url }], model }`. The answer is Markdown written by
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` from the best chunks, in 3 to 8 s. 503 `ASK_UNAVAILABLE` without the
  binding.
- Open CORS, no auth. Limited per address in production: 30 searches and 6 answers a minute (`429 RATE_LIMITED`,
  `Retry-After: 60`). `/mcp` is never limited: all of Claude's traffic shares one address range.

The protocol is the official SDK's (`@modelcontextprotocol/server`, `createMcpHandler`): a fresh server per request, no
session, no Durable Object.

## Develop

```bash
pnpm --filter @ottabase/otta-docs-mcp dev        # builds the corpus, then wrangler dev on http://127.0.0.1:8790
pnpm --filter @ottabase/otta-docs-mcp run smoke  # the official client against the running server, every tool once
pnpm --filter @ottabase/otta-docs-mcp test       # the client against the Worker's fetch handler, in process
```

`@ottabase/scripts` must be built (`pnpm build:pkg`): the corpus reuses its `gen-llms` collectors.

The tests cover the tool list the connector directory reviews (titles, annotations, name length), every tool's answers
and refusals, a 2025-era client, the real corpus (what goes in, what must not, search time) and the other routes.

## Deploy

```bash
pnpm --filter @ottabase/otta-docs-mcp run deploy                             # corpus, then wrangler deploy --env production
pnpm --filter @ottabase/otta-docs-mcp run smoke https://mcp.ottabase.com/mcp
```

`wrangler.jsonc` routes `env.production` to the custom domain `mcp.ottabase.com`. `cloudflare-config.json` has
`deployable: false`, so CI never deploys it and a fork never tries to claim that domain. Redeploy after the docs change:
the corpus is a snapshot taken at build time, and `/health` says which commit it was read at.

## Decisions

- **Tool arguments are plain JSON Schema, not zod.** The SDK depends on zod 4 while the rest of the workspace is on
  zod 3. A second zod as a direct dependency of an app changes which one pnpm hoists for packages that import zod
  without declaring it, which broke `zodResolver` in otta-web. The SDK's `fromJsonSchema` needs no zod here.
- **No rate limit.** A call is an in-memory lookup, and all of Claude's traffic arrives from one address range, so a
  per-address limit would throttle every Claude user together. Add a Cloudflare WAF rate rule on the zone if needed.
- **No Origin or Host check, open CORS.** The docs are public and nothing can be written. A strict Origin check rejects
  Claude's own requests.
- **Nothing is logged from a request body.** A tool argument is the user's words. Cloudflare's request logs hold the
  time, path and status.
