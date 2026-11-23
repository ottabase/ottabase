// ============================================================
// Ottabase - Root ESLint Flat Config (ESLint v9)
// ============================================================
//
// Single source of truth for linting every workspace. ESLint resolves this file
// by walking up from each package's cwd, so packages do NOT need their own
// config -- and should not add one, because a local config shadows this file and
// silently opts the package out of the framework invariants below.
//
// The "Framework invariants" section encodes rules that AGENTS.MD used to state
// only in prose. Prose did not hold: `errorResponse(...)` has been an Always-On
// Rule for months and hand-rolled JSON error responses still shipped. Anything
// an agent must never do should live here, where the toolchain rejects it.
//
// Adding a rule? Also add a one-line pointer in AGENTS.MD -> "Enforced by lint",
// and keep the prose short. The docs describe judgement; this file describes law.
//
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import storybook from 'eslint-plugin-storybook';

// ============================================================
// Path groups
// ============================================================

/** Browser/client code. Must reach the network through the provider client. */
const CLIENT_GLOBS = ['apps/*/src/**/*.{ts,tsx}'];

/** Edge/server code: Workers, route handlers, and framework package sources. */
const SERVER_GLOBS = [
    'apps/*/worker/**/*.ts',
    'apps/*/ottabase/**/*.{ts,tsx}',
    'apps/*/cloudflare-worker.ts',
    // Next.js (OpenNext) apps: the App Router and its server helpers run on the Worker.
    'apps/*/app/**/*.{ts,tsx}',
    'apps/*/lib/**/*.{ts,tsx}',
    'packages/*/src/**/*.{ts,tsx}',
    // Ottabase Pro, subtree'd into a buyer's monorepo at packages/pro: the same invariants hold.
    'packages/pro/*/src/**/*.{ts,tsx}',
];

/** Node-only tooling. Genuinely allowed to use `process`, raw responses, etc. */
const TOOLING_GLOBS = [
    'packages/scripts/**',
    'packages/cli/**',
    'packages/docs/**',
    '**/*.config.{ts,js,cjs,mjs}',
    '**/scripts/**',
    // Pro Blackbox's source-map uploader: a Node CLI run after `vite build`, never bundled.
    'packages/pro/blackbox/src/upload.ts',
];

const TEST_GLOBS = ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/*.stories.{ts,tsx}'];

// ============================================================
// Framework invariants (selectors)
// ============================================================

/**
 * Hand-rolled JSON error responses drift from the canonical error contract:
 * they miss the stable `code`, `Cache-Control: no-store`, and the 5xx redaction
 * that `errorResponse()` applies by default.
 */
const NO_HANDROLLED_JSON_RESPONSE = {
    selector:
        "NewExpression[callee.name='Response'] > CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
    message:
        'Use errorResponse()/jsonResponse() from @ottabase/utils instead of new Response(JSON.stringify(...)). Hand-rolled responses bypass the stable error code, no-store caching, and 5xx redaction.',
};

/**
 * Cloudflare Workers have no `process`. Edge config must come from the env
 * binding via the config loader, not from a build-time global.
 */
const NO_PROCESS_ENV = {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
        'process.env is not available in the Cloudflare Workers runtime. Read configuration from the env binding (getOttabaseConfig(env)) instead.',
};

/**
 * `Model.all()` is a complete-set request and must go through OttaORM's
 * bounded implementation or the explicit keyset `pages()` API. The selector
 * intentionally targets model-shaped calls and `withTrashed().all()` without
 * matching D1's lowercase statement `.all()` or `Promise.all()`.
 */
const NO_UNBOUNDED_MODEL_ALL = {
    selector: [
        "CallExpression[callee.type='MemberExpression'][callee.property.name='all'][callee.object.type='ThisExpression']",
        "CallExpression[callee.type='MemberExpression'][callee.property.name='all'][callee.object.type='Identifier'][callee.object.name=/^[A-Z]/][callee.object.name!='Promise']",
        "CallExpression[callee.type='MemberExpression'][callee.property.name='all'][callee.object.type='CallExpression'][callee.object.callee.property.name='withTrashed']",
    ].join(','),
    message:
        'Do not read a model with .all() from a request path. Use a bounded where/aggregate query or iterate Model.pages({ perPage }).',
};

