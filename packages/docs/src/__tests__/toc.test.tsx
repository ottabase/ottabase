// The docs TOC is @ottabase/ui's TableOfContents, unstyled and dressed by styles.css through data-slot selectors.
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TableOfContents } from '../components/MarkdownRenderer';

describe('docs <TableOfContents>', () => {
    it('renders every part styles.css targets, indented from the shallowest heading', () => {
        const css = readFileSync(join(__dirname, '../styles.css'), 'utf8');
        const slots = [...new Set([...css.matchAll(/\.otta-docs-toc \[data-slot='([\w-]+)'\]/g)].map((m) => m[1]))];
        expect(slots.length).toBeGreaterThan(0);

        const { container } = render(<TableOfContents content={'## Intro\n\n### Setup'} />);
        for (const slot of slots) {
            expect(container.querySelector(`.otta-docs-toc [data-slot='${slot}']`), slot).not.toBeNull();
        }
        const setup = screen.getByRole('link', { name: 'Setup' });
        expect(screen.getByRole('link', { name: 'Intro' }).style.getPropertyValue('--toc-depth')).toBe('0');
        expect(setup.style.getPropertyValue('--toc-depth')).toBe('1');

        // The active selector (`[data-active]`) lands on the clicked entry
        fireEvent.click(setup);
        expect(setup).toHaveAttribute('data-active');
    });
});
