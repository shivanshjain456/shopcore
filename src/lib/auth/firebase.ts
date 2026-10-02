/**
 * Optional Firebase Admin mirror.
 *
 * When FIREBASE_SERVICE_ACCOUNT_JSON (or _PATH) is configured we mirror users
 * into Firebase Auth so you can use Google's identity vault + future federated
 * login. When NOT configured we no-op gracefully (dev convenience).
 *
 * IMPORTANT: All real auth decisions live in this codebase. Firebase is the
 * mirror, not the master, because we need email-OTP (Firebase Auth doesn't
 * natively send 6-digit codes to email).
 */
import fs from 'node:fs';
import { env } from '@/lib/config';
import { log } from '@/lib/log';

type Admin = typeof import('firebase-admin');

let _admin: Admin | null = null;
let _disabled = false;

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

async function getAdmin(): Promise<Admin | null> {
  if (_disabled) return null;
  if (_admin) return _admin;

  const svc = loadServiceAccount();
  if (!svc) {
    _disabled = true;
    if (env.NODE_ENV !== 'test') {
      log.warn('firebase.mirror.disabled', { reason: 'service_account_not_configured' });
    }
    return null;
  }

  const admin: Admin = (await import('firebase-admin')) as unknown as Admin;
  if (!admin.apps?.length) {
    admin.initializeApp({
      credential: admin.credential.cert(svc as Parameters<typeof admin.credential.cert>[0]),
      projectId: env.FIREBASE_PROJECT_ID,
    });
  }
  _admin = admin;
  return admin;
}

export async function mirrorUserToFirebase(user: {
  id: string; email: string; firstName: string; lastName: string; phone: string;
}): Promise<string | null> {
  const admin = await getAdmin();
  if (!admin) return null;
  try {
    const auth = admin.auth();
    const displayName = `${user.firstName} ${user.lastName}`.trim();
    // Try create; if exists, fetch by email.
    try {
      const rec = await auth.createUser({
        uid: user.id, email: user.email, emailVerified: true,
        displayName, phoneNumber: user.phone || undefined, disabled: false,
      });
      return rec.uid;
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
        const rec = await auth.getUserByEmail(user.email);
        return rec.uid;
      }
      throw e;
    }
  } catch (e) {
    log.warn('firebase.mirror.failed', { err: (e as Error).message });
    return null;
  }
}

export async function disableUserInFirebase(uid: string): Promise<void> {
  const admin = await getAdmin();
  if (!admin || !uid) return;
  try { await admin.auth().updateUser(uid, { disabled: true }); }
  catch (e) { log.warn('firebase.disable.failed', { err: (e as Error).message }); }
}
