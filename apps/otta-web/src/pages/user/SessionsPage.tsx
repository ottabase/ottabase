/**
 * /sessions: every device signed in to this account. One card per session, newest first, with
 * an inline-editable name, device and location, the expiry countdown, and Sign out / Revoke.
 * Ids are opaque server HMACs; the server only ever touches the caller's own sessions.
 */
import { useSession } from '@/lib/auth';
import { useEndpointMutation, useEndpointQuery } from '@ottabase/ottaorm/client';
import { listSessions, renameSession, revokeOtherSessions, revokeSession } from '../../../ottabase/endpoints/sessions';
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    ConfirmDialog,
    DataList,
    DataListItem,
    DataListLabel,
    DataListValue,
    PageHeader,
    toast,
} from '@ottabase/ui';
import { formatDateForUser } from '@ottabase/utils/timezone';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CalendarClock, CheckCircle2, Clock, LogOut, MapPin, MonitorSmartphone, Pencil } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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

function InlineName({
    value,
    placeholder,
    onSave,
    disabled,
}: {
    value: string | null;
    placeholder: string;
    onSave: (name: string) => void;
    disabled?: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value ?? placeholder);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);
    useEffect(() => setDraft(value ?? placeholder), [value, placeholder]);

    const commit = () => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== (value ?? placeholder)) onSave(next);
        else setDraft(value ?? placeholder);
    };

    if (editing) {
        return (
            <input
                ref={inputRef}
                value={draft}
                maxLength={40}
                aria-label="Session name"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    if (e.key === 'Escape') {
                        setDraft(value ?? placeholder);
                        setEditing(false);
                    }
                }}
                className="h-7 w-full rounded-md bg-background px-2 text-sm font-medium ring-1 ring-border focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
        );
    }
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={() => setEditing(true)}
            className="group inline-flex min-w-0 items-center gap-1.5 text-left text-sm font-medium text-foreground"
            title="Rename"
        >
            <span className="truncate">{value ?? placeholder}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
    );
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
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
            <PageHeader
                title="Sessions"
                description="Manage and monitor your active sessions across different devices and browsers."
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
            />

            {sessions.isPending ? (
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3" aria-busy="true">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className="h-44 animate-pulse rounded-xl bg-muted/40" />
                    ))}
                </div>
            ) : sessions.isError ? (
                <div
                    role="alert"
                    className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                >
                    {sessions.error.message || 'Could not load sessions'}
                </div>
            ) : (
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
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
                                        onSave={(name) =>
                                            rename.mutate({ params: { id: session.id }, input: { name } })
                                        }
                                        disabled={rename.isPending}
                                    />
                                </div>
                                {session.current && (
                                    <Badge className="bg-success/15 text-success hover:bg-success/15">Current</Badge>
                                )}
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
                                                Signed in {formatDateForUser(session.createdAt, 'date') || '—'}
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
        </div>
    );
}
