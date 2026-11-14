/**
 * Standardized API error response from the server.
 * All API endpoints should return errors in this format.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ApiErrorResponse {
    /** Primary error message */
    error: string;
    /** Error code for programmatic handling (e.g., "UNAUTHORIZED", "RATE_LIMITED") */
    code?: string;
    /** Human-readable context. Keep machine-readable values in metadata. */
    details?: string;
    /** Actionable suggestion for fixing the error */
    hint?: string;
    /** Multiple error messages (e.g., validation errors) */
    messages?: string[];
    /** Field-specific errors for form validation */
    fieldErrors?: Record<string, string[]>;
    /** Safe, machine-readable context for client-side conflict handling. */
    metadata?: Record<string, JsonValue>;
    /** Correlation ID for support and server-side log lookup. */
    requestId?: string;
}

export interface ErrorResponseOptions extends Partial<ApiErrorResponse> {
    /**
     * Explicitly expose a 5xx message and its optional context.
     *
     * Five-hundred responses are private by default. Use this only for a message
     * deliberately written as public API copy, never for an exception message.
     */
    exposure?: 'public';
    /** Additional response headers. Content-Type and Cache-Control remain enforced. */
    headers?: HeadersInit;
}

export interface ServiceErrorOptions extends Omit<ErrorResponseOptions, 'headers'> {
    /** Private underlying failure for the server error boundary; never serialized to clients. */
    internalCause?: unknown;
}

const STATUS_CODES: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    402: 'PAYMENT_REQUIRED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    406: 'NOT_ACCEPTABLE',
    407: 'PROXY_AUTHENTICATION_REQUIRED',
    408: 'REQUEST_TIMEOUT',
    409: 'CONFLICT',
    410: 'GONE',
    411: 'LENGTH_REQUIRED',
    412: 'PRECONDITION_FAILED',
    413: 'PAYLOAD_TOO_LARGE',
    414: 'URI_TOO_LONG',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    416: 'RANGE_NOT_SATISFIABLE',
    417: 'EXPECTATION_FAILED',
    421: 'MISDIRECTED_REQUEST',
    422: 'VALIDATION_ERROR',
    423: 'LOCKED',
    424: 'FAILED_DEPENDENCY',
    425: 'TOO_EARLY',
    426: 'UPGRADE_REQUIRED',
    428: 'PRECONDITION_REQUIRED',
    429: 'RATE_LIMITED',
    431: 'REQUEST_HEADER_FIELDS_TOO_LARGE',
    451: 'UNAVAILABLE_FOR_LEGAL_REASONS',
    500: 'INTERNAL_SERVER_ERROR',
    501: 'NOT_IMPLEMENTED',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
    504: 'GATEWAY_TIMEOUT',
};

const PRIVATE_SERVER_MESSAGES: Record<number, string> = {
    500: 'Internal server error',
    501: 'Server functionality is unavailable',
    502: 'Bad gateway',
    503: 'Service temporarily unavailable',
    504: 'Gateway timeout',
};

/** Return a stable programmatic code when the caller did not provide one. */
export function defaultErrorCode(status: number): string {
    return STATUS_CODES[status] ?? (status >= 500 ? 'SERVER_ERROR' : status >= 400 ? 'CLIENT_ERROR' : 'HTTP_ERROR');
}

function buildApiError(message: string, status: number, options: ErrorResponseOptions = {}): ApiErrorResponse {
    const exposeServerDetails = status < 500 || options.exposure === 'public';
    const publicMessage = exposeServerDetails ? message : (PRIVATE_SERVER_MESSAGES[status] ?? 'Internal server error');

    return {
        error: publicMessage,
        code: options.code || defaultErrorCode(status),
        messages: exposeServerDetails ? options.messages || [publicMessage] : [publicMessage],
        details: exposeServerDetails ? options.details : undefined,
        hint: exposeServerDetails ? options.hint : undefined,
        fieldErrors: exposeServerDetails ? options.fieldErrors : undefined,
        metadata: exposeServerDetails ? options.metadata : undefined,
        requestId: options.requestId,
    };
}

