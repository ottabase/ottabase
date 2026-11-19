// FormField renders the @ottabase/ui inputs for number, password and file fields.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OttaQueryProvider } from '@ottabase/ottaorm/client';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FormField } from '../components/FormField';

const scope = { appId: 'test-app', organizationId: 'org-1', principalId: 'user-1' };
const wrap = (node: ReactNode, apiClient = vi.fn()) =>
    render(
        <OttaQueryProvider apiClient={apiClient} visibilityScope={scope}>
            {node}
        </OttaQueryProvider>,
    );

describe('FormField ui inputs', () => {
    it('number: a NumberInput that emits numbers, whole numbers for integer fields', () => {
        const onChange = vi.fn();
        wrap(
            <FormField
                name="qty"
                label="Quantity"
                value="3"
                onChange={onChange}
                field={{ type: 'integer', formConfig: { min: 0, max: 10 } }}
            />,
        );
        const input = screen.getByLabelText('Quantity');
        expect(input).toHaveAttribute('role', 'spinbutton');
        expect(input).toHaveValue('3');
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(onChange).toHaveBeenLastCalledWith(4);
        fireEvent.change(input, { target: { value: '2.5' } }); // no decimals for an integer
        expect(input).toHaveValue('3');
        fireEvent.change(input, { target: { value: '' } });
        expect(onChange).toHaveBeenLastCalledWith(null);
    });

    it('password: reveal toggle, and the checklist when showPasswordHints is set', () => {
        wrap(
            <FormField
                name="secret"
                label="Secret"
                value="abc"
                onChange={vi.fn()}
                field={{ type: 'string', formConfig: { fieldType: 'password', showPasswordHints: true, min: 12 } }}
            />,
        );
        expect(screen.getByLabelText('Secret')).toHaveAttribute('type', 'password');
        expect(screen.getByLabelText('Secret')).toHaveAttribute('autocomplete', 'new-password');
        fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
        expect(screen.getByLabelText('Secret')).toHaveAttribute('type', 'text');
        expect(screen.getByText('At least 12 characters')).toBeInTheDocument();
    });

    it('file: uploads the picked file and stores the returned url', async () => {
        const onChange = vi.fn();
        const apiClient = vi.fn().mockResolvedValue({ url: 'https://cdn.example.com/a.pdf' });
        wrap(
            <FormField
                name="doc"
                label="Document"
                value={null}
                onChange={onChange}
                field={{ type: 'string', formConfig: { fieldType: 'file', uploadEndpoint: '/api/files' } }}
            />,
            apiClient,
        );
        const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
        fireEvent.change(screen.getByLabelText('Document'), { target: { files: [file] } });
        await waitFor(() => expect(onChange).toHaveBeenCalledWith('https://cdn.example.com/a.pdf'));
        expect(apiClient).toHaveBeenCalledWith('/api/files', expect.objectContaining({ method: 'POST' }));
    });

    it('file: refuses a file over maxSize without uploading it', () => {
        const onChange = vi.fn();
        const apiClient = vi.fn();
        wrap(
            <FormField
                name="doc"
                label="Document"
                value={null}
                onChange={onChange}
                field={{ type: 'string', formConfig: { fieldType: 'file', uploadEndpoint: '/api/files', maxSize: 10 } }}
            />,
            apiClient,
        );
        fireEvent.change(screen.getByLabelText('Document'), {
            target: { files: [new File(['more than ten bytes'], 'big.pdf', { type: 'application/pdf' })] },
        });
        expect(screen.getByRole('alert')).toHaveTextContent('big.pdf is larger than 10 B');
        expect(apiClient).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });
});
