'use client';
/**
 * Browser-only Firebase JS SDK singleton for Phone Authentication.
 *
 * This module is the ONLY place where the Firebase JS SDK is initialised
 * on the client. `<PhoneVerificationForm>` reads `getFirebaseAuth()` /
 * `isFirebaseConfigured()` from here and never touches the SDK directly.
 *
 * Strict separation:
 *   - This file initialises the *client* SDK (`firebase` npm package).
 *   - `src/lib/auth/firebasePhone.ts` initialises the *Admin* SDK
 *     (`firebase-admin` npm package, server-only).
 * The two SDKs maintain SEPARATE app registries — they don't collide.
 *
 * Static-audit invariant: this file must not import from `firebase-admin`
 * — the test suite walks `'use client'` files and asserts zero
 * firebase-admin imports.
 *
 * Safe to import from any component — never throws on import; misuse of
 * a `null` return is the caller's problem.
 */
import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _initTried = false;

/** True iff all three NEXT_PUBLIC_FIREBASE_* env vars are present at
 *  build time (Next.js embeds them via `process.env.NEXT_PUBLIC_*`
 *  string substitution). */
export function isFirebaseConfigured(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY
    && process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
    && process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  );
}

/** Get-or-init the Firebase Auth instance. Returns `null` when:
 *    - called from SSR (no `window`)
 *    - or any NEXT_PUBLIC_FIREBASE_* var is missing
 *    - or initialisation throws (logged to console.warn).
 *
 *  The caller treats `null` as "Firebase not available — fall back to
 *  the dev-bypass UI" (which the form does in non-prod).
 */
export async function getFirebaseAuth(): Promise<Auth | null> {
  if (typeof window === 'undefined') return null;
  if (_auth) return _auth;
  if (!isFirebaseConfigured()) return null;
  if (_initTried && !_auth) return null;
  _initTried = true;

  try {
    const { initializeApp, getApps, getApp } = await import('firebase/app');
    const { getAuth } = await import('firebase/auth');

    if (getApps().length === 0) {
      _app = initializeApp({
        apiKey:     process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
        appId:      process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
        projectId:  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.split('.')[0],
      });
    } else {
      _app = getApp();
    }
    _auth = getAuth(_app);
    return _auth;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[firebase-client] init failed:', (e as Error).message);
    return null;
  }
}
