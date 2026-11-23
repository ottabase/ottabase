/**
 * The frame for the person's own settings pages (/profile, /security, /sessions): one width,
 * one header, and a side nav between them (a row of tabs on small screens).
 */
import { useSession } from '@/lib/auth';
import { PageHeader } from '@ottabase/ui';
import { Link } from '@tanstack/react-router';
import { LockKeyhole, MonitorSmartphone, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';

const SECTIONS = [
    { to: '/profile', label: 'Profile', icon: UserRound },
    { to: '/security', label: 'Security', icon: LockKeyhole },
    { to: '/sessions', label: 'Sessions', icon: MonitorSmartphone },
] as const;

export function SettingsPage({
    title,
    description,
    actions,
    children,
}: {
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
}) {
    // While a two-factor policy confines the session, only /security opens: leave the others out.
    const { user } = useSession();
    const sections = user?.twoFactorSetupRequired ? SECTIONS.filter((s) => s.to === '/security') : SECTIONS;

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:flex-row md:gap-10">
            <nav aria-label="Account settings" className="flex gap-1 overflow-x-auto md:w-44 md:shrink-0 md:flex-col">
                {sections.map(({ to, label, icon: Icon }) => (
                    <Link
                        key={to}
                        to={to}
                        className="flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                        activeProps={{ className: 'bg-muted font-medium text-foreground', 'aria-current': 'page' }}
                    >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {label}
                    </Link>
                ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col gap-6">
                <PageHeader title={title} description={description} actions={actions} />
                {children}
            </div>
        </div>
    );
}
