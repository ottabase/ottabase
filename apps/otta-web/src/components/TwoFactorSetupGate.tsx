import { useSession } from '@/lib/auth';
import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

/** Where a session that owes two-factor setup may still go: the setup itself and the sign-in pages. */
const ALLOWED = ['/security', '/login'];

/**
 * When a policy requires two-factor and this person has not turned it on, the server already
 * answers every API but `/api/auth/*` with 401. This keeps the browser on the page that fixes it,
 * instead of a screen full of failed requests.
 */
export function TwoFactorSetupGate({ pathname }: { pathname: string }) {
    const navigate = useNavigate();
    const { user } = useSession();
    const required = user?.twoFactorSetupRequired === true;
    const allowed = ALLOWED.some((path) => pathname === path || pathname.startsWith(`${path}/`));

    useEffect(() => {
        if (required && !allowed) navigate({ to: '/security', replace: true });
    }, [required, allowed, navigate]);

    return null;
}
