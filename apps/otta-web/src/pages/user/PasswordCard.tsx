/**
 * The Password card on /security: change the password, then sign in again with the new one
 * (the server signs every session out when the password changes).
 */
import { changePassword } from '@/lib/auth-api';
import { invalidateAuthSession } from '@ottabase/auth/react';
import {
    Alert,
    AlertDescription,
    Button,
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
    Label,
    PasswordInput,
    Spinner,
} from '@ottabase/ui';
import { withNotice } from '@ottabase/utils/url';
import { useState } from 'react';

const EMPTY = { currentPassword: '', newPassword: '', confirmPassword: '' };

/** Why a new password is refused, or null when it is fine. */
export function passwordProblem(form: typeof EMPTY): string | null {
    const current = form.currentPassword.trim();
    const next = form.newPassword.trim();
    if (!current) return 'Enter your current password.';
    if (!next) return 'Enter a new password.';
    if (next.length < 8 || !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/.test(next))
        return 'Use at least 8 characters, with upper and lower case letters, a number and a symbol.';
    if (next !== form.confirmPassword.trim()) return 'The new passwords do not match.';
    if (next === current) return 'Pick a password different from the current one.';
    return null;
}

export function PasswordCard() {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState(EMPTY);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const close = (next: boolean) => {
        setOpen(next);
        if (!next) {
            setForm(EMPTY);
            setError(null);
        }
    };

    const submit = async () => {
        const problem = passwordProblem(form);
        setError(problem);
        if (problem) return;
        setSaving(true);
        const result = await changePassword({
            currentPassword: form.currentPassword.trim(),
            newPassword: form.newPassword.trim(),
        });
        setSaving(false);
        if (!result.success) {
            setError(result.error || 'Your password was not changed. Try again.');
            return;
        }
        // Every session ends with the old password; sign in again with the new one.
        invalidateAuthSession();
        window.location.href = withNotice('/login', 'password-changed');
    };

    const field = (id: keyof typeof EMPTY, label: string, autoComplete: string) => (
        <div className="space-y-2">
            <Label htmlFor={id}>{label}</Label>
            <PasswordInput
                id={id}
                autoComplete={autoComplete}
                value={form[id]}
                onChange={(e) => setForm((prev) => ({ ...prev, [id]: e.target.value }))}
                disabled={saving}
                aria-describedby={error ? 'password-error' : undefined}
            />
        </div>
    );

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <div className="space-y-1.5">
                    <CardTitle>Password</CardTitle>
                    <CardDescription>Change the password you sign in with.</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => close(true)}>
                    Change password
                </Button>
            </CardHeader>

            <Dialog open={open} onOpenChange={close}>
                <DialogContent className="max-w-md">
                    <DialogTitle>Change password</DialogTitle>
                    <DialogDescription>You will sign in again with the new password.</DialogDescription>
                    <form
                        className="space-y-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        {field('currentPassword', 'Current password', 'current-password')}
                        {field('newPassword', 'New password', 'new-password')}
                        {field('confirmPassword', 'Confirm new password', 'new-password')}
                        {error && (
                            <Alert variant="destructive" id="password-error">
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        )}
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="outline" onClick={() => close(false)} disabled={saving}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={saving}>
                                {saving && <Spinner className="h-4 w-4" />}
                                Change password
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
