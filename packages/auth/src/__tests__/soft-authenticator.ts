// A software passkey for tests: makes credentials and signs assertions the way a browser's
// authenticator does (attestation "none", CBOR attestation object, DER ECDSA signatures).
// It shares no code with ../webauthn.ts: its CBOR encoder and DER writer are its own, so a
// round trip checks the verifier against an independent encoder, not against itself.

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '../webauthn';

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, length: number): number[] {
    if (length < 24) return [(major << 5) | length];
    if (length < 256) return [(major << 5) | 24, length];
    if (length < 65536) return [(major << 5) | 25, length >> 8, length & 255];
    return [(major << 5) | 26, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255];
}

export function encodeCbor(value: Cbor): Uint8Array {
    if (typeof value === 'number') {
        return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value));
    }
    if (typeof value === 'string') {
        const bytes = new TextEncoder().encode(value);
        return concat(new Uint8Array(head(3, bytes.length)), bytes);
    }
    if (value instanceof Uint8Array) return concat(new Uint8Array(head(2, value.length)), value);
    const parts: Uint8Array[] = [new Uint8Array(head(5, value.size))];
    for (const [key, item] of value) parts.push(encodeCbor(key), encodeCbor(item));
    return concat(...parts);
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export const b64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

const fromB64url = (value: string): Uint8Array =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Raw r||s (what Web Crypto signs) to the ASN.1 DER an authenticator sends. */
function rawToDer(raw: Uint8Array): Uint8Array {
    const int = (bytes: Uint8Array) => {
        let start = 0;
        while (start < bytes.length - 1 && bytes[start] === 0) start++;
        let body = bytes.subarray(start);
        if (body[0] & 0x80) body = concat(new Uint8Array([0]), body);
        return concat(new Uint8Array([0x02, body.length]), body);
    };
    const r = int(raw.subarray(0, 32));
    const s = int(raw.subarray(32));
    return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

/** ES256, EdDSA (Ed25519), RS256: the COSE algorithms the relying party accepts. */
export type SoftAlgorithm = -7 | -8 | -257;

const KEY_PARAMS: Record<SoftAlgorithm, EcKeyGenParams | RsaHashedKeyGenParams | Algorithm> = {
    [-7]: { name: 'ECDSA', namedCurve: 'P-256' },
    [-8]: { name: 'Ed25519' },
    [-257]: {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
    },
};

const SIGN_PARAMS: Record<SoftAlgorithm, AlgorithmIdentifier | EcdsaParams> = {
    [-7]: { name: 'ECDSA', hash: 'SHA-256' },
    [-8]: { name: 'Ed25519' },
    [-257]: { name: 'RSASSA-PKCS1-v1_5' },
};

export interface SoftPasskey {
    credentialId: Uint8Array;
    algorithm: SoftAlgorithm;
    privateKey: CryptoKey;
    counter: number;
    userHandle: string;
}

export interface ClientContext {
    rpId: string;
    origin: string;
}

export async function createPasskey(
    ctx: ClientContext,
    challenge: string,
    options: { algorithm?: SoftAlgorithm; userHandle?: string; type?: string; userVerified?: boolean } = {},
): Promise<{ passkey: SoftPasskey; response: RegistrationResponseJSON }> {
    const algorithm = options.algorithm ?? -7;
    const pair = (await crypto.subtle.generateKey(KEY_PARAMS[algorithm], true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const cose =
        algorithm === -7
            ? new Map<number, Cbor>([
                  [1, 2],
                  [3, -7],
                  [-1, 1],
                  [-2, fromB64url(jwk.x!)],
                  [-3, fromB64url(jwk.y!)],
              ])
            : algorithm === -257
              ? new Map<number, Cbor>([
                    [1, 3],
                    [3, -257],
                    [-1, fromB64url(jwk.n!)],
                    [-2, fromB64url(jwk.e!)],
                ])
              : new Map<number, Cbor>([
                    [1, 1],
                    [3, -8],
                    [-1, 6],
                    [-2, fromB64url(jwk.x!)],
                ]);
    const credentialId = crypto.getRandomValues(new Uint8Array(16));
    const authData = concat(
        await sha256(new TextEncoder().encode(ctx.rpId)),
        new Uint8Array([options.userVerified === false ? 0x41 : 0x45]), // UP | (UV) | AT
        new Uint8Array([0, 0, 0, 0]),
        new Uint8Array(16),
        new Uint8Array([0, credentialId.length]),
        credentialId,
        encodeCbor(cose),
    );
    const attestationObject = encodeCbor(
        new Map<string, Cbor>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
        ]),
    );
    const clientData = JSON.stringify({
        type: options.type ?? 'webauthn.create',
        challenge,
        origin: ctx.origin,
        crossOrigin: false,
    });
    return {
        passkey: {
            credentialId,
            algorithm,
            privateKey: pair.privateKey,
            counter: 0,
            userHandle: options.userHandle ?? '',
        },
        response: {
            id: b64url(credentialId),
            rawId: b64url(credentialId),
            type: 'public-key',
            response: {
                clientDataJSON: b64url(new TextEncoder().encode(clientData)),
                attestationObject: b64url(attestationObject),
                transports: ['internal'],
            },
        },
    };
}

export async function signIn(
    passkey: SoftPasskey,
    ctx: ClientContext,
    challenge: string,
    options: { userVerified?: boolean; counter?: number; origin?: string } = {},
): Promise<AuthenticationResponseJSON> {
    const counter = options.counter ?? passkey.counter;
    const authData = concat(
        await sha256(new TextEncoder().encode(ctx.rpId)),
        new Uint8Array([options.userVerified === false ? 0x01 : 0x05]),
        new Uint8Array([(counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255]),
    );
    const clientData = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.get', challenge, origin: options.origin ?? ctx.origin }),
    );
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(await crypto.subtle.sign(SIGN_PARAMS[passkey.algorithm], passkey.privateKey, signed));
    return {
        id: b64url(passkey.credentialId),
        rawId: b64url(passkey.credentialId),
        type: 'public-key',
        response: {
            clientDataJSON: b64url(clientData),
            authenticatorData: b64url(authData),
            signature: b64url(passkey.algorithm === -7 ? rawToDer(raw) : raw),
            userHandle: passkey.userHandle || null,
        },
    };
}
