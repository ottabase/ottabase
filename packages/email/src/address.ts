import type { EmailAddress } from './types';

/** Characters that end or split a display name in an address list unless it is quoted (RFC 5322 specials). */
const SPECIALS = /[()<>[\]:;@\\,."]/;
/** One mailbox and nothing else: no space, bracket, comma, quote or control character. */
const ADDR_SPEC = /^[^\s<>,;"()\\@\u0000-\u001f\u007f]+@[^\s<>,;"()\\@\u0000-\u001f\u007f]+$/;

/**
 * `Name <email>` for a provider. A name holding a special is quoted, so "Acme, Inc." stays one
 * recipient and a name such as `x <victim@example.com>, y` cannot add one. Line breaks never
 * reach a header.
 */
export function formatAddress(address: EmailAddress): string {
    // A bare string may already be `Name <email>`; it only loses its line breaks.
    if (typeof address === 'string') return address.replace(/[\r\n]+/g, ' ');
    // The email half is not a place for a second recipient (`a@b.com>, evil@c.com`) or a header.
    if (!ADDR_SPEC.test(address.email)) throw new Error('Invalid email address');
    const name = address.name
        // No control character reaches a header; a line break becomes a space.
        ?.replace(/[\r\n]+/g, ' ')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        // A name that arrives already quoted is unwrapped first, so it is not quoted twice.
        .replace(/^"(.*)"$/, '$1')
        .replace(/\\(["\\])/g, '$1');
    if (!name) return address.email;
    const shown = SPECIALS.test(name) ? `"${name.replace(/[\\"]/g, '\\$&')}"` : name;
    return `${shown} <${address.email}>`;
}

export function normalizeAddressList(address?: EmailAddress | EmailAddress[]): string[] | undefined {
    if (!address) return undefined;
    return (Array.isArray(address) ? address : [address]).map(formatAddress);
}
