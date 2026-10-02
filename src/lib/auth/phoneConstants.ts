/**
 * Phone-verification constants — safe to import from BOTH server and
 * client code paths (this file has no Prisma / Node imports). The
 * dev-bypass token literal lives here so:
 *
 *   - `<PhoneVerificationForm>` (client) can submit it without forcing
 *     a bundle of the server-only `phoneVerification.ts` service.
 *   - The server modules (`phoneVerification.ts`, the verify route) can
 *     re-export it via plain value re-exports.
 *
 * The static audit in `scripts/test-phone-verification.ts` allows the
 * literal `'dev-bypass-token'` to appear in:
 *   - this file (the single source of truth)
 *   - src/lib/auth/phoneVerification.ts (service)
 *   - src/app/api/auth/phone/verify/route.ts (route handler triple-guard)
 *
 * Anywhere else is an audit failure.
 */
export const DEV_BYPASS_TOKEN = 'dev-bypass-token';
