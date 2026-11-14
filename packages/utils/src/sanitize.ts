import createDOMPurify from 'dompurify';
import { imageSources, isStoredFile } from './media';

type SanitizeConfig = Record<string, unknown>;
type ProcessLike = {
    versions?: {
        node?: unknown;
    };
};

const EMPTY_STRING = '';
// What is left once whole `<script>…</script>` and `<style>…</style>` elements are gone: an
// opening tag never closed (`<script src=…>`), a stray closing one, and the tags that load, run
// or animate something on their own (SVG `<animate>` / `<set>` can write a `javascript:` href).
// The `>` is optional: a tag cut off at the end of the text is closed by whatever follows it.
const ACTIVE_TAG_PATTERN =
    /<\/?(?:script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|frame|frameset|applet|noscript|template|animate|animatemotion|animatetransform|set)\b[^>]*>?/gi;
// An attribute name the rebuilt tag may carry; anything stranger is dropped with its value.
const PLAIN_ATTR_NAME = /^[a-z_:][\w:.-]*$/i;
// A whole document in an attribute: it would need sanitizing of its own.
const DROPPED_ATTR_NAMES = new Set(['srcdoc']);
// Where something is cut out, a space goes in: with nothing there, the two sides of the cut can
// join into a tag (`<scr<iframe>ipt>` would become `<script>`).
const CUT = ' ';
// The attribute part stops at the next `<` (a rebuilt value never holds one): without that, text
// full of `</a ` and no `>` is scanned to its end from every one of them.
const HTML_TAG_PATTERN = /<\/?([a-z][a-z0-9:-]*)(\s[^<>]*)?>/gi;
const PLAIN_TAG_NAME = /^[a-z][a-z0-9:-]*$/i;
const ATTRIBUTE_PATTERN = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
const JSON_SCRIPT_ESCAPE_PATTERN = /[<>&\u2028\u2029]/g;
const CSS_DANGEROUS_CONTENT_PATTERN = /<script|<\/style|expression\s*\(|url\((\s*['"]?)\s*javascript:/i;
const CSS_STYLE_BREAKOUT_PATTERN = /<\/style/gi;
const CSS_EXPRESSION_PATTERN = /expression\s*\(/gi;
// Bounded runs: an open-ended one rescans the rest of the text from each `url(` that never closes.
const CSS_JS_URL_PATTERN = /url\((\s{0,64}['"]?)\s{0,64}javascript:[^)]{0,2048}\)?/gi;
const JSON_SCRIPT_ESCAPE_MAP: Record<string, string> = {
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
};
const NULL_JSON_LITERAL = 'null';
const SAFE_LINK_ATTR_NAMES = new Set(['href', 'src', 'xlink:href', 'formaction']);
const SAFE_URL_SCHEME_SET = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:']);

const INLINE_SANITIZE_CONFIG: SanitizeConfig = {
    ALLOWED_TAGS: ['strong', 'em', 'u', 'b', 'i', 's', 'code', 'a', 'span', 'mark', 'br'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
};

// No forms in user content: a same-origin form can POST to the app's own routes with the
// visitor's cookies (login CSRF, a phishing box that looks like the app's own).
const BLOCK_SANITIZE_CONFIG: SanitizeConfig = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'fieldset'],
    FORBID_ATTR: ['formaction', 'action', 'form'],
};

const SVG_SANITIZE_CONFIG: SanitizeConfig = {
    USE_PROFILES: { svg: true, svgFilters: true },
};

interface PurifyLike {
    sanitize: (dirty: string, cfg?: SanitizeConfig) => string;
}

type PurifyFactory = ((windowLike: Window) => PurifyLike) & Partial<PurifyLike>;

// DOMPurify export shape differs by runtime/bundler:
// - Browser builds often expose a ready instance with `.sanitize`.
// - Node builds expose a factory that needs a Window.
// We normalize both shapes here.
const rawDomPurifyExport = createDOMPurify as unknown as PurifyFactory | { default?: PurifyFactory };
const domPurifyExport =
    typeof rawDomPurifyExport === 'object' && rawDomPurifyExport && 'default' in rawDomPurifyExport
        ? ((rawDomPurifyExport.default ?? rawDomPurifyExport) as PurifyFactory)
        : (rawDomPurifyExport as PurifyFactory);
let cachedPurify: PurifyLike | null | undefined;

// A DOMPurify instance is a FUNCTION carrying `.sanitize` (the factory returns itself with the
// methods attached), so an object-only test rejects every real instance and silently leaves the
// regex fallback as the only sanitizer.
function isPurifyLike(value: unknown): value is PurifyLike {
    return Boolean(
        value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof (value as PurifyLike).sanitize === 'function',
    );
}

function resolvePurify(): PurifyLike | null {
    if (cachedPurify !== undefined) {
        return cachedPurify;
    }

    // Browser / jsdom test env where the default export may already be an instance.
    if (isPurifyLike(domPurifyExport)) {
        cachedPurify = domPurifyExport;
        return cachedPurify;
    }

    // Browser-like env where we can initialize the factory with global window.
    if (typeof window !== 'undefined' && typeof domPurifyExport === 'function') {
        try {
            const browserPurify = domPurifyExport(window);
            if (isPurifyLike(browserPurify)) {
                cachedPurify = browserPurify;
                return cachedPurify;
            }
        } catch {
            // fall through to Node/fallback path
        }
    }

    // Node.js path: lazily require jsdom only when actually running in Node.
    // This avoids pulling jsdom into browser/Workers bundles.
    const runtimeProcess =
        typeof globalThis === 'object' && globalThis
            ? ((globalThis as { process?: ProcessLike }).process ?? null)
            : null;

    if (runtimeProcess?.versions?.node && typeof domPurifyExport === 'function') {
        try {
            // eslint-disable-next-line no-eval
            const dynamicRequire = (0, eval)('require') as (id: string) => unknown;
            const { JSDOM } = dynamicRequire('jsdom') as { JSDOM: new (html?: string) => { window: Window } };
            const { window: nodeWindow } = new JSDOM('');
            const nodePurify = domPurifyExport(nodeWindow);
            if (isPurifyLike(nodePurify)) {
                cachedPurify = nodePurify;
                return cachedPurify;
            }
        } catch {
            // Continue to fallback sanitizer below.
        }
    }

    cachedPurify = null;
    return cachedPurify;
}

function toStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sanitizeFallbackOpeningTag(tagName: string, rawAttrs: string, allowedAttrSet: Set<string>): string {
    if (!rawAttrs || allowedAttrSet.size === 0) {
        return `<${tagName}>`;
    }

    const sanitizedAttrs: string[] = [];
    ATTRIBUTE_PATTERN.lastIndex = 0;
    let match = ATTRIBUTE_PATTERN.exec(rawAttrs);
    while (match) {
        const attrName = (match[1] ?? EMPTY_STRING).toLowerCase();
        if (!attrName || !allowedAttrSet.has(attrName)) {
            match = ATTRIBUTE_PATTERN.exec(rawAttrs);
            continue;
        }

        const attrValue = (match[3] ?? match[4] ?? match[5] ?? EMPTY_STRING).trim();
        if (!attrValue) {
            sanitizedAttrs.push(attrName);
            match = ATTRIBUTE_PATTERN.exec(rawAttrs);
            continue;
        }

        const safeValue = SAFE_LINK_ATTR_NAMES.has(attrName) ? sanitizeUrl(attrValue) : attrValue;
        // The value was already written back escaped by rebuildStartTags; its entities stay as they are.
        sanitizedAttrs.push(`${attrName}="${escapeRebuiltValue(safeValue)}"`);
        match = ATTRIBUTE_PATTERN.exec(rawAttrs);
    }

    return sanitizedAttrs.length > 0 ? `<${tagName} ${sanitizedAttrs.join(' ')}>` : `<${tagName}>`;
}

/**
 * Cut every whole `<tag …>…</tag>` element, content included. One forward scan: each search
 * starts where the last one ended, so text with thousands of unclosed `<script>` costs one pass
 * (a lazy `<script[\s\S]*?>[\s\S]*?</script>` pattern rescans the rest from each of them).
 * An opening tag with no closing one is left for ACTIVE_TAG_PATTERN.
 */
function cutElements(input: string, tag: 'script' | 'style'): string {
    const open = new RegExp(`<${tag}\\b`, 'gi');
    // A closing tag may carry whitespace before its `>` (`</script >`), and a browser honours it.
    const close = new RegExp(`</${tag}\\s*>`, 'gi');
    let out = EMPTY_STRING;
    let at = 0;
    for (;;) {
        open.lastIndex = at;
        const start = open.exec(input);
        if (!start) break;
        close.lastIndex = open.lastIndex;
        if (!close.exec(input)) break;
        out += input.slice(at, start.index) + CUT;
        at = close.lastIndex;
    }
    return out + input.slice(at);
}

const isTagSpace = (char: string | undefined): boolean =>
    char === ' ' || char === '\n' || char === '\t' || char === '\r' || char === '\f';

/** A value as it goes back between double quotes. `&` stays: the value's own entities are kept. */
function escapeRebuiltValue(value: string): string {
    return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Read every start tag the way a browser's tokenizer does and write it back in one plain form:
 * `<name attr="value" …>`. Handlers (`on…`) and `srcdoc` are left out, link attributes go
 * through `sanitizeUrl`, and every value is re-quoted and escaped.
 *
 * Patching a tag in place needs this code and the browser to agree on where each attribute and
 * the tag itself end, and a stray quote is enough to break that (`<img x' y='>' onerror=…>`).
 * Written back like this, the browser reads exactly the attributes that were checked. One
 * forward scan; text outside a start tag is not touched.
 */
function rebuildStartTags(input: string): string {
    const length = input.length;
    let out = EMPTY_STRING;
    let at = 0;
    while (at < length) {
        const open = input.indexOf('<', at);
        if (open < 0) break;
        const first = input.charCodeAt(open + 1) | 0x20;
        if (!(first >= 97 && first <= 122)) {
            // Not a start tag (`a < b`, `</p>`, `<!-- -->`).
            out += input.slice(at, open + 1);
            at = open + 1;
            continue;
        }
        out += input.slice(at, open);
        let i = open + 1;
        while (i < length && !isTagSpace(input[i]) && input[i] !== '/' && input[i] !== '>') i++;
        const tagName = input.slice(open + 1, i);
        if (!PLAIN_TAG_NAME.test(tagName)) {
            // `<img<x>`: one tag named `img<x` to a browser, but cutting the `<x>` out of it later
            // would leave `<img`. The whole name becomes text, each `<` in it escaped, and the scan
            // goes on after it: going on from the next character rescans the rest from every `<`.
            out += `&lt;${tagName.replace(/</g, '&lt;')}`;
            at = i;
            continue;
        }
        let tag = `<${tagName}`;
        let selfClosing = false;
        for (;;) {
            while (i < length && (isTagSpace(input[i]) || input[i] === '/')) {
                selfClosing = input[i] === '/';
                i++;
            }
            if (i >= length || input[i] === '>') break;
            selfClosing = false;
            const nameStart = i;
            // A leading `=` belongs to the name, as the tokenizer has it.
            if (input[i] === '=') i++;
            while (i < length && !isTagSpace(input[i]) && input[i] !== '/' && input[i] !== '>' && input[i] !== '=') i++;
            const name = input.slice(nameStart, i).toLowerCase();
            let value: string | null = null;
            let next = i;
            while (next < length && isTagSpace(input[next])) next++;
            if (input[next] === '=') {
                next++;
                while (next < length && isTagSpace(input[next])) next++;
                const quote = input[next];
                if (quote === '"' || quote === "'") {
                    // An unclosed quote runs to the end of the text, for the browser too.
                    const close = input.indexOf(quote, next + 1);
                    value = input.slice(next + 1, close < 0 ? length : close);
                    next = close < 0 ? length : close + 1;
                } else {
                    const valueStart = next;
                    while (next < length && !isTagSpace(input[next]) && input[next] !== '>') next++;
                    value = input.slice(valueStart, next);
                }
                i = next;
            }
            if (!PLAIN_ATTR_NAME.test(name) || name.startsWith('on') || DROPPED_ATTR_NAMES.has(name)) continue;
            if (value === null) {
                tag += ` ${name}`;
                continue;
            }
            const safe = SAFE_LINK_ATTR_NAMES.has(name) ? sanitizeUrl(value) : value;
            tag += ` ${name}="${escapeRebuiltValue(safe)}"`;
        }
        out += `${tag}${selfClosing ? ' /' : ''}>`;
        at = Math.min(i + 1, length);
    }
    return out + input.slice(at);
}

function basicFallbackSanitize(input: string, cfg: SanitizeConfig): string {
    if (!input) {
        return EMPTY_STRING;
    }

    const withoutActiveTags = cutElements(cutElements(input, 'script'), 'style').replace(ACTIVE_TAG_PATTERN, CUT);

    const normalizedLinks = rebuildStartTags(withoutActiveTags);

    const allowedTags = toStringArray(cfg.ALLOWED_TAGS).map((tag) => tag.toLowerCase());
    if (allowedTags.length === 0) {
        return normalizedLinks;
    }

    const allowedTagSet = new Set(allowedTags);
    const allowedAttrSet = new Set(toStringArray(cfg.ALLOWED_ATTR).map((attr) => attr.toLowerCase()));

    return normalizedLinks.replace(HTML_TAG_PATTERN, (fullTag, tagName: string, rawAttrs: string | undefined) => {
        const normalizedTagName = tagName.toLowerCase();
        if (!allowedTagSet.has(normalizedTagName)) {
            // A space, not nothing: the text on either side of a dropped tag must not join into one.
            return CUT;
        }

        if (fullTag.startsWith('</')) {
            return `</${normalizedTagName}>`;
        }

        return sanitizeFallbackOpeningTag(normalizedTagName, rawAttrs ?? EMPTY_STRING, allowedAttrSet);
    });
}

function sanitizeWithFallback(input: string, cfg: SanitizeConfig): string {
    if (!input) {
        return EMPTY_STRING;
    }

    const purify = resolvePurify();
    if (purify) {
        return purify.sanitize(input, cfg);
    }

    // Last resort for runtimes without a DOM implementation (e.g. Workers startup).
    return basicFallbackSanitize(input, cfg);
}

/**
 * Allowed URL schemes for anchor href and similar link attributes.
 * `javascript:`, `data:`, `vbscript:` and any unknown scheme are blocked.
 */
/**
 * Sanitize a URL for use in an anchor href or similar attribute.
 * Returns '#' for any URL whose scheme is not in the safe allowlist.
 * Relative URLs (starting with /, ./, ../, ?, #) are allowed as-is.
 *
 * @example
 * <a href={sanitizeUrl(url)}>link</a>
 */
export function sanitizeUrl(url: string | null | undefined): string {
    if (!url) return '#';

    const trimmed = url.trim();
    if (!trimmed) return '#';

    // Block protocol-relative URLs (`//evil.com`). Browsers drop tab/CR/LF inside URLs and read `\` as `/`,
    // so `/\evil.com` and `/<TAB>/evil.com` are protocol-relative too. In an attribute the browser
    // also decodes entities first, so `/&#47;evil.com` or `/&Tab;/evil.com` is one: a path never
    // needs `&` straight after its first `/`.
    if (/^[/\\][/\\&]/.test(trimmed.replace(/[\t\n\r]/g, ''))) return '#';

    // Allow relative URLs
    if (
        trimmed.startsWith('/') ||
        trimmed.startsWith('./') ||
        trimmed.startsWith('../') ||
        trimmed.startsWith('?') ||
        trimmed.startsWith('#')
    ) {
        return trimmed;
    }

    // The scheme is read first: most refusals end here, and a `new URL` that throws is slow
    // enough to matter when one hostile mail carries thousands of links.
    const scheme = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(trimmed);
    if (!scheme || !SAFE_URL_SCHEME_SET.has(`${scheme[1]!.toLowerCase()}:`)) return '#';

    // Parse protocol: must be in the allowlist
    try {
        const parsed = new URL(trimmed);
        if (!SAFE_URL_SCHEME_SET.has(parsed.protocol.toLowerCase())) {
            return '#';
        }
    } catch {
        // Unparseable URL (e.g. bare hostname): block it
        return '#';
    }

    return trimmed;
}

/** `<img>` attributes for a content image (see `@ottabase/utils/media`). */
export interface SafeImageProps {
    src: string;
    srcSet?: string;
    sizes?: string;
    width?: number;
    height?: number;
}

/**
 * The `<img>` attributes for a content image, or null when there is nothing safe to show. A stored file offers its
 * renditions with `sizes` (the slot's rendered CSS width); an outside address is sanitized and stands alone. An object
 * that is not a well-formed `StoredFile` renders nothing.
 */
export function safeImageProps(value: unknown, sizes: string): SafeImageProps | null {
    if (typeof value === 'string') {
        const src = value.trim() ? sanitizeUrl(value) : '#';
        return src === '#' ? null : { src };
    }
    if (!isStoredFile(value)) return null;
    const { src, srcSet, width, height } = imageSources(value);
    return { src, srcSet, sizes: srcSet ? sizes : undefined, width, height };
}

/**
 * Allowed inline tags for EditorJS block content (list items, paragraph spans, step text, etc.).
 * Covers the subset EditorJS tools actually emit: bold, italic, underline, inline code, links, marks.
 */
/**
 * Sanitize untrusted inline HTML produced by EditorJS tools.
 * Strips any tag or attribute not in the inline allowlist.
 * Safe for use with React's `dangerouslySetInnerHTML`.
 *
 * @example
 * <span dangerouslySetInnerHTML={{ __html: sanitizeInlineHtml(item.content) }} />
 */
export function sanitizeInlineHtml(html: string): string {
    return sanitizeWithFallback(html, INLINE_SANITIZE_CONFIG);
}

/**
 * Sanitize block-level HTML (e.g. HtmlRenderer, raw article HTML).
 * Allows a broader set of tags while still stripping scripts and event handlers.
 * Safe for use with React's `dangerouslySetInnerHTML`.
 *
 * @example
 * <div dangerouslySetInnerHTML={{ __html: sanitizeBlockHtml(content) }} />
 */
export function sanitizeBlockHtml(html: string): string {
    return sanitizeWithFallback(html, BLOCK_SANITIZE_CONFIG);
}

/** The `rel` every link in user-generated content carries: no endorsement, no ranking credit, no opener. */
export const UGC_LINK_REL = 'ugc nofollow noopener';

// One `<a ...>` start tag with its attributes; quoted values may hold `>`.
const ANCHOR_START_TAG = /<a\b((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/gi;
const REL_ATTRIBUTE = /\s{1,64}rel\s{0,64}=\s{0,64}(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;

/**
 * Mark every link of ALREADY SANITIZED HTML as user-generated: any `rel` it had is replaced by
 * `rel="ugc nofollow noopener"`. Use it wherever people the site does not vouch for wrote the
 * HTML (comments, community or tenant posts), after `sanitizeInlineHtml` / `sanitizeBlockHtml`.
 *
 * @example
 * <div dangerouslySetInnerHTML={{ __html: markUgcLinks(sanitizeBlockHtml(comment.html)) }} />
 */
export function markUgcLinks(html: string): string {
    return html.replace(
        ANCHOR_START_TAG,
        (_tag, attrs: string) => `<a${attrs.replace(REL_ATTRIBUTE, '')} rel="${UGC_LINK_REL}">`,
    );
}

/**
 * Sanitize an SVG string (e.g. an inline icon from editor config).
 * Allows SVG and SVG filter elements, strips scripts and foreign objects.
 * Safe for use with React's `dangerouslySetInnerHTML`.
 *
 * @example
 * <span dangerouslySetInnerHTML={{ __html: sanitizeSvgHtml(icon) }} />
 */
export function sanitizeSvgHtml(svg: string): string {
    return sanitizeWithFallback(svg, SVG_SANITIZE_CONFIG);
}

/**
 * Serialize unknown data for safe embedding inside a `<script>` tag.
 * Escapes characters that can break out of script context.
 *
 * @example
 * <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: sanitizeJsonForScript(schema) }} />
 */
export function sanitizeJsonForScript(data: unknown): string {
    let serialized = NULL_JSON_LITERAL;

    try {
        serialized = JSON.stringify(data) ?? NULL_JSON_LITERAL;
    } catch {
        serialized = NULL_JSON_LITERAL;
    }

    return serialized.replace(
        JSON_SCRIPT_ESCAPE_PATTERN,
        (character) => JSON_SCRIPT_ESCAPE_MAP[character] ?? character,
    );
}

/**
 * Sanitize CSS before embedding in a `<style>` tag.
 * Neutralizes break-out sequences and strips obvious script vectors.
 */
export function sanitizeCssForStyleTag(css: string): string {
    if (!css) return '';

    if (!CSS_DANGEROUS_CONTENT_PATTERN.test(css)) {
        return css;
    }

    return cutElements(css, 'script')
        .replace(CSS_STYLE_BREAKOUT_PATTERN, '<\\/style')
        .replace(CSS_EXPRESSION_PATTERN, EMPTY_STRING)
        .replace(CSS_JS_URL_PATTERN, 'url($1#)');
}

/**
 * The DOM-free pass on its own: what `sanitizeBlockHtml` runs where there is no DOM to parse
 * with (a Worker). Exported so it can be tested where a DOM exists; app code calls the
 * `sanitize*Html` functions, which pick the parser when there is one.
 */
export function sanitizeHtmlWithoutDom(html: string, mode: 'block' | 'inline' = 'block'): string {
    return basicFallbackSanitize(html, mode === 'inline' ? INLINE_SANITIZE_CONFIG : {});
}
