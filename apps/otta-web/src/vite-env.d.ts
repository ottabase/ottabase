/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Docs full-text search endpoint (`GET ?q=&limit=`), e.g. https://mcp.ottabase.com/api/search. Unset: off. */
    readonly VITE_DOCS_SEARCH_URL?: string;
}
