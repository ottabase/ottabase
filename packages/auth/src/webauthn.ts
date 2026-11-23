// ============================================================
// @ottabase/auth - Passkeys (WebAuthn Level 2, relying-party side)
// ============================================================
//
// Registration and sign-in checks for passkeys, on Web Crypto alone:
//
// - attestation "none": the app trusts the passkey it is shown, not a hardware vendor's
//   certificate chain (what passkey sign-in on the web uses; attestation statements are ignored).
// - ES256 (P-256), RS256 and EdDSA (Ed25519) public keys, read from their COSE form and kept as a
//   JWK. Those three cover platform authenticators, password managers and security keys.
// - The relying party is the host of AUTH_URL, the origin its origin: both come from
//   configuration, never from the request.
//
// CBOR is decoded by the small reader below: definite lengths, the major types a credential
// uses, nothing else.
//
// ============================================================

import { base64UrlDecode, base64UrlEncode, randomBytes } from './crypto';

type Bytes = Uint8Array<ArrayBuffer>;

/** COSE algorithm identifiers this relying party accepts, most preferred first. */
export const SUPPORTED_ALGORITHMS = [-7, -8, -257] as const;
export type CoseAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

export class WebAuthnError extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'WebAuthnError';
    }
}

// ---------- CBOR ----------

type CborValue =
    | number
    | bigint
    | string
    | boolean
    | null
    | undefined
    | Bytes
    | CborValue[]
    | Map<CborValue, CborValue>;

/** Decode one CBOR item; `end` is where it stopped (authenticator data carries bytes after the key). */
export function decodeCbor(bytes: Uint8Array, start = 0): { value: CborValue; end: number } {
    let offset = start;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const need = (count: number) => {
        if (offset + count > bytes.length) throw new WebAuthnError('cbor-truncated');
    };
    const readLength = (info: number): number => {
        if (info < 24) return info;
        if (info === 24) {
            need(1);
            return bytes[offset++];
        }
        if (info === 25) {
            need(2);
            const value = view.getUint16(offset);
            offset += 2;
            return value;
        }
        if (info === 26) {
            need(4);
            const value = view.getUint32(offset);
            offset += 4;
            return value;
        }
        if (info === 27) {
            need(8);
            const value = view.getBigUint64(offset);
            offset += 8;
            if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError('cbor-too-large');
            return Number(value);
        }
        // 28-30 are reserved, 31 is an indefinite length: no credential uses either.
        throw new WebAuthnError('cbor-unsupported');
    };

    const item = (depth: number): CborValue => {
        if (depth > 16) throw new WebAuthnError('cbor-too-deep');
        need(1);
        const head = bytes[offset++];
        const major = head >> 5;
        const info = head & 0x1f;
        switch (major) {
            case 0:
                return readLength(info);
            case 1:
                return -1 - readLength(info);
            case 2: {
                const length = readLength(info);
                need(length);
                const out = new Uint8Array(length);
                out.set(bytes.subarray(offset, offset + length));
                offset += length;
                return out;
            }
            case 3: {
                const length = readLength(info);
                need(length);
                const text = new TextDecoder().decode(bytes.subarray(offset, offset + length));
                offset += length;
                return text;
            }
            case 4: {
                const length = readLength(info);
                const out: CborValue[] = [];
                for (let i = 0; i < length; i++) out.push(item(depth + 1));
                return out;
            }
            case 5: {
                const length = readLength(info);
                const out = new Map<CborValue, CborValue>();
                for (let i = 0; i < length; i++) {
                    const key = item(depth + 1);
                    out.set(key, item(depth + 1));
                }
                return out;
            }
            case 6:
                // A tag: skip it, keep its content.
                readLength(info);
                return item(depth + 1);
            case 7:
                if (info === 20) return false;
                if (info === 21) return true;
                if (info === 22) return null;
                if (info === 23) return undefined;
                throw new WebAuthnError('cbor-unsupported');
            default:
                throw new WebAuthnError('cbor-unsupported');
        }
    };

    const value = item(0);
    return { value, end: offset };
}

