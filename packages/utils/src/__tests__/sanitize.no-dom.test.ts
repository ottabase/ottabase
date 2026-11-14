import { describe, expect, it } from 'vitest';
import { sanitizeHtmlWithoutDom } from '../sanitize';

// A Worker has no DOM, so this regex pass is the whole sanitizer there. It is not a parser:
// these are the shapes it must not let through.
describe('the DOM-free sanitizer pass', () => {
    const blocked: Array<[string, string]> = [
        ['a closing script tag with a space', '<script>alert(1)</script >'],
        ['a script tag never closed', '<p>hi</p><script src=https://evil.example/x.js>'],
        ['a script tag cut off at the end', '<p>hi</p><script src=https://evil.example/x.js'],
        ['an iframe with a document', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
        ['an object', '<object data="https://evil.example/x.swf"></object>'],
        ['a handler after a slash', '<img/src="x"/onerror="alert(1)">'],
        ['a handler after a quote', '<img src="x"onerror="alert(1)">'],
        ['a script address after a slash', '<a/href="javascript:alert(1)">x</a>'],
        ['a base tag', '<base href="https://evil.example/">'],
        ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
        ['a script tag rebuilt by a cut', '<scr<iframe>ipt>alert(1)</scr<iframe>ipt>'],
        ['a script tag rebuilt by a cut element', '<scr<script>x</script>ipt>alert(1)</scr<script>x</script>ipt>'],
        ['an iframe rebuilt by a cut', '<ifr<link>ame srcdoc="x">'],
        [
            'an animated script address',
            '<svg><a><animate attributeName=href values=javascript:alert(1) /><text>x</text></a></svg>',
        ],
        ['a set script address', '<svg><a><set attributeName=href to=javascript:alert(1) /><text>x</text></a></svg>'],
        ['a handler after a quoted >', '<a title=">" onclick="alert(1)">x</a>'],
        // A quote opens a value only after `=`: these two end the tag early for a naive matcher.
        ['a handler behind a stray quote', `<img x' y='>' onerror=alert(1) src=x>`],
        ['a handler behind a quote in a name', `<img src=x a'b=" '>" onerror=alert(1)>`],
        ['a handler with no space before it', '<img src="x"onerror=alert(1)//>'],
        ['a handler in capitals after a newline', '<img src=x\nONERROR\n=\nalert(1)>'],
        ['a document in an attribute', '<div srcdoc="<img src=x onerror=alert(1)>">x</div>'],
    ];
    for (const [name, html] of blocked) {
        it(`drops ${name}`, () => {
            const out = sanitizeHtmlWithoutDom(html);
            expect(out).not.toMatch(/<\s*\/?\s*(script|iframe|object|base|meta|animate|set)\b/i);
            expect(out).not.toMatch(/\son\w+\s*=|["'/]on\w+\s*=/i);
            expect(out).not.toMatch(/javascript:/i);
        });
    }

    it('keeps ordinary markup and safe links', () => {
        const html =
            '<h2>Title</h2><p>Read <a href="https://example.com/a?b=1">this</a> and <strong>that</strong>.</p>';
        expect(sanitizeHtmlWithoutDom(html)).toBe(html);
    });

    // The inline mode drops every tag off its short list. Dropping one must never join the text
    // around it into a tag, and a tag name holding `<` must not hide one.
    const inlineBlocked = [
        '<<x>img src=x onerror=alert(1)>',
        '<</x>img src=x onerror=alert(1)>',
        '<img<x> src=x onerror=alert(1)>',
        '<scr<x>ipt>alert(1)</scr<x>ipt>',
        '<a<x> href=javascript:alert(1)>x</a>',
        '<a href="javascript:alert(1)">x</a>',
        '<span onclick="alert(1)">x</span>',
    ];
    for (const html of inlineBlocked) {
        it(`inline mode makes no live tag of ${html}`, () => {
            for (const mode of ['inline', 'block'] as const) {
                // What a browser would read as start tags: `<` straight before a letter. The rest is text.
                const tags = (sanitizeHtmlWithoutDom(html, mode).match(/<[a-z][^>]*>?/gi) ?? []).join('\n');
                expect(tags, mode).not.toMatch(/<(script|img|iframe)\b/i);
                expect(tags, mode).not.toMatch(/\son\w+\s*=|["'/]on\w+\s*=/i);
                expect(tags, mode).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
            }
        });
    }

    it('inline mode keeps its tags and a link with a query string as written', () => {
        const html = '<strong>a</strong> <a href="https://x.test/?a=1&amp;b=2" class="c">link</a>';
        expect(sanitizeHtmlWithoutDom(html, 'inline')).toBe(html);
    });

    it('inline mode costs one pass on closing tags never closed', () => {
        for (const hostile of ['</a '.repeat(50_000), '</b\t'.repeat(50_000), '</a x="y" '.repeat(20_000)]) {
            const started = performance.now();
            sanitizeHtmlWithoutDom(hostile, 'inline');
            expect(performance.now() - started).toBeLessThan(500);
        }
    });

    it('never lets a link value break out of its quotes', () => {
        const out = sanitizeHtmlWithoutDom(`<a href='https://x.com/"><a href=javascript:alert(1)>x'>click</a>`);
        expect(out).toBe('<a href="https://x.com/&quot;&gt;&lt;a href=javascript:alert(1)&gt;x">click</a>');
    });

    it('writes every tag back in one plain form', () => {
        expect(sanitizeHtmlWithoutDom(`<IMG SRC=https://x.test/a.png alt='a "b"' hidden/>`)).toBe(
            '<IMG src="https://x.test/a.png" alt="a &quot;b&quot;" hidden />',
        );
        expect(sanitizeHtmlWithoutDom('1 < 2 and a< b, <p class=x>ok</p> <!-- c -->')).toBe(
            '1 < 2 and a< b, <p class="x">ok</p> <!-- c -->',
        );
    });

    it('leaves prose that only looks like an attribute', () => {
        const html = '<p>Set online=yes and onload=fast, then "online=true".</p>';
        expect(sanitizeHtmlWithoutDom(html)).toBe(html);
    });

    it('costs one pass on thousands of unclosed tags', () => {
        // Anyone who can send mail reaches this in a Worker: it must not be cubic.
        for (const hostile of [
            '<script>'.repeat(20_000),
            '<script a>'.repeat(20_000),
            '<style>'.repeat(20_000),
            '<a href='.repeat(25_000),
            `<a x='`.repeat(30_000),
            '<a '.repeat(50_000),
        ]) {
            const started = performance.now();
            sanitizeHtmlWithoutDom(hostile);
            expect(performance.now() - started).toBeLessThan(500);
        }
    });

    it('costs one pass on tag names that are not names', () => {
        // Each of these was a full rescan of the rest from every `<`: about a minute at 200 KB.
        for (const unit of ['<b', '<a\0', '<b.']) {
            const hostile = unit.repeat(Math.ceil(200_000 / unit.length));
            for (const mode of ['block', 'inline'] as const) {
                const started = performance.now();
                const out = sanitizeHtmlWithoutDom(hostile, mode);
                expect(performance.now() - started, `${JSON.stringify(unit)} ${mode}`).toBeLessThan(500);
                expect(out).not.toMatch(/<[a-z]/i);
            }
        }
        expect(sanitizeHtmlWithoutDom('<img<x src=x onerror=alert(1)>')).toBe('&lt;img&lt;x src=x onerror=alert(1)>');
    });
});
