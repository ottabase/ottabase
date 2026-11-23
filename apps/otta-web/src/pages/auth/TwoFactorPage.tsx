/**
 * /login/two-factor: the second step of a sign-in for an account with an authenticator app.
 * Password, magic-link and OAuth sign-ins land here with a short-lived pending cookie; a code, a
 * recovery code or a passkey finishes the sign-in and the person goes on to `callbackUrl`.
 */
import { useSession } from '@/lib/auth';
import { getTwoFactorChallenge, isPasskeySupported, submitTwoFactor } from '@/lib/auth-api';
import { safeAuthRedirect } from '@/lib/auth-redirect';
import {
    Alert,
    AlertDescription,
    Button,
    Card,
    CardContent,
    Input,
    InputOTP,
    InputOTPGroup,
    InputOTPSlot,
    Spinner,
} from '@ottabase/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Mode = 'code' | 'recovery';

export function TwoFactorPage() {
    const navigate = useNavigate();
    const { login } = useSession();
    const target = useRef(
        safeAuthRedirect(
            typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('callbackUrl'),
        ),
    );
    const [state, setState] = useState<'loading' | 'pending' | 'expired'>('loading');
    const [canUsePasskey, setCanUsePasskey] = useState(false);
    const [hasRecoveryCodes, setHasRecoveryCodes] = useState(false);
    const [mode, setMode] = useState<Mode>('code');
    const [code, setCode] = useState('');
    const [recoveryCode, setRecoveryCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        void getTwoFactorChallenge().then((challenge) => {
            if (!mounted) return;
            setState(challenge.pending ? 'pending' : 'expired');
            setCanUsePasskey(!!challenge.passkey && isPasskeySupported());
            setHasRecoveryCodes(!!challenge.recoveryCodes);
        });
        return () => {
            mounted = false;
        };
    }, []);

    const finish = async (proof: Parameters<typeof submitTwoFactor>[0]) => {
        setBusy(true);
        setError(null);
        const result = await submitTwoFactor(proof);
        setBusy(false);
        if (result.success && result.session) {
            login(result.session);
            navigate({ to: target.current, replace: true });
            return;
        }
        if (result.cancelled) return;
        if (result.code === 'SECOND_FACTOR_EXPIRED') setState('expired');
        setError(result.error ?? 'That did not work. Try again.');
        setCode('');
    };

    if (state === 'loading') {
        return (
            <div className="flex min-h-[60vh] items-center justify-center">
                <Spinner className="h-6 w-6" />
            </div>
        );
    }

    return (
        <div className="flex min-h-[80vh] items-center justify-center">
            <div className="w-full max-w-sm space-y-6">
                <div className="flex flex-col items-center gap-3 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-background ring-1 ring-border">
                        <ShieldCheck className="h-5 w-5" />
                    </span>
                    <div className="space-y-1.5">
                        <h1 className="text-2xl font-semibold tracking-[-0.015em]">Two-factor sign-in</h1>
                        <p className="text-sm text-muted-foreground">
                            {state === 'expired'
                                ? 'This sign-in has expired.'
                                : mode === 'code'
                                  ? 'Enter the six-digit code from your authenticator app.'
                                  : 'Enter one of the recovery codes you saved.'}
                        </p>
                    </div>
                </div>

                <Card>
                    <CardContent className="space-y-4 pt-6">
                        {error && (
                            <Alert variant="destructive">
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        )}

                        {state === 'expired' ? (
                            <Button asChild className="w-full">
                                <Link to="/login">Sign in again</Link>
                            </Button>
                        ) : mode === 'code' ? (
                            <form
                                className="space-y-4"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    if (code.length === 6) void finish({ code });
                                }}
                            >
                                <div className="flex justify-center">
                                    <InputOTP
                                        maxLength={6}
                                        value={code}
                                        onChange={setCode}
                                        onComplete={(value: string) => void finish({ code: value })}
                                        disabled={busy}
                                        autoFocus
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
                                <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                                    {busy ? 'Checking...' : 'Verify'}
                                </Button>
                            </form>
                        ) : (
                            <form
                                className="space-y-4"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    if (recoveryCode.trim()) void finish({ recoveryCode });
                                }}
                            >
                                <Input
                                    value={recoveryCode}
                                    onChange={(event) => setRecoveryCode(event.target.value)}
                                    placeholder="xxxxx-xxxxx"
                                    autoFocus
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-label="Recovery code"
                                    className="font-mono"
                                />
                                <Button type="submit" className="w-full" disabled={busy || !recoveryCode.trim()}>
                                    {busy ? 'Checking...' : 'Use recovery code'}
                                </Button>
                            </form>
                        )}

                        {state === 'pending' && canUsePasskey && (
                            <Button
                                variant="outline"
                                className="w-full"
                                disabled={busy}
                                onClick={() => void finish({ passkey: true })}
                            >
                                <KeyRound className="h-4 w-4" />
                                Use a passkey
                            </Button>
                        )}
                    </CardContent>
                </Card>

                {state === 'pending' && (
                    <div className="flex flex-col items-center gap-2 text-sm">
                        {mode === 'code' && hasRecoveryCodes && (
                            <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground hover:underline"
                                onClick={() => {
                                    setMode('recovery');
                                    setError(null);
                                }}
                            >
                                Lost your phone? Use a recovery code
                            </button>
                        )}
                        {mode === 'recovery' && (
                            <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground hover:underline"
                                onClick={() => {
                                    setMode('code');
                                    setError(null);
                                }}
                            >
                                Use the authenticator app instead
                            </button>
                        )}
                        <Link to="/login" className="text-muted-foreground hover:text-foreground hover:underline">
                            Cancel and start over
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
