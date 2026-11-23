/**
 * /security: everything about how this person signs in. The password, two-factor sign-in (an
 * authenticator app, recovery codes) and passkeys, plus a way to the signed-in devices.
 * Changing a factor needs a recent sign-in (the server answers REAUTH_REQUIRED otherwise); the
 * page says so up front and offers to sign in again. "Two-factor on" means an authenticator app
 * OR at least one passkey, so the last of either is what an organization's policy protects.
 */
import { QrCode } from '@/components/auth/QrCode';
import { SixDigitCode } from '@/components/auth/SixDigitCode';
import { InlineName } from '@/components/InlineName';
import { SettingsPage } from '@/components/SettingsPage';
import { useSession } from '@/lib/auth';
import {
    addPasskey,
    confirmTotpSetup,
    disableTotp,
    isPasskeySupported,
    regenerateRecoveryCodes,
    removePasskey,
    renamePasskey,
    startTotpSetup,
    type PasskeySummary,
} from '@/lib/auth-api';
import { rememberReturnPath } from '@/lib/auth-redirect';
import { APP_META } from '@/ottabase/config';
import { useFactors } from '@ottabase/auth/react';
import {
    Alert,
    AlertDescription,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    ConfirmDialog,
    CopyButton,
    Skeleton,
    StatusChip,
    toast,
} from '@ottabase/ui';
import { formatDateForUser } from '@ottabase/utils/timezone';
import { Link, useNavigate } from '@tanstack/react-router';
import { Download, Info, KeyRound, MonitorSmartphone, ShieldAlert, Smartphone, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PasswordCard } from './PasswordCard';

type Setup = { secret: string; uri: string } | null;
type Pending = null | 'disable' | 'regenerate' | { remove: PasskeySummary };

