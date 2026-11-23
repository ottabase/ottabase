/**
 * /sessions: every device signed in to this account. One card per session, newest first, with
 * an inline-editable name, device and location, the expiry countdown, and Sign out / Revoke.
 * Ids are opaque server HMACs; the server only ever touches the caller's own sessions.
 */
import { InlineName } from '@/components/InlineName';
import { SettingsPage } from '@/components/SettingsPage';
import { useSession } from '@/lib/auth';
import { useEndpointMutation, useEndpointQuery } from '@ottabase/ottaorm/client';
import { listSessions, renameSession, revokeOtherSessions, revokeSession } from '../../../ottabase/endpoints/sessions';
import {
    Alert,
    AlertDescription,
    Button,
    Card,
    CardContent,
    CardHeader,
    ConfirmDialog,
    DataList,
    DataListItem,
    DataListLabel,
    DataListValue,
    Skeleton,
    StatusChip,
    toast,
} from '@ottabase/ui';
import { formatDateForUser } from '@ottabase/utils/timezone';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CalendarClock, CheckCircle2, Clock, LogOut, MapPin, MonitorSmartphone } from 'lucide-react';
import { useMemo, useState } from 'react';

const SESSIONS_KEY = ['me', 'sessions'];

/** "Expires in 3 days" from a future epoch; never shows "expired" since the TTL removes those rows. */
export function expiresIn(expiresAt: number, now = Date.now()): string {
    const ms = expiresAt - now;
    if (ms <= 0) return 'Expires soon';
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `Expires in ${minutes} min`;
    const hours = Math.round(ms / 3_600_000);
    if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(ms / 86_400_000);
    return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

/** Default names count down so the newest session has the highest number. */
function defaultName(index: number, total: number): string {
    return `Session ${total - index}`;
}

export function SessionsPage() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { logout } = useSession();
    const [confirm, setConfirm] = useState<{ kind: 'signout' | 'revoke' | 'others'; id?: string } | null>(null);

    // Typed by the shared declarations in ottabase/endpoints/sessions.ts, which the Worker serves.
    const sessions = useEndpointQuery(listSessions, {}, { queryKey: SESSIONS_KEY, select: (r) => r.sessions });
    const invalidate = () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });

    const rename = useEndpointMutation(renameSession, {
        mutationOptions: {
            onSuccess: () => invalidate(),
            onError: (error) => toast.error(error.message || 'Could not rename the session'),
        },
    });

    const revoke = useEndpointMutation(revokeSession, {
        mutationOptions: {
            onSuccess: (result) => {
                if (result.signedOut) {
                    logout();
                    void navigate({ to: '/' });
                    return;
                }
                toast.success('Session revoked');
                invalidate();
            },
            onError: (error) => toast.error(error.message || 'Could not revoke the session'),
        },
    });

    const revokeOthers = useEndpointMutation(revokeOtherSessions, {
        mutationOptions: {
            onSuccess: ({ revoked }) => {
                toast.success(
                    revoked === 0
                        ? 'No other sessions'
                        : `Signed out ${revoked} other session${revoked === 1 ? '' : 's'}`,
                );
                invalidate();
            },
            onError: (error) => toast.error(error.message || 'Could not sign out other sessions'),
        },
    });

    const list = sessions.data ?? [];
    const others = useMemo(() => list.filter((s) => !s.current).length, [list]);

    return (
        <SettingsPage
            title="Sessions"
            description="Every device and browser signed in to your account."
            actions={
                <Button
                    variant="outline"
                    disabled={others === 0 || revokeOthers.isPending}
                    onClick={() => setConfirm({ kind: 'others' })}
                >
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign out all other sessions
                </Button>
            }
        >
            {sessions.isPending ? (
                <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
                    {[...Array(2)].map((_, i) => (
                        <Skeleton key={i} className="h-44 rounded-xl" />
                    ))}
                </div>
            ) : sessions.isError ? (
                <Alert variant="destructive">
                    <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                        <span>{sessions.error.message || 'Could not load your sessions.'}</span>
                        <Button size="sm" variant="outline" onClick={() => void sessions.refetch()}>
                            Try again
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                    {list.map((session, index) => (
                        <Card key={session.id} className={session.current ? 'border-success/40' : undefined}>
                            <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
                                <div className="flex min-w-0 items-center gap-2">
                                    {session.current ? (
                                        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                                    ) : (
                                        <Clock className="h-4 w-4 shrink-0 text-primary" />
                                    )}
                                    <InlineName
                                        value={session.name}
                                        placeholder={defaultName(index, list.length)}
                                        label="Session name"
                                        onSave={(name) =>
                                            rename.mutate({ params: { id: session.id }, input: { name } })
                                        }
                                        disabled={rename.isPending}
                                        pending={rename.isPending && rename.variables?.params.id === session.id}
                                    />
                                </div>
                                {session.current && <StatusChip tone="green">Current</StatusChip>}
                            </CardHeader>
                            <CardContent className="space-y-3">
                                {/* Icons are the visible labels; each carries its name for screen readers */}
                                <DataList className="gap-x-2">
                                    <DataListItem className="items-center">
                                        <DataListLabel className="flex">
                                            <MonitorSmartphone aria-hidden="true" />
                                            <span className="sr-only">Device</span>
                                        </DataListLabel>
                                        <DataListValue className="truncate">
                                            {session.device ?? 'Unknown device'}
                                        </DataListValue>
                                    </DataListItem>
                                    {(session.geo || session.ip) && (
                                        <DataListItem className="items-center">
                                            <DataListLabel className="flex">
                                                <MapPin aria-hidden="true" />
                                                <span className="sr-only">Location</span>
                                            </DataListLabel>
                                            <DataListValue className="truncate text-muted-foreground">
                                                {[session.geo, session.ip].filter(Boolean).join(' · ')}
                                            </DataListValue>
                                        </DataListItem>
                                    )}
                                    <DataListItem className="items-center">
                                        <DataListLabel className="flex">
                                            <CalendarClock aria-hidden="true" />
                                            <span className="sr-only">Signed in</span>
                                        </DataListLabel>
                                        <DataListValue className="flex items-center justify-between gap-2 text-muted-foreground">
                                            <span title={new Date(session.createdAt).toISOString()}>
                                                Signed in {formatDateForUser(session.createdAt, 'date')}
                                            </span>
                                            <span className="text-success">{expiresIn(session.expiresAt)}</span>
                                        </DataListValue>
                                    </DataListItem>
                                </DataList>
                                {session.current ? (
                                    <Button
                                        variant="destructive"
                                        className="w-full"
                                        onClick={() => setConfirm({ kind: 'signout', id: session.id })}
                                    >
                                        Sign out
                                    </Button>
                                ) : (
                                    <Button
                                        variant="outline"
                                        className="w-full"
                                        disabled={revoke.isPending}
                                        onClick={() => setConfirm({ kind: 'revoke', id: session.id })}
                                    >
                                        Revoke
                                    </Button>
                                )}
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={(open) => !open && setConfirm(null)}
                tone="destructive"
                title={
                    confirm?.kind === 'signout'
                        ? 'Sign out'
                        : confirm?.kind === 'others'
                          ? 'Sign out other sessions'
                          : 'Revoke session'
                }
                description={
                    confirm?.kind === 'signout'
                        ? 'Are you sure you want to sign out? You will be redirected to the home page.'
                        : confirm?.kind === 'others'
                          ? `Every session except this one will be signed out (${others}). This action cannot be undone.`
                          : 'Are you sure you want to revoke this session? This action cannot be undone.'
                }
                confirmLabel={confirm?.kind === 'revoke' ? 'Revoke' : 'Sign out'}
                onConfirm={() => {
                    const action = confirm;
                    setConfirm(null);
                    if (!action) return;
                    if (action.kind === 'others') revokeOthers.mutate({});
                    else if (action.id) revoke.mutate({ params: { id: action.id } });
                }}
            />
        </SettingsPage>
    );
}
