import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable stand-in for REFERRALS_CONFIG so each test can vary the configured key.
const { cfg } = vi.hoisted(() => ({
    cfg: { enabled: true, trackClicks: true, expiryDays: 90, referralParam: 'ref' } as {
        enabled: boolean;
        trackClicks: boolean;
        expiryDays: number;
        referralParam?: string;
    },
}));

vi.mock('@/ottabase/config', () => ({ REFERRALS_CONFIG: cfg }));
// referrals.ts imports './api' at module load; we never exercise it here.
vi.mock('../api', () => ({ api: vi.fn() }));

import {
    buildReferralLink,
    clearStoredReferralCode,
    getReferralParamKey,
    getStoredReferralCode,
    storeReferralCode,
} from '../referrals';

afterEach(() => {
    cfg.referralParam = 'ref';
});

describe('referral param client helpers', () => {
    describe('getReferralParamKey', () => {
        it('defaults to "ref"', () => {
            expect(getReferralParamKey()).toBe('ref');
        });

        it('honors a configured key', () => {
            cfg.referralParam = 'invite';
            expect(getReferralParamKey()).toBe('invite');
        });

        it('falls back to "ref" when the config value is missing', () => {
            cfg.referralParam = undefined;
            expect(getReferralParamKey()).toBe('ref');
        });
    });

    describe('buildReferralLink', () => {
        it('builds the short /r/ link (the worker 302s it to the configured param)', () => {
            cfg.referralParam = 'invite';
            expect(buildReferralLink('john', 'https://app.example.com')).toBe('https://app.example.com/r/john');
        });

        it('url-encodes the username', () => {
            expect(buildReferralLink('a b', 'https://x.com')).toBe('https://x.com/r/a%20b');
        });
    });
});

describe('stored referral code', () => {
    const KEY = 'ottabase.referral';
    const DAY = 24 * 60 * 60 * 1000;

    beforeEach(() => {
        localStorage.clear();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('stores one JSON record { code, storedAt } and reads the code back', () => {
        storeReferralCode('alice');
        const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
        expect(stored).toEqual({ code: 'alice', storedAt: expect.any(Number) });
        expect(getStoredReferralCode()).toBe('alice');
    });

    it('keeps the first touch', () => {
        storeReferralCode('alice');
        storeReferralCode('bob');
        expect(getStoredReferralCode()).toBe('alice');
    });

    it('drops an expired code from storage', () => {
        localStorage.setItem(KEY, JSON.stringify({ code: 'old', storedAt: Date.now() - (cfg.expiryDays + 1) * DAY }));
        expect(getStoredReferralCode()).toBeNull();
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('reads a malformed value as no code, and clear removes the key', () => {
        localStorage.setItem(KEY, 'alice');
        expect(getStoredReferralCode()).toBeNull();
        localStorage.setItem(KEY, JSON.stringify({ code: 'alice' }));
        expect(getStoredReferralCode()).toBeNull();

        storeReferralCode('carol');
        clearStoredReferralCode();
        expect(localStorage.getItem(KEY)).toBeNull();
    });
});
