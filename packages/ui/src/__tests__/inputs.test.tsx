// Input building blocks: NumberInput, PasswordInput, FileInput, ColorInput, Textarea autosize, plus the Slider
// (one thumb per value) and Checkbox (dash when indeterminate) fixes.
import { fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from '../../components/ui/checkbox';
import { ColorInput, normalizeHex } from '../../components/ui/color-input';
import { FileInput } from '../../components/ui/file-input';
import { formatNumberInput, NumberInput, parseNumberInput } from '../../components/ui/number-input';
import { PasswordInput } from '../../components/ui/password-input';
import { Slider } from '../../components/ui/slider';
import { Textarea } from '../../components/ui/textarea';

describe('<NumberInput>', () => {
    it('formats and parses with a thousand separator and decimal scale', () => {
        expect(formatNumberInput(1234567.891, 2, ',')).toBe('1,234,567.89');
        expect(formatNumberInput(null)).toBe('');
        expect(parseNumberInput('1,234.5', ',')).toBe(1234.5);
        expect(parseNumberInput('-')).toBeNull();
        expect(parseNumberInput('abc')).toBeNaN();
    });

    it('applies an in-range number as typed and clamps the rest on blur', () => {
        const onChange = vi.fn();
        render(<NumberInput aria-label="n" min={10} max={100} defaultValue={50} onChange={onChange} />);
        const input = screen.getByRole('spinbutton', { name: 'n' });

        fireEvent.change(input, { target: { value: '2' } }); // on the way to "24": not applied yet
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.change(input, { target: { value: '24' } });
        expect(onChange).toHaveBeenLastCalledWith(24);

        fireEvent.change(input, { target: { value: '500' } });
        fireEvent.blur(input);
        expect(onChange).toHaveBeenLastCalledWith(100);
        expect(input).toHaveValue('100');
    });

    it('steps with the arrow keys (Shift: ×10) and the stepper buttons, inside min/max', () => {
        const onChange = vi.fn();
        render(<NumberInput aria-label="n" min={0} max={30} step={0.1} defaultValue={0.2} onChange={onChange} />);
        const input = screen.getByRole('spinbutton');

        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onChange).toHaveBeenLastCalledWith(0.3); // not 0.30000000000000004
        fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
        expect(onChange).toHaveBeenLastCalledWith(1.3);
        fireEvent.click(screen.getByRole('button', { name: 'Decrement' }));
        expect(onChange).toHaveBeenLastCalledWith(1.2);
        fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
        fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
        expect(onChange).toHaveBeenLastCalledWith(0);
        expect(screen.getByRole('button', { name: 'Decrement' })).toBeDisabled();
    });

    it('rejects characters that cannot be part of the number', () => {
        render(<NumberInput aria-label="n" min={0} decimalScale={0} />);
        const input = screen.getByRole('spinbutton');
        fireEvent.change(input, { target: { value: '-3' } });
        expect(input).toHaveValue('');
        fireEvent.change(input, { target: { value: '1.5' } });
        expect(input).toHaveValue('');
        fireEvent.change(input, { target: { value: '15' } });
        expect(input).toHaveValue('15');
    });

    it('shows prefix/suffix outside the text, posts the plain number under `name`, forwards the ref', () => {
        const ref = React.createRef<HTMLInputElement>();
        const { container } = render(
            <NumberInput
                ref={ref}
                aria-label="price"
                name="price"
                prefix="$"
                suffix="USD"
                thousandSeparator
                value={1234.5}
                hideControls
            />,
        );
        expect(screen.getByRole('spinbutton')).toHaveValue('1,234.5');
        expect(screen.getByText('$')).toBeInTheDocument();
        expect(screen.getByText('USD')).toBeInTheDocument();
        expect(container.querySelector('input[type="hidden"][name="price"]')).toHaveValue('1234.5');
        expect(ref.current).toBe(screen.getByRole('spinbutton'));
        expect(screen.queryByRole('button', { name: 'Increment' })).toBeNull();
    });

    it('clears to null', () => {
        const onChange = vi.fn();
        render(<NumberInput aria-label="n" defaultValue={5} onChange={onChange} />);
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
        expect(onChange).toHaveBeenLastCalledWith(null);
    });

    it('keeps half-typed text ("-", "1.") when controlled, and posts the number in a native form', () => {
        const seen: (number | null)[] = [];
        function Controlled() {
            const [value, setValue] = React.useState<number | null>(7);
            return (
                <form aria-label="f">
                    <NumberInput
                        aria-label="n"
                        name="qty"
                        value={value}
                        onChange={(next) => {
                            seen.push(next);
                            setValue(next);
                        }}
                    />
                </form>
            );
        }
        render(<Controlled />);
        const input = screen.getByRole('spinbutton');
        const posted = () => new FormData(screen.getByRole('form') as HTMLFormElement).get('qty');

        fireEvent.change(input, { target: { value: '-' } });
        expect(input).toHaveValue('-');
        expect(posted()).toBe('');
        fireEvent.change(input, { target: { value: '-1.' } });
        expect(input).toHaveValue('-1.');
        expect(posted()).toBe('-1');
        fireEvent.change(input, { target: { value: '-1.5' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(input).toHaveValue('-1.5');
        expect(seen).toEqual([null, -1, -1.5]);
    });

    it('clamps on Enter, and leaves out-of-range text alone with clampOnBlur off', () => {
        const onChange = vi.fn();
        const { rerender } = render(<NumberInput aria-label="n" max={10} onChange={onChange} />);
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '99' } });
        fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'Enter' });
        expect(onChange).toHaveBeenLastCalledWith(10);

        rerender(<NumberInput key="free" aria-label="n" max={10} clampOnBlur={false} onChange={onChange} />);
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '99' } });
        fireEvent.blur(screen.getByRole('spinbutton'));
        expect(onChange).toHaveBeenLastCalledWith(99);
    });
});

