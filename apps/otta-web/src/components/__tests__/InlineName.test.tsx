import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InlineName } from '../InlineName';

function edit(onSave = vi.fn()) {
    render(<InlineName value="Laptop" placeholder="Passkey" label="Passkey name" onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Laptop' }));
    return { onSave, input: screen.getByRole('textbox', { name: 'Passkey name' }) as HTMLInputElement };
}

describe('InlineName', () => {
    it('saves once on Enter, not again on the blur that follows', () => {
        const { onSave, input } = edit();
        expect(input.maxLength).toBe(40);
        fireEvent.change(input, { target: { value: '  Work laptop ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.blur(input);
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith('Work laptop');
    });

    it('saves when focus leaves', () => {
        const { onSave, input } = edit();
        fireEvent.change(input, { target: { value: 'Phone' } });
        fireEvent.blur(input);
        expect(onSave).toHaveBeenCalledWith('Phone');
    });

    it('puts the old name back on Escape', () => {
        const { onSave, input } = edit();
        fireEvent.change(input, { target: { value: 'Phone' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        fireEvent.blur(input);
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Rename Laptop' })).toBeTruthy();
    });
});
