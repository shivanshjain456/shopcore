# ShopCore — Testing Strategy & Verification Architecture

ShopCore employs an exhaustive, multi-layered verification strategy designed to prove transaction safety, mathematical accuracy, security boundaries, and responsive accessibility without depending on external network services.

---

## 1. Testing Philosophy & Guarantees

1. **Zero External Flakiness**: Tests run entirely self-contained. No live SMTP servers, paid SMS gateways, external APIs, or third-party credentials are required.
2. **Deterministic Assertions**: Tests assert on exact values, state machines, and relational database constraints rather than snapshot matching or fuzzy assertions.
3. **Defense-in-Depth Verification**: Every critical domain capability is validated across three distinct tiers:
   - **Tier 1 (Unit & Math)**: Pure functions (integer currency calculations, loyalty algorithms, phone normalizers).
   - **Tier 2 (Static Architecture Audits)**: AST and regex scanning across the entire codebase to prevent regressions (e.g. banning `console.log` in API routes, banning `window.alert`, enforcing tap targets).
   - **Tier 3 (Component & DOM)**: JSDOM accessibility compliance, focus management, ARIA roles, and keyboard navigation.
   - **Tier 4 (Integration & Database)**: Real SQLite transactions, foreign key constraints, atomic rollback verification, and concurrent race condition simulation.

---

## 2. Master Verification Test Suite (`npm test`)

The primary test runner (`scripts/run-all-tests.ts`) executes 13 core suites comprising hundreds of assertions in ~30 seconds:

| Suite | Execution File | Assertions | Core Engineering Claims Verified |
| ----- | -------------- | ---------- | -------------------------------- |
| `preflight` | `scripts/preflight.ts` | 7 checks | SQLite file integrity, migration alignment, StoreConfig initialization, job queue health. |
| `test:no-native-dialogs` | `scripts/test-no-native-dialogs.ts` | 446 files | Static audit ensuring zero unhandled `alert()`, `confirm()`, or `prompt()` calls across all source files. |
| `test:loyalty` | `scripts/test-loyalty.ts` | 32 assertions | Exact paise-level cashback calculation across percentage/amount modes, cap clamping, order value floors, and re-verification idempotency. |
| `test:variant-price` | `scripts/test-variant-price.ts` | 39 assertions | Pure variant selector logic, fallback pricing, and server-authoritative cart line item assignment in SQLite. |
| `test:dialog` | `scripts/test-dialog.tsx` | 84 assertions | Modal lifecycle, HTML5 `<dialog>` polyfills, focus trapping, Escape cancellation, ARIA attributes, and double-open conflict prevention. |
| `test:hero-carousel` | `scripts/test-hero-carousel.tsx` | 61 assertions | WAI-ARIA carousel compliance (`role="region"`, `aria-roledescription`), timer leak detection on unmount, and keyboard/touch navigation. |
| `test:otp-input` | `scripts/test-otp-input.tsx` | 54 assertions | 6-slot OTP component, numeric input mode, keyboard auto-advance, backspace navigation, paste handling, and ARIA labels. |
| `test:share-dialog` | `scripts/test-share-dialog.tsx` | 60 assertions | Native `navigator.share` fallback, per-channel UTM parameter tracking, and clipboard write fallback. |
| `test:responsive` | `scripts/test-responsive.tsx` | 51 assertions | Viewport meta settings, 44px tap target enforcement, safe-area inset variables, and responsive table overflow containers. |
| `test:logout-ui` | `scripts/test-logout-ui.tsx` | 42 assertions | Client state cleanup, cookie invalidation requests, and bfcache navigation guards. |
| `test:image-upload-input` | `scripts/test-image-upload-input.tsx` | 37 assertions | Drag-and-drop file upload, client-side MIME type filtering, CSRF header propagation, and Sharp thumbnail feedback. |
| `test:pincode-ui` | `scripts/test-pincode-ui.tsx` | 38 assertions | Debounced 6-digit Indian PIN code queries, race-condition mitigation on fast typing, and auto-filling city/state. |
| `test:auth` | `scripts/test-auth.ts` | 18 assertions | Complete authentication lifecycle: user creation, verification code issuance, brute-force lockout, bcrypt hashing, and password validation. |

---

## 3. High-Risk Financial & Transactional Suites

Beyond the standard test runner, ShopCore provides specialized simulation harnesses for high-risk transactional vectors:

### 3.1 Server-Side Price Integrity (`test:price-integrity`)
- **Threat Model**: Hostile client intercepts checkout and injects forged pricing fields (`totalPaise: 100`, `discountPaise: 9999999`, `shippingPaise: -50000`).
- **Test Strategy**: Spawns live HTTP requests against the application, verifying:
  1. Requests containing extraneous pricing fields are rejected with HTTP 400 (`VALIDATION_ERROR`).
  2. Legitimate orders calculate totals strictly from current database catalog rows.
  3. The persisted `Order` row in SQLite matches a deterministic SHA-256 fingerprint of canonical server calculations.

### 3.2 Inventory Race Condition Protection (`test:stock`)
- **Threat Model**: 10 users simultaneously attempt to purchase the last 3 units of an item.
- **Test Strategy**: Executes concurrent asynchronous requests against stock levels:
  1. Verifies that SQLite write serialisation prevents overselling.
  2. Asserts that exactly 3 orders succeed and exactly 7 requests are rejected with `400 INSUFFICIENT_STOCK`.
  3. Confirms that catalog stock never drops below zero.

### 3.3 Mutation Idempotency (`test:idempotency`)
- **Threat Model**: Network timeout causes client retry, or aggressive user double-clicks "Place Order".
- **Test Strategy**: Fires 10 parallel HTTP POST requests with identical `idempotency-key` headers:
  1. Verifies that only a single `Order` row is created in the database.
  2. Confirms that duplicate requests receive identical response payloads from the idempotency cache.

---

## 4. Running the Tests Locally

```bash
# Execute master test suite (Unit, Component, Security, and Math)
npm test

# Run individual standalone test scripts
npm run test:auth
npm run test:loyalty
npm run test:variant-price
npm run test:dialog
npm run test:responsive
npm run test:pincode-ui
```
