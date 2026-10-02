/**
 * Server-side verification of Firebase Phone-Auth ID tokens.
 *
 * Sits ON TOP of the existing `src/lib/auth/firebase.ts` Admin-SDK
 * initialiser. We deliberately DO NOT initialise a second Admin app:
 * Firebase throws if `initializeApp()` is called twice with the same name.
 *
 * The flow this module supports:
 *
 *   1. Browser uses `firebase` JS SDK + invisible reCAPTCHA to call
 *      `signInWithPhoneNumber()` → user enters SMS code → browser holds
 *      a Firebase `UserCredential` whose `getIdToken()` yields a JWT.
 *   2. Browser POSTs `{ idToken, phone }` to `/api/auth/phone/verify`.
 *   3. The route handler calls `verifyFirebasePhoneToken(idToken)` from
 *      this module to extract `{ uid, phone_number }` from the token in
 *      a cryptographically verified, anti-replay way.
 *
 * Security properties we rely on:
 *   - `verifyIdToken(token, true)` — second arg `checkRevoked` flag —
 *     forces a round-trip to the Firebase Auth REST API to confirm the
 *     token has not been revoked since issuance (e.g. by an admin
 *     disabling the account in the Firebase console). Worth the latency
 *     hit; phone verify is a once-per-account event.
 *   - Token issuer is implicitly checked against the initialised
 *     project's audience by the Admin SDK — a token minted for another
 *     Firebase project will fail verification.
 *   - `phone_number` claim is present ONLY for phone-auth tokens; we
 *     reject email-auth tokens that someone might submit to this surface.
 *
 * Failure model — see `PhoneTokenVerificationError` below. The route
 * handler maps it to `401 INVALID_FIREBASE_TOKEN`.
 */
import { env } from '@/lib/config';
import { log } from '@/lib/log';
import { ExternalServiceError } from '@/lib/errors';
import fs from 'node:fs';

type Admin = typeof import('firebase-admin');

let _admin: Admin | null = null;
let _disabled = false;
let _initInflight: Promise<Admin | null> | null = null;

/** Tagged error so callers can `instanceof`-distinguish Firebase failures
 *  from internal bugs. Carries the underlying Firebase error code so
 *  log lines can pinpoint expired-vs-invalid-vs-revoked-vs-wrong-project.
 *
 *  Extends `ExternalServiceError` (HTTP 502) so it flows through the
 *  central `handleError` router unchanged — the dedicated subclass
 *  exists only so the phone-verify service module can `instanceof`-
 *  check and map specific Firebase codes to friendlier responses. */
export class PhoneTokenVerificationError extends ExternalServiceError {
  constructor(
    message: string,
    public readonly firebaseCode: string | null,
    /** True when the token was syntactically valid but failed semantic
     *  rules (missing `phone_number`, wrong project, etc.) rather than
     *  expiring / revocation. */
    public readonly semantic: boolean = false,
  ) {
    super(message, {
      code: 'INVALID_FIREBASE_TOKEN',
      clientMessage: 'Could not verify your phone code. Please request a fresh code and try again.',
      context: { firebaseCode, semantic, service: 'firebase', operation: 'verifyIdToken' },
    });
    this.name = 'PhoneTokenVerificationError';
  }
}

function loadServiceAccount(): Record<string, unknown> | null {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try { return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON); }
    catch { /* fallthrough */ }
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH && fs.existsSync(env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
    try { return JSON.parse(fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8')); }
    catch { /* fallthrough */ }
  }
  return null;
}

/** Internal: get-or-initialise the shared Admin app. Re-uses whichever
 *  app the existing `lib/auth/firebase.ts` opened — we call `getApps()`
 *  and reuse the first instance instead of constructing a new one. */
async function getAdmin(): Promise<Admin | null> {
  if (_disabled) return null;
  if (_admin) return _admin;
  // Concurrent first-callers must not race on initializeApp().
  if (_initInflight) return _initInflight;

  _initInflight = (async () => {
    const admin: Admin = (await import('firebase-admin')) as unknown as Admin;
    // If `lib/auth/firebase.ts` already booted Admin for the email-mirror
    // path, reuse that. `admin.apps` is the public registry.
    if (admin.apps?.length) {
      _admin = admin;
      return admin;
    }
    const svc = loadServiceAccount();
    if (!svc) {
      _disabled = true;
      return null;
    }
    admin.initializeApp({
      credential: admin.credential.cert(svc as Parameters<typeof admin.credential.cert>[0]),
      projectId: env.FIREBASE_PROJECT_ID,
    });
    _admin = admin;
    return admin;
  })();
  try { return await _initInflight; }
  finally { _initInflight = null; }
}

/** Verify a Firebase phone-auth ID token.
 *
 *  Returns:
 *    - `{ uid, phone }`           on success
 *    - `null`                     when Firebase Admin is NOT configured.
 *                                 The caller decides whether this is a
 *                                 dev-time graceful path or a production
 *                                 misconfiguration (route handler logs
 *                                 at `error` level in production).
 *
 *  Throws `PhoneTokenVerificationError` for any cryptographic /
 *  semantic failure of the token itself.
 */
export async function verifyFirebasePhoneToken(
  idToken: string,
): Promise<{ uid: string; phone: string } | null> {
  if (!idToken || typeof idToken !== 'string') {
    throw new PhoneTokenVerificationError('Empty Firebase ID token.', null, true);
  }
  const admin = await getAdmin();
  if (!admin) return null;

  let decoded;
  try {
    // `checkRevoked = true` consults the Firebase auth backend to ensure
    // the user's session has not been revoked since issuance.
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (e: unknown) {
    const code = (e as { code?: string }).code ?? null;
    log.warn('phone.verify.token_invalid', { firebaseErrorCode: code });
    throw new PhoneTokenVerificationError(
      'Firebase ID token verification failed.',
      code,
      false,
    );
  }

  const uid   = decoded.uid;
  const phone = (decoded as { phone_number?: string }).phone_number ?? null;

  if (!phone) {
    // Caller submitted an email-auth (or anonymous) token to a phone
    // surface. Semantic misuse.
    log.warn('phone.verify.token_invalid', {
      firebaseErrorCode: 'no_phone_number_claim',
    });
    throw new PhoneTokenVerificationError(
      'Firebase ID token is not a phone-auth token (missing phone_number claim).',
      'auth/no-phone-claim',
      true,
    );
  }
  if (!uid) {
    throw new PhoneTokenVerificationError(
      'Firebase ID token has no subject (uid).',
      'auth/no-uid-claim',
      true,
    );
  }
  return { uid, phone };
}

/** Cheap dev/test introspection — TRUE iff the Admin SDK is configured
 *  enough to verify tokens. Used by the dev-bypass detection paths. */
export async function isFirebaseAdminReady(): Promise<boolean> {
  const a = await getAdmin();
  return a !== null;
}