const SERVER_SYNTAX_RULES = [NO_HANDROLLED_JSON_RESPONSE, NO_PROCESS_ENV, NO_UNBOUNDED_MODEL_ALL];

// ============================================================
// Local plugin: Ottabase-specific rules
// ============================================================
//
// Home for invariants that generic ESLint rules cannot express. `no-restricted-
// syntax` carries one severity for all of its selectors, so anything that needs
// its own severity lives here rather than being folded in above.

/**
 * Node built-ins Workers do not have, even with `nodejs_compat`: no filesystem, no processes, no
 * threads, no VM. Edge and browser code that imports one builds, then fails at runtime.
 */
const NODE_ONLY_MODULES = new Set([
    'fs',
    'fs/promises',
    'child_process',
    'cluster',
    'worker_threads',
    'readline',
    'repl',
    'vm',
    'inspector',
    'v8',
]);

/** Modules that render DOM UI: a headless root entrypoint must not reach them (mobile imports it). */
const RENDERED_MODULE = /^(react-dom|@ottabase\/ui|lucide-react|@tabler\/icons-react|@radix-ui\/)/;

/** Import, re-export, dynamic import and require sources in a file, as [node, source] pairs. */
function moduleSources(node) {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return [node.source?.value];
    if (node.type === 'ExportNamedDeclaration') return node.source ? [node.source.value] : [];
    if (node.type === 'ImportExpression' && node.source.type === 'Literal') return [node.source.value];
    if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments[0]?.type === 'Literal'
    ) {
        return [node.arguments[0].value];
    }
    return [];
}

const SOURCE_NODES = [
    'ImportDeclaration',
    'ExportAllDeclaration',
    'ExportNamedDeclaration',
    'ImportExpression',
    'CallExpression',
];

/** The specifiers a module file imports, read from disk (for the one-hop headless check). */
function importsOf(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    } catch {
        return [];
    }
}

function resolveRelative(fromFile, specifier) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
        const candidate = base + suffix;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

/** Is `__html` given something visibly sanitized: a sanitize*() call, a `sanitized*` value, or a constant? */
function isSanitizedHtml(expression) {
    if (!expression) return false;
    if (expression.type === 'CallExpression') {
        const callee = expression.callee;
        const name =
            callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property.name : '';
        return /^sanitize/.test(name ?? '');
    }
    if (expression.type === 'Identifier') return /^sanitized/i.test(expression.name);
    if (expression.type === 'ConditionalExpression') {
        return isSanitizedHtml(expression.consequent) && isSanitizedHtml(expression.alternate);
    }
    if (expression.type === 'Literal') return typeof expression.value === 'string';
    if (expression.type === 'TemplateLiteral') return expression.expressions.length === 0;
    return false;
}

/** `env.OBCF_D1.prepare(...)` and friends: a D1 binding called directly. */
function isRawD1Call(node) {
    const callee = node.callee;
    if (callee.type !== 'MemberExpression' || !['prepare', 'exec', 'batch'].includes(callee.property.name))
        return false;
    let target = callee.object;
    if (target.type === 'TSNonNullExpression') target = target.expression;
    return target.type === 'MemberExpression' && /(^|_)D1$/.test(target.property.name ?? '');
}

const RAW_ERROR_LOG_SELECTOR =
    "CallExpression[callee.object.name='console'][callee.property.name=/^(error|warn|log|info)$/] > Identifier[name=/^(err|error|e)$/]";

