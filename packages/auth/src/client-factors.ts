// ============================================================
// @ottabase/auth - Browser calls for passkeys and two-factor sign-in
// ============================================================
//
// The client half of factors.ts. Exported from `@ottabase/auth/client`. The WebAuthn options
// travel as JSON (base64url for every binary field); these helpers turn them into what
// `navigator.credentials` takes and turn its answer back into JSON.
//
// ============================================================

import type { AuthClientOptions, AuthSession } from './client-api';

const base = (options?: AuthClientOptions) => options?.baseUrl ?? '/api/auth';

function fromB64url(value: string): ArrayBuffer {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function toB64url(buffer: ArrayBuffer | null | undefined): string {
    if (!buffer) return '';
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Does this browser do passkeys at all? (The server separately says whether the app can.) */
export function isPasskeySupported(): boolean {
    return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

interface CredentialDescriptorJSON {
    type: 'public-key';
    id: string;
    transports?: string[];
}

const descriptors = (list: CredentialDescriptorJSON[] | undefined): PublicKeyCredentialDescriptor[] =>
    (list ?? []).map((item) => ({
        type: 'public-key',
        id: fromB64url(item.id),
        ...(item.transports?.length ? { transports: item.transports as AuthenticatorTransport[] } : {}),
    }));

async function createCredential(json: any): Promise<Record<string, unknown>> {
    const credential = (await navigator.credentials.create({
        publicKey: {
            ...json,
            challenge: fromB64url(json.challenge),
            user: { ...json.user, id: fromB64url(json.user.id) },
            excludeCredentials: descriptors(json.excludeCredentials),
        },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error('No passkey was created');
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
        id: credential.id,
        rawId: toB64url(credential.rawId),
        type: credential.type,
        response: {
            clientDataJSON: toB64url(response.clientDataJSON),
            attestationObject: toB64url(response.attestationObject),
            transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
        },
    };
}

async function getCredential(json: any): Promise<Record<string, unknown>> {
    const credential = (await navigator.credentials.get({
        publicKey: {
            ...json,
            challenge: fromB64url(json.challenge),
            allowCredentials: descriptors(json.allowCredentials),
        },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error('No passkey was chosen');
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
        id: credential.id,
        rawId: toB64url(credential.rawId),
        type: credential.type,
        response: {
            clientDataJSON: toB64url(response.clientDataJSON),
            authenticatorData: toB64url(response.authenticatorData),
            signature: toB64url(response.signature),
            userHandle: response.userHandle ? toB64url(response.userHandle) : null,
        },
    };
}

/** The person dismissed the browser's passkey sheet: not an error worth showing. */
export function isPasskeyCancelled(error: unknown): boolean {
    return error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

async function csrf(options?: AuthClientOptions): Promise<string | null> {
    const response = await fetch(`${base(options)}/csrf`, { credentials: 'include' });
    if (!response.ok) return null;
    return ((await response.json().catch(() => null)) as { csrfToken?: string } | null)?.csrfToken ?? null;
}

/** A JSON call to the auth API with a fresh CSRF token. Throws nothing: failures come back as `{ error }`. */
async function call<T>(
    path: string,
    init: { method?: string; body?: Record<string, unknown> } = {},
    options?: AuthClientOptions,
): Promise<T & { error?: string; code?: string; status: number }> {
    try {
        const method = init.method ?? 'GET';
        const body = method === 'GET' ? undefined : JSON.stringify({ ...init.body, csrfToken: await csrf(options) });
        const response = await fetch(`${base(options)}${path}`, {
            method,
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        const data = ((await response.json().catch(() => ({}))) ?? {}) as T & { error?: string; code?: string };
        return { ...data, status: response.status };
    } catch (error) {
        return { error: error instanceof Error ? error.message : 'Request failed', status: 0 } as T & {
            error: string;
            status: number;
        };
    }
}

export interface FactorSignInResult {
    success: boolean;
    session?: AuthSession;
    /** The account has an authenticator app: go to the second-factor page. */
    twoFactorRequired?: boolean;
    error?: string;
    code?: string;
    /** The person closed the browser's passkey sheet. */
    cancelled?: boolean;
}

/** Sign in with a passkey: the browser offers this site's passkeys and the person picks one. */
export async function signInWithPasskey(options?: AuthClientOptions): Promise<FactorSignInResult> {
    const requestOptions = await call<Record<string, unknown>>('/passkey/options', { method: 'POST' }, options);
    if (requestOptions.error) return { success: false, error: requestOptions.error, code: requestOptions.code };
    let credential: Record<string, unknown>;
    try {
        credential = await getCredential(requestOptions);
    } catch (error) {
        return { success: false, cancelled: isPasskeyCancelled(error), error: 'The passkey sign-in was cancelled.' };
    }
    const result = await call<FactorSignInResult>(
        '/callback/passkey',
        { method: 'POST', body: { credential } },
        options,
    );
    return { ...result, success: result.success === true };
}

export interface TwoFactorChallengeState {
    pending: boolean;
    /** The person has a passkey that can finish this sign-in. */
    passkey?: boolean;
    /** The person has recovery codes left. */
    recoveryCodes?: boolean;
}

export async function getTwoFactorChallenge(options?: AuthClientOptions): Promise<TwoFactorChallengeState> {
    const state = await call<TwoFactorChallengeState>('/two-factor/challenge', {}, options);
    return {
        pending: state.pending === true,
        passkey: state.passkey === true,
        recoveryCodes: state.recoveryCodes === true,
    };
}

/** Finish a sign-in waiting on a second factor: a code, a recovery code, or a passkey. */
export async function submitTwoFactor(
    proof: { code: string } | { recoveryCode: string } | { passkey: true },
    options?: AuthClientOptions,
): Promise<FactorSignInResult> {
    let body: Record<string, unknown> = proof;
    if ('passkey' in proof) {
        const requestOptions = await call<Record<string, unknown>>(
            '/two-factor/passkey-options',
            { method: 'POST' },
            options,
        );
        if (requestOptions.error) return { success: false, error: requestOptions.error };
        try {
            body = { passkey: await getCredential(requestOptions) };
        } catch (error) {
            return { success: false, cancelled: isPasskeyCancelled(error), error: 'The passkey was not used.' };
        }
    }
    const result = await call<FactorSignInResult>('/two-factor/challenge', { method: 'POST', body }, options);
    return { ...result, success: result.success === true };
}

// ---------- the signed-in person's own factors ----------

export interface PasskeySummary {
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
    transports: string[];
}

export interface FactorSummary {
    twoFactor: { enabled: boolean; pending: boolean; recoveryCodesLeft: number };
    passkeys: PasskeySummary[];
    /** The app can do passkeys at its address (a domain over https, or localhost). */
    passkeysAvailable: boolean;
    /** The session is recent enough to change factors; otherwise sign in again first. */
    recentSignIn: boolean;
    recentSignInUntil: number | null;
}

export type FactorResult<T = Record<string, never>> =
    | (T & { success: true })
    | { success: false; error: string; code?: string };

function result<T>(data: Record<string, unknown> & { error?: string; code?: string; status: number }): FactorResult<T> {
    if (data.error || data.status >= 400 || data.status === 0) {
        return { success: false, error: data.error ?? 'Something went wrong', code: data.code };
    }
    return { ...(data as unknown as T), success: true };
}

export async function getFactors(options?: AuthClientOptions): Promise<FactorResult<FactorSummary>> {
    return result<FactorSummary>(await call('/factors', {}, options));
}

/** Start authenticator-app setup: show `uri` as a QR code and `secret` as text. */
export async function startTotpSetup(
    options?: AuthClientOptions,
): Promise<FactorResult<{ secret: string; uri: string }>> {
    return result(await call('/factors/totp', { method: 'POST' }, options));
}

/** The first code turns it on; the recovery codes come back once, to be saved. */
export async function confirmTotpSetup(
    code: string,
    options?: AuthClientOptions,
): Promise<FactorResult<{ recoveryCodes: string[] }>> {
    return result(await call('/factors/totp/confirm', { method: 'POST', body: { code } }, options));
}

export async function disableTotp(options?: AuthClientOptions): Promise<FactorResult> {
    return result(await call('/factors/totp', { method: 'DELETE' }, options));
}

export async function regenerateRecoveryCodes(
    options?: AuthClientOptions,
): Promise<FactorResult<{ recoveryCodes: string[] }>> {
    return result(await call('/factors/recovery-codes', { method: 'POST' }, options));
}

/** Make a passkey on this device and add it to the account. */
export async function addPasskey(
    name: string,
    options?: AuthClientOptions,
): Promise<FactorResult<{ passkey: { id: string; name: string } }> & { cancelled?: boolean }> {
    const creation = await call<Record<string, unknown>>('/factors/passkeys/options', { method: 'POST' }, options);
    if (creation.error) return { success: false, error: creation.error, code: creation.code };
    let credential: Record<string, unknown>;
    try {
        credential = await createCredential(creation);
    } catch (error) {
        return {
            success: false,
            error: 'No passkey was made.',
            ...(isPasskeyCancelled(error) ? { cancelled: true } : {}),
        };
    }
    return result(await call('/factors/passkeys', { method: 'POST', body: { credential, name } }, options));
}

export async function renamePasskey(id: string, name: string, options?: AuthClientOptions): Promise<FactorResult> {
    return result(
        await call(`/factors/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }, options),
    );
}

export async function removePasskey(id: string, options?: AuthClientOptions): Promise<FactorResult> {
    return result(await call(`/factors/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }, options));
}
