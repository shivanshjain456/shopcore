# ShopCore — Security Architecture & Threat Model

This document provides a comprehensive technical overview of the security posture, threat model, cryptographic boundaries, and defensive mitigations implemented in ShopCore.

---

## 1. Threat Modeling & Mitigation Matrix

| Threat Category | Attack Vector | Potential Impact | ShopCore Technical Mitigation | Code Reference |
| --------------- | ------------- | ---------------- | ----------------------------- | -------------- |
| **Financial Tampering** | Client submits modified `price` or `total` in checkout POST. | Revenue loss / purchase of goods below cost. | Zod `.strict()` schema drops or rejects client pricing fields; server recomputes totals strictly from current DB rows. | `src/lib/checkout/placeOrder.ts` |
| **Inventory Racing** | Concurrent requests attempt to claim the last available stock. | Overselling inventory beyond warehouse stock. | Atomic SQLite write transactions serialize stock decrements alongside order row insertion. | `src/lib/checkout/placeOrder.ts:180-220` |
| **Replay & Double Spend** | User re-submits order request or network retries identical payload. | Duplicate charges, double shipping, inventory exhaustion. | Mandatory `idempotency-key` header with SHA-256 payload hashing and DB unique constraint. | `src/lib/checkout/idempotency.ts` |
| **Coupon Racing** | Concurrent parallel threads use a single-use coupon simultaneously. | Excessive discounts applied across multiple orders. | Atomic DB check and increment of coupon usage counter inside checkout transaction. | `src/lib/checkout/coupon.ts` |
| **Privilege Escalation** | Compromised customer session attempts to access `/admin/*`. | Unauthorized store configuration or financial access. | Strict physical dual-cookie isolation (`sc_session` vs `sc_admin`). Admin session verified by `getCurrentUser({ requireAdmin: true })`. | `src/lib/auth/guards.ts` |
| **Session Hijacking** | Interception or theft of persistent refresh tokens. | Prolonged account compromise. | RFC 6749 refresh token family rotation. Presentation of a revoked token invalidates the entire token family. | `src/lib/auth/refresh.ts` |
| **OTP Brute Force** | Automated enumeration of 6-digit verification codes. | Account takeover via phone or email OTP. | Strict 5-attempt ceiling with attempt countdown, 60s resend cooldown, and IP/email rate limiting. | `src/lib/auth/otp.ts` |
| **CSRF Exploitation** | Cross-site malicious form submission on authenticated users. | Unauthorized state mutations (password reset, order placement). | Double-submit cookie pattern with cryptographic HMAC token (`sc_csrf` vs `x-csrf-token`) verified on all mutations. | `src/lib/security/csrf.ts` |
| **PII & Credential Leaks** | Passwords, tokens, or customer data written to server logs. | Privacy violations, compliance failure. | Automatic PII redaction engine strips sensitive keys before writing JSON logs to stdout/stderr. | `src/lib/log.ts` |
| **Metadata Exfiltration** | Uploaded product or receipt images contain GPS EXIF metadata. | Exposure of customer or facility physical locations. | Server-side Sharp pipeline strips all EXIF metadata and re-encodes images before disk storage. | `src/lib/uploads/adminImages.ts` |

---

## 2. Cryptographic Implementations & Boundaries

### 2.1 Password Hashing
- **Algorithm**: `bcryptjs` with a work factor of 12.
- **Pre-hashing Validation**: Passwords must meet minimum length requirements and pass inspection against a 13,000+ entry common-password dictionary (`src/lib/auth/commonPasswords.ts`).

### 2.2 Token Signing & Verification
- **JWT Implementation**: Signed using `jose` with symmetric `HS256`.
- **Secret Hygiene**: Derived from high-entropy environment variables (`SESSION_SECRET`, `CSRF_SECRET`). Preflight audits reject startup if secrets do not meet the 64-hexadecimal-character minimum.

### 2.3 Timing-Safe Equality
Comparisons of sensitive tokens, OTP hashes, and CSRF signatures use `crypto.timingSafeEqual()` to eliminate side-channel timing attacks.

---

## 3. Rate Limiting Policies (`src/lib/security/rateLimitPolicies.ts`)

ShopCore enforces granular in-memory token-bucket rate limits keyed by client IP, authenticated user ID, or composite keys:

| Policy Name | Scope / Target | Limit | Window | Purpose |
| ----------- | -------------- | ----- | ------ | ------- |
| `auth.login` | IP / Email | 5 attempts | 15 minutes | Protect customer login from dictionary attacks. |
| `auth.adminLogin` | IP / Email | 5 attempts | 30 minutes | Strict lockdown on administrative authentication. |
| `auth.otp_verify` | Target Identifier | 5 attempts | 10 minutes | Lockout verification after repeated failed guesses. |
| `checkout.placeOrder` | Authenticated User | 10 requests | 1 hour | Prevent automated order flooding. |
| `contact.form` | Client IP | 3 submissions | 1 hour | Block contact form spam. |
| `newsletter.subscribe` | Client IP | 5 requests | 1 hour | Prevent email subscription list flooding. |
| `pincode.lookup` | Client IP | 60 requests | 1 minute | Prevent abuse of the India Post lookup proxy. |

---

## 4. Privacy & Data Handling Guarantees

1. **Synthetic Fixtures**: All sample catalogs, seed databases, and automated test fixtures use synthetic names, dummy addresses, and test email domains (`@shopcore.test`).
2. **Payment Privacy**: ShopCore does not process or store raw credit card numbers. Manual UPI/bank transfer transactions store only the transaction reference string (UTR) and receipt images with stripped metadata.
3. **No External Trackers**: The storefront and administrative portals do not embed third-party tracking pixels, foreign font CDNs, or marketing telemetry. All static assets and fonts are self-served.