const REQUIRED_BY_ORG = 'Required by your organization';

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
    const heading = useRef<HTMLHeadingElement>(null);
    const text = codes.join('\n');
    // The codes appear after a click elsewhere on the page: take focus there so it is heard and seen.
    useEffect(() => heading.current?.focus(), []);

    const download = () => {
        const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${APP_META.appName}-recovery-codes.txt`;
        link.click();
        // Some browsers start the download after this tick; revoking now can cancel it.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    return (
        <section
            role="region"
            aria-labelledby="recovery-codes-title"
            className="space-y-4 rounded-lg border border-border bg-muted/30 p-4"
        >
            <div className="space-y-1">
                <h2
                    id="recovery-codes-title"
                    ref={heading}
                    tabIndex={-1}
                    className="text-[0.9375rem] font-semibold outline-hidden"
                >
                    Save your recovery codes
                </h2>
                <p className="text-sm text-muted-foreground">
                    Each code signs you in once when you cannot use your authenticator app or a passkey. You will not
                    see them again.
                </p>
            </div>
            <ul className="grid gap-x-6 gap-y-1.5 font-mono text-sm sm:grid-cols-2">
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
        </section>
    );
}

/** One line of a settings card: an icon, a title, a sentence, and what can be done. */
function Row({
    icon: Icon,
    title,
    children,
    action,
}: {
    icon: typeof KeyRound;
    title: ReactNode;
    children?: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4 first:pt-0 last:pb-0">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{title}</div>
                {children && <div className="text-sm text-muted-foreground">{children}</div>}
            </div>
            {action}
        </div>
    );
}

const Muted = ({ children }: { children: ReactNode }) => (
    <span className="text-sm text-muted-foreground">{children}</span>
);

export function SecurityPage() {
    const navigate = useNavigate();
    const { user, logout, refreshSession } = useSession();
    const { data: factors, error: loadError, pending: loading, reload } = useFactors();
    const [setup, setSetup] = useState<Setup>(null);
    const [setupError, setSetupError] = useState<string | null>(null);
    const [code, setCode] = useState('');
    const [codes, setCodes] = useState<string[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<Pending>(null);
    const codeInput = useRef<HTMLInputElement>(null);
    const checking = useRef(false);

    /** Show a failure. A stale session re-reads (the alert at the top then says what to do). */
    const failed = (result: { error: string; code?: string }) => {
        if (result.code === 'REAUTH_REQUIRED') {
            void reload();
            return;
        }
        toast.error(result.error);
        if (result.code === 'TWO_FACTOR_REQUIRED') void reload();
    };

    const afterChange = () => Promise.all([reload(), refreshSession()]);

    const signInAgain = async () => {
        rememberReturnPath('/security');
        await logout();
        navigate({ to: '/login', replace: true });
    };

    const beginSetup = async () => {
        setBusy(true);
        const result = await startTotpSetup();
        setBusy(false);
        if (!result.success) return failed(result);
        setSetup({ secret: result.secret, uri: result.uri });
        setSetupError(null);
        setCode('');
    };

    const finishSetup = async (value: string) => {
        if (checking.current) return;
        checking.current = true;
        setSetupError(null);
        const result = await confirmTotpSetup(value);
        checking.current = false;
        if (!result.success) {
            setCode('');
            codeInput.current?.focus();
            if (result.code === 'REAUTH_REQUIRED') failed(result);
            else setSetupError(result.error);
            return;
        }
        setSetup(null);
        if (result.recoveryCodes?.length) setCodes(result.recoveryCodes);
        toast.success('Authenticator app is on');
        await afterChange();
    };

    const runConfirmed = async () => {
        const action = confirm;
        setConfirm(null);
        if (!action) return;
        setBusy(true);
        if (action === 'disable') {
            const result = await disableTotp();
            if (result.success) {
                setCodes(null);
                toast.success('Authenticator app is off');
            } else failed(result);
        } else if (action === 'regenerate') {
            const result = await regenerateRecoveryCodes();
            if (result.success) setCodes(result.recoveryCodes);
            else failed(result);
        } else {
            const result = await removePasskey(action.remove.id);
            if (result.success) {
                setCodes(null);
                toast.success(`Removed ${action.remove.name}`);
            } else failed(result);
        }
        setBusy(false);
        await afterChange();
    };

    const newPasskey = async () => {
        setBusy(true);
        const result = await addPasskey();
        setBusy(false);
        if ('cancelled' in result) return;
        if (!result.success) return failed(result);
        // The first passkey of an account with no authenticator app turns two-factor on.
        if (result.recoveryCodes?.length) setCodes(result.recoveryCodes);
        toast.success('Passkey added');
        await afterChange();
    };

    const rename = async (passkey: PasskeySummary, name: string) => {
        setRenaming(passkey.id);
        const result = await renamePasskey(passkey.id, name);
        setRenaming(null);
        if (result.success) await reload();
        else failed(result);
    };

    if (!factors) {
        return (
            <SettingsPage title="Security" description="Your password, two-factor sign-in and passkeys.">
                {loadError && !loading ? (
                    <Alert variant="destructive">
                        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                            <span>{loadError}</span>
                            <Button size="sm" variant="outline" onClick={() => void reload()}>
                                Try again
                            </Button>
                        </AlertDescription>
                    </Alert>
                ) : (
                    <div className="space-y-6" aria-busy="true">
                        {[0, 1, 2].map((index) => (
                            <Skeleton key={index} className="h-36 rounded-xl" />
                        ))}
                    </div>
                )}
            </SettingsPage>
        );
    }

    const twoFactor = factors.twoFactor;
    const now = Date.now();
    const requiredNow = twoFactor.requiredFrom !== null && twoFactor.requiredFrom <= now;
    const requiredLater = twoFactor.requiredFrom !== null && twoFactor.requiredFrom > now;
    // Under a policy in force, the last factor cannot go: an app with no passkeys, or one passkey and no app.
    const lastFactorKept = requiredNow && (twoFactor.totp ? 1 : 0) + twoFactor.passkeys <= 1;
    // While new recovery codes are on screen, nothing else competes with saving them.
    const showingCodes = codes !== null;
    const locked = !factors.recentSignIn || busy || showingCodes;
    const confined = user?.twoFactorSetupRequired === true;

    return (
        <SettingsPage title="Security" description="Your password, two-factor sign-in and passkeys.">
            {confined && !twoFactor.enabled && (
                <Alert variant="warning">
                    <ShieldAlert />
                    <AlertDescription>
                        Your organization requires two-factor sign-in. Turn it on below to get back to work.
                    </AlertDescription>
                </Alert>
            )}

            {requiredLater && twoFactor.requiredFrom !== null && (
                <Alert variant="info" role="status">
                    <Info />
                    <AlertDescription>
                        Two-factor sign-in will be required from {formatDateForUser(twoFactor.requiredFrom)}.
                    </AlertDescription>
                </Alert>
            )}

            {!factors.recentSignIn && (
                <Alert variant="info" role="status">
                    <Info />
                    <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                        <span>To change these, sign in again first.</span>
                        <Button size="sm" variant="outline" onClick={() => void signInAgain()}>
                            Sign in again
                        </Button>
                    </AlertDescription>
                </Alert>
            )}

            {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

            <PasswordCard />

            <Card>
                <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5">
                        <CardTitle>Two-factor sign-in</CardTitle>
                        <CardDescription>
                            Asked for after your password, an email link or a social sign-in.
                        </CardDescription>
                    </div>
                    <StatusChip tone={twoFactor.enabled ? 'green' : 'smoke'}>
                        {twoFactor.enabled ? 'On' : 'Off'}
                    </StatusChip>
                </CardHeader>
                <CardContent className="divide-y divide-border">
                    <Row
                        icon={Smartphone}
                        title="Authenticator app"
                        action={
                            setup || showingCodes ? null : twoFactor.totp ? (
                                lastFactorKept ? (
                                    <Muted>{REQUIRED_BY_ORG}</Muted>
                                ) : (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={locked}
                                        onClick={() => setConfirm('disable')}
                                    >
                                        Turn off
                                    </Button>
                                )
                            ) : (
                                <Button size="sm" disabled={locked} onClick={() => void beginSetup()}>
                                    Set up
                                </Button>
                            )
                        }
                    >
                        {twoFactor.totp
                            ? 'On. A six-digit code from the app on your phone.'
                            : 'A six-digit code from an app on your phone.'}
                    </Row>

                    {setup && (
                        <div className="grid gap-6 py-4 sm:grid-cols-[auto_1fr]">
                            <div className="flex flex-col items-start gap-2">
                                <QrCode value={setup.uri} label="QR code for your authenticator app" />
                                {/* On a phone the app is on this device: open it instead of scanning. */}
                                <a
                                    href={setup.uri}
                                    className="text-sm font-medium text-primary hover:underline md:hidden"
                                >
                                    Open in authenticator app
                                </a>
                            </div>
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
                                    <SixDigitCode
                                        value={code}
                                        onChange={setCode}
                                        onComplete={(value) => void finishSetup(value)}
                                        inputRef={codeInput}
                                        errorId={setupError ? 'setup-code-error' : undefined}
                                        autoFocus
                                    />
                                    {setupError && (
                                        <p id="setup-code-error" role="alert" className="text-sm text-destructive">
                                            {setupError}
                                        </p>
                                    )}
                                </div>
                                <Button variant="ghost" size="sm" onClick={() => setSetup(null)}>
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    )}

                    {twoFactor.enabled && (
                        <Row
                            icon={KeyRound}
                            title="Recovery codes"
                            action={
                                showingCodes ? null : (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={locked}
                                        onClick={() => setConfirm('regenerate')}
                                    >
                                        New codes
                                    </Button>
                                )
                            }
                        >
                            {twoFactor.recoveryCodesLeft === 1
                                ? '1 code left.'
                                : `${twoFactor.recoveryCodesLeft} codes left.`}{' '}
                            Each one works once, when you cannot use your app or a passkey.
                        </Row>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Passkeys</CardTitle>
                    <CardDescription>
                        Sign in with your fingerprint, face or device PIN. A passkey is also a second step on its own.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {factors.passkeys.length > 0 && (
                        <ul className="divide-y divide-border">
                            {factors.passkeys.map((passkey) => (
                                <li key={passkey.id} className="flex items-center gap-3 py-3 first:pt-0">
                                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <div className="min-w-0 flex-1">
                                        <InlineName
                                            value={passkey.name}
                                            placeholder="Passkey"
                                            label="Passkey name"
                                            disabled={locked}
                                            pending={renaming === passkey.id}
                                            onSave={(name) => void rename(passkey, name)}
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Added {formatDateForUser(passkey.createdAt, 'date')} ·{' '}
                                            {passkey.lastUsedAt
                                                ? `last used ${formatDateForUser(passkey.lastUsedAt, 'date')}`
                                                : 'never used'}
                                        </p>
                                    </div>
                                    {lastFactorKept && !twoFactor.totp ? (
                                        <Muted>{REQUIRED_BY_ORG}</Muted>
                                    ) : (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Remove ${passkey.name}`}
                                            disabled={locked}
                                            onClick={() => setConfirm({ remove: passkey })}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {!factors.passkeysAvailable ? (
                        <Muted>Passkeys are not available on this site.</Muted>
                    ) : !isPasskeySupported() ? (
                        <Muted>This browser does not support passkeys.</Muted>
                    ) : showingCodes ? null : (
                        <Button variant="outline" size="sm" disabled={locked} onClick={() => void newPasskey()}>
                            Add a passkey
                        </Button>
                    )}
                </CardContent>
            </Card>

            {!confined && (
                <Card>
                    <CardContent className="pt-6">
                        <Row
                            icon={MonitorSmartphone}
                            title="Signed-in devices"
                            action={
                                <Button variant="outline" size="sm" asChild>
                                    <Link to="/sessions">Review</Link>
                                </Button>
                            }
                        >
                            See where you are signed in, and sign out of the ones you do not know.
                        </Row>
                    </CardContent>
                </Card>
            )}

            <ConfirmDialog
                open={confirm !== null}
                onOpenChange={(open) => !open && setConfirm(null)}
                title={
                    confirm === 'disable'
                        ? 'Turn off the authenticator app?'
                        : confirm === 'regenerate'
                          ? 'Make new recovery codes?'
                          : 'Remove this passkey?'
                }
                description={
                    confirm === 'disable'
                        ? 'It will no longer be asked for. If it is your only second step, two-factor sign-in turns off and your recovery codes stop working.'
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
        </SettingsPage>
    );
}
