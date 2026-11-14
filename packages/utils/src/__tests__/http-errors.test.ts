import { describe, expect, it } from 'vitest';
import {
    defaultErrorCode,
    errorResponse,
    redactErrorForLog,
    ServiceError,
    type ApiErrorResponse,
} from '../http-errors';

async function readError(response: Response): Promise<ApiErrorResponse> {
    return (await response.json()) as ApiErrorResponse;
}

describe('errorResponse', () => {
    it('redacts 5xx content by default while preserving stable correlation fields', async () => {
        const response = errorResponse('Database password=super-secret', 500, {
            code: 'DATABASE_FAILURE',
            details: 'SQL and stack details',
            hint: 'Restart the private database',
            messages: ['token=secret-token'],
            fieldErrors: { password: ['super-secret'] },
            metadata: { host: 'private.internal' },
            requestId: 'req-123',
        });
        const body = await readError(response);

        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(body).toEqual({
            error: 'Internal server error',
            code: 'DATABASE_FAILURE',
            messages: ['Internal server error'],
            requestId: 'req-123',
        });
        expect(JSON.stringify(body)).not.toContain('super-secret');
        expect(JSON.stringify(body)).not.toContain('private.internal');
    });

    it('uses status-specific default codes instead of collapsing every 4xx to BAD_REQUEST', () => {
        expect(defaultErrorCode(400)).toBe('BAD_REQUEST');
        expect(defaultErrorCode(401)).toBe('UNAUTHORIZED');
        expect(defaultErrorCode(403)).toBe('FORBIDDEN');
        expect(defaultErrorCode(404)).toBe('NOT_FOUND');
        expect(defaultErrorCode(409)).toBe('CONFLICT');
        expect(defaultErrorCode(422)).toBe('VALIDATION_ERROR');
        expect(defaultErrorCode(426)).toBe('UPGRADE_REQUIRED');
        expect(defaultErrorCode(429)).toBe('RATE_LIMITED');
        expect(defaultErrorCode(503)).toBe('SERVICE_UNAVAILABLE');
    });

    it('allows deliberate public 5xx copy only through the explicit exposure marker', async () => {
        const response = errorResponse('Maintenance window in progress', 503, {
            exposure: 'public',
            code: 'PLANNED_MAINTENANCE',
            details: 'Try again after 18:00 UTC',
        });

        expect(await readError(response)).toEqual({
            error: 'Maintenance window in progress',
            code: 'PLANNED_MAINTENANCE',
            messages: ['Maintenance window in progress'],
            details: 'Try again after 18:00 UTC',
        });
    });
});

describe('ServiceError', () => {
    it('is also opaque by default when converted directly to an API response', () => {
        const error = new ServiceError('D1 failed: password=super-secret', 503, {
            code: 'SECURITY_CONTEXT_UNAVAILABLE',
            details: 'internal lookup details',
            internalCause: { token: 'private-cause-token' },
        });

        expect(error.toApiResponse()).toEqual({
            error: 'Service temporarily unavailable',
            code: 'SECURITY_CONTEXT_UNAVAILABLE',
            messages: ['Service temporarily unavailable'],
            requestId: undefined,
            details: undefined,
            hint: undefined,
            fieldErrors: undefined,
            metadata: undefined,
        });
        const serialized = JSON.stringify(error);
        expect(serialized).not.toContain('super-secret');
        expect(serialized).not.toContain('internal lookup details');
        expect(serialized).not.toContain('private-cause-token');
    });
});

