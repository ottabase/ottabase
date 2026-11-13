import type { Mailer, SendEmailInput } from '../types';
import { formatAddress, normalizeAddressList } from '../address';

export interface ResendMailerOptions {
    apiKey: string;
    baseUrl?: string;
}

const DEFAULT_RESEND_BASE_URL = 'https://api.resend.com';

/**
 * Resend takes `{ name, value }`, both required and both limited to ASCII letters, digits, `_`
 * and `-` (anything else is a 422 that fails the send). `kind:id` becomes name and value; a bare
 * tag is a flag.
 */
function resendTag(tag: string): { name: string; value: string } {
    const clean = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 256);
    const at = tag.indexOf(':');
    return at > 0
        ? { name: clean(tag.slice(0, at)), value: clean(tag.slice(at + 1)) || 'true' }
        : { name: clean(tag) || 'tag', value: 'true' };
}

function removeUndefined<T extends Record<string, unknown>>(payload: T) {
    const cleaned = {} as T;
    for (const key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
            const value = payload[key];
            if (value !== undefined) {
                cleaned[key] = value;
            }
        }
    }
    return cleaned;
}

export function createResendMailer(options: ResendMailerOptions): Mailer {
    const provider = 'resend';
    const baseUrl = options.baseUrl ?? DEFAULT_RESEND_BASE_URL;

    return {
        provider,
        async send(input: SendEmailInput) {
            try {
                const payload = removeUndefined({
                    from: formatAddress(input.from),
                    to: normalizeAddressList(input.to),
                    subject: input.subject,
                    html: input.html,
                    text: input.text,
                    cc: normalizeAddressList(input.cc),
                    bcc: normalizeAddressList(input.bcc),
                    reply_to: input.replyTo ? formatAddress(input.replyTo) : undefined,
                    headers: input.headers,
                    tags: input.tags?.map(resendTag),
                });

                const response = await fetch(`${baseUrl}/emails`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${options.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });

                const json: unknown = await response.json().catch(() => null);
                const data = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;

                if (!response.ok) {
                    return {
                        provider,
                        success: false,
                        error:
                            (typeof data?.message === 'string' && data.message) ||
                            `Resend request failed (${response.status})`,
                        raw: json,
                    };
                }

                return {
                    provider,
                    success: true,
                    id: typeof data?.id === 'string' ? data.id : undefined,
                    raw: json,
                };
            } catch (error) {
                return {
                    provider,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    };
}