describe('<PasswordInput>', () => {
    it('toggles visibility with a pressed-state button', () => {
        render(<PasswordInput aria-label="Password" />);
        const input = screen.getByLabelText('Password');
        const toggle = screen.getByRole('button', { name: 'Show password' });
        expect(input).toHaveAttribute('type', 'password');
        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(toggle);
        expect(input).toHaveAttribute('type', 'text');
        expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

    it('shows the requirement checklist only when asked and once something is typed', () => {
        const { rerender } = render(<PasswordInput aria-label="Password" defaultValue="abc" />);
        expect(document.querySelector('[data-slot="password-requirements"]')).toBeNull();

        rerender(
            <PasswordInput aria-label="Password" value="" onChange={() => undefined} requirements minLength={10} />,
        );
        expect(document.querySelector('[data-slot="password-requirements"]')).toBeNull();

        rerender(
            <PasswordInput
                aria-label="Password"
                value="Abc1!"
                onChange={() => undefined}
                requirements
                minLength={10}
            />,
        );
        const items = [...document.querySelectorAll('[data-slot="password-requirement"]')];
        expect(items.map((li) => li.getAttribute('data-met'))).toEqual(['false', 'true', 'true', 'true', 'true']);
        expect(screen.getByText('At least 10 characters')).toBeInTheDocument();
    });

    it('accepts custom rules and tracks uncontrolled typing', () => {
        render(
            <PasswordInput aria-label="Password" requirements={[{ label: 'Has a z', test: (p) => p.includes('z') }]} />,
        );
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fizz' } });
        expect(document.querySelector('[data-slot="password-requirement"]')).toHaveAttribute('data-met', 'true');
    });
});

describe('<FileInput>', () => {
    const file = (name: string, size: number, type = 'text/plain') => {
        const f = new File(['x'], name, { type });
        Object.defineProperty(f, 'size', { value: size });
        return f;
    };

    it('passes picked files and lists them', () => {
        const onChange = vi.fn();
        render(<FileInput aria-label="Upload" onChange={onChange} multiple />);
        const picked = [file('a.txt', 10), file('b.txt', 2048)];
        fireEvent.change(screen.getByLabelText('Upload'), { target: { files: picked } });
        expect(onChange).toHaveBeenCalledWith(picked);
        expect(screen.getByText('a.txt')).toBeInTheDocument();
        expect(screen.getByText('(2.0 KB)')).toBeInTheDocument();
    });

    it('refuses a file over maxSize with a message', () => {
        const onChange = vi.fn();
        render(<FileInput aria-label="Upload" onChange={onChange} maxSize={1024} />);
        fireEvent.change(screen.getByLabelText('Upload'), { target: { files: [file('big.txt', 5000)] } });
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('big.txt is larger than 1.0 KB');
    });

    it('previews a picked image from an object URL and revokes it on replace and unmount', () => {
        const create = vi.fn((f: Blob) => `blob:${(f as File).name}`);
        const revoke = vi.fn();
        Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
        const { unmount } = render(<FileInput aria-label="Upload" imagePreview />);
        const input = screen.getByLabelText('Upload');

        fireEvent.change(input, { target: { files: [file('a.png', 10, 'image/png')] } });
        expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:a.png');
        fireEvent.change(input, { target: { files: [file('b.png', 10, 'image/png')] } });
        expect(revoke).toHaveBeenCalledWith('blob:a.png');
        expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'blob:b.png');
        unmount();
        expect(revoke).toHaveBeenCalledWith('blob:b.png');
    });

    it('previews a given URL and clears', () => {
        const onClear = vi.fn();
        render(<FileInput aria-label="Upload" previewUrl="https://example.com/a.png" onClear={onClear} />);
        expect(screen.getByAltText('Preview')).toHaveAttribute('src', 'https://example.com/a.png');
        fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
        expect(onClear).toHaveBeenCalled();
    });
});

describe('<ColorInput>', () => {
    it('normalises hex', () => {
        expect(normalizeHex('ABC')).toBe('#aabbcc');
        expect(normalizeHex('#123456')).toBe('#123456');
        expect(normalizeHex('#12345')).toBeNull();
    });

    it('applies valid typed hex, flags invalid text and restores it on blur', () => {
        const onChange = vi.fn();
        render(<ColorInput aria-label="Color" defaultValue="#ff0000" onChange={onChange} />);
        const text = screen.getByLabelText('Color');
        fireEvent.change(text, { target: { value: '#0f0' } });
        expect(onChange).toHaveBeenLastCalledWith('#00ff00');
        fireEvent.change(text, { target: { value: '#zz' } });
        expect(text).toHaveAttribute('aria-invalid', 'true');
        fireEvent.blur(text);
        expect(text).toHaveValue('#00ff00');
    });

    it('picks from the native picker and presets, and clears to null', () => {
        const onChange = vi.fn();
        render(
            <ColorInput
                aria-label="Color"
                defaultValue="#ff0000"
                swatches={['#0000ff']}
                clearable
                onChange={onChange}
            />,
        );
        fireEvent.change(screen.getByLabelText('Pick a color'), { target: { value: '#123456' } });
        expect(onChange).toHaveBeenLastCalledWith('#123456');
        fireEvent.click(screen.getByRole('button', { name: '#0000ff' }));
        expect(onChange).toHaveBeenLastCalledWith('#0000ff');
        expect(screen.getByRole('button', { name: '#0000ff' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Clear color' }));
        expect(onChange).toHaveBeenLastCalledWith(null);
    });
});

describe('<Textarea autosize>', () => {
    it('sizes with field-sizing and rows-based bounds', () => {
        render(<Textarea aria-label="t" autosize minRows={2} maxRows={6} />);
        const el = screen.getByLabelText('t');
        expect(el.className).toContain('field-sizing-content');
        // jsdom reorders the calc terms; only the line count matters here
        expect(el.style.minHeight).toContain('calc(2lh');
        expect(el.style.maxHeight).toContain('calc(6lh');
    });

    it('is a plain textarea without autosize', () => {
        render(<Textarea aria-label="t" />);
        expect(screen.getByLabelText('t').className).not.toContain('field-sizing-content');
    });
});
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