const ottabasePlugin = {
    rules: {
        /**
         * Logging a caught error directly can write bearer tokens, cookies,
         * connection strings, and request bodies into the log sink. Wrap it in
         * redactErrorForLog() from @ottabase/utils/http-errors.
         */
        'no-raw-error-log': {
            meta: {
                type: 'problem',
                docs: { description: 'Redact thrown values before logging them' },
                schema: [],
                messages: {
                    rawErrorLog:
                        'Wrap "{{name}}" in redactErrorForLog() from @ottabase/utils/http-errors. Raw error objects can carry tokens, cookies, and request bodies into logs.',
                },
            },
            create(context) {
                return {
                    [RAW_ERROR_LOG_SELECTOR](node) {
                        context.report({ node, messageId: 'rawErrorLog', data: { name: node.name } });
                    },
                };
            },
        },

        /** Edge and browser code runs on Workers and in browsers: no fs, no child_process, no threads. */
        'no-node-only-imports': {
            meta: {
                type: 'problem',
                docs: { description: 'Keep Node-only built-ins out of edge and browser code' },
                schema: [],
                messages: {
                    nodeOnly:
                        '"{{name}}" is Node-only: Cloudflare Workers and browsers have no filesystem, processes or threads. Use an R2/KV/D1 binding through @ottabase/cf, or move this into tooling (packages/cli, packages/scripts).',
                },
            },
            create(context) {
                const check = (node) => {
                    for (const source of moduleSources(node)) {
                        if (typeof source !== 'string') continue;
                        const name = source.replace(/^node:/, '');
                        if (NODE_ONLY_MODULES.has(name))
                            context.report({ node, messageId: 'nodeOnly', data: { name: source } });
                    }
                };
                return Object.fromEntries(SOURCE_NODES.map((type) => [type, check]));
            },
        },

        /**
         * A package's root entrypoint is headless: mobile and Workers import it. It must not reach
         * a DOM renderer or the UI kit, directly or through a module it re-exports (checked one hop
         * deep, which is where a stray re-export of a component lands).
         */
        'headless-root': {
            meta: {
                type: 'problem',
                docs: { description: 'Keep package root entrypoints DOM-free' },
                schema: [],
                messages: {
                    rendered:
                        'The root entrypoint reaches "{{module}}"{{via}}. Keep it headless (types, models, schemas, hooks, pure utils) and export rendered UI from a subpath such as ./react.',
                },
            },
            create(context) {
                const file = context.filename;
                const check = (node) => {
                    for (const source of moduleSources(node)) {
                        if (typeof source !== 'string') continue;
                        if (RENDERED_MODULE.test(source)) {
                            context.report({ node, messageId: 'rendered', data: { module: source, via: '' } });
                        } else if (source.startsWith('.')) {
                            const resolved = resolveRelative(file, source);
                            const hit = resolved && importsOf(resolved).find((inner) => RENDERED_MODULE.test(inner));
                            if (hit) {
                                context.report({
                                    node,
                                    messageId: 'rendered',
                                    data: { module: hit, via: ` through ${source}` },
                                });
                            }
                        }
                    }
                };
                return Object.fromEntries(SOURCE_NODES.map((type) => [type, check]));
            },
        },

        /**
         * Every `dangerouslySetInnerHTML` payload is visibly sanitized where it is used:
         * `sanitizeBlockHtml(...)` and the other helpers of @ottabase/utils/sanitize, or a value
         * named `sanitized*` that one of them produced.
         */
        'sanitized-inner-html': {
            meta: {
                type: 'problem',
                docs: { description: 'Pass dangerouslySetInnerHTML through a sanitizer' },
                schema: [],
                messages: {
                    unsanitized:
                        'Pass __html through a sanitizer from @ottabase/utils/sanitize (sanitizeBlockHtml, sanitizeInlineHtml, sanitizeSvgHtml, sanitizeJsonForScript, sanitizeCssForStyleTag), or name the sanitized value `sanitized...`.',
                },
            },
            create(context) {
                return {
                    "JSXAttribute[name.name='dangerouslySetInnerHTML']"(node) {
                        const value = node.value?.type === 'JSXExpressionContainer' ? node.value.expression : null;
                        const html =
                            value?.type === 'ObjectExpression'
                                ? value.properties.find(
                                      (property) =>
                                          property.type === 'Property' &&
                                          (property.key.name === '__html' || property.key.value === '__html'),
                                  )?.value
                                : null;
                        if (!isSanitizedHtml(html)) context.report({ node, messageId: 'unsanitized' });
                    },
                };
            },
        },

        /** App code reaches D1 through OttaORM models, which carry RLS and the tenant scope. */
        'no-raw-d1': {
            meta: {
                type: 'problem',
                docs: { description: 'Use OttaORM models instead of the raw D1 binding in app code' },
                schema: [],
                messages: {
                    rawD1: 'Raw D1 ({{method}}) skips OttaORM: no RLS, no tenant scope, no casts. Use a model method (a fat model owns its queries).',
                },
            },
            create(context) {
                return {
                    CallExpression(node) {
                        if (isRawD1Call(node)) {
                            context.report({ node, messageId: 'rawD1', data: { method: node.callee.property.name } });
                        }
                    },
                };
            },
        },
    },
};

