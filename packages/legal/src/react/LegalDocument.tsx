/**
 * Renders one legal document: title, "last updated", an on-page table of contents, the body and a copyright footer.
 * Bring your own renderer through `renderMarkdown`, or use the built-in one. Import the styles once:
 * `import '@ottabase/legal/styles.css'`.
 */

import { TableOfContents } from '@ottabase/ui';
import { type ReactNode } from 'react';
import { assembleLegalDocument } from '../assemble';
import type { LegalConfig, LegalDocId } from '../types';
import { LegalMarkdown } from './LegalMarkdown';

export interface LegalDocumentProps {
    /** Which document to render. */
    docId: LegalDocId;
    /** Your assembled legal config. */
    config: LegalConfig;
    /** Optional custom Markdown renderer; it receives the fully assembled document Markdown. */
    renderMarkdown?: (markdown: string) => ReactNode;
    /** Show the on-page table of contents (default: true). */
    toc?: boolean;
    /** Extra class on the root `<article>`. */
    className?: string;
}

export function LegalDocument({ docId, config, renderMarkdown, toc = true, className }: LegalDocumentProps) {
    const doc = assembleLegalDocument(docId, config);
    const tocItems = doc.toc.filter((t) => t.level === 2);

    return (
        <article className={['otta-legal', className].filter(Boolean).join(' ')}>
            <h1 className="otta-legal-title">{doc.title}</h1>
            {doc.lastUpdated ? <p className="otta-legal-meta">Last updated {doc.lastUpdated}</p> : null}

            {toc && tocItems.length > 1 ? (
                // @ottabase/ui's TableOfContents, unstyled and dressed by styles.css (.otta-legal-toc [data-slot=…])
                <TableOfContents
                    unstyled
                    className="otta-legal-toc"
                    aria-label="On this page"
                    title="On this page"
                    items={tocItems.map((t) => ({ id: t.id, label: t.text, depth: t.level }))}
                />
            ) : null}

            {renderMarkdown ? renderMarkdown(doc.markdown) : <LegalMarkdown markdown={doc.markdown} />}

            <footer className="otta-legal-footer">
                <p>{doc.copyright}</p>
            </footer>
        </article>
    );
}