// ---------- authenticator data ----------

export interface AuthenticatorData {
    rpIdHash: Bytes;
    userPresent: boolean;
    userVerified: boolean;
    signCount: number;
    credential?: { id: Bytes; publicKey: Map<CborValue, CborValue> };
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
    if (data.length < 37) throw new WebAuthnError('authenticator-data-short');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const flags = data[32];
    const parsed: AuthenticatorData = {
        rpIdHash: new Uint8Array(data.subarray(0, 32)),
        userPresent: (flags & FLAG_UP) !== 0,
        userVerified: (flags & FLAG_UV) !== 0,
        signCount: view.getUint32(33),
    };
    if (flags & FLAG_AT) {
        // aaguid (16) + credential id length (2) + credential id + COSE key
        if (data.length < 55) throw new WebAuthnError('authenticator-data-short');
        const idLength = view.getUint16(53);
        const idStart = 55;
        if (data.length < idStart + idLength) throw new WebAuthnError('authenticator-data-short');
        const id = new Uint8Array(data.subarray(idStart, idStart + idLength));
        const { value } = decodeCbor(data, idStart + idLength);
        if (!(value instanceof Map)) throw new WebAuthnError('credential-key-malformed');
        parsed.credential = { id, publicKey: value };
    }
    return parsed;
}

// ---------- COSE keys ----------

const asBytes = (value: CborValue | undefined): Bytes => {
    if (!(value instanceof Uint8Array)) throw new WebAuthnError('credential-key-malformed');
    return value;
};

/** The COSE key as a JWK Web Crypto can import, and its algorithm. */
export function coseToJwk(cose: Map<CborValue, CborValue>): { jwk: JsonWebKey; algorithm: CoseAlgorithm } {
    const kty = cose.get(1);
    const alg = cose.get(3);
    if (alg === -7 && kty === 2 && cose.get(-1) === 1) {
        return {
            algorithm: -7,
            jwk: {
                kty: 'EC',
                crv: 'P-256',
                x: base64UrlEncode(asBytes(cose.get(-2))),
                y: base64UrlEncode(asBytes(cose.get(-3))),
            },
        };
    }
    if (alg === -257 && kty === 3) {
        return {
            algorithm: -257,
            jwk: {
                kty: 'RSA',
                alg: 'RS256',
                n: base64UrlEncode(asBytes(cose.get(-1))),
                e: base64UrlEncode(asBytes(cose.get(-2))),
            },
        };
    }
    if (alg === -8 && kty === 1 && cose.get(-1) === 6) {
        return { algorithm: -8, jwk: { kty: 'OKP', crv: 'Ed25519', x: base64UrlEncode(asBytes(cose.get(-2))) } };
    }
    throw new WebAuthnError('algorithm-unsupported');
}

function importParams(algorithm: CoseAlgorithm): {
    importAlg: AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams;
    verifyAlg: AlgorithmIdentifier | EcdsaParams;
} {
    if (algorithm === -7) {
        return { importAlg: { name: 'ECDSA', namedCurve: 'P-256' }, verifyAlg: { name: 'ECDSA', hash: 'SHA-256' } };
    }
    if (algorithm === -257) {
        return {
            importAlg: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            verifyAlg: { name: 'RSASSA-PKCS1-v1_5' },
        };
    }
    return { importAlg: { name: 'Ed25519' }, verifyAlg: { name: 'Ed25519' } };
}

