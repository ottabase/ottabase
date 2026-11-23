import { describe, expect, it } from 'vitest';
import {
    decodeCbor,
    derToRawEcdsa,
    relyingPartyFor,
    verifyAuthentication,
    verifyRegistration,
    type RelyingParty,
} from '../webauthn';
import { createPasskey, encodeCbor, signIn, type SoftAlgorithm } from './soft-authenticator';

// The software authenticator in ./soft-authenticator.ts has its own CBOR encoder and DER writer,
// so these round trips check the verifier against independent code. They are not a browser: the
// end-to-end proof with a real authenticator is manual (see the package README).

const rp: RelyingParty = { id: 'app.example.com', origin: 'https://app.example.com', name: 'Example' };
const ctx = { rpId: rp.id, origin: rp.origin };

async function registered(algorithm: SoftAlgorithm = -7) {
    const { passkey, response } = await createPasskey(ctx, 'reg-challenge', { algorithm });
    const verified = await verifyRegistration(response, rp, 'reg-challenge');
    return { passkey, verified };
}

describe('relyingPartyFor', () => {
    it('takes the host and origin of AUTH_URL', () => {
        expect(relyingPartyFor('https://app.example.com/', 'Example')).toEqual(rp);
        expect(relyingPartyFor('http://localhost:3003', 'Dev')).toEqual({
            id: 'localhost',
            origin: 'http://localhost:3003',
            name: 'Dev',
        });
    });

    it('has no passkeys on an IP address or plain http off localhost', () => {
        expect(relyingPartyFor('http://127.0.0.1:3003', 'Dev')).toBeNull();
        expect(relyingPartyFor('http://[::1]:3003', 'Dev')).toBeNull();
        expect(relyingPartyFor('http://app.example.com', 'Dev')).toBeNull();
        expect(relyingPartyFor('not a url', 'Dev')).toBeNull();
    });
});

describe('CBOR and DER', () => {
    it('decodes maps, negative keys, byte and text strings', () => {
        const encoded = encodeCbor(
            new Map<number | string, never>([
                [1, 2 as never],
                [-3, new Uint8Array([1, 2, 3]) as never],
                ['fmt', 'none' as never],
            ]),
        );
        const { value } = decodeCbor(encoded);
        expect(value).toBeInstanceOf(Map);
        const map = value as Map<unknown, unknown>;
        expect(map.get(1)).toBe(2);
        expect([...(map.get(-3) as Uint8Array)]).toEqual([1, 2, 3]);
        expect(map.get('fmt')).toBe('none');
    });

    it('refuses truncated input and indefinite lengths', () => {
        expect(() => decodeCbor(new Uint8Array([0x43, 1]))).toThrow('cbor-truncated');
        expect(() => decodeCbor(new Uint8Array([0x5f]))).toThrow('cbor-unsupported');
    });

    it('turns a DER signature with padded integers into 64 raw bytes', () => {
        const r = new Uint8Array(32).fill(0x81);
        const s = new Uint8Array(32).fill(0x01);
        const der = new Uint8Array([0x30, 69, 0x02, 33, 0, ...r, 0x02, 32, ...s]);
        const raw = derToRawEcdsa(der);
        expect([...raw.subarray(0, 32)]).toEqual([...r]);
        expect([...raw.subarray(32)]).toEqual([...s]);
    });
});

describe('verifyRegistration', () => {
    it('accepts an ES256, an Ed25519 and an RS256 passkey and keeps a JWK', async () => {
        for (const algorithm of [-7, -8, -257] as const) {
            const { verified } = await registered(algorithm);
            expect(verified.algorithm).toBe(algorithm);
            expect(verified.publicKey.kty).toBe({ [-7]: 'EC', [-8]: 'OKP', [-257]: 'RSA' }[algorithm]);
            expect(verified.transports).toEqual(['internal']);
            expect(verified.counter).toBe(0);
        }
    });

    it('refuses another challenge, another origin, another relying party, a get response', async () => {
        const { response } = await createPasskey(ctx, 'reg-challenge');
        await expect(verifyRegistration(response, rp, 'other')).rejects.toThrow('challenge-mismatch');
        await expect(
            verifyRegistration(response, { ...rp, origin: 'https://evil.example' }, 'reg-challenge'),
        ).rejects.toThrow('origin-mismatch');
        const elsewhere = await createPasskey({ rpId: 'evil.example', origin: rp.origin }, 'reg-challenge');
        await expect(verifyRegistration(elsewhere.response, rp, 'reg-challenge')).rejects.toThrow('rp-mismatch');
        const wrongType = await createPasskey(ctx, 'reg-challenge', { type: 'webauthn.get' });
        await expect(verifyRegistration(wrongType.response, rp, 'reg-challenge')).rejects.toThrow('client-data-type');
    });

    it('refuses a passkey made without user verification', async () => {
        const { response } = await createPasskey(ctx, 'reg-challenge', { userVerified: false });
        await expect(verifyRegistration(response, rp, 'reg-challenge')).rejects.toThrow('user-not-verified');
    });
});

describe('verifyAuthentication', () => {
    it('accepts a signature from the registered key, for ES256, Ed25519 and RS256', async () => {
        for (const algorithm of [-7, -8, -257] as const) {
            const { passkey, verified } = await registered(algorithm);
            const assertion = await signIn(passkey, ctx, 'sign-challenge');
            await expect(
                verifyAuthentication(assertion, rp, 'sign-challenge', { ...verified, counter: 0 }),
            ).resolves.toEqual({ counter: 0 });
        }
    });

    it('refuses another key, no user verification, another origin, a replayed counter', async () => {
        const { passkey, verified } = await registered();
        const other = await registered();

        const byOther = await signIn(other.passkey, ctx, 'c');
        await expect(verifyAuthentication(byOther, rp, 'c', { ...verified, counter: 0 })).rejects.toThrow(
            'signature-invalid',
        );

        const noUv = await signIn(passkey, ctx, 'c', { userVerified: false });
        await expect(verifyAuthentication(noUv, rp, 'c', { ...verified, counter: 0 })).rejects.toThrow(
            'user-not-verified',
        );

        const phished = await signIn(passkey, ctx, 'c', { origin: 'https://app-example.com' });
        await expect(verifyAuthentication(phished, rp, 'c', { ...verified, counter: 0 })).rejects.toThrow(
            'origin-mismatch',
        );

        const counted = await signIn(passkey, ctx, 'c', { counter: 7 });
        await expect(verifyAuthentication(counted, rp, 'c', { ...verified, counter: 6 })).resolves.toEqual({
            counter: 7,
        });
        await expect(verifyAuthentication(counted, rp, 'c', { ...verified, counter: 7 })).rejects.toThrow(
            'counter-replayed',
        );
    });
});
