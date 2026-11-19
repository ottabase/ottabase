// The Slider (one thumb per value) and Checkbox (dash when indeterminate) fixes.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Checkbox } from '../../components/ui/checkbox';
import { Slider } from '../../components/ui/slider';

// Radix Slider measures its track; jsdom has no ResizeObserver
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

describe('<Slider>', () => {
    it('renders one thumb per value, with per-thumb labels', () => {
        render(<Slider defaultValue={[20, 80]} thumbLabels={['Minimum', 'Maximum']} />);
        const thumbs = screen.getAllByRole('slider');
        expect(thumbs).toHaveLength(2);
        expect(thumbs[0]).toHaveAccessibleName('Minimum');
        expect(thumbs[1]).toHaveAttribute('aria-valuenow', '80');
    });

    it('labels a single thumb from aria-label', () => {
        render(<Slider defaultValue={[5]} aria-label="Volume" />);
        expect(screen.getByRole('slider', { name: 'Volume' })).toBeInTheDocument();
    });
});

describe('<Checkbox indeterminate>', () => {
    it('shows the dash, not the check, when indeterminate', () => {
        const { container } = render(<Checkbox aria-label="all" checked="indeterminate" />);
        const indicator = container.querySelector('[data-slot="checkbox-indicator"]');
        expect(indicator).toHaveAttribute('data-state', 'indeterminate');
        expect(container.querySelector('[data-slot="checkbox-dash"]')?.getAttribute('class')).toContain(
            'group-data-[state=indeterminate]/checkbox-indicator:block',
        );
        expect(container.querySelector('[data-slot="checkbox-check"]')?.getAttribute('class')).toContain(
            'group-data-[state=indeterminate]/checkbox-indicator:hidden',
        );
    });

    it('stamps the indicator checked when checked, and renders no mark when unchecked', () => {
        const { container, rerender } = render(<Checkbox aria-label="one" checked />);
        expect(container.querySelector('[data-slot="checkbox-indicator"]')).toHaveAttribute('data-state', 'checked');
        rerender(<Checkbox aria-label="one" checked={false} />);
        expect(container.querySelector('[data-slot="checkbox-check"]')).toBeNull();
        expect(container.querySelector('[data-slot="checkbox-dash"]')).toBeNull();
    });
});