// ============================================================
// Config
// ============================================================

export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/.next/**',
            '**/.turbo/**',
            '**/coverage/**',
            '**/.wrangler/**',
            '**/*.min.js',
            // Generated Cloudflare type surface - tens of thousands of lines.
            'apps/*/cloudflare-env.d.ts',
            'apps/*/worker-configuration.d.ts',
        ],
    },

    // ---- Base: every TypeScript source in the monorepo ----
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
                ecmaFeatures: { jsx: true },
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            'react-hooks': reactHooks,
            ottabase: ottabasePlugin,
        },
        rules: {
            // Registered repo-wide: hook ordering is a correctness bug, and the
            // codebase already carries `eslint-disable react-hooks/*` directives
            // that silently referenced an unregistered rule until now.
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            // TypeScript resolves identifiers; core no-undef only produces noise here.
            'no-undef': 'off',
            'no-unused-vars': 'off',
            // Hygiene, not correctness. Held at `warn` because this config is the
            // first time most of the monorepo has been linted at all, and ~60
            // pre-existing violations should not gate CI on day one. The framework
            // invariants below stay at `error` -- the ratchet list is reserved for
            // invariant debt so it stays short enough to actually shrink.
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },

    // ---- Invariant: client code goes through the provider request client ----
    {
        files: CLIENT_GLOBS,
        rules: {
            'no-restricted-globals': [
                'error',
                {
                    name: 'fetch',
                    message:
                        'Use the framework request client instead of raw fetch: a query hook (useApiQuery/createModelHooks) for reads, useApiMutation for writes, or useApiClient() imperatively. Raw fetch skips auth headers, tenant scope, cancellation, and canonical ApiError handling.',
                },
            ],
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: '@ottabase/api',
                            importNames: ['createApiClient'],
                            message:
                                'Build the API client once in src/lib/api.ts and pass it to OttaQueryProvider. A second client gets its own auth/tenant headers and bypasses the visibility-scope boundary. Importing ApiError/isApiError is fine.',
                        },
                    ],
                },
            ],
        },
    },

    // ---- Invariant: edge/server code ----
    {
        files: SERVER_GLOBS,
        rules: {
            'no-restricted-syntax': ['error', ...SERVER_SYNTAX_RULES],
            'ottabase/no-raw-error-log': 'warn',
        },
    },

    // ---- Invariant: no Node-only built-ins in edge or browser code ----
    {
        files: [...SERVER_GLOBS, ...CLIENT_GLOBS],
        rules: { 'ottabase/no-node-only-imports': 'error' },
    },

    // ---- Invariant: a package's root entrypoint stays headless ----
    // Component libraries are rendered by design: their root IS the UI.
    {
        files: ['packages/*/src/index.ts', 'packages/pro/*/src/index.ts'],
        ignores: [
            'packages/ui/**',
            'packages/ui-*/**',
            'packages/brand-engine-react/**',
            'packages/ottaeditor/**',
            'packages/ottarenderer/**',
            'packages/ottaselect/**',
        ],
        rules: { 'ottabase/headless-root': 'error' },
    },

    // ---- Invariant: dangerouslySetInnerHTML goes through a sanitizer ----
    {
        files: ['**/*.tsx'],
        rules: { 'ottabase/sanitized-inner-html': 'error' },
    },

    // ---- Invariant: app server code reaches D1 through OttaORM models ----
    {
        files: [
            'apps/*/worker/**/*.ts',
            'apps/*/ottabase/**/*.{ts,tsx}',
            'apps/*/app/**/*.{ts,tsx}',
            'apps/*/lib/**/*.{ts,tsx}',
            'apps/*/cloudflare-worker.ts',
        ],
        rules: { 'ottabase/no-raw-d1': 'error' },
    },

    // ---- Sanctioned Node-only entrypoints (never imported by edge code) ----
    // A package's explicit Node subpath (file and git helpers, the headless-browser runner), the
    // migration generator drizzle-kit runs at build time, and the logger's FileTransport, which
    // imports fs lazily and only when `process.versions.node` says it runs on Node.
    {
        files: [
            'packages/logger/src/transports.ts',
            'packages/utils/src/file.ts',
            'packages/utils/src/git.ts',
            'packages/screenshot/src/node.ts',
            'packages/ottaorm/src/migrations/auto-generator.ts',
        ],
        rules: { 'ottabase/no-node-only-imports': 'off' },
    },

    // ---- Sanctioned raw D1: no model exists yet, or raw SQL is the feature ----
    // The bootstrap runs before the tables (and so the models) exist; the database console and
    // the D1 demo exist to run SQL.
    {
        files: [
            'apps/*/worker/bootstrap/**/*.ts',
            'apps/*/worker/routes/admin-db.ts',
            'apps/*/worker/routes/cloudflare-d1.ts',
        ],
        rules: { 'ottabase/no-raw-d1': 'off' },
    },

    // ---- Sanctioned static markup in innerHTML ----
    // The landing's colour-scheme script is a constant the app writes; the editor palette's icons
    // are its own built-in SVG strings. Neither carries user input.
    {
        files: ['apps/*/app/layout.tsx', 'packages/ottaeditor/src/BlockPalette.tsx'],
        rules: { 'ottabase/sanitized-inner-html': 'off' },
    },

    // ---- Sanctioned implementations of the response contract ----
    // These files ARE the helpers everything else is required to call.
    {
        files: [
            'packages/utils/src/http-errors.ts',
            'packages/utils/src/http-response.ts',
            'packages/utils/src/pagination.ts',
        ],
        rules: {
            'no-restricted-syntax': ['error', NO_PROCESS_ENV],
        },
    },

    // ---- Sanctioned readers of the Node/build-time environment ----
    // The env util and the app-config builder run during build or under an
    // explicit `typeof process !== 'undefined'` guard. Everything else on the
    // edge must go through the env binding.
    {
        files: ['packages/utils/src/env.ts', 'packages/config/src/**/*.ts'],
        rules: {
            'no-restricted-syntax': ['error', NO_HANDROLLED_JSON_RESPONSE],
        },
    },

    // ---- The single sanctioned API client construction site ----
    {
        files: ['apps/*/src/lib/api.ts'],
        rules: {
            'no-restricted-imports': 'off',
        },
    },

    // ---- Node-only tooling: process/env access is legitimate here ----
    {
        files: TOOLING_GLOBS,
        rules: {
            'no-restricted-syntax': 'off',
            'ottabase/no-raw-error-log': 'off',
            'ottabase/no-node-only-imports': 'off',
            'ottabase/no-raw-d1': 'off',
        },
    },

    // ---- Tests: assert against raw shapes, construct raw responses ----
    {
        files: TEST_GLOBS,
        rules: {
            'no-restricted-syntax': 'off',
            'no-restricted-globals': 'off',
            'no-restricted-imports': 'off',
            'ottabase/no-raw-error-log': 'off',
            // Tests run on Node (node:sqlite stands in for D1) and seed raw rows on purpose.
            'ottabase/no-node-only-imports': 'off',
            'ottabase/no-raw-d1': 'off',
            'ottabase/sanitized-inner-html': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },

    // ---- Storybook ----
    ...storybook.configs['flat/recommended'],
    {
        files: ['**/*.stories.{ts,tsx}'],
        rules: {
            // Story authoring conventions, not framework invariants. Visible but
            // non-blocking so they cannot mask a real failure in CI.
            'storybook/no-renderer-packages': 'warn',
            'storybook/no-redundant-story-name': 'warn',
        },
    },

    // ============================================================
    // RATCHET: pre-existing violations
    // ============================================================
    //
    // These files predate the rule that exempts them. The list may SHRINK, never
    // grow -- a new entry is a visible config diff and must be challenged in
    // review. Do not add a new app or package here; fix the call site instead.
    //
    // Each entry below is tracked debt, not an approved pattern.
    // ============================================================

    {
        // Imperative fetch() calls written before the provider client was mandatory.
        // Fix: move to useApiQuery / useApiMutation / useApiClient().
        // `apps/*`, not `apps/otta-web`: `otta new web` copies these files verbatim into a new app
        // (and `otta presets check` lints that copy), so the debt follows the file, not the folder.
        files: [
            'apps/*/src/pages/admin/appearance/brand/brandApi.ts',
            'apps/*/src/pages/admin/content/blog/AdminBlogEditorPage.tsx',
            'apps/*/src/pages/admin/infrastructure/MigrationsPage.tsx',
            'apps/*/src/pages/auth/LoginPage.tsx',
            'apps/*/src/pages/demo/cloudflare/CloudflareR2DemoPage.tsx',
            'apps/*/src/pages/demo/CodeBlockDemoPage.tsx',
        ],
        rules: { 'no-restricted-globals': 'off' },
    },
    {
        // Hand-rolled JSON responses predating the errorResponse() contract.
        // Fix: return errorResponse(...) / jsonResponse(...) from @ottabase/utils.
        files: [
            'packages/analytics/src/server.ts',
            'packages/cf-realtime/src/server/RealtimeActor.ts',
            'packages/ottaai/src/ottaorm/handlers.ts',
            'packages/ottaorm/src/crud/index.ts',
            'packages/rbac/src/admin-guard.ts',
            'packages/rbac/src/middleware.ts',
        ],
        rules: { 'no-restricted-syntax': ['error', NO_PROCESS_ENV] },
    },
    {
        // process.env.BASE_URL as a default parameter in an edge-shipped util.
        // This is a latent runtime bug on Workers, not just a style issue.
        files: ['packages/utils/src/url.ts'],
        rules: { 'no-restricted-syntax': ['error', NO_HANDROLLED_JSON_RESPONSE] },
    },
    {
        // !! REAL BUGS, NOT STYLE !!
        //
        // These components call hooks after an early return, so the hook order
        // changes between renders. React associates state by call order, which
        // means the wrong state can be read, effects can be skipped or attached
        // to the wrong values, and the component can throw on re-render.
        //
        // They were invisible until now only because repo-wide lint never ran.
        // Each file needs its early returns moved below the hook calls (render
        // the fallback from the returned JSX instead). Fix and delete the entry.
        files: [
            'apps/*/src/components/ReferralTracker.tsx',
            'packages/ottarenderer/src/components/AdvancedImage/AdvancedImage.tsx',
            'packages/ottarenderer/src/components/BeforeAfter/BeforeAfter.tsx',
            'packages/ottarenderer/src/components/ImageHotspots/ImageHotspots.tsx',
            'packages/ottarenderer/src/components/MediaEmbed.tsx',
            'packages/ottarenderer/src/components/Review.tsx',
        ],
        rules: { 'react-hooks/rules-of-hooks': 'warn' },
    },
    {
        // Raw D1 queries in an app route, predating the rule. The audit log reads join
        // memberships by hand; an AuditLog model method should own them.
        // Fix: move the query into a model method and call that.
        files: ['apps/*/worker/routes/audit.ts'],
        rules: { 'ottabase/no-raw-d1': 'off' },
    },
];