/** WebAuthn ECDSA signatures are ASN.1 DER; Web Crypto wants the raw 64-byte r||s. */
export function derToRawEcdsa(der: Uint8Array): Bytes {
    let offset = 0;
    const take = (expected: number) => {
        if (der[offset++] !== expected) throw new WebAuthnError('signature-malformed');
    };
    const length = () => {
        let len = der[offset++];
        if (len & 0x80) {
            const count = len & 0x7f;
            len = 0;
            for (let i = 0; i < count; i++) len = (len << 8) | der[offset++];
        }
        return len;
    };
    const integer = (): Uint8Array => {
        take(0x02);
        const len = length();
        let value = der.subarray(offset, offset + len);
        offset += len;
        while (value.length > 32 && value[0] === 0) value = value.subarray(1);
        if (value.length > 32) throw new WebAuthnError('signature-malformed');
        const out = new Uint8Array(32);
        out.set(value, 32 - value.length);
        return out;
    };
    take(0x30);
    length();
    const r = integer();
    const s = integer();
    const raw = new Uint8Array(64);
    raw.set(r, 0);
    raw.set(s, 32);
    return raw;
}

async function verifySignature(
    jwk: JsonWebKey,
    algorithm: CoseAlgorithm,
    signature: Uint8Array,
    data: Bytes,
): Promise<boolean> {
    const { importAlg, verifyAlg } = importParams(algorithm);
    const key = await crypto.subtle.importKey('jwk', jwk, importAlg, false, ['verify']);
    const sig = algorithm === -7 ? derToRawEcdsa(signature) : new Uint8Array(signature);
    return crypto.subtle.verify(verifyAlg, key, sig, data);
}

// ---------- relying party ----------

export interface RelyingParty {
    /** The host the passkeys belong to (`example.com`, `localhost`). */
    id: string;
    /** The exact origin the browser runs at (`https://example.com`). */
    origin: string;
    /** Shown by the browser when a passkey is created. */
    name: string;
}

/**
 * The relying party for AUTH_URL, or null where passkeys cannot work: browsers refuse an IP
 * address as a relying-party id, so a dev app opened at 127.0.0.1 has no passkeys (open it at
 * localhost instead), and anything but https (or http on localhost) is not a secure context.
 */
export function relyingPartyFor(authUrl: string, name: string): RelyingParty | null {
    let url: URL;
    try {
        url = new URL(authUrl);
    } catch {
        return null;
    }
    const host = url.hostname;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
    if (isIp) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && host === 'localhost')) return null;
    return { id: host, origin: url.origin, name };
}

export function newChallenge(): string {
    return base64UrlEncode(randomBytes(32));
}

