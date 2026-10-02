# Security Policy

ShopCore is built with security-first financial and transactional engineering principles. This document outlines our security model, threat mitigations, and responsible disclosure procedures.

---

## 1. Supported Versions

| Version | Supported          | Security Maintenance Status |
| ------- | ------------------ | --------------------------- |
| 0.1.x   | :white_check_mark: | Active                      |

---

## 2. Reporting a Vulnerability

We take the security of ShopCore seriously. If you discover a security vulnerability, please report it responsibly.

- **Private Disclosure**: Do not create public GitHub issues for security vulnerabilities.
- **Reporting Channel**: Send an email to `security@yourdomain.in` or use GitHub Private Vulnerability Reporting on the repository.
- **Report Details**: Include:
  - Description of the vulnerability and potential impact
  - Step-by-step reproduction instructions or proof-of-concept payload
  - Affected endpoint(s), parameter(s), or component(s)
  - Suggested remediation, if known
- **Response Timeline**:
  - Initial acknowledgment: within 24 hours
  - Triage and severity confirmation: within 72 hours
  - Remediation patch release: within 7 days for critical findings

---

## 3. Security Architecture & Threat Mitigations

ShopCore incorporates defense-in-depth protections across financial transactions, authentication, session isolation, and data integrity:

### 3.1 Financial & Transaction Safety
- **Integer-Paise Money**: All currency values (`pricePaise`, `subtotalPaise`, `taxPaise`, `discountPaise`, `totalPaise`) are stored and calculated as 64-bit integers. Floating-point arithmetic is strictly prohibited in monetary code paths.
- **Zero-Trust Client Pricing**: The server never trusts client-submitted prices, subtotals, discounts, or shipping values. All totals are recomputed authoritative from current database records inside `placeOrder()`. Any unknown pricing fields in request payloads trigger immediate rejection via Zod strict schemas (`400 VALIDATION_ERROR`).
- **Atomic Stock Protection**: Inventory checks and decrements execute within an atomic SQLite write transaction. Concurrent checkout races are serialized by SQLite's single-writer architecture, eliminating double-allocation and overselling.
- **Strict Idempotency**: Order mutations require an `idempotency-key` header. The system tracks state transitions (`PROCESSING` -> `SUCCEEDED` / `FAILED`) via a unique constraint on `(userId, idempotencyKey)`. Concurrent duplicate submissions receive cached responses rather than duplicating orders or charges.

### 3.2 Authentication & Session Boundaries
- **Dual-Cookie Separation**: Customer and admin authentication use distinct cookie pairs:
  - `sc_session`: Customer and B2B user tokens (HttpOnly, SameSite=Strict).
  - `sc_admin`: Store administrator tokens (HttpOnly, SameSite=Strict, tighter 12-hour TTL).
  - A compromised customer session cannot elevate to administrative endpoints.
- **Refresh Token Rotation**: Refresh tokens are issued within cryptographic families. Each token is single-use. If a token reuse event is detected, the entire family is immediately revoked, neutralizing stolen credentials.
- **Password Security**: Passwords are hashed using bcrypt with work factor 12. Signup and password updates enforce a 13,000+ common-password blocklist and complexity scoring.

### 3.3 Anti-Fraud & Payment Integrity
- **UTR Validation**: Manual UPI/IMPS/NEFT transaction references (UTR) undergo structural format validation, checksum verification, and known fraud-pattern heuristics.
- **Receipt Image Hardening**: Uploaded receipt proofs are inspected with byte-level MIME sniffing, stripped of all EXIF metadata via `sharp`, and converted to safe image containers before storage.

### 3.4 Request Defense & Rate Limiting
- **CSRF Defense**: All mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) require a valid `x-csrf-token` header matching the signed double-submit `sc_csrf` cookie using timing-safe comparison.
- **Rate Limiting**: Multi-tiered rate limiting policies are enforced in `src/lib/security/rateLimitPolicies.ts`, guarding login endpoints (5 attempts per 15 min), OTP dispatch, password reset requests, and catalog scraping.
- **PII Scrubbing**: Server-side structured logs pass through an automated redaction pipeline (`src/lib/log.ts`) that strips passwords, tokens, full payment details, and personal identifiable information prior to log persistence.

---

## 4. Production Deployment Guidelines

When deploying ShopCore to production:
1. Generate high-entropy secrets for `SESSION_SECRET` and `CSRF_SECRET` (minimum 64 hexadecimal characters via `openssl rand -hex 32`).
2. Run behind a reverse proxy (e.g. Nginx, Caddy, or Cloudflare) configured for TLS 1.3 with HSTS enabled.
3. Restrict SQLite database and backup file permissions (`chmod 600 data/store.db`).
4. Keep `NODE_ENV=production` set so debug error details and internal traces remain suppressed from client responses.
