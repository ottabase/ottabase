// ============================================================
// Copied templates that keep your edits
// ============================================================
// `otta add` copies a package's `app/` files (its composition, its pages) into the app. Those
// copies are yours to change, and the package keeps improving its templates. To bring a later
// template into an edited copy without losing the edit, the CLI records the template each file
// was copied from in `apps/<app>/.ottabase-templates.json` (the "base"), and on the next add:
//
//   - template unchanged since the copy        -> nothing to do
//   - copy unchanged since the copy (no edits) -> replaced by the new template
//   - both changed                             -> three-way merge (git merge-file): the
//                                                 template's changes applied to your edits
//   - both changed the same lines              -> conflict markers in the file, as git writes
//                                                 them; resolve them and commit
//   - git cannot merge them (binary, error)    -> left alone, the plan says why
//   - template removed from the package        -> copy deleted when unedited, flagged when
//                                                 edited; the record forgets it either way
//
// A copy made before this record existed has no base: when it still equals the template it is
// recorded from now on; when it differs, it is left alone and the plan says so.
// ============================================================

import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

export const TEMPLATE_RECORD = '.ottabase-templates.json';

export interface TemplateRecord {
    /** The package key the file came from. */
    package: string;
    /** The template's text when it was last copied or merged in: the base of the next merge. */
    base: string;
}

export interface TemplateRecords {
    version: 1;
    files: Record<string, TemplateRecord>;
}

export type TemplateOutcome =
    | { action: 'create'; content: string; detail: string }
    | { action: 'update'; content: string; detail: string }
    | { action: 'merge'; content: string; detail: string }
    | { action: 'conflict'; content: string; detail: string }
    | { action: 'skip'; detail: string };

export const lf = (text: string) => text.replace(/\r\n/g, '\n');
const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (text: string, eol: string) => (eol === '\n' ? text : text.replace(/\n/g, eol));

export function readTemplateRecords(appDir: string): TemplateRecords {
    const file = path.join(appDir, TEMPLATE_RECORD);
    try {
        const parsed = fs.readJsonSync(file) as Partial<TemplateRecords>;
        return { version: 1, files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {} };
    } catch {
        return { version: 1, files: {} };
    }
}

/** The record file's content, keys sorted so the diff stays small. Null when there is nothing to record. */
export function serializeTemplateRecords(records: TemplateRecords): string | null {
    const keys = Object.keys(records.files).sort();
    if (keys.length === 0) return null;
    const files = Object.fromEntries(keys.map((key) => [key, records.files[key]]));
    return `${JSON.stringify({ version: 1, files }, null, 4)}\n`;
}

export type MergeResult = { ok: true; text: string; conflicts: boolean } | { ok: false; reason: string };

/**
 * Three-way merge with `git merge-file` (git's own algorithm, on plain files: no repository
 * needed). Null when git is not installed. Exit status 1 to 127 is the number of conflicts (stdout
 * holds the merge with markers); anything else (255 for a binary file or an error, a signal) is a
 * failure, never an empty merge: writing that stdout would wipe the copy.
 */
export function mergeThreeWay(current: string, base: string, incoming: string): MergeResult | null {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otta-merge-'));
    try {
        const files = {
            current: path.join(dir, 'yours'),
            base: path.join(dir, 'base'),
            incoming: path.join(dir, 'template'),
        };
        fs.writeFileSync(files.current, current);
        fs.writeFileSync(files.base, base);
        fs.writeFileSync(files.incoming, incoming);
        const args = ['merge-file', '-p', '-L', 'yours', '-L', 'original template', '-L', 'new template'];
        try {
            const text = execFileSync('git', [...args, files.current, files.base, files.incoming], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            return { ok: true, text, conflicts: false };
        } catch (error) {
            const failure = error as { code?: string; status?: number | null; stdout?: string; stderr?: string };
            if (failure.code === 'ENOENT') return null;
            const status = failure.status;
            if (typeof status === 'number' && status >= 1 && status <= 127 && typeof failure.stdout === 'string') {
                return { ok: true, text: failure.stdout, conflicts: true };
            }
            const reason =
                (typeof failure.stderr === 'string' && failure.stderr.trim().split(/\r?\n/)[0]) ||
                (typeof status === 'number' ? `git merge-file exited ${status}` : String(error));
            return { ok: false, reason };
        }
    } finally {
        fs.removeSync(dir);
    }
}

/**
 * What to do with one template file, and the record it leaves behind (null: leave the record as
 * it was). `current` is the app's copy, or null when the app has none yet.
 */
export function planTemplate(input: {
    current: string | null;
    template: string;
    record: TemplateRecord | undefined;
    packageKey: string;
    source: string;
}): { outcome: TemplateOutcome; record: TemplateRecord | null } {
    const { current, template, record, packageKey, source } = input;
    const fresh: TemplateRecord = { package: packageKey, base: lf(template) };

    if (current === null) {
        return { outcome: { action: 'create', content: template, detail: `copied from ${source}` }, record: fresh };
    }
    const mine = lf(current);
    const next = lf(template);

    if (!record) {
        return mine === next
            ? { outcome: { action: 'skip', detail: 'same as the template; tracked from now on' }, record: fresh }
            : {
                  outcome: {
                      action: 'skip',
                      detail: 'differs from the template and was copied before otta recorded templates: compare it by hand',
                  },
                  record: null,
              };
    }
    if (record.base === next) return { outcome: { action: 'skip', detail: 'template unchanged' }, record: null };
    if (mine === next)
        return { outcome: { action: 'skip', detail: 'already matches the new template' }, record: fresh };
    if (mine === record.base) {
        return {
            outcome: {
                action: 'update',
                content: withEol(next, eolOf(current)),
                detail: `new template from ${source} (no local edits)`,
            },
            record: fresh,
        };
    }

    const merged = mergeThreeWay(mine, record.base, next);
    if (!merged) {
        return {
            outcome: { action: 'skip', detail: 'the template changed and so did your copy; install git to merge them' },
            record: null,
        };
    }
    if (!merged.ok) {
        return { outcome: { action: 'skip', detail: `could not merge: ${merged.reason}` }, record: null };
    }
    const content = withEol(merged.text, eolOf(current));
    return merged.conflicts
        ? {
              outcome: {
                  action: 'conflict',
                  content,
                  detail: 'your edits and the new template change the same lines: resolve the conflict markers',
              },
              record: fresh,
          }
        : {
              outcome: { action: 'merge', content, detail: `merged the new template from ${source} into your edits` },
              record: fresh,
          };
}
