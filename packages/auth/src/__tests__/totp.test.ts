import { describe, expect, it } from 'vitest';
import {
    base32Decode,
    base32Encode,
    generateTotpSecret,
    hotp,
    matchTotpStep,
    openSecret,
    sealSecret,
    totpStep,
    totpUri,
} from '../totp';

// The shared secret of both RFCs' appendices: ASCII "12345678901234567890".
const RFC_SECRET = new TextEncoder().encode('12345678901234567890') as Uint8Array<ArrayBuffer>;

describe('HOTP (RFC 4226, appendix D)', () => {
    it('produces the published code for counters 0 to 9', async () => {
        const expected = [
            '755224',
            '287082',
            '359152',
            '969429',
            '338314',
            '254676',
            '287922',
            '162583',
            '399871',
            '520489',
        ];
        for (let counter = 0; counter < expected.length; counter++) {
            expect(await hotp(RFC_SECRET, counter)).toBe(expected[counter]);
        }
    });
});

describe('TOTP (RFC 6238, appendix B, SHA-1)', () => {
    it.each([
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130'],
    ])('at %i seconds the 8-digit code is %s', async (seconds, code) => {
        expect(await hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
    });
});

describe('matchTotpStep', () => {
    const secret = base32Encode(RFC_SECRET);
    const at = 1_700_000_000_000;

    it('accepts the current step and one either side, and names the step', async () => {
        const now = totpStep(at);
        for (const step of [now - 1, now, now + 1]) {
            expect(await matchTotpStep(secret, await hotp(RFC_SECRET, step), at)).toBe(step);
        }
    });

    it('refuses a code two steps away, malformed input, and tolerates spaces', async () => {
        const now = totpStep(at);
        expect(await matchTotpStep(secret, await hotp(RFC_SECRET, now - 2), at)).toBeNull();
        expect(await matchTotpStep(secret, '12345', at)).toBeNull();
        expect(await matchTotpStep(secret, 'abcdef', at)).toBeNull();
        const code = await hotp(RFC_SECRET, now);
        expect(await matchTotpStep(secret, `${code.slice(0, 3)} ${code.slice(3)}`, at)).toBe(now);
    });
});

describe('base32 and secrets', () => {
    it('round-trips bytes and matches the RFC 4648 vector', () => {
        expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
        const bytes = crypto.getRandomValues(new Uint8Array(20));
        expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    });

    it('makes 160-bit secrets an app accepts', () => {
        const secret = generateTotpSecret();
        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(base32Decode(secret)).toHaveLength(20);
    });

    it('builds the otpauth address with issuer and account escaped', () => {
        const uri = totpUri({ secret: 'ABC', account: 'ana@example.com', issuer: 'Acme Inc' });
        expect(uri).toBe(
            'otpauth://totp/Acme%20Inc:ana%40example.com?secret=ABC&issuer=Acme+Inc&algorithm=SHA1&digits=6&period=30',
        );
    });

    it('seals a secret so only the same AUTH_SECRET opens it', async () => {
        const sealed = await sealSecret('secret-one-at-least-32-characters!!', 'JBSWY3DPEHPK3PXP');
        expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
        expect(await openSecret('secret-one-at-least-32-characters!!', sealed)).toBe('JBSWY3DPEHPK3PXP');
        await expect(openSecret('secret-two-at-least-32-characters!!', sealed)).rejects.toThrow();
    });
});
