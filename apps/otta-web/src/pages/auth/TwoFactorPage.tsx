/**
 * /login/two-factor: the second step of a sign-in for an account with two-factor sign-in on.
 * Password, magic-link and OAuth sign-ins land here with a short-lived pending cookie; a code
 * from the authenticator app, a passkey or a recovery code finishes the sign-in and the person
 * goes on to `callbackUrl`, with the sign-in form's "Remember me" choice (`remember`).
 */
import { SixDigitCode } from '@/components/auth/SixDigitCode';
import { useSession } from '@/lib/auth';
import {
    getTwoFactorChallenge,
    isPasskeySupported,
    submitTwoFactor,
    type TwoFactorChallengeState,
} from '@/lib/auth-api';
import { rememberReturnPath, safeAuthRedirect } from '@/lib/auth-redirect';
import { Alert, AlertDescription, Button, Card, CardContent, Input, Spinner } from '@ottabase/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Mode = 'code' | 'passkey' | 'recovery';
type Methods = TwoFactorChallengeState['methods'];

const ERROR_ID = 'two-factor-error';

export function TwoFactorPage() {
    const navigate = useNavigate();
    const { login } = useSession();
    const search = useSearch({ from: '/login/two-factor' });
    const target = safeAuthRedirect(search.callbackUrl ?? null);
    const [state, setState] = useState<'loading' | 'pending' | 'expired' | 'unreachable'>('loading');
    const [methods, setMethods] = useState<Methods>({ totp: false, passkey: false, recoveryCode: false });
    const [mode, setMode] = useState<Mode>('code');
    const [code, setCode] = useState('');
    const [recoveryCode, setRecoveryCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const codeInput = useRef<HTMLInputElement>(null);
    // The code field stays enabled while a code is checked (so focus stays put); this stops a second submit.
    const submitting = useRef(false);

    const load = useCallback(async () => {
        setState('loading');
        setError(null);
        const challenge = await getTwoFactorChallenge();
        if (challenge.error) {
            setError(challenge.error);
            setState('unreachable');
            return;
        }
        const usable = { ...challenge.methods, passkey: challenge.methods.passkey && isPasskeySupported() };
        setMethods(usable);
        setMode(usable.totp ? 'code' : usable.passkey ? 'passkey' : 'recovery');
        setState(challenge.pending ? 'pending' : 'expired');
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    /** Back to the sign-in form, keeping where the person was going. */
    const startOver = () => rememberReturnPath(target);

    const finish = async (proof: Parameters<typeof submitTwoFactor>[0]) => {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError(null);
        const result = await submitTwoFactor(proof);
        submitting.current = false;
        setBusy(false);
        if (result.success && result.session) {
            login(result.session, { remember: search.remember });
            navigate({ to: target, replace: true });
            return;
        }
        if (result.cancelled) return;
        if (result.code === 'SECOND_FACTOR_EXPIRED') {
            // The page says it once, in the header and the card.
            setState('expired');
            return;
        }
        setError(result.error ?? 'That did not work. Try again.');
        setCode('');
        codeInput.current?.focus();
    };

    const switchTo = (next: Mode) => {
        setMode(next);
        setError(null);
    };

    if (state === 'loading') {
        return (
            <div className="flex min-h-[60vh] items-center justify-center">
                <Spinner className="h-6 w-6" />
            </div>
        );
    }

    const prompt =
        state === 'expired'
            ? 'This sign-in has expired. Sign in again to continue.'
            : state === 'unreachable'
              ? 'We could not check your sign-in.'
              : mode === 'code'
                ? 'Enter the six-digit code from your authenticator app.'
                : mode === 'passkey'
                  ? 'Use the passkey on this device to finish signing in.'
                  : 'Enter one of the recovery codes you saved.';

    const errorAlert = error && (
        <Alert variant="destructive" id={ERROR_ID}>
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    );

    return (
        <div className="flex min-h-[80vh] items-center justify-center">
            <div className="w-full max-w-md space-y-6">
                <div className="flex flex-col items-center gap-3 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-background ring-1 ring-border">
                        <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="space-y-1.5">
                        <h1 className="text-2xl font-semibold tracking-[-0.015em]">Two-factor sign-in</h1>
                        <p className="text-sm text-muted-foreground">{prompt}</p>
                    </div>
                </div>

                <Card>
                    <CardContent className="space-y-4 pt-6">
                        {errorAlert}

                        {state === 'unreachable' ? (
                            <Button className="w-full" onClick={() => void load()}>
                                Try again
                            </Button>
                        ) : state === 'expired' ? (
                            <Button asChild className="w-full">
                                <Link to="/login" onClick={startOver}>
                                    Sign in again
                                </Link>
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
                                    <SixDigitCode
                                        value={code}
                                        onChange={setCode}
                                        onComplete={(value) => void finish({ code: value })}
                                        inputRef={codeInput}
                                        errorId={error ? ERROR_ID : undefined}
                                        autoFocus
                                    />
                                </div>
                                <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                                    {busy ? 'Checking...' : 'Verify'}
                                </Button>
                            </form>
                        ) : mode === 'recovery' ? (
                            <form
                                className="space-y-4"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    if (recoveryCode.trim()) void finish({ recoveryCode: recoveryCode.trim() });
                                }}
                            >
                                <Input
                                    value={recoveryCode}
                                    onChange={(event) => setRecoveryCode(event.target.value)}
                                    placeholder="xxxx-xxxx-xxxx-xxxx"
                                    autoFocus
                                    autoComplete="off"
                                    spellCheck={false}
                                    aria-label="Recovery code"
                                    aria-describedby={error ? ERROR_ID : undefined}
                                    aria-invalid={error ? true : undefined}
                                    className="font-mono"
                                />
                                <Button type="submit" className="w-full" disabled={busy || !recoveryCode.trim()}>
                                    {busy ? 'Checking...' : 'Use recovery code'}
                                </Button>
                            </form>
                        ) : null}

                        {state === 'pending' && methods.passkey && mode !== 'recovery' && (
                            <Button
                                variant={mode === 'passkey' ? 'default' : 'outline'}
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

                {state !== 'expired' && (
                    <div className="flex flex-col items-center gap-2 text-sm">
                        {state === 'pending' && mode !== 'recovery' && methods.recoveryCode && (
                            <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground hover:underline"
                                onClick={() => switchTo('recovery')}
                            >
                                Use a recovery code
                            </button>
                        )}
                        {state === 'pending' && mode === 'recovery' && (methods.totp || methods.passkey) && (
                            <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground hover:underline"
                                onClick={() => switchTo(methods.totp ? 'code' : 'passkey')}
                            >
                                {methods.totp ? 'Use the authenticator app instead' : 'Use a passkey instead'}
                            </button>
                        )}
                        <Link
                            to="/login"
                            onClick={startOver}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                        >
                            Cancel and start over
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
