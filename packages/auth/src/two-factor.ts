// ============================================================
// @ottabase/auth - Passkey sign-in and the second-factor challenge
// ============================================================
//
// Routes (all under /api/auth, answered by `handleAuthRequest` through `handleSignInFactorRequest`):
//
//   POST   /passkey/options                 sign-in options for a passkey (anyone)
//   POST   /callback/passkey                sign in with a passkey (anyone): { credential }
//   GET    /two-factor/challenge            { pending: false } | { pending: true, methods: { totp, passkey, recoveryCode } }
//   POST   /two-factor/challenge            finish it: { code } | { recoveryCode } | { passkey }
//   POST   /two-factor/passkey-options      options to finish it with a passkey
//
// A sign-in waiting on its second factor holds the pending cookie (sign-in.ts). Codes and recovery
// codes are guessable in principle, so each guess is counted BEFORE it is checked: more than five
// against one pending sign-in, or more than thirty against the account in an hour, answers 429
// `TOO_MANY_ATTEMPTS` without checking (attemptRefused in factors.ts). A passkey is a signature,
// not a guess: it is never counted and never blocked, so a person locked out of codes can still
// finish with one.
//
// ============================================================

import { Authenticator, User, VerificationToken } from '@ottabase/ottaorm/models';
import { hashToken } from './crypto';
import {
    acceptTotpCode,
    attemptRefused,
    authenticatorUnreadable,
    challengeIdentifier,
    checkPasskey,
    clearAttempts,
    consumeChallenge,
    fail,
    issueChallenge,
    logRefused,
    normalizeRecoveryCode,
    openTotpSecret,
    passkeysUnavailable,
    readBody,
    recoveryIdentifier,
    relyingParty,
    requestOptions,
    restoreRecoveryCode,
    secondFactorInvalid,
    tooManyAttempts,
    type Body,
} from './factors';
import { ensureOrmConnection, jsonResponse, requireCsrf } from './http';
import {
    announce,
    authorizedUserFrom,
    clearPendingSecondFactorCookie,
    completeSignIn,
    jsonForOutcome,
    readPendingSecondFactor,
    signInOrChallenge,
    type PendingSecondFactor,
} from './sign-in';
import type { AuthEnv, CreateAuthConfigOptions } from './types';
import type { AuthenticationResponseJSON } from './webauthn';

const secondFactorExpired = () => fail('This sign-in expired. Start again.', 401, 'SECOND_FACTOR_EXPIRED');
const passkeyRefused = () => fail('That passkey could not sign you in.', 401, 'PASSKEY_REFUSED');

// ---------- the second factor ----------

/** What the person offers. Decided once, so a body carrying several proofs is judged by one. */
type Proof =
    | { kind: 'passkey'; response: AuthenticationResponseJSON }
    | { kind: 'code'; code: string }
    | { kind: 'recovery'; code: string };

function proofOf(body: Body): Proof | null {
    if (body.passkey && typeof body.passkey === 'object') {
        return { kind: 'passkey', response: body.passkey as AuthenticationResponseJSON };
    }
    if (typeof body.code === 'string') return { kind: 'code', code: body.code };
    if (typeof body.recoveryCode === 'string') return { kind: 'recovery', code: body.recoveryCode };
    return null;
}

/**
 * Check the proof. Null when it holds, else the answer to send. A recovery code that holds is
 * consumed; its hash comes back so the caller can restore it if the sign-in fails after all.
 */
async function verifyProof(
    pending: PendingSecondFactor,
    proof: Proof,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
): Promise<{ refused: Response } | { recoveryHash: string | null }> {
    const { userId } = pending;

    if (proof.kind === 'passkey') {
        const rp = relyingParty(env, options);
        if (!rp) return { refused: passkeysUnavailable() };
        const challenge = await consumeChallenge(
            challengeIdentifier.factor(userId),
            proof.response.response?.clientDataJSON,
        );
        if (!challenge) return { refused: passkeyRefused() };
        try {
            await checkPasskey(proof.response, rp, challenge, userId);
        } catch (error) {
            logRefused('auth_second_factor_passkey_refused', error);
            return { refused: passkeyRefused() };
        }
        return { recoveryHash: null };
    }

    if (proof.kind === 'code') {
        const totp = await Authenticator.totpFor(userId);
        // No app to check against: nothing to guess, so nothing to count.
        if (!totp?.secret || totp.confirmedAt == null) return { refused: secondFactorInvalid() };
        // Opened before the attempt is counted: an unreadable app is not a wrong guess.
        const secret = await openTotpSecret(env, totp.secret);
        if (secret === null) return { refused: authenticatorUnreadable() };
        if (await attemptRefused(userId, pending)) return { refused: tooManyAttempts() };
        return (await acceptTotpCode(totp, secret, proof.code))
            ? { recoveryHash: null }
            : { refused: secondFactorInvalid() };
    }

    if (await attemptRefused(userId, pending)) return { refused: tooManyAttempts() };
    const normalized = normalizeRecoveryCode(proof.code);
    if (!normalized) return { refused: secondFactorInvalid() };
    const hash = await hashToken(normalized);
    const used = await VerificationToken.consumeByIdentifierAndToken(recoveryIdentifier(userId), hash);
    return used ? { recoveryHash: hash } : { refused: secondFactorInvalid() };
}

