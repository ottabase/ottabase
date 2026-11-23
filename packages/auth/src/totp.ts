// ============================================================
// @ottabase/auth - Authenticator-app codes (TOTP, RFC 6238)
// ============================================================
//
// HOTP (RFC 4226) over a 30-second time step, HMAC-SHA1, six digits: what every authenticator
// app (Google Authenticator, 1Password, Authy, Microsoft Authenticator...) speaks by default.
// Web Crypto only. The shared secret is sealed at rest (`sealSecret`), never stored plaintext.
//
// ============================================================

import { base64UrlDecode, base64UrlEncode, timingSafeEqualString } from './crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and the next step too: clocks drift, and people type slowly. */
const DRIFT_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** RFC 4648 base32 without padding: how authenticator apps take a secret. */
export function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
    const clean = input.toUpperCase().replace(/[\s=-]/g, '');
    const out: number[] = [];
    let bits = 0;
    let value = 0;
    for (const char of clean) {
        const index = BASE32.indexOf(char);
        if (index === -1) throw new Error('Not a base32 secret');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

/** A new 160-bit secret, base32 (what RFC 4226 recommends and every app accepts). */
export function generateTotpSecret(): string {
    return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** RFC 4226 HOTP: the code for one counter value. */
export async function hotp(secret: Uint8Array<ArrayBuffer>, counter: number, digits = DIGITS): Promise<string> {
    const message = new Uint8Array(8);
    let rest = counter;
    for (let i = 7; i >= 0; i--) {
        message[i] = rest & 0xff;
        rest = Math.floor(rest / 256);
    }
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
    const offset = mac[mac.length - 1] & 0x0f;
    const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step a moment falls in. */
export function totpStep(atMs: number = Date.now()): number {
    return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/**
 * The step a code belongs to, within one step of `atMs` either way, or null when it matches none.
 * The caller refuses a step it already accepted (`Authenticator.acceptTotpStep`), which is what
 * makes a code single-use.
 */
export async function matchTotpStep(
    base32Secret: string,
    code: string,
    atMs: number = Date.now(),
): Promise<number | null> {
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) return null;
    const secret = base32Decode(base32Secret);
    const now = totpStep(atMs);
    let matched: number | null = null;
    // Every candidate is computed and compared, so the time taken says nothing about which matched.
    for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
        if (timingSafeEqualString(await hotp(secret, step), digits) && matched === null) matched = step;
    }
    return matched;
}

/** The `otpauth://` address an authenticator app scans as a QR code. */
export function totpUri(input: { secret: string; account: string; issuer: string }): string {
    const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
    const params = new URLSearchParams({
        secret: input.secret,
        issuer: input.issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------- sealing (AES-GCM under a key derived from AUTH_SECRET) ----------

async function sealingKey(secret: string): Promise<CryptoKey> {
    const material = await crypto.subtle.digest('SHA-256', encoder.encode(`${secret}:ottabase-auth-factor`));
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `<iv>.<ciphertext>`, both base64url. */
export async function sealSecret(authSecret: string, plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await sealingKey(authSecret),
        encoder.encode(plaintext),
    );
    return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

export async function openSecret(authSecret: string, envelope: string): Promise<string> {
    const [iv, cipher] = envelope.split('.');
    if (!iv || !cipher) throw new Error('Not a sealed value');
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64UrlDecode(iv) },
        await sealingKey(authSecret),
        base64UrlDecode(cipher),
    );
    return decoder.decode(plain);
}
