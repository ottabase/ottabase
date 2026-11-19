/**
 * Client-side referral tracking utilities
 *
 * Handles referral code storage, expiry, and tracking.
 */

import { REFERRALS_CONFIG } from '@/ottabase/config';
import { getStorageValue, setStorageValue } from '@ottabase/ui';
import { api } from './api';

// Local storage key: the first-touch code and when it was stored
const REFERRAL_KEY = 'ottabase.referral';

interface StoredReferral {
    code: string;
    storedAt: number;
}

function readStoredReferral(): StoredReferral | null {
    const stored = getStorageValue<StoredReferral | null>(REFERRAL_KEY, null);
    return stored && typeof stored.code === 'string' && typeof stored.storedAt === 'number' ? stored : null;
}

/**
 * URL query-param key that carries an inbound referral code (e.g. `ref` in
 * `?ref=johndoe`). Configurable via `features.referrals.referralParam` in
 * ottabase.config.ts (or the REFERRAL_PARAM env var); falls back to `ref`.
 */
export function getReferralParamKey(): string {
    return REFERRALS_CONFIG?.referralParam || 'ref';
}

// Calculate expiry based on config (with fallback)
const getReferralExpiryMs = () => {
    try {
        return (REFERRALS_CONFIG?.expiryDays || 90) * 24 * 60 * 60 * 1000;
    } catch {
        return 90 * 24 * 60 * 60 * 1000; // Default to 90 days
    }
};

/**
 * Check if a referral timestamp has expired based on app config
 */
function isReferralExpired(timestamp: number): boolean {
    return Date.now() - timestamp > getReferralExpiryMs();
}

/**
 * Get the stored referral code (if valid and not expired)
 */
export function getStoredReferralCode(): string | null {
    const stored = readStoredReferral();
    if (!stored) return null;

    // Check if expired
    if (isReferralExpired(stored.storedAt)) {
        clearStoredReferralCode();
        return null;
    }

    return stored.code;
}

/**
 * Store a referral code in local storage
 */
export function storeReferralCode(code: string): void {
    // Only store if there's no existing code (first-touch wins)
    const existing = getStoredReferralCode();
    if (existing) {
        console.log('Referral code already stored (first-touch wins):', existing);
        return;
    }

    setStorageValue<StoredReferral>(REFERRAL_KEY, { code, storedAt: Date.now() });
    console.log('Stored referral code:', code);
}

/**
 * Clear stored referral code
 */
export function clearStoredReferralCode(): void {
    setStorageValue(REFERRAL_KEY, undefined);
}

/**
 * Track a referral click (sends to API)
 */
export async function trackReferralClick(referralCode: string, meta?: Record<string, any>): Promise<boolean> {
    try {
        const response = await api<{ success: boolean }>('/api/referrals/track', {
            method: 'POST',
            body: {
                referralCode,
                referer: typeof document !== 'undefined' ? document.referrer : undefined,
                meta: {
                    ...meta,
                    utm: extractUtmParams(),
                },
            },
        });

        if (!response || (response as any).success === false) {
            console.error('Failed to track referral: API returned failure');
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error tracking referral:', error);
        return false;
    }
}

/**
 * Extract UTM parameters from URL
 */
export function extractUtmParams(): Record<string, string> {
    if (typeof window === 'undefined') return {};

    try {
        const params = new URLSearchParams(window.location.search);
        const utm: Record<string, string> = {};

        const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

        utmKeys.forEach((key) => {
            const value = params.get(key);
            if (value) {
                utm[key] = value;
            }
        });

        return utm;
    } catch (error) {
        console.error('Error extracting UTM params:', error);
        return {};
    }
}

/**
 * Remove the referral parameter from the URL (clean URL)
 */
export function cleanReferralFromUrl(): void {
    if (typeof window === 'undefined') return;

    try {
        const paramKey = getReferralParamKey();
        const url = new URL(window.location.href);
        if (url.searchParams.has(paramKey)) {
            url.searchParams.delete(paramKey);
            window.history.replaceState({}, '', url.toString());
        }
    } catch (error) {
        console.error('Error cleaning referral from URL:', error);
    }
}

/**
 * Build the shareable referral link: `/r/{username}`, which the worker 302s to
 * `/?{referralParam}={username}`.
 */
export function buildReferralLink(referralUsername: string, origin?: string): string {
    const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
    return `${base}/r/${encodeURIComponent(referralUsername)}`;
}

/**
 * Get referral expiry info
 */
export function getReferralExpiryInfo(): {
    expiresAt: Date | null;
    daysRemaining: number | null;
    isExpired: boolean;
} {
    const stored = readStoredReferral();

    if (!stored) {
        return {
            expiresAt: null,
            daysRemaining: null,
            isExpired: false,
        };
    }

    const timestampNum = stored.storedAt;
    const expiresAt = new Date(timestampNum + getReferralExpiryMs());
    const daysRemaining = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const expired = isReferralExpired(timestampNum);

    return {
        expiresAt,
        daysRemaining: expired ? 0 : Math.max(0, daysRemaining),
        isExpired: expired,
    };
}
