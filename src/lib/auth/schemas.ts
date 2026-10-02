/**
 * Zod schemas for every auth payload. Used on both server and (via re-export) client.
 * All 11 signup fields are MANDATORY per the spec.
 *
 * Feature #10 — every `email:` field below runs through the shared
 * `checkEmailPolicy()` validator (strict allowlist + plus-alias + Gmail
 * dot-obfuscation + fragmentation checks). This is the SINGLE chokepoint —
 * signup, login (customer + admin), OTP resend, OTP verify all go through
 * the same Zod schema, so adding a route automatically inherits the policy.
 */
import { z } from 'zod';
import { ZIndianState } from '@/lib/enums';
import { validatePassword, PASSWORD_POLICY } from '@/lib/auth/passwordPolicy';
import {
  checkEmailPolicy, devOnlyExtraAllowedDomains, EMAIL_POLICY_USER_MESSAGE,
} from '@/lib/auth/emailPolicy';
import { normalisePhone } from '@/lib/utils/phone';

const trimmed = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} is required.`).max(max, `${label} is too long.`);

/**
 * Phone Zod schema (Item 9). Accepts ANY format the canonical
 * `normalisePhone()` understands (bare 10 digits, leading 0,
 * `+91 / 91 / +91 9 / +91-9 / 091-9 / (+91) 9` etc.) and TRANSFORMS to the
 * canonical E.164 `+91XXXXXXXXXX`. The transform runs BEFORE validation
 * (Zod pipeline order), so any reader of `phoneSchema.parse(...)` always
 * gets a clean E.164 string.
 *
 * This is the SINGLE chokepoint — signup, profile-update, address,
 * phone-verify all reuse it, so adding a route automatically gets the
 * normalisation + validation contract.
 *
 * `<PhoneField>` always submits E.164 anyway, but the transform is the
 * server-side safety net for direct API callers (curl, Postman, future
 * mobile clients) per spec §3.7.
 */
export const phoneSchema = z
  .string()
  .trim()
  // `transform → refine` order: normalise to E.164 first, THEN refine.
  // Using `.transform(...).pipe(z.string()...)` would also work but the
  // current shape keeps `normalisePhone`'s null-return inline.
  .transform((s, ctx) => {
    const e164 = normalisePhone(s);
    if (e164 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid 10-digit Indian mobile number.',
      });
      return z.NEVER;
    }
    return e164;
  });

/** Phone-verification body schemas. Reuse `phoneSchema` (above) so the
 *  same normalisation rules apply everywhere phone numbers cross the
 *  trust boundary. `idToken` is bounded to keep memory pressure sane;
 *  Firebase tokens fit comfortably under 4KB. */
export const PhoneVerifyBodySchema = z.object({
  idToken: z.string().trim().min(8).max(8192),
  phone:   phoneSchema,
}).strict();

export const PhoneResendBodySchema = z.object({
  phone: phoneSchema,
}).strict();

export const UpdatePhoneBodySchema = z.object({
  phone: phoneSchema,
}).strict();

const pinSchema = z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits.');

/**
 * Password schema — Feature #11.
 *
 * Delegates ALL rule enforcement to the shared `validatePassword()` (which
 * is the SAME validator the client-side strength meter uses). This makes
 * the server the authority while guaranteeing UI/server can't diverge.
 *
 * NB: we intentionally do NOT have the email at the schema level — that's
 * passed into a second `assertPasswordOk(pw, { email })` check inside the
 * signup/change routes so the "password cannot contain your email name"
 * rule fires with the actual email value the user submitted.
 */
const passwordSchema = z
  .string()
  .min(PASSWORD_POLICY.minLength, `Password must be at least ${PASSWORD_POLICY.minLength} characters.`)
  .max(PASSWORD_POLICY.maxLength, `Password must be at most ${PASSWORD_POLICY.maxLength} characters.`)
  .superRefine((value, ctx) => {
    // Same validator the strength meter calls. We omit the email check
    // here because the schema doesn't have access to other fields; the
    // route handler re-runs the validator with the email after parsing
    // for that one rule. Every other rule fires at the schema layer.
    const r = validatePassword(value);
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: r.reason ?? 'Password does not meet the policy.',
      });
    }
  });

/**
 * Email schema — strict default-deny.
 *
 *  1. trim
 *  2. RFC-style basic shape check (Zod's `.email()`)
 *  3. shared policy check (`checkEmailPolicy`) — allowlist + plus-alias +
 *     gmail dot-obfuscation + fragmentation. ONE generic user-facing error
 *     so abusers can't iterate on the specific rule that fired.
 *  4. transform to the normalised lower-case form
 *
 * The dev-only exemption (`shopcore.test`) is bound to NODE_ENV — production
 * runs with the bare allowlist.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .superRefine((value, ctx) => {
    const r = checkEmailPolicy(value, { extraAllowedDomains: devOnlyExtraAllowedDomains() });
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: EMAIL_POLICY_USER_MESSAGE,
        // Forensics for server-side logs; never surfaced to UI.
        params: { policyCode: r.code, internalReason: r.internalReason },
      });
    }
  });

export const SignupSchema = z
  .object({
    firstName:    trimmed(1, 60, 'First name'),
    lastName:     trimmed(1, 60, 'Last name'),
    email:        emailSchema,
    phone:        phoneSchema,
    password:     passwordSchema,
    confirmPassword: z.string().min(1, 'Please retype your password.'),
    addressLine1: trimmed(1, 200, 'Address Line 1'),
    addressLine2: trimmed(1, 200, 'Address Line 2'),
    city:         trimmed(1, 80, 'City'),
    state:        ZIndianState,
    pinCode:      pinSchema,
    country:      z.literal('India'),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export type SignupInput = z.infer<typeof SignupSchema>;

export const OtpVerifySchema = z.object({
  email:   emailSchema,
  purpose: z.enum(['SIGNUP', 'LOGIN', 'RESET', 'EMAIL_CHANGE']),
  code:    z.string().trim().regex(/^\d{4,10}$/, 'Invalid OTP.'),
});

export const OtpResendSchema = z.object({
  email:   emailSchema,
  purpose: z.enum(['SIGNUP', 'LOGIN', 'RESET', 'EMAIL_CHANGE']),
});

export const LoginSchema = z.object({
  email:    emailSchema,
  password: z.string().min(1, 'Password is required.'),
});

export const AdminLoginSchema = LoginSchema; // same shape; role-gated server-side

// ─── Feature #12 — Forgot/Reset Password ───────────────────────────────────
const requestIdSchema = z.string().trim().min(10).max(120).regex(
  /^[A-Za-z0-9_\-]+$/, 'Invalid request identifier.',
);

export const ForgotPasswordInitiateSchema = z.object({
  email: emailSchema,
}).strict();

export const ForgotPasswordVerifyOtpSchema = z.object({
  requestId: requestIdSchema,
  code:      z.string().trim().regex(/^\d{4,10}$/, 'Invalid OTP.'),
}).strict();

export const ForgotPasswordResendSchema = z.object({
  requestId: requestIdSchema,
}).strict();

export const ForgotPasswordResetSchema = z.object({
  resetToken:      z.string().trim().min(40).max(64).regex(/^[A-Za-z0-9_\-]+$/, 'Invalid reset token.'),
  newPassword:     z.string().min(1).max(PASSWORD_POLICY.maxLength),
  confirmPassword: z.string().min(1).max(PASSWORD_POLICY.maxLength),
}).strict()
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'New password and confirmation do not match.',
    path: ['confirmPassword'],
  });
