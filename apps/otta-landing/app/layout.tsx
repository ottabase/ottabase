import { getTheme, SCHEME_STORAGE_KEY, themeStyles } from '@ottabase/ottalanding';
import { fileUrl } from '@ottabase/utils/media';
import { sanitizeCssForStyleTag, sanitizeJsonForScript } from '@ottabase/utils/sanitize';
import type { Metadata } from 'next';
import { getSite, isProduction, siteOrigin, turnstileKeys } from '../lib/content';
import './globals.css';

/**
 * Applies the visitor's saved light/dark choice before first paint, so a dark-mode visitor never
 * sees a light flash. Fixed markup: its only interpolation is the JSON-escaped storage key.
 */
const SCHEME_INIT_SCRIPT = `try{var s=localStorage.getItem(${sanitizeJsonForScript(SCHEME_STORAGE_KEY)});if(s==='light'||s==='dark')document.documentElement.setAttribute('data-scheme',s)}catch(e){}`;

// Content is edited live in otta-web's admin, so every request reads the current site.
export const dynamic = 'force-dynamic';

/** A URL, or undefined for empty/unparseable input (metadata must never throw). */
function toUrl(value?: string): URL | undefined {
    try {
        return value ? new URL(value) : undefined;
    } catch {
        return undefined;
    }
}

export async function generateMetadata(): Promise<Metadata> {
    const [site, production] = await Promise.all([getSite(), isProduction()]);
    return {
        title: site?.name ?? 'Landing site',
        description: site?.tagline,
        // Only the production deployment may be indexed; preview/staging copies must not compete with it.
        robots: production ? 'index, follow' : 'noindex, nofollow',
        // Resolves canonical, Open Graph and social-image URLs: the Public URL, else this request's origin.
        metadataBase: toUrl(await siteOrigin(site)),
        // The uploaded favicon; without one, browsers fall back to /favicon.ico.
        ...(site?.favicon ? { icons: { icon: fileUrl(site.favicon) } } : {}),
    };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const [site, turnstile] = await Promise.all([getSite(), turnstileKeys()]);
    // The theme's design tokens on :root, rendered server-side so the first paint is already on-brand.
    const theme = getTheme(site?.theme ?? 'launch');
    const { css, fonts } = themeStyles(theme.id, ':root', site?.brandColor);
    return (
        // data-scheme starts as the theme's default; the inline script swaps in the visitor's
        // saved light/dark choice before first paint (hence suppressHydrationWarning).
        <html lang="en" data-scheme={theme.scheme} suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: SCHEME_INIT_SCRIPT }} />
                <style id="landing-theme" dangerouslySetInnerHTML={{ __html: sanitizeCssForStyleTag(css) }} />
                {fonts.map((href) => (
                    <link key={href} rel="stylesheet" href={href} />
                ))}
                {/* The lead form's Turnstile widget reads its site key here (@ottabase/ui/turnstile); absent: no bot check. */}
                {turnstile && <meta name="turnstile-site-key" content={turnstile.siteKey} />}
            </head>
            <body className="bg-background text-foreground">{children}</body>
        </html>
    );
}