/**
 * Custom error class for service-level errors that can be caught
 * by a global error handler to return structured API responses.
 */
export class ServiceError extends Error {
    public readonly code?: string;
    public readonly status: number;
    public readonly details?: string;
    public readonly hint?: string;
    public readonly messages?: string[];
    public readonly fieldErrors?: Record<string, string[]>;
    public readonly metadata?: Record<string, JsonValue>;
    public readonly requestId?: string;
    public readonly exposure?: 'public';
    public readonly internalCause?: unknown;

    constructor(message: string, status: number = 400, options: ServiceErrorOptions = {}) {
        super(message);
        this.name = 'ServiceError';
        this.status = status;
        this.code = options.code;
        this.details = options.details;
        this.hint = options.hint;
        this.messages = options.messages;
        this.fieldErrors = options.fieldErrors;
        this.metadata = options.metadata;
        this.requestId = options.requestId;
        this.exposure = options.exposure;
        Object.defineProperty(this, 'internalCause', {
            value: options.internalCause,
            enumerable: false,
            configurable: false,
            writable: false,
        });

        const errorConstructor = Error as ErrorConstructor & {
            captureStackTrace?: (target: object, constructor?: typeof ServiceError) => void;
        };
        errorConstructor.captureStackTrace?.(this, ServiceError);
    }

    /**
     * Convert the error to a standardized API error response object.
     */
    toApiResponse(): ApiErrorResponse {
        return buildApiError(this.message, this.status, {
            code: this.code,
            details: this.details,
            hint: this.hint,
            messages: this.messages,
            fieldErrors: this.fieldErrors,
            metadata: this.metadata,
            requestId: this.requestId,
            exposure: this.exposure,
        });
    }

    /**
     * Keep accidental JSON serialization aligned with the secure public shape.
     * In particular, private causes and default-private 5xx context never leak.
     */
    toJSON(): ApiErrorResponse {
        return this.toApiResponse();
    }
}

/**
 * Utility to create a structured JSON error response. Server failures are
 * deliberately opaque unless the caller opts in with `exposure: 'public'`.
 */
export function errorResponse(message: string, status: number = 500, options: ErrorResponseOptions = {}): Response {
    const body = buildApiError(message, status, options);
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'no-store');

    return new Response(JSON.stringify(body), {
        status,
        headers,
    });
}

