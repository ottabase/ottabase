// The framework invariants in the root eslint.config.mjs, run against snippets at the paths they
// guard: each rule fires on the shape it exists to stop (and on each known way around it) and stays
// quiet on the sanctioned one.

import { ESLint } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const eslint = new ESLint({ cwd: ROOT });

/** Every error a snippet raises, as if it lived at `file` (relative to the repo root). */
async function errors(code: string, file: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
    return result.messages.filter((message) => message.severity === 2).map((message) => message.ruleId as string);
}

/** The ottabase/* rules a snippet breaks. */
async function broken(code: string, file: string): Promise<string[]> {
    return (await errors(code, file)).filter((rule) => rule.startsWith('ottabase/'));
}

// Modules on disk for the one-hop checks, beside this test; removed afterwards.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '.lint-fixtures');
function fixture(name: string, content: string): string {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(path.join(FIXTURES, name), content);
    return path.join(FIXTURES, name);
}
/** A relative specifier from `from` (repo-relative) to a fixture, as an import would spell it. */
const relativeTo = (from: string, file: string) =>
    path
        .relative(path.dirname(path.join(ROOT, from)), file)
        .split(path.sep)
        .join('/');
afterAll(() => fs.rmSync(FIXTURES, { recursive: true, force: true }));

describe('no-node-only-imports', () => {
    it('stops fs and child_process in Worker and browser code, any import form', async () => {
        expect(await broken("import { readFileSync } from 'node:fs';", 'apps/otta-web/worker/lib/x.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
        expect(
            await broken("export async function f() { return import('child_process'); }", 'packages/utils/src/x.ts'),
        ).toEqual(['ottabase/no-node-only-imports']);
        expect(await broken("const fs = require('fs/promises');", 'apps/otta-web/src/x.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
        // A template literal without interpolation is a plain specifier.
        expect(await broken('export const f = () => import(`fs`);', 'packages/utils/src/x.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
        expect(await broken('const cp = require(`child_process`);', 'apps/otta-web/worker/x.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
    });

    it('allows type-only imports, what Workers have, tooling and tests', async () => {
        const worker = 'apps/otta-web/worker/lib/x.ts';
        expect(await broken("import type { Stats } from 'node:fs';", worker)).toEqual([]);
        expect(await broken("import { type Stats } from 'node:fs';", worker)).toEqual([]);
        expect(await broken("export type { Stats } from 'fs';", worker)).toEqual([]);
        expect(await broken("import { Buffer } from 'node:buffer';", worker)).toEqual([]);
        expect(await broken("import fs from 'node:fs';", 'packages/cli/src/x.ts')).toEqual([]);
        expect(await broken("import fs from 'node:fs';", 'apps/otta-web/scripts/seed.ts')).toEqual([]);
        expect(
            await broken(
                "import { DatabaseSync } from 'node:sqlite'; import fs from 'fs';",
                'packages/auth/src/__tests__/x.test.ts',
            ),
        ).toEqual([]);
    });

    it('treats a scripts/ folder inside shipped code as shipped code', async () => {
        expect(await broken("import fs from 'node:fs';", 'apps/otta-web/worker/scripts/x.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
        expect(await broken("import fs from 'node:fs';", 'packages/utils/src/scripts/x.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
    });

    it('follows one relative re-export: a barrel of a sanctioned Node file fails', async () => {
        // packages/utils/src/file.ts is sanctioned (its own subpath) and imports node:fs.
        expect(await broken("export * from './file';", 'packages/utils/src/index.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
        expect(await broken("export { readFile } from './file.js';", 'packages/utils/src/index.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
        // A lazy, guarded import() there (the logger's FileTransport) does not ship fs.
        expect(
            await broken("export { FileTransport } from './transports.js';", 'packages/logger/src/index.ts'),
        ).toEqual([]);
        // Nor does a type-only re-export.
        expect(await broken("export type * from './file';", 'packages/utils/src/index.ts')).toEqual([]);
    });
});

describe('headless-root', () => {
    it('stops a package root that reaches the UI kit or react-dom', async () => {
        expect(await broken("export { Button } from '@ottabase/ui';", 'packages/kernel/src/index.ts')).toEqual([
            'ottabase/headless-root',
        ]);
        expect(await broken("export * from 'react-dom/client';", 'packages/kernel/src/index.ts')).toEqual([
            'ottabase/headless-root',
        ]);
        expect(await broken("export { Button } from '@ottabase/ui';", 'packages/kernel/src/index.tsx')).toEqual([
            'ottabase/headless-root',
        ]);
        expect(await broken("export * from '@ottabase/ui/button';", 'packages/kernel/src/index.ts')).toEqual([
            'ottabase/headless-root',
        ]);
        expect(await broken("export * from '@ottabase/ui-tailwind';", 'packages/kernel/src/index.ts')).toEqual([
            'ottabase/headless-root',
        ]);
        expect(
            await broken("export { X } from 'lucide-react/dist/esm/icons/x';", 'packages/kernel/src/index.ts'),
        ).toEqual(['ottabase/headless-root']);
        expect(await broken("export * from '@ottabase/ui-datatable/react';", 'packages/kernel/src/index.ts')).toEqual([
            'ottabase/headless-root',
        ]);
    });

    it('lets through headless packages that only share the prefix, and type-only re-exports', async () => {
        const root = 'packages/kernel/src/index.ts';
        expect(await broken("export { useDataTable } from '@ottabase/ui-datatable';", root)).toEqual([]);
        expect(await broken("export * from '@ottabase/uikit-tokens';", root)).toEqual([]);
        expect(await broken("export type { ButtonProps } from '@ottabase/ui';", root)).toEqual([]);
        expect(await broken("export { useState } from 'react';", root)).toEqual([]);
    });

    it('looks one hop into a re-exported module, and leaves component libraries alone', async () => {
        // packages/ottaselect/src/components/OttaSelect.tsx imports @ottabase/ui.
        expect(
            await broken(
                "export { default } from '../../ottaselect/src/components/OttaSelect';",
                'packages/kernel/src/index.ts',
            ),
        ).toEqual(['ottabase/headless-root']);
        // ESM spelling: './x.js' names './x.ts'.
        expect(
            await broken(
                "export { default } from '../../ottaselect/src/components/OttaSelect.js';",
                'packages/kernel/src/index.ts',
            ),
        ).toEqual(['ottabase/headless-root']);
        expect(await broken("export { Button } from '@ottabase/ui';", 'packages/ottaselect/src/index.ts')).toEqual([]);
    });

    it('reads the hop without its comments or type-only imports', async () => {
        const root = 'packages/kernel/src/index.ts';
        const quiet = fixture(
            'quiet.ts',
            [
                "// Not like this: import { Button } from '@ottabase/ui';",
                "/* nor export * from 'react-dom'; */",
                "import type { ButtonProps } from '@ottabase/ui';",
                'export type Props = ButtonProps;',
            ].join('\n'),
        );
        expect(await broken(`export * from './${relativeTo(root, quiet)}';`, root)).toEqual([]);
        const loud = fixture('loud.ts', "import { Button } from '@ottabase/ui';\nexport const B = Button;\n");
        expect(await broken(`export * from './${relativeTo(root, loud)}';`, root)).toEqual(['ottabase/headless-root']);
    });
});

describe('sanitized-inner-html', () => {
    const at = 'packages/ottarenderer/src/X.tsx';

    it('stops an unsanitized payload', async () => {
        const bad = [
            'export const X = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;',
            'export const X = ({ props }) => <div dangerouslySetInnerHTML={props} />;',
            // Spread into JSX.
            'export const X = ({ html }) => <div {...{ dangerouslySetInnerHTML: { __html: html } }} />;',
            // A name that only starts like the helpers, or like a sanitized value.
            'export const X = ({ html }) => <div dangerouslySetInnerHTML={{ __html: sanitizeAnything(html) }} />;',
            'export const X = ({ sanitizedish }) => <div dangerouslySetInnerHTML={{ __html: sanitizedish }} />;',
            'export const X = ({ Sanitized }) => <div dangerouslySetInnerHTML={{ __html: Sanitized }} />;',
            // A template or fallback with one raw part.
            'export const X = ({ html }) => <div dangerouslySetInnerHTML={{ __html: `<b>${html}</b>` }} />;',
            'export const X = ({ sanitizedA, html }) => <div dangerouslySetInnerHTML={{ __html: sanitizedA || html }} />;',
            // A constant that is not a fixed string.
            'export const X = ({ html }) => { const HTML = html; return <div dangerouslySetInnerHTML={{ __html: HTML }} />; };',
            "let MARKUP = '<br>'; export const X = () => <div dangerouslySetInnerHTML={{ __html: MARKUP }} />;",
        ];
        for (const code of bad) expect(await broken(code, at), code).toEqual(['ottabase/sanitized-inner-html']);
        // createElement in a plain .ts file.
        expect(
            await broken(
                "export const x = (html: string) => createElement('div', { dangerouslySetInnerHTML: { __html: html } });",
                'packages/ottarenderer/src/x.ts',
            ),
        ).toEqual(['ottabase/sanitized-inner-html']);
    });

    it('accepts a sanitizer call, a sanitized value, a string constant, and choices or templates of them', async () => {
        const ok = [
            'export const X = ({ html }) => <div dangerouslySetInnerHTML={{ __html: sanitizeBlockHtml(html) }} />;',
            'export const X = ({ html }) => <div dangerouslySetInnerHTML={{ __html: utils.sanitizeInlineHtml(html) }} />;',
            'export const X = ({ sanitized }) => <div dangerouslySetInnerHTML={{ __html: sanitized }} />;',
            'export const X = ({ post }) => <div dangerouslySetInnerHTML={{ __html: post.sanitizedHtml }} />;',
            "export const X = () => <div dangerouslySetInnerHTML={{ __html: '<br>' }} />;",
            'export const X = ({ a, b, c }) => <div dangerouslySetInnerHTML={{ __html: c ? sanitizeSvgHtml(a) : sanitizedB }} />;',
            "export const X = ({ sanitizedA }) => <div dangerouslySetInnerHTML={{ __html: sanitizedA ?? '' }} />;",
            'export const X = ({ a }) => <div dangerouslySetInnerHTML={{ __html: `<p>${sanitizeInlineHtml(a)}</p>` }} />;',
            "const SCRIPT = '<b>x</b>'; export const X = () => <div dangerouslySetInnerHTML={{ __html: SCRIPT }} />;",
            'const SCHEME_INIT_SCRIPT = `var k=${sanitizeJsonForScript(KEY)};`; export const X = () => <script dangerouslySetInnerHTML={{ __html: SCHEME_INIT_SCRIPT }} />;',
            'export const X = ({ a }) => <div {...{ dangerouslySetInnerHTML: { __html: sanitizeBlockHtml(a) } }} />;',
        ];
        for (const code of ok) expect(await broken(code, at), code).toEqual([]);
        expect(
            await broken(
                "export const x = (html: string) => createElement('div', { dangerouslySetInnerHTML: { __html: sanitizeBlockHtml(html) } });",
                'packages/ottarenderer/src/x.ts',
            ),
        ).toEqual([]);
    });
});

describe('Ottabase Pro', () => {
    it('holds the same invariants under packages/pro', async () => {
        expect(await broken("import fs from 'node:fs';", 'packages/pro/sso/src/x.ts')).toEqual([
            'ottabase/no-node-only-imports',
        ]);
        expect(await broken("export { Button } from '@ottabase/ui';", 'packages/pro/sso/src/index.ts')).toEqual([
            'ottabase/headless-root',
        ]);
    });

    it('lints the app templates a Pro package ships, where they live', async () => {
        expect(
            await broken(
                "export const f = (env) => env.OBCF_D1.prepare('SELECT 1');",
                'packages/pro/tower/app/ottabase/packages/tower.ts',
            ),
        ).toEqual(['ottabase/no-raw-d1']);
        expect(
            await errors("export const f = () => fetch('/api/x');", 'packages/pro/tower/app/src/pages/TowerPage.tsx'),
        ).toContain('no-restricted-globals');
    });
});

describe('no-raw-d1', () => {
    const route = 'apps/otta-web/worker/routes/x.ts';

    it('stops raw D1 in an app route and lets the model call through', async () => {
        expect(await broken("export const f = (env) => env.OBCF_D1.prepare('SELECT 1').first();", route)).toEqual([
            'ottabase/no-raw-d1',
        ]);
        expect(
            await broken('export const f = (env) => env.OBCF_D1!.batch([]);', 'apps/otta-web/ottabase/x.ts'),
        ).toEqual(['ottabase/no-raw-d1']);
        expect(await broken("export const f = () => User.first({ email: 'a' });", route)).toEqual([]);
    });

    it('stops every way of getting a handle on the binding', async () => {
        const evasions = [
            "export const f = (env) => env['OBCF_D1'].prepare('SELECT 1');",
            "export const f = (env) => { const { OBCF_D1 } = env; return OBCF_D1.prepare('SELECT 1'); };",
            "export const f = (env) => { const db = env.OBCF_D1; return db.prepare('SELECT 1'); };",
            "export const f = (env) => (env.OBCF_D1 as D1Database).prepare('SELECT 1');",
            "export const f = (env) => env?.OBCF_D1?.exec('SELECT 1');",
            "export const f = ({ OBCF_D1: db }) => db.prepare('SELECT 1');",
            'export const f = (env) => createD1Driver(env.ANALYTICS_D1);',
        ];
        for (const code of evasions) expect(await broken(code, route), code).toEqual(['ottabase/no-raw-d1']);
        // Worker .tsx (a server-rendered page) is server code too.
        expect(
            await broken("export const f = (env) => env.OBCF_D1.prepare('SELECT 1');", 'apps/otta-web/worker/x.tsx'),
        ).toEqual(['ottabase/no-raw-d1']);
    });

    it('allows a presence check, which yields a boolean and no handle', async () => {
        const checks = [
            'export const f = (env) => { if (!env.OBCF_D1) return null; return 1; };',
            'export const f = (env) => !env?.OBCF_D1;',
            'export const f = (env) => Boolean(env.OBCF_D1);',
            'export const f = (env, seen) => seen === env.OBCF_D1;',
        ];
        for (const code of checks) expect(await broken(code, route), code).toEqual([]);
    });

    it('leaves the bootstrap and the driver registration alone', async () => {
        expect(
            await broken(
                "export const f = (env) => env.OBCF_D1.prepare('SELECT 1').first();",
                'apps/otta-web/worker/bootstrap/x.ts',
            ),
        ).toEqual([]);
        expect(
            await broken(
                "export const f = (env) => registerConnection('default', createD1Driver(env.OBCF_D1));",
                'apps/otta-web/worker/lib/db-utils.ts',
            ),
        ).toEqual([]);
    });
});
