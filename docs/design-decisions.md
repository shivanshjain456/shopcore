# Architecture Decision Records (ADRs) & Tradeoffs

This document details the critical engineering decisions, tradeoffs, and rejected alternatives across the lifecycle of ShopCore.

---

## ADR 01: SQLite in WAL Mode over Hosted Relational DB (PostgreSQL / MySQL)

### Context & Problem Statement
ShopCore is engineered for a defined target scale: ~500 active users/month, up to ~100 concurrent sessions, and 1-2 administrative operators. The infrastructure budget explicitly dictates zero recurring third-party hosting fees.

### Decision
Deploy SQLite via Prisma ORM running in Write-Ahead Logging (`WAL`) mode, storing data in a single local file (`data/store.db`).

### Tradeoffs & Alternatives Considered
- **Alternative 1: Managed PostgreSQL (AWS RDS / Supabase)**:
  - *Pros*: Out-of-the-box multi-instance scalability, native row-level locking.
  - *Cons*: Monthly infrastructure cost ($15-$50+/month minimum for reliable instances), network latency between application server and database, complex connection pooling setup.
- **Alternative 2: SQLite in WAL Mode (Chosen)**:
  - *Pros*: Zero infrastructure overhead, zero network hops (in-process microsecond reads), atomic single-file backups via `VACUUM INTO`, complete transactional ACID guarantees.
  - *Cons*: Single-writer concurrency ceiling. All write transactions are serialized.

### Mitigations for SQLite Limitations
1. **WAL Mode**: Enables concurrent read operations while a write transaction is active.
2. **Short-Lived Transactions**: Database writes in `placeOrder()` are strictly bounded (under 15ms execution time), preventing queue starvation.
3. **Automated Online Backups**: In-process background jobs execute `VACUUM INTO 'data/backups/auto_YYYYMMDD_HHMM.db'` during off-peak hours without locking active readers.

---

## ADR 02: In-Process SQLite-Backed Job Queue over Redis / BullMQ

### Context & Problem Statement
Transactional emails, abandoned cart reminders, OTP cleanup, and database vacuuming require asynchronous background processing. Introducing Redis or an external worker queue introduces operational complexity, process supervision overhead, and external failure domains.

### Decision
Implement a self-contained, SQLite-backed job queue (`src/lib/jobs/`) managed by an in-process runner inside the Next.js Node.js server.

### Tradeoffs & Alternatives Considered
- **Alternative 1: Redis + BullMQ**:
  - *Pros*: High throughput (10,000+ jobs/sec), native delayed job scheduling.
  - *Cons*: Requires running and monitoring a Redis daemon, memory consumption, two separate state stores (DB vs Queue) leading to dual-write failure modes.
- **Alternative 2: SQLite-Backed Job Queue (Chosen)**:
  - *Pros*: Zero external dependencies, jobs are created inside the same atomic database transaction as business events (e.g. creating an order and queuing its confirmation email is 100% transactional), persistent across server restarts.
  - *Cons*: Limited to the processing capacity of the single Node process.

### Operational Mitigations
- **Atomic Job Claims**: Workers claim jobs via parameterized `UPDATE` with row locking (`status='PROCESSING'`).
- **Stuck Job Reclaim**: If a process crashes while executing a job, the runner reclaims jobs whose lock has expired (`JOB_RUNNER_LOCK_TTL_MS = 300000` / 5 minutes).
- **Graceful Shutdown**: Intercepts `SIGTERM` / `SIGINT` signals, pausing new claims and granting in-flight jobs a 30-second drain window before exit.

---

## ADR 03: Integer-Paise Representation for Currency

### Context & Problem Statement
Floating-point arithmetic (IEEE 754 standard) in JavaScript and traditional database floats introduces catastrophic rounding errors in financial transactions (`0.1 + 0.2 === 0.30000000000000004`). In e-commerce, cumulative fractions of a currency unit cause balancing discrepancies in ledger rows, tax calculations, and payment provider reconciliation.