const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// Every open-ended run below is bounded: an unbounded one rescans a long run without whitespace
// from each place a match can start, which is quadratic in the run's length.
// Basic and Bearer carry one token. Any other scheme (Digest, AWS4-HMAC-SHA256, Signature) spreads
// its credentials over the rest of the line, so the rest of the line goes. No scheme: one token.
const AUTHORIZATION_VALUE =
    /\b(authorization|proxy-authorization)\b\s*[:=]\s*(?:(?:Basic|Bearer)[ \t]+[^\s,;"']{1,4096}|[a-z][\w-]{0,31}[ \t]+[^\r\n]{1,4096}|[^\s,;"']{1,4096})/gi;
// Every cookie of a `Cookie:` / `Set-Cookie:` line, not the first one only.
const COOKIE_HEADER =
    /\b((?:set-)?cookie\s{0,8}:\s{0,8})[^\s=;]{1,256}=[^\s;]{0,4096}(?:;\s{0,8}[^\s=;]{1,256}=[^\s;]{0,4096})*/gi;
// One quoted value: inside a JSON string (\"…\"), in double quotes, in single quotes. Inside a JSON
// string an escape of the value's own (`\\\"` for a quote, `\\\\` for a backslash) is skipped whole,
// so a quote in the secret does not end it early; `\n` and the like are one step.
const QUOTED_SECRET = String.raw`(?:\\"(?:\\\\(?:\\\\|\\"|[^\\"])|\\[^\\"]|[^\\"]){0,8192}\\"|"(?:\\.|[^"\\]){0,8192}"|'(?:\\.|[^'\\]){0,8192}')`;
// A named secret: `password=…`, `"access_token":"…"`, `clientSecret: …`, `'cookie' => '…'`, the same inside
// a JSON string, and a list of them (`"authorization":["Basic …"]`, `tokens: [a, b]`). Group 2 is whatever
// the name starts with (`access_`, `client`); `isSecretName` decides whether the keyword is a word of its own
// there. A value that is already `[REDACTED]` is not a value: a second pass changes nothing. An
// unquoted word that is itself a secret's name, followed by a separator of its own, is the next
// name, not this one's value: in `secret: aws_secret_access_key = …` the match is the second pair,
// so the key itself goes. Only a name counts (`password: hunter2 = wrong` still loses hunter2), and
// the look is bounded, so a run of names costs a few characters each.
const NEXT_SECRET_NAME = String.raw`(?:[\w.-]{0,40}[_.-])?(?:passwords?|passwd|pwd|secrets?|tokens?|authorization|cookies?|api[-_]?keys?|access[-_]?keys?|credentials?|private[-_]?keys?)(?:[_.-][\w.-]{0,40})?[ \t]{1,8}(?:=>|[:=])`;
const SECRET_ASSIGNMENT = new RegExp(
    String.raw`(\\?["']|)(?<![\w-])([\w-]{0,48}?)(passwords?|passwd|pwd|passphrase|secrets?|tokens?|authorization|cookies?|api[-_ ]?keys?|access[-_ ]?keys?|secret[-_ ]?keys?|credentials?|private[-_ ]?keys?)\1` +
        String.raw`(\s{0,8}(?:=>|[:=])[ \t]{0,256})(?![=>])(?!\[REDACTED\])` +
        String.raw`(?:\[\s{0,8}${QUOTED_SECRET}(?:\s{0,8},\s{0,8}${QUOTED_SECRET}){0,64}\s{0,8}\]?|${QUOTED_SECRET}|` +
        String.raw`\[[^\]\r\n"']{0,2048}\]|(?!${NEXT_SECRET_NAME})[^\s,;}"'&=][^\s,;}"'&]{0,8191})`,
    'gi',
);
// What follows a secret's name in ordinary error text rather than a secret: `password: Required`,
// `Unexpected token: <`. Kept tiny on purpose: every word here is one a real secret could not be.
const NOT_A_SECRET = new Set([
    'required',
    'must',
    'invalid',
    'missing',
    'denied',
    'permission',
    'undefined',
    'null',
    'true',
    'false',
    'empty',
    'not',
    'is',
    'too',
    'expired',
    'mismatch',
]);
// `key` and `client_secret` are secrets in a query string (`?key=AIza…`), not in prose.
const QUERY_SECRET = /([?&](?:key|client_secret)=)(?!\[REDACTED\])[^&\s#"'<>]{1,4096}/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
// The user may be empty (`redis://:pw@host`) and the password may hold an `@`: it runs to the last one.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]{0,256}:[^\s/]{1,1024}@/gi;
// Credentials recognisable by shape alone, wherever they sit: a JWT, an AWS key id, a Google API
// key, the Stripe, GitHub, Slack, Anthropic, OpenAI, Svix/Stripe webhook, npm and GitLab token
// prefixes; then a Telegram bot token in its `/bot…` path and a Slack webhook's path (both
// recognisable only by where they sit).
const TOKEN_SHAPE =
    /(?<![\w-])(?:eyJ[\w-]{8,4096}\.[\w-]{8,4096}\.[\w-]{0,4096}|A[KS]IA[A-Z0-9]{16}|AIza[\w-]{35}(?![\w-])|[sr]k_(?:live|test)_[A-Za-z0-9]{8,256}|gh[pousr]_[A-Za-z0-9]{20,256}|github_pat_\w{20,256}|xox[abprs]-[A-Za-z0-9-]{10,256}|sk-(?:ant|proj)-[\w-]{16,256}|whsec_[A-Za-z0-9+/=]{16,256}|npm_[A-Za-z0-9]{36}|glpat-[\w-]{20,256})|(?<=\/bot)\d{6,12}:[\w-]{30,64}|(?<=hooks\.slack\.com\/services\/)[\w/-]{8,256}/g;

/**
 * The keyword stands as a word of its own after `prefix`: at the start, after a separator
 * (`access_token`), or as a new camelCase word (`clientSecret`). So `design`, `tokenizer` and
 * `sessionStorage` are not secrets.
 */
function isSecretName(prefix: string, keyword: string): boolean {
    if (!prefix) return true;
    const last = prefix[prefix.length - 1]!;
    if (!/[A-Za-z]/.test(last)) return true;
    return /[a-z]/.test(last) && /[A-Z]/.test(keyword[0]!);
}

/**
 * An unquoted value that is prose, not a secret: punctuation a message uses (`Unexpected token: <`,
 * `password: ***`), a word of `NOT_A_SECRET`, or a count of tokens (`max_tokens: 4096`).
 */
function isOrdinaryWord(value: string, keyword: string): boolean {
    if (/^[\\"'[]/.test(value)) return false;
    if (/^[*<>?.-]+$/.test(value) || NOT_A_SECRET.has(value.toLowerCase())) return true;
    // Plural only: `token: 482913` is a one-time code, `max_tokens: 4096` a count.
    return /^tokens$/i.test(keyword) && /^\d{1,9}$/.test(value);
}

/** A key whose END marker is missing (the text was cut inside it): everything from BEGIN goes. */
const PRIVATE_KEY_OPEN = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*$/i;
/** How far past what is shown the text is still read, so a secret that starts in view is whole when matched. */
const REDACTION_LOOKAHEAD = 16_384;

function redactLogText(value: string, maxLength: number): string {
    // Bounded, so a caller-sized string (an error reported from a browser) costs a known amount;
    // but read well past what is shown: a secret cut in half no longer matches its pattern.
    const redacted = value
        .slice(0, maxLength * 2 + REDACTION_LOOKAHEAD)
        .replace(PRIVATE_KEY_BLOCK, '[REDACTED PRIVATE KEY]')
        .replace(PRIVATE_KEY_OPEN, '[REDACTED PRIVATE KEY]')
        .replace(URL_CREDENTIALS, '$1[REDACTED]@')
        .replace(AUTHORIZATION_VALUE, '$1: [REDACTED]')
        .replace(COOKIE_HEADER, '$1[REDACTED]')
        .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
        .replace(TOKEN_SHAPE, '[REDACTED]')
        .replace(QUERY_SECRET, '$1[REDACTED]')
        .replace(SECRET_ASSIGNMENT, (match, quote: string, prefix: string, keyword: string, separator: string) => {
            if (!isSecretName(prefix, keyword)) return match;
            const name = `${quote}${prefix}${keyword}${quote}${separator}`;
            return isOrdinaryWord(match.slice(name.length), keyword) ? match : `${name}[REDACTED]`;
        });
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…[truncated]` : redacted;
}

export interface RedactedErrorLog {
    name: string;
    message: string;
    stack?: string;
}

/**
 * Convert a thrown value to bounded, secret-redacted structured log data.
 * It intentionally does not serialize arbitrary thrown objects.
 */
export function redactErrorForLog(error: unknown, maxLength = 2_000): RedactedErrorLog {
    if (!(error instanceof Error)) {
        return {
            name: 'NonErrorThrow',
            message: redactLogText(typeof error === 'string' ? error : 'A non-Error value was thrown', maxLength),
        };
    }

    return {
        name: redactLogText(error.name || 'Error', 128),
        message: redactLogText(error.message || 'No error message', maxLength),
        stack: error.stack ? redactLogText(error.stack, maxLength * 2) : undefined,
    };
}