/** What `navigator.credentials` returned, as JSON (base64url for every binary field). */
export interface RegistrationResponseJSON {
    id: string;
    rawId?: string;
    type: string;
    response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export interface AuthenticationResponseJSON {
    id: string;
    rawId?: string;
    type: string;
    response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

/** The challenge a response's client data carries, before anything is verified (to find the stored one). */
export function readChallenge(clientDataJSON: unknown): string | null {
    if (typeof clientDataJSON !== 'string') return null;
    try {
        const data = JSON.parse(new TextDecoder().decode(base64UrlDecode(clientDataJSON))) as { challenge?: unknown };
        return typeof data.challenge === 'string' && data.challenge.length > 0 && data.challenge.length <= 128
            ? data.challenge
            : null;
    } catch {
        return null;
    }
}

interface ClientData {
    type: string;
    challenge: string;
    origin: string;
    crossOrigin?: boolean;
}

function readClientData(encoded: string, type: string, rp: RelyingParty): { data: ClientData; raw: Bytes } {
    let raw: Bytes;
    let data: ClientData;
    try {
        raw = base64UrlDecode(encoded);
        data = JSON.parse(new TextDecoder().decode(raw)) as ClientData;
    } catch {
        throw new WebAuthnError('client-data-malformed');
    }
    if (data.type !== type) throw new WebAuthnError('client-data-type');
    if (data.origin !== rp.origin) throw new WebAuthnError('origin-mismatch');
    if (data.crossOrigin === true) throw new WebAuthnError('cross-origin');
    if (typeof data.challenge !== 'string' || !data.challenge) throw new WebAuthnError('challenge-missing');
    return { data, raw };
}

async function sha256(bytes: Bytes): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function checkRpIdHash(authData: AuthenticatorData, rp: RelyingParty): Promise<void> {
    const expected = await sha256(new TextEncoder().encode(rp.id));
    if (base64UrlEncode(expected) !== base64UrlEncode(authData.rpIdHash)) throw new WebAuthnError('rp-mismatch');
}

export interface VerifiedRegistration {
    credentialId: string;
    publicKey: JsonWebKey;
    algorithm: CoseAlgorithm;
    counter: number;
    transports: string[];
}

/**
 * Check a new passkey. `challenge` is the one this server issued (already consumed by the
 * caller, so it is single-use). Throws `WebAuthnError` with a reason code on any mismatch.
 */
export async function verifyRegistration(
    response: RegistrationResponseJSON,
    rp: RelyingParty,
    challenge: string,
): Promise<VerifiedRegistration> {
    if (response?.type !== 'public-key' || !response.response) throw new WebAuthnError('response-malformed');
    const { data } = readClientData(response.response.clientDataJSON, 'webauthn.create', rp);
    if (data.challenge !== challenge) throw new WebAuthnError('challenge-mismatch');

    const { value } = decodeCbor(base64UrlDecode(response.response.attestationObject));
    if (!(value instanceof Map)) throw new WebAuthnError('attestation-malformed');
    const authData = parseAuthenticatorData(asBytes(value.get('authData')));
    await checkRpIdHash(authData, rp);
    if (!authData.userPresent) throw new WebAuthnError('user-not-present');
    if (!authData.credential) throw new WebAuthnError('credential-missing');

    const { jwk, algorithm } = coseToJwk(authData.credential.publicKey);
    // Import now: a key Web Crypto refuses must fail here, not at the first sign-in.
    await crypto.subtle.importKey('jwk', jwk, importParams(algorithm).importAlg, false, ['verify']);

    const credentialId = base64UrlEncode(authData.credential.id);
    if (response.id && response.id !== credentialId) throw new WebAuthnError('credential-id-mismatch');
    const transports = Array.isArray(response.response.transports)
        ? response.response.transports.filter((t): t is string => typeof t === 'string').slice(0, 8)
        : [];
    return { credentialId, publicKey: jwk, algorithm, counter: authData.signCount, transports };
}

/**
 * Check a sign-in assertion against the stored passkey. Requires user verification (the
 * fingerprint, face or PIN), which is what lets a passkey stand in for a password AND a code.
 * Returns the authenticator's new signature counter.
 */
export async function verifyAuthentication(
    response: AuthenticationResponseJSON,
    rp: RelyingParty,
    challenge: string,
    stored: { publicKey: JsonWebKey; algorithm: CoseAlgorithm; counter: number },
): Promise<{ counter: number }> {
    if (response?.type !== 'public-key' || !response.response) throw new WebAuthnError('response-malformed');
    const { data, raw } = readClientData(response.response.clientDataJSON, 'webauthn.get', rp);
    if (data.challenge !== challenge) throw new WebAuthnError('challenge-mismatch');

    const authDataBytes = base64UrlDecode(response.response.authenticatorData);
    const authData = parseAuthenticatorData(authDataBytes);
    await checkRpIdHash(authData, rp);
    if (!authData.userPresent) throw new WebAuthnError('user-not-present');
    if (!authData.userVerified) throw new WebAuthnError('user-not-verified');

    const signed = new Uint8Array(authDataBytes.length + 32);
    signed.set(authDataBytes, 0);
    signed.set(await sha256(raw), authDataBytes.length);
    const ok = await verifySignature(
        stored.publicKey,
        stored.algorithm,
        base64UrlDecode(response.response.signature),
        signed,
    );
    if (!ok) throw new WebAuthnError('signature-invalid');

    // A counter that does not move forward means a cloned authenticator. Synced passkeys report 0
    // every time, which is fine: only a nonzero counter going backwards is refused.
    if (authData.signCount !== 0 || stored.counter !== 0) {
        if (authData.signCount <= stored.counter) throw new WebAuthnError('counter-replayed');
    }
    return { counter: authData.signCount };
}
