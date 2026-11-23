import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigate, session } = vi.hoisted(() => ({
    navigate: vi.fn(),
    session: { user: null as null | { twoFactorSetupRequired?: boolean } },
}));

vi.mock('@/lib/auth', () => ({ useSession: () => session }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

import { TwoFactorSetupGate } from '../TwoFactorSetupGate';

describe('TwoFactorSetupGate', () => {
    beforeEach(() => navigate.mockReset());

    it('sends a session that owes two-factor setup to /security, from anywhere else', () => {
        session.user = { twoFactorSetupRequired: true };
        render(<TwoFactorSetupGate pathname="/admin/users" />);
        expect(navigate).toHaveBeenCalledWith({ to: '/security', replace: true });
    });

    it('leaves the setup page and the sign-in pages alone', () => {
        session.user = { twoFactorSetupRequired: true };
        for (const pathname of ['/security', '/login', '/login/two-factor'])
            render(<TwoFactorSetupGate pathname={pathname} />);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('does nothing when no policy requires it', () => {
        session.user = { twoFactorSetupRequired: false };
        render(<TwoFactorSetupGate pathname="/admin" />);
        session.user = null;
        render(<TwoFactorSetupGate pathname="/admin" />);
        expect(navigate).not.toHaveBeenCalled();
    });
});
