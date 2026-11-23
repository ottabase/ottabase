/**
 * /security: how this person signs in beyond their password. An authenticator app (two-factor
 * sign-in, with recovery codes) and passkeys. Changing either needs a recent sign-in (the server
 * answers REAUTH_REQUIRED otherwise); the page says so up front and offers to sign in again.
 */
import { QrCode } from '@/components/auth/QrCode';
import { useSession } from '@/lib/auth';
import {
    addPasskey,
    confirmTotpSetup,
    disableTotp,
    getFactors,
    isPasskeySupported,
    regenerateRecoveryCodes,
    removePasskey,
    renamePasskey,
    startTotpSetup,
    type FactorSummary,
    type PasskeySummary,
} from '@/lib/auth-api';
import { rememberReturnPath } from '@/lib/auth-redirect';
import {
    Alert,
    AlertDescription,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    ConfirmDialog,
    CopyButton,
    Input,
    InputOTP,
    InputOTPGroup,
    InputOTPSlot,
    PageHeader,
    Spinner,
    toast,
} from '@ottabase/ui';
import { formatDateForUser } from '@ottabase/utils/timezone';
import { useNavigate } from '@tanstack/react-router';
import { Download, KeyRound, Pencil, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type Setup = { secret: string; uri: string } | null;

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
    const text = codes.join('\n');
    const download = () => {
        const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'recovery-codes.txt';
        link.click();
        URL.revokeObjectURL(url);
    };
    return (
        <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
            <div className="space-y-1">
                <p className="text-sm font-medium">Save your recovery codes</p>
                <p className="text-sm text-muted-foreground">
                    Each one signs you in once if you lose your phone. This is the only time they are shown.
                </p>
            </div>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-sm">
                {codes.map((code) => (
                    <li key={code}>{code}</li>
                ))}
            </ul>
            <div className="flex flex-wrap gap-2">
                <CopyButton value={text} label="recovery codes" notify variant="outline" size="sm">
                    Copy
                </CopyButton>
                <Button variant="outline" size="sm" onClick={download}>
                    <Download className="h-4 w-4" />
                    Download
                </Button>
                <Button size="sm" onClick={onDone}>
                    I have saved them
                </Button>
            </div>
        </div>
    );
}

