// ============================================================
// @ottabase/auth - Browser calls for passkeys and two-factor sign-in
// ============================================================
//
// The client half of factors.ts. Exported from `@ottabase/auth/client`. The WebAuthn options
// travel as JSON (base64url for every binary field); these helpers turn them into what
// `navigator.credentials` takes and turn its answer back into JSON.
//
// ============================================================

import { getCsrfToken, type AuthClientOptions, type AuthSession } from './client-api';

const base = (options?: AuthClientOptions) => options?.baseUrl ?? '/api/auth';

export function fromB64url(value: string): ArrayBuffer {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

export function toB64url(buffer: ArrayBuffer | null | undefined): string {
    if (!buffer) return '';
    let binary = '';
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Does this browser do passkeys at all? (The server separately says whether the app can.) */
export function isPasskeySupported(): boolean {
    return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

/** "Chrome on Windows", say, so a new passkey has a useful name before the person renames it. */
export function defaultPasskeyName(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
    if (!ua) return 'Passkey';
    // iOS browsers name themselves CriOS / FxiOS / EdgiOS, and iPads claim "Mac OS X": test those first.
    const browser = /EdgiOS|Edg\//.test(ua)
        ? 'Edge'
        : /CriOS|Chrome\//.test(ua)
          ? 'Chrome'
          : /FxiOS|Firefox\//.test(ua)
            ? 'Firefox'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser';
    const os = /iPhone/.test(ua)
        ? 'iPhone'
        : /iPad/.test(ua)
          ? 'iPad'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Android/.test(ua)
              ? 'Android'
              : /Mac OS X/.test(ua)
                ? 'Mac'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : '';
    return os ? `${browser} on ${os}` : browser;
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

/** A refusal faster than this came from the browser, not from a person closing the sheet. */
const INSTANT_REFUSAL_MS = 750;
const DEFAULT_CEREMONY_TIMEOUT_MS = 300_000;

/**
 * Did the person close the browser's passkey sheet? Then the page shows nothing.
 *
 * `AbortError` is always a cancel. `NotAllowedError` is how WebAuthn reports a dismissal, a
 * timeout AND a refusal by the browser (no focus, a permissions policy), on purpose, so the
 * name alone cannot tell them apart. The rule: it counts as a cancel when it came after the
 * sheet had time to show (750 ms) and before the ceremony's timeout; an instant refusal or a
 * timeout is a failure worth a message.
 * ponytail: timing heuristic, revisit if browsers ever expose a distinct cancel reason.
 */
export function isPasskeyCancelled(
    error: unknown,
    elapsedMs = INSTANT_REFUSAL_MS,
    timeoutMs = DEFAULT_CEREMONY_TIMEOUT_MS,
): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === 'AbortError') return true;
    return error.name === 'NotAllowedError' && elapsedMs >= INSTANT_REFUSAL_MS && elapsedMs < timeoutMs;
}

export const PASSKEY_FAILED = 'Your passkey did not work. Try again or use another way to sign in.';
export const PASSKEY_EXISTS = 'This device already has a passkey here.';

/** Run a passkey ceremony and sort its failure: a cancel (show nothing) or a message. */
async function ceremony<T>(
    run: () => Promise<T>,
    timeout: unknown,
    failed: string,
): Promise<{ value: T } | { cancelled: true } | { error: string }> {
    const started = Date.now();
    try {
        return { value: await run() };
    } catch (error) {
        const limit = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_CEREMONY_TIMEOUT_MS;
        if (isPasskeyCancelled(error, Date.now() - started, limit)) return { cancelled: true };
        if (error instanceof Error && error.name === 'InvalidStateError') return { error: PASSKEY_EXISTS };
        return { error: failed };
    }
}

type CallResult<T> = T & { error?: string; code?: string; status: number };

/** A JSON call to the auth API with a fresh CSRF token. Throws nothing: failures come back as `{ error }`. */
async function call<T>(
    path: string,
    init: { method?: string; body?: Record<string, unknown> } = {},
    options?: AuthClientOptions,
): Promise<CallResult<T>> {
    try {
        const method = init.method ?? 'GET';
        const body =
            method === 'GET' ? undefined : JSON.stringify({ ...init.body, csrfToken: await getCsrfToken(options) });
        const response = await fetch(`${base(options)}${path}`, {
            method,
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        const data = ((await response.json().catch(() => ({}))) ?? {}) as T & { error?: string; code?: string };
        return { ...data, status: response.status };
    } catch {
        return {
            error: 'Could not reach the server. Check your connection and try again.',
            code: 'NETWORK_ERROR',
            status: 0,
        } as CallResult<T>;
    }
}

export interface FactorSignInResult {
    success: boolean;
    session?: AuthSession;
    /** The account has two-factor sign-in on: go to the second-factor page. */
    twoFactorRequired?: boolean;
    error?: string;
    code?: string;
    /** The person closed the browser's passkey sheet: show nothing. */
    cancelled?: boolean;
}

/** Sign in with a passkey: the browser offers this site's passkeys and the person picks one. */
export async function signInWithPasskey(options?: AuthClientOptions): Promise<FactorSignInResult> {
    const requestOptions = await call<Record<string, unknown>>('/passkey/options', { method: 'POST' }, options);
    if (requestOptions.error) return { success: false, error: requestOptions.error, code: requestOptions.code };
    const used = await ceremony(() => getCredential(requestOptions), requestOptions.timeout, PASSKEY_FAILED);
    if (!('value' in used)) return { success: false, ...used };
    const result = await call<FactorSignInResult>(
        '/callback/passkey',
        { method: 'POST', body: { credential: used.value } },
        options,
    );
    return { ...result, success: result.success === true };
}

export interface TwoFactorMethods {
    totp: boolean;
    passkey: boolean;
    recoveryCode: boolean;
}

export interface TwoFactorChallengeState {
    pending: boolean;
    /** What can finish this sign-in. */
    methods: TwoFactorMethods;
    /** The state could not be read (network, server): not the same as "expired". */
    error?: string;
}

export async function getTwoFactorChallenge(options?: AuthClientOptions): Promise<TwoFactorChallengeState> {
    const state = await call<{ pending?: boolean; methods?: Partial<TwoFactorMethods> }>(
        '/two-factor/challenge',
        {},
        options,
    );
    const methods = {
        totp: state.methods?.totp === true,
        passkey: state.methods?.passkey === true,
        recoveryCode: state.methods?.recoveryCode === true,
    };
    if (state.status === 0 || state.status >= 500) {
        return { pending: false, methods, error: state.error ?? 'Something went wrong. Try again.' };
    }
    return { pending: state.pending === true, methods };
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
        if (requestOptions.error) return { success: false, error: requestOptions.error, code: requestOptions.code };
        const used = await ceremony(() => getCredential(requestOptions), requestOptions.timeout, PASSKEY_FAILED);
        if (!('value' in used)) return { success: false, ...used };
        body = { passkey: used.value };
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
    twoFactor: {
        /** Two-factor sign-in is on: an authenticator app, or at least one passkey. */
        enabled: boolean;
        /** An authenticator app is confirmed. */
        totp: boolean;
        /** Authenticator setup was started and not confirmed. */
        totpPending: boolean;
        /** How many passkeys the account has. */
        passkeys: number;
        recoveryCodesLeft: number;
        /** Epoch ms from which the person's organization requires two-factor; null when none does. */
        requiredFrom: number | null;
    };
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

/** Any failure (no response, an error status, or a 200 that carries `error`) becomes `{ success: false }`. */
export function result<T>(data: CallResult<Record<string, unknown>>): FactorResult<T> {
    if (data.error || data.status >= 400 || data.status === 0) {
        return { success: false, error: data.error ?? 'Something went wrong. Try again.', code: data.code };
    }
    const { status: _status, ...rest } = data;
    return { ...(rest as unknown as T), success: true };
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

/** The first code turns it on. When that turns two-factor on, the recovery codes come back once. */
export async function confirmTotpSetup(
    code: string,
    options?: AuthClientOptions,
): Promise<FactorResult<{ recoveryCodes?: string[] }>> {
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

/**
 * Make a passkey on this device and add it to the account, named for the browser and device
 * unless a name is given. The first passkey of an account without an authenticator app turns
 * two-factor on, and then the recovery codes come back once.
 */
export async function addPasskey(
    name: string = defaultPasskeyName(),
    options?: AuthClientOptions,
): Promise<
    | FactorResult<{ passkey: { id: string; name: string }; recoveryCodes?: string[] }>
    | { success: false; cancelled: true }
> {
    const creation = await call<Record<string, unknown>>('/factors/passkeys/options', { method: 'POST' }, options);
    if (creation.error) return { success: false, error: creation.error, code: creation.code };
    const made = await ceremony(() => createCredential(creation), creation.timeout, 'No passkey was added. Try again.');
    if ('cancelled' in made) return { success: false, cancelled: true };
    if ('error' in made) return { success: false, error: made.error };
    return result(await call('/factors/passkeys', { method: 'POST', body: { credential: made.value, name } }, options));
}

export async function renamePasskey(id: string, name: string, options?: AuthClientOptions): Promise<FactorResult> {
    return result(
        await call(`/factors/passkeys/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }, options),
    );
}

export async function removePasskey(id: string, options?: AuthClientOptions): Promise<FactorResult> {
    return result(await call(`/factors/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }, options));
}
