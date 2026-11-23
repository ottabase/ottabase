// Visitor light/dark choice: stored in localStorage, applied as `data-scheme` on <html>.

// The app's <head> re-applies the saved choice before first paint with an inline script it
// declares as a string constant (apps/otta-landing/app/layout.tsx, SCHEME_INIT_SCRIPT): the
// sanitized-inner-html lint rule accepts fixed markup only when it is declared in the file that
// renders it.

export const SCHEME_STORAGE_KEY = 'ottalanding.scheme';
