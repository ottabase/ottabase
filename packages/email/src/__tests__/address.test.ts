import { describe, expect, it } from 'vitest';
import { formatAddress } from '../address';

describe('formatAddress', () => {
    it('refuses an email half that carries a second recipient or a header', () => {
        for (const email of [
            'a@b.com>, evil@c.com',
            'a@b.com\r\nBcc: evil@c.com',
            'a@b.com evil@c.com',
            'no-at',
            'a@b@c',
        ]) {
            expect(() => formatAddress({ name: 'x', email }), email).toThrow('Invalid email address');
            expect(() => formatAddress({ email }), email).toThrow('Invalid email address');
        }
    });

    it('keeps ordinary addresses and takes line breaks out of a bare string', () => {
        expect(formatAddress({ name: 'Ana', email: 'ana+tag@example.co.uk' })).toBe('Ana <ana+tag@example.co.uk>');
        expect(formatAddress({ email: 'ana@example.com' })).toBe('ana@example.com');
        expect(formatAddress('Ana <ana@example.com>\r\nBcc: evil@c.com')).toBe('Ana <ana@example.com> Bcc: evil@c.com');
    });
});
