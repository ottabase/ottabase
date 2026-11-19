import { describe, expect, it } from 'vitest';
import { changesAsBeforeAfter } from '../AuditLogViewerPage';

describe('changesAsBeforeAfter', () => {
    it('splits { field: { from, to } } into before/after records, partial pairs included', () => {
        expect(
            changesAsBeforeAfter({
                name: { from: 'Old', to: 'New' },
                role: { to: 'admin' },
                plan: { from: 'pro' },
            }),
        ).toEqual({ before: { name: 'Old', plan: 'pro' }, after: { name: 'New', role: 'admin' } });
    });

    it('returns null for any other shape, which then shows as JSON', () => {
        expect(changesAsBeforeAfter({ created: { id: 1, name: 'x' } })).toBeNull();
        expect(changesAsBeforeAfter({ request: 'raw' })).toBeNull();
        expect(changesAsBeforeAfter({ tags: ['a'] })).toBeNull();
        expect(changesAsBeforeAfter({})).toBeNull();
    });
});
