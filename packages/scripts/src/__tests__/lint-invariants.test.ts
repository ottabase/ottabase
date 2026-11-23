// The framework invariants in the root eslint.config.mjs, run against snippets at the paths they
// guard: each rule fires on the shape it exists to stop and stays quiet on the sanctioned one.

import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const eslint = new ESLint({ cwd: ROOT });

/** The ottabase/* rules a snippet breaks, as if it lived at `file` (relative to the repo root). */
async function broken(code: string, file: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
    return result.messages
        .filter((message) => message.severity === 2 && message.ruleId?.startsWith('ottabase/'))
        .map((message) => message.ruleId as string);
}

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
    });

    it('allows what Workers have, tooling and tests', async () => {
        expect(await broken("import { Buffer } from 'node:buffer';", 'apps/otta-web/worker/lib/x.ts')).toEqual([]);
        expect(await broken("import fs from 'node:fs';", 'packages/cli/src/x.ts')).toEqual([]);
        expect(
            await broken(
                "import { DatabaseSync } from 'node:sqlite'; import fs from 'fs';",
                'packages/auth/src/__tests__/x.test.ts',
            ),
        ).toEqual([]);
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
    });

    it('looks one hop into a re-exported module, and leaves component libraries alone', async () => {
        // packages/ottaselect/src/components/OttaSelect.tsx imports @ottabase/ui.
        expect(
            await broken(
                "export { default } from '../../ottaselect/src/components/OttaSelect';",
                'packages/kernel/src/index.ts',
            ),
        ).toEqual(['ottabase/headless-root']);
        expect(await broken("export { Button } from '@ottabase/ui';", 'packages/ottaselect/src/index.ts')).toEqual([]);
        expect(await broken("export { useState } from 'react';", 'packages/kernel/src/index.ts')).toEqual([]);
    });
});

describe('sanitized-inner-html', () => {
    const at = 'packages/ottarenderer/src/X.tsx';

    it('stops an unsanitized payload', async () => {
        expect(
            await broken('export const X = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />;', at),
        ).toEqual(['ottabase/sanitized-inner-html']);
        expect(await broken('export const X = ({ props }) => <div dangerouslySetInnerHTML={props} />;', at)).toEqual([
            'ottabase/sanitized-inner-html',
        ]);
    });

    it('accepts a sanitizer call, a sanitized value, a constant and a choice between them', async () => {
        const ok = [
            'export const X = ({ html }) => <div dangerouslySetInnerHTML={{ __html: sanitizeBlockHtml(html) }} />;',
            'export const X = ({ sanitized }) => <div dangerouslySetInnerHTML={{ __html: sanitized }} />;',
            "export const X = () => <div dangerouslySetInnerHTML={{ __html: '<br>' }} />;",
            'export const X = ({ a, b, c }) => <div dangerouslySetInnerHTML={{ __html: c ? sanitizeSvgHtml(a) : sanitizedB }} />;',
        ];
        for (const code of ok) expect(await broken(code, at)).toEqual([]);
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
});

describe('no-raw-d1', () => {
    it('stops raw D1 in an app route and lets the model call through', async () => {
        expect(
            await broken(
                "export const f = (env) => env.OBCF_D1.prepare('SELECT 1').first();",
                'apps/otta-web/worker/routes/x.ts',
            ),
        ).toEqual(['ottabase/no-raw-d1']);
        expect(
            await broken('export const f = (env) => env.OBCF_D1!.batch([]);', 'apps/otta-web/ottabase/x.ts'),
        ).toEqual(['ottabase/no-raw-d1']);
        expect(
            await broken("export const f = () => User.first({ email: 'a' });", 'apps/otta-web/worker/routes/x.ts'),
        ).toEqual([]);
    });

    it('leaves the bootstrap, which runs before the models have tables, alone', async () => {
        expect(
            await broken(
                "export const f = (env) => env.OBCF_D1.prepare('SELECT 1').first();",
                'apps/otta-web/worker/bootstrap/x.ts',
            ),
        ).toEqual([]);
    });
});