function PasskeyRow({
    passkey,
    disabled,
    onRename,
    onRemove,
}: {
    passkey: PasskeySummary;
    disabled: boolean;
    onRename: (name: string) => void;
    onRemove: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(passkey.name);
    return (
        <li className="flex items-center gap-3 py-3">
            <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
                {editing ? (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            setEditing(false);
                            if (draft.trim() && draft.trim() !== passkey.name) onRename(draft.trim());
                        }}
                    >
                        <Input
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => setEditing(false)}
                            maxLength={60}
                            autoFocus
                            aria-label="Passkey name"
                            className="h-8"
                        />
                    </form>
                ) : (
                    <p className="truncate text-sm font-medium">{passkey.name}</p>
                )}
                <p className="text-xs text-muted-foreground">
                    Added {formatDateForUser(passkey.createdAt)}
                    {passkey.lastUsedAt ? ` · last used ${formatDateForUser(passkey.lastUsedAt)}` : ' · never used'}
                </p>
            </div>
            <Button
                variant="ghost"
                size="icon"
                aria-label={`Rename ${passkey.name}`}
                disabled={disabled}
                onClick={() => {
                    setDraft(passkey.name);
                    setEditing(true);
                }}
            >
                <Pencil className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${passkey.name}`}
                disabled={disabled}
                onClick={onRemove}
            >
                <Trash2 className="h-4 w-4" />
            </Button>
        </li>
    );
}

export function SecurityPage() {
    const navigate = useNavigate();
    const { user, logout, refreshSession } = useSession();
    const [factors, setFactors] = useState<FactorSummary | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [setup, setSetup] = useState<Setup>(null);
    const [code, setCode] = useState('');
    const [codes, setCodes] = useState<string[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<null | 'disable' | 'regenerate' | { remove: PasskeySummary }>(null);

    const load = useCallback(async () => {
        const result = await getFactors();
        if (result.success) {
            setFactors(result);
            setLoadError(null);
        } else setLoadError(result.error);
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    /** Show a failure; a stale session sends the person to sign in again instead. */
    const failed = (result: { error: string; code?: string }) => {
        if (result.code === 'REAUTH_REQUIRED') void load();
        toast.error(result.error);
    };

    const signInAgain = async () => {
        rememberReturnPath('/security');
        await logout();
        navigate({ to: '/login', replace: true });
    };

    const beginSetup = async () => {
        setBusy(true);
        const result = await startTotpSetup();
        setBusy(false);
        if (result.success) {
            setSetup({ secret: result.secret, uri: result.uri });
            setCode('');
        } else failed(result);
    };

    const finishSetup = async (value: string) => {
        setBusy(true);
        const result = await confirmTotpSetup(value);
        setBusy(false);
        if (!result.success) {
            setCode('');
            failed(result);
            return;
        }
        setSetup(null);
        setCodes(result.recoveryCodes);
        await Promise.all([load(), refreshSession()]);
    };

    const runConfirmed = async () => {
        const action = confirm;
        setConfirm(null);
        if (!action) return;
        setBusy(true);
        if (action === 'disable') {
            const result = await disableTotp();
            if (result.success) toast.success('Two-factor sign-in is off');
            else failed(result);
        } else if (action === 'regenerate') {
            const result = await regenerateRecoveryCodes();
            if (result.success) setCodes(result.recoveryCodes);
            else failed(result);
        } else {
            const result = await removePasskey(action.remove.id);
            if (result.success) toast.success(`Removed ${action.remove.name}`);
            else failed(result);
        }
        setBusy(false);
        await Promise.all([load(), refreshSession()]);
    };

    const newPasskey = async () => {
        setBusy(true);
        const result = await addPasskey(defaultPasskeyName());
        setBusy(false);
        if (result.success) {
            toast.success('Passkey added. Rename it so you can tell it apart.');
            await load();
        } else if (!('cancelled' in result && result.cancelled)) failed(result);
    };

    const rename = async (passkey: PasskeySummary, name: string) => {
        const result = await renamePasskey(passkey.id, name);
        if (result.success) await load();
        else failed(result);
    };

    if (!factors) {
        return (
            <div className="flex min-h-[50vh] items-center justify-center">
                {loadError ? (
                    <p className="text-sm text-muted-foreground">{loadError}</p>
                ) : (
                    <Spinner className="h-6 w-6" />
                )}
            </div>
        );
    }

    const locked = !factors.recentSignIn || busy;
    const twoFactorOn = factors.twoFactor.enabled;
    const browserPasskeys = isPasskeySupported();

    return (
        <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6">
            <PageHeader title="Security" description="How you sign in, beyond your password." />

            {user?.twoFactorSetupRequired && !twoFactorOn && (
                <Alert>
                    <ShieldCheck className="h-4 w-4" />
                    <AlertDescription>
                        Your organization requires two-factor sign-in. Turn it on below to get back to work.
                    </AlertDescription>
                </Alert>
            )}

            {!factors.recentSignIn && (
                <Alert>
                    <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                        <span>
                            To change how you sign in, sign in again first. It keeps a borrowed session from doing it.
                        </span>
                        <Button size="sm" variant="outline" onClick={() => void signInAgain()}>
                            Sign in again
                        </Button>
                    </AlertDescription>
                </Alert>
            )}

            <Card>
                <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1.5">
                            <CardTitle className="flex items-center gap-2">
                                <Smartphone className="h-4 w-4" />
                                Authenticator app
                            </CardTitle>
                            <CardDescription>
                                A six-digit code from an app on your phone, asked for after your password, a sign-in
                                link or a Google or GitHub sign-in.
                            </CardDescription>
                        </div>
                        <Badge variant={twoFactorOn ? 'default' : 'secondary'}>{twoFactorOn ? 'On' : 'Off'}</Badge>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

                    {setup ? (
                        <div className="grid gap-6 md:grid-cols-[auto_1fr]">
                            <QrCode value={setup.uri} label="QR code for your authenticator app" />
                            <div className="space-y-4">
                                <div className="space-y-1.5">
                                    <p className="text-sm font-medium">1. Scan the code with your authenticator app</p>
                                    <p className="text-sm text-muted-foreground">Or type this key in by hand:</p>
                                    <div className="flex items-center gap-2">
                                        <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                                            {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
                                        </code>
                                        <CopyButton
                                            value={setup.secret}
                                            label="setup key"
                                            size="icon"
                                            variant="ghost"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <p className="text-sm font-medium">2. Enter the code it shows</p>
                                    <InputOTP
                                        maxLength={6}
                                        value={code}
                                        onChange={setCode}
                                        onComplete={(value: string) => void finishSetup(value)}
                                        disabled={busy}
                                        inputMode="numeric"
                                        autoComplete="one-time-code"
                                        aria-label="Six-digit code"
                                    >
                                        <InputOTPGroup>
                                            {[0, 1, 2, 3, 4, 5].map((index) => (
                                                <InputOTPSlot key={index} index={index} />
                                            ))}
                                        </InputOTPGroup>
                                    </InputOTP>
                                </div>
                                <Button variant="ghost" size="sm" onClick={() => setSetup(null)}>
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    ) : twoFactorOn ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm text-muted-foreground">
                                {factors.twoFactor.recoveryCodesLeft} of 10 recovery codes left.
                            </p>
                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={locked}
                                    onClick={() => setConfirm('regenerate')}
                                >
                                    New recovery codes
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={locked}
                                    onClick={() => setConfirm('disable')}
                                >
                                    Turn off
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <Button disabled={locked} onClick={() => void beginSetup()}>
                            Set up an authenticator app
                        </Button>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <KeyRound className="h-4 w-4" />
                        Passkeys
                    </CardTitle>
                    <CardDescription>
                        Sign in with your fingerprint, face or device PIN. No password or code to type, and nothing a
                        fake site can reuse.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {factors.passkeys.length > 0 && (
                        <ul className="divide-y divide-border">
                            {factors.passkeys.map((passkey) => (
                                <PasskeyRow
                                    key={passkey.id}
                                    passkey={passkey}
                                    disabled={locked}
                                    onRename={(name) => void rename(passkey, name)}
                                    onRemove={() => setConfirm({ remove: passkey })}
                                />
                            ))}
                        </ul>
                    )}
                    {!factors.passkeysAvailable ? (
                        <p className="text-sm text-muted-foreground">
                            Passkeys need this app at a domain name over https, or at localhost while developing.
                        </p>
                    ) : !browserPasskeys ? (
                        <p className="text-sm text-muted-foreground">This browser does not support passkeys.</p>
                    ) : (
                        <Button variant="outline" disabled={locked} onClick={() => void newPasskey()}>
                            Add a passkey
                        </Button>
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={(open) => !open && setConfirm(null)}
                title={
                    confirm === 'disable'
                        ? 'Turn off two-factor sign-in?'
                        : confirm === 'regenerate'
                          ? 'Make new recovery codes?'
                          : 'Remove this passkey?'
                }
                description={
                    confirm === 'disable'
                        ? 'Your password alone will sign you in again, and your recovery codes stop working.'
                        : confirm === 'regenerate'
                          ? 'Your current recovery codes stop working at once.'
                          : 'It will no longer sign you in. You can add it again later.'
                }
                confirmLabel={
                    confirm === 'disable' ? 'Turn off' : confirm === 'regenerate' ? 'Make new codes' : 'Remove'
                }
                tone="destructive"
                onConfirm={() => void runConfirmed()}
            />
        </div>
    );
}

/** "Chrome on Windows", say, so the first passkey has a useful name before the person renames it. */
function defaultPasskeyName(): string {
    if (typeof navigator === 'undefined') return 'Passkey';
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua)
        ? 'Edge'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser';
    const os = /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Android/.test(ua)
            ? 'Android'
            : /iPhone|iPad/.test(ua)
              ? 'iOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
    return os ? `${browser} on ${os}` : browser;
}
