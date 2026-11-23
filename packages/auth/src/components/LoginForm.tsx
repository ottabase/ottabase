import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@ottabase/ui';
import type { SocialProvider } from './helpers';
import { SocialLoginButtons, SocialLoginDivider } from './SocialLoginButtons';
import { CredentialsForm } from './CredentialsForm';
import { MagicLinkForm } from './MagicLinkForm';

export interface LoginFormProps {
    // Title and description
    title?: string;
    description?: string;

    // Provider configurations
    socialProviders?: SocialProvider[];
    showCredentials?: boolean;
    showMagicLink?: boolean;
    /**
     * Offer "Sign in with a passkey" first in the card, above the "or" divider. Pass it once
     * you know (the app can do passkeys and so can this browser), so the card does not shift.
     */
    showPasskey?: boolean;

    // Default tab
    defaultTab?: 'credentials' | 'magic-link';

    // Callbacks
    onSocialLogin?: (providerId: string) => void;
    onCredentialsLogin?: (credentials: { email: string; password: string; rememberMe: boolean }) => Promise<void>;
    onMagicLinkSend?: (email: string) => Promise<void>;
    onForgotPassword?: () => void;
    /** The passkey button; gets the same "Remember me" choice as the password form. */
    onPasskeyLogin?: (options: { rememberMe: boolean }) => void;

    // State
    isLoading?: boolean;
    error?: string;
    magicLinkSuccess?: boolean;

    // Customization
    className?: string;
    showSignUp?: boolean;
    onSignUpClick?: () => void;
    showRememberMe?: boolean;
    rememberMeLabel?: string;
    defaultRememberMe?: boolean;
    passkeyLabel?: string;
    /**
     * A bot check (the `useTurnstile` widget) shared by the credentials and magic-link forms,
     * rendered above whichever submit button is showing. One widget covers both methods.
     */
    botCheck?: React.ReactNode;
}

export function LoginForm({
    title = 'Welcome back',
    description = 'Sign in to your account',
    socialProviders = [],
    showCredentials = true,
    showMagicLink = false,
    showPasskey = false,
    defaultTab = 'credentials',
    onSocialLogin,
    onCredentialsLogin,
    onMagicLinkSend,
    onForgotPassword,
    onPasskeyLogin,
    isLoading = false,
    error,
    magicLinkSuccess = false,
    className = '',
    showSignUp = false,
    onSignUpClick,
    showRememberMe = true,
    rememberMeLabel = 'Remember me',
    defaultRememberMe = true,
    passkeyLabel = 'Sign in with a passkey',
    botCheck,
}: LoginFormProps) {
    const [activeTab, setActiveTab] = useState(defaultTab);
    // Held here, not in the password form, so the passkey button honours it too.
    const [rememberMe, setRememberMe] = useState(defaultRememberMe);

    const hasSocial = socialProviders.length > 0 && !!onSocialLogin;
    const hasPasskey = showPasskey && !!onPasskeyLogin;
    const hasForms = showCredentials || showMagicLink;
    const hasMultipleMethods = [showCredentials, showMagicLink].filter(Boolean).length > 1;
    const credentialsForm = showCredentials && onCredentialsLogin && (
        <CredentialsForm
            onSubmit={onCredentialsLogin}
            isLoading={isLoading}
            error={error}
            showForgotPassword={!!onForgotPassword}
            onForgotPassword={onForgotPassword}
            showRememberMe={showRememberMe}
            rememberMeLabel={rememberMeLabel}
            rememberMe={rememberMe}
            onRememberMeChange={setRememberMe}
            botCheck={botCheck}
        />
    );
    const magicLinkForm = showMagicLink && onMagicLinkSend && (
        <MagicLinkForm
            onSubmit={onMagicLinkSend}
            isLoading={isLoading}
            error={error}
            success={magicLinkSuccess}
            botCheck={botCheck}
        />
    );

    return (
        <Card className={`w-full max-w-md ${className}`}>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
                {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Passkey first: the quickest way in when the device has one */}
                {hasPasskey && (
                    <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={isLoading}
                        onClick={() => onPasskeyLogin?.({ rememberMe })}
                    >
                        <KeyRound className="h-4 w-4" />
                        {passkeyLabel}
                    </Button>
                )}

                {/* Social providers */}
                {hasSocial && onSocialLogin && (
                    <SocialLoginButtons
                        providers={socialProviders}
                        onProviderClick={onSocialLogin}
                        isLoading={isLoading}
                    />
                )}
                {(hasPasskey || hasSocial) && hasForms && <SocialLoginDivider text="or" />}

                {/* Credentials and Magic Link */}
                {hasForms &&
                    (hasMultipleMethods ? (
                        <Tabs
                            value={activeTab}
                            onValueChange={(v: string) => setActiveTab(v as 'credentials' | 'magic-link')}
                        >
                            <TabsList className="grid w-full grid-cols-2">
                                {showCredentials && <TabsTrigger value="credentials">Email & Password</TabsTrigger>}
                                {showMagicLink && <TabsTrigger value="magic-link">Magic Link</TabsTrigger>}
                            </TabsList>
                            {credentialsForm && <TabsContent value="credentials">{credentialsForm}</TabsContent>}
                            {magicLinkForm && <TabsContent value="magic-link">{magicLinkForm}</TabsContent>}
                        </Tabs>
                    ) : (
                        <>
                            {credentialsForm}
                            {magicLinkForm}
                        </>
                    ))}

                {/* Sign up link */}
                {showSignUp && onSignUpClick && (
                    <div className="text-center text-sm">
                        Don't have an account?{' '}
                        <button
                            type="button"
                            onClick={onSignUpClick}
                            className="font-medium text-primary hover:underline"
                        >
                            Sign up
                        </button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