async function handleChallengeState(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const pending = await readPendingSecondFactor(request, env);
    if (!pending) return jsonResponse({ pending: false });
    const [rows, recoveryCodes] = await Promise.all([
        Authenticator.listForUser(pending.userId),
        VerificationToken.countByIdentifier(recoveryIdentifier(pending.userId)),
    ]);
    return jsonResponse({
        pending: true,
        methods: {
            totp: rows.some((row) => row.kind === 'totp' && row.confirmedAt != null),
            passkey: rows.some((row) => row.kind === 'passkey') && !!relyingParty(env, options),
            recoveryCode: recoveryCodes > 0,
        },
    });
}

async function handleChallenge(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;

    const pending = await readPendingSecondFactor(request, env);
    if (!pending) return secondFactorExpired();
    const proof = proofOf(body);
    if (!proof) return fail('Send a code, a recovery code or a passkey.', 400, 'VALIDATION_ERROR');

    const verdict = await verifyProof(pending, proof, env, options);
    if ('refused' in verdict) return verdict.refused;
    if (proof.kind !== 'passkey') await clearAttempts(pending.userId, pending.jti);

    // From here the proof is spent. A recovery code goes back if the sign-in does not finish, so
    // a person locked out of everything else does not lose one to a failure of ours.
    const restore = async () => {
        if (verdict.recoveryHash) await restoreRecoveryCode(pending.userId, verdict.recoveryHash);
    };
    let completed;
    try {
        const user = await User.find(pending.userId);
        if (!user) {
            await restore();
            return secondFactorExpired();
        }
        completed = await completeSignIn(authorizedUserFrom(user), env, request, options, {
            signInMethod: pending.signInMethod,
            twoFactorEnabled: true,
        });
    } catch (error) {
        await restore();
        throw error;
    }
    if (!completed) {
        await restore();
        return jsonForOutcome({ kind: 'failed' });
    }
    if (verdict.recoveryHash) {
        await announce(env, options, 'user.factor.changed', {
            userId: pending.userId,
            factor: 'recovery-codes',
            change: 'removed',
            at: Date.now(),
        });
    }
    return jsonForOutcome({ kind: 'session', ...completed }, [clearPendingSecondFactorCookie(env, request)]);
}

async function handleChallengePasskeyOptions(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    const pending = await readPendingSecondFactor(request, env);
    if (!pending) return secondFactorExpired();
    const rp = relyingParty(env, options);
    if (!rp) return passkeysUnavailable();
    const passkeys = (await Authenticator.listForUser(pending.userId)).filter((row) => row.kind === 'passkey');
    if (passkeys.length === 0) return fail('This account has no passkey.', 404, 'NOT_FOUND');
    return jsonResponse(requestOptions(rp, await issueChallenge(challengeIdentifier.factor(pending.userId)), passkeys));
}

// ---------- passkey sign-in ----------

async function handlePasskeySignInOptions(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    const rp = relyingParty(env, options);
    if (!rp) return passkeysUnavailable();
    // No allow-list: the browser offers whichever of this site's passkeys the person picks.
    return jsonResponse(requestOptions(rp, await issueChallenge(challengeIdentifier.signIn)));
}

async function handlePasskeySignIn(request: Request, env: AuthEnv, options: CreateAuthConfigOptions) {
    const body = await readBody(request);
    const rejected = await requireCsrf(request, env, body.csrfToken);
    if (rejected) return rejected;
    const rp = relyingParty(env, options);
    if (!rp) return passkeysUnavailable();

    const response = body.credential as AuthenticationResponseJSON | undefined;
    if (!response || typeof response !== 'object') return passkeyRefused();
    const challenge = await consumeChallenge(challengeIdentifier.signIn, response.response?.clientDataJSON);
    if (!challenge) return passkeyRefused();

    let userId: string;
    try {
        userId = (await checkPasskey(response, rp, challenge)).userId;
    } catch (error) {
        logRefused('auth_passkey_sign_in_refused', error);
        return passkeyRefused();
    }
    const user = await User.find(userId);
    if (!user) return passkeyRefused();
    const authorized = authorizedUserFrom(user);
    if (options.requireVerifiedEmail && !authorized.emailVerified) {
        return fail('Please verify your email before signing in', 401, 'EMAIL_UNVERIFIED');
    }
    return jsonForOutcome(await signInOrChallenge(authorized, env, request, options, 'passkey'));
}

/** Passkey sign-in and the second-factor challenge, or null for any other path. */
export async function handleSignInFactorRequest(
    request: Request,
    env: AuthEnv,
    options: CreateAuthConfigOptions,
    segments: string[],
): Promise<Response | null> {
    const [action, param] = segments;
    const method = request.method;
    const route =
        (action === 'passkey' && param === 'options' && method === 'POST' && 'passkey-options') ||
        (action === 'callback' && param === 'passkey' && method === 'POST' && 'passkey-sign-in') ||
        (action === 'two-factor' && param === 'challenge' && (method === 'GET' || method === 'POST') && 'challenge') ||
        (action === 'two-factor' && param === 'passkey-options' && method === 'POST' && 'challenge-passkey') ||
        null;
    if (!route) return null;

    ensureOrmConnection(env);
    switch (route) {
        case 'passkey-options':
            return handlePasskeySignInOptions(request, env, options);
        case 'passkey-sign-in':
            return handlePasskeySignIn(request, env, options);
        case 'challenge':
            return method === 'GET'
                ? handleChallengeState(request, env, options)
                : handleChallenge(request, env, options);
        case 'challenge-passkey':
            return handleChallengePasskeyOptions(request, env, options);
    }
}