### Decision
Store and calculate all monetary quantities as 64-bit integers in Indian paise (1 INR = 100 paise). The database columns (`pricePaise`, `subtotalPaise`, `taxPaise`, `discountPaise`, `totalPaise`) and API JSON payloads strictly mandate integers.

### Tradeoffs & Alternatives Considered
- **Alternative 1: Floating Point Numbers (`number` / `Float`)**:
  - *Rejected*: Inevitable rounding discrepancies during tax and coupon calculations.
- **Alternative 2: Decimal String Objects (`decimal.js` / Prisma `Decimal`)**:
  - *Pros*: Arbitrary precision.
  - *Cons*: Serialization complexity over JSON boundaries, performance penalty in compute-heavy loops.
- **Alternative 3: Integer Paise (Chosen)**:
  - *Pros*: 100% exact math, native JSON integer compatibility, zero external math libraries required, simple comparison operations (`>` and `<`).
  - *Cons*: Requires explicit division by 100 at the presentation layer for display formatting (`₹499.00`).

---

## ADR 04: Dual-Cookie Isolation (`sc_session` vs `sc_admin`)

### Context & Problem Statement
A single session cookie carrying a role claim (`role: "ADMIN"`) introduces vulnerability to privilege escalation. If an XSS vulnerability occurs on any storefront surface, an attacker could harvest an administrator's cookie if both portals share the same session context.

### Decision
Enforce strict physical isolation between customer sessions and administrator sessions:
- `sc_session`: Customer and B2B buyers. Standard 30-day sliding TTL.
- `sc_admin`: Store administrative staff. Tighter 12-hour expiration, restricted to `/admin` paths, with independent rate limiting and stricter audit tracking.

### Tradeoffs
- *Pros*: A compromised storefront session can never be presented to `/api/admin/*` endpoints. Admin login requires a distinct authentication ceremony.
- *Cons*: Administrators who wish to browse the public storefront as regular customers maintain two distinct cookies.

---

## ADR 05: Server-Authoritative Price Recomputation

### Context & Problem Statement
A prevalent security flaw in e-commerce applications is accepting client-computed cart totals or per-item prices directly in checkout payloads (`POST /api/checkout/place-order`). Attackers routinely tamper with HTTP request bodies to submit `price: 1` for a `₹50,000` laptop.

### Decision
The checkout endpoint treats all client-supplied pricing data as hostile.
1. Mutating endpoints enforce Zod `.strict()` validation. Submitting fields like `price`, `totalPaise`, or `discount` triggers immediate `400 VALIDATION_ERROR` rejection.
2. Inside `placeOrder()`, the server looks up the product and variant from the database, retrieves the authoritative `pricePaise`, applies active B2B tier pricing if applicable, and computes subtotals, taxes, and shipping strictly on the server.

### Tradeoffs
- *Pros*: Eliminates price tampering vulnerabilities completely.
- *Cons*: Requires database read lookups during checkout execution (well within performance budgets due to local SQLite speed).

---

## ADR 06: Server-Side Sharp Processing over Third-Party Media CDNs

### Context & Problem Statement
Image processing and media hosting often rely on third-party SaaS providers (e.g. Cloudinary, Uploadcare). For self-hosted systems with privacy considerations, relying on external services creates billing unpredictability and data sovereignty questions.

### Decision
Implement image processing and normalization locally using `sharp`:
- Strip all EXIF metadata on upload to protect customer and admin privacy (preventing geolocation leakage).
- Enforce declarative image kinds (`src/lib/uploads/imageKinds.ts`): transparent assets (logos, icons) are re-encoded to optimized PNGs; photographic assets (product galleries, hero banners) are converted to high-quality progressive JPEGs.
- Local storage in `data/uploads/` with public static serving through Next.js route handlers.

### Tradeoffs
- *Pros*: Zero recurring service bills, deterministic transformations, privacy protection.
- *Cons*: Consumes local CPU and disk storage; does not provide global edge geo-caching out of the box (can be fronted by Cloudflare CDN if required).