describe('redactErrorForLog', () => {
    it('bounds logs and removes common credential forms without serializing arbitrary objects', () => {
        const redacted = redactErrorForLog(
            new Error(
                'authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l {"password":"hunter2"} token=secret-token\n' +
                    'postgresql://database-user:database-password@db.internal/app\n' +
                    '-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----',
            ),
            500,
        );
        const serialized = JSON.stringify(redacted);

        expect(serialized).not.toContain('YWxhZGRpbjpvcGVuc2VzYW1l');
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('secret-token');
        expect(serialized).not.toContain('database-user');
        expect(serialized).not.toContain('database-password');
        expect(serialized).not.toContain('private-key-material');
        expect(serialized).toContain('[REDACTED]');
        expect(redactErrorForLog({ password: 'do-not-serialize' })).toEqual({
            name: 'NonErrorThrow',
            message: 'A non-Error value was thrown',
        });
    });

    it('stays cheap on a long run without whitespace', () => {
        // Seconds before the scheme was bounded; an anonymous error report reaches this.
        const hostile = new Error('a-'.repeat(200_000));
        hostile.stack = 'a.'.repeat(200_000);
        const started = performance.now();
        const log = redactErrorForLog(hostile, 16_000);
        expect(performance.now() - started).toBeLessThan(250);
        expect(log.message.endsWith('…[truncated]')).toBe(true);
    });

    it('redacts a secret that starts in view and ends past it', () => {
        // An RSA-4096 key is about 3,200 characters: it begins inside what is shown and ends beyond it.
        const key = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIJKAIBAAKCAgEA'.repeat(220)}\n-----END RSA PRIVATE KEY-----`;
        const log = redactErrorForLog(new Error(`${'x'.repeat(1_900)} ${key} tail`));
        expect(log.message).not.toContain('MIIJKAIBAAKCAgEA');
        // And one whose END never arrives is redacted from its BEGIN.
        const open = redactErrorForLog(new Error(`boot failed -----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(50)}`));
        expect(open.message).toBe('boot failed [REDACTED PRIVATE KEY]');
    });

    it('redacts the forms a credential really takes', () => {
        const secrets: Array<[string, string]> = [
            ['Authorization: Token abc123xyz', 'abc123xyz'],
            ['GET /cb?access_token=tok_9f8e7d&x=1', 'tok_9f8e7d'],
            ['aws_secret_access_key=wJalrXUtnFEMI', 'wJalrXUtnFEMI'],
            ['{"clientSecret":"s3cr3tvalue"}', 's3cr3tvalue'],
            [JSON.stringify({ body: JSON.stringify({ password: 'hunter2', access_token: 'abc999' }) }), 'hunter2'],
            [JSON.stringify({ body: JSON.stringify({ password: 'hunter2', access_token: 'abc999' }) }), 'abc999'],
            ["Map{'cookie' => 'sid=abc777','password' => 'hunter2'}", 'hunter2'],
            ["Map{'cookie' => 'sid=abc777','password' => 'hunter2'}", 'abc777'],
            ['redis://:pw12345@cache.internal:6379', 'pw12345'],
            ['mysql://user:p@ssw0rd@db.internal/app', 'ssw0rd'],
            ['Cookie: a=first1; b=second2; c=third3', 'second2'],
            ['Cookie: a=first1; b=second2; c=third3', 'third3'],
            ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P', 'eyJzdWIi'],
            ['key AKIAIOSFODNN7EXAMPLE used', 'AKIAIOSFODNN7EXAMPLE'],
            // Joined at runtime: a literal in this shape stops a push at GitHub's secret scanning.
            [`stripe ${['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_')}`, '4eC39HqLyjWDarjtT1zdp7dc'],
            ['gh ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz'],
            ['slack xoxb-123456789012-abcdefghij', '123456789012'],
            ['{"authorization":["Basic dXNlcjpwYXNz"]}', 'dXNlcjpwYXNz'],
            ['{"passwords":["pa]ss","hunter2"]}', 'hunter2'],
            ['{"passwords":["pa]ss","hunter2"]}', 'ss"'],
            ['password=[hunter2]', 'hunter2'],
            ['tokens: [abc123, def456]', 'def456'],
            // A separator after the value does not make it a name; only a secret's own name does.
            ['password: hunter2 = wrong', 'hunter2'],
            ['password=hunter2 => denied', 'hunter2'],
            ['pwd: Hunter2! : bad', 'Hunter2!'],
            ['token: abc = def', 'abc'],
            ['secret=abc123 = x', 'abc123'],
            ['password:          hunter2', 'hunter2'],
            ['password=@#$%^&()', '@#$%^'],
            ['password: 🔑🔑🔑', '🔑'],
            ['token: 482913', '482913'],
            ['access_token=987654321', '987654321'],
            ['password: Passw0rd = expected', 'Passw0rd'],
            ['password: Secret123 : wrong', 'Secret123'],
            [
                'Authorization: AWS4-HMAC-SHA256 Credential=AKID/20261114/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fe5f80f77d5fa3beca038a248ff027',
                'fe5f80f77d5f',
            ],
            ["{ 'x-api-key': [ 'abc123zz' ] }", 'abc123zz'],
            [
                'Authorization: Digest username="u", realm="r", response="6629fae49393a05397450978507c4ef1"',
                '6629fae49393',
            ],
            // The first name's "value" is the second name: the second pair is the one to redact.
            ['AWS secret: aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
            // A JSON string inside a JSON string, the secret holding a quote: all of it goes.
            [JSON.stringify({ body: JSON.stringify({ password: 'hun"ter2 tail' }) }), 'ter2'],
            ['GET https://maps.example/api?key=AIzaSyA1234567890abcdefghijklmnopqrstuv&z=1', 'AIzaSyA1234567890'],
            ['GET /geo?q=x&key=plainkeyvalue99', 'plainkeyvalue99'],
            ['POST /token?client_secret=GOCSPXabcdef', 'GOCSPXabcdef'],
            ['google AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSyA1234567890'],
            [
                'POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage',
                'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
            ],
            ['POST https://hooks.slack.com/services/T0001/B0002/XXXXXXXXXXXXXXXXXXXXXXXX failed', 'XXXXXXXXXXXX'],
            ['anthropic sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'zzzzzzzzzzzz'],
            ['openai sk-proj-abcdEFGHijklMNOPqrstUVWXyz0123', 'abcdEFGHijkl'],
            [`webhook ${['whsec', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'].join('_')}`, 'MfKQ9r8GKYqr'],
            ['npm npm_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnop'],
            ['gitlab glpat-abcdefghij0123456789xy', 'abcdefghij0123'],
        ];
        for (const [text, secret] of secrets) {
            expect(redactErrorForLog(new Error(text)).message, text).not.toContain(secret);
        }
    });

    it('stops at the next query parameter, and a second pass changes nothing', () => {
        const once = redactErrorForLog(new Error('GET /cb?access_token=tok9&state=s1 {"password":"x"}')).message;
        expect(once).toBe('GET /cb?access_token=[REDACTED]&state=s1 {"password":[REDACTED]}');
        expect(redactErrorForLog(new Error(once)).message).toBe(once);
    });

    it('leaves ordinary errors readable', () => {
        for (const text of [
            'POST /signup: validation failed; design: required; signal: SIGTERM',
            'sessionStorage: quota exceeded',
            'tokenizer: bad input',
            'tokenCount === 0',
            'see notes [1] and tokens[0] = first, docs [here]',
            'https://example.com:8080/path?a=1 answered 502',
            'Unexpected token: < in JSON at position 0',
            'password: must be at least 8 characters',
            'Validation failed: password: Required, email: Invalid',
            'Failed to read secrets: permission denied',
            'Token: expired',
            'the key is a monkey; donkey=1',
            'max_tokens: 4096, input_tokens: 512',
        ]) {
            expect(redactErrorForLog(new Error(text)).message).toBe(text);
        }
    });

    it('stays cheap on hostile runs', () => {
        for (const hostile of [
            'eyJ-'.repeat(20_000),
            'cookie:'.repeat(10_000),
            'a://:'.repeat(10_000),
            'token'.repeat(10_000),
        ]) {
            const started = performance.now();
            redactErrorForLog(new Error(hostile), 40_000);
            expect(performance.now() - started, hostile.slice(0, 12)).toBeLessThan(1_000);
        }
        // Runs of names with a separator after them: each name's look ahead must stay short.
        for (const block of ['password:', 'password:[', 'pwd:', 'password:secret_key']) {
            const hostile = `${block.repeat(Math.ceil(8_000 / block.length))} = `.repeat(12);
            const started = performance.now();
            redactErrorForLog(new Error(hostile), 100_000);
            expect(performance.now() - started, block).toBeLessThan(250);
        }
    });

    it('still redacts credentials in a URL', () => {
        const log = redactErrorForLog(new Error('connect postgres://admin:hunter2@db.internal/app failed'));
        expect(log.message).toBe('connect postgres://[REDACTED]@db.internal/app failed');
    });
});
