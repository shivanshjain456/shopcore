/**
 * Password hashing — bcrypt at cost 12.
 * Always use `verifyPassword` for compare; bcrypt is constant-time internally.
 */
import bcrypt from 'bcryptjs';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Password policy used at signup/reset.
 * Keep this in one place so client and server stay in sync.
 */
export const PASSWORD_RULES = {
  minLength: 10,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: false, // optional; common symbols on Indian keyboards can be a pain
};

export function validatePasswordPolicy(pw: string): { ok: true } | { ok: false; reason: string } {
  if (pw.length < PASSWORD_RULES.minLength) {
    return { ok: false, reason: `Password must be at least ${PASSWORD_RULES.minLength} characters.` };
  }
  if (PASSWORD_RULES.requireUpper && !/[A-Z]/.test(pw)) {
    return { ok: false, reason: 'Password must contain an uppercase letter.' };
  }
  if (PASSWORD_RULES.requireLower && !/[a-z]/.test(pw)) {
    return { ok: false, reason: 'Password must contain a lowercase letter.' };
  }
  if (PASSWORD_RULES.requireDigit && !/[0-9]/.test(pw)) {
    return { ok: false, reason: 'Password must contain a digit.' };
  }
  if (PASSWORD_RULES.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) {
    return { ok: false, reason: 'Password must contain a symbol.' };
  }
  return { ok: true };
}
