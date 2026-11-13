/** A header value without its comments `( … )` and quoted strings: nothing inside either can pose as a result. One pass. */
function withoutCommentsAndQuotes(value: string): string {
    let out = '';
    let depth = 0;
    let quoted = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i]!;
        if ((depth || quoted) && char === '\\') i++;
        else if (quoted) quoted = char !== '"';
        else if (depth) depth += char === '(' ? 1 : char === ')' ? -1 : 0;
        else if (char === '"') quoted = true;
        else if (char === '(') {
            depth = 1;
            out += ' ';
        } else out += char;
    }
    return out;
}

/**
 * The receiving server (`authservId`) vouches for the From address: its first `dmarc=` result
 * is `pass` with `header.from` the From's own domain. Pass an inbound mail's `edgeHeaders`: only
 * what sits above the topmost `Received` line, which every hop prepends, so nothing the sender
 * wrote is there. The verdict is its `ARC-Authentication-Results` (Cloudflare Email Routing
 * prepends an ARC set to every mail it receives), else its `Authentication-Results`. Anything
 * else (no verdict, another server's, `dmarc=none`, a softfail, another domain) proves nothing
 * about the From. Never read the verdict from `headers`: the sender writes those.
 */
export function passesDmarc(
    edgeHeaders: Record<string, string>,
    authservId: string,
    fromAddress: string | null | undefined,
): boolean {
    const arc = edgeHeaders['arc-authentication-results'];
    const value = arc ?? edgeHeaders['authentication-results'];
    if (!value || !fromAddress?.includes('@')) return false;
    const parts = withoutCommentsAndQuotes(value)
        .toLowerCase()
        .split(';')
        .map((part) => part.trim());
    if (arc !== undefined && !/^i=\d+$/.test(parts.shift() ?? '')) return false;
    if ((parts.shift() ?? '').split(/\s+/)[0] !== authservId.toLowerCase()) return false;
    const [result, ...properties] = (parts.find((part) => part.startsWith('dmarc=')) ?? '').split(/\s+/);
    const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1).toLowerCase();
    return result === 'dmarc=pass' && properties.includes(`header.from=${domain}`);
}
