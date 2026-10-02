# ShopCore — Technical Interview & Recruiter Executive Summary

> **Review Time**: Under 3 minutes.
> **Audience**: Engineering Managers, Staff/Principal Engineers, and Technical Recruiters evaluating full-stack, backend, and infrastructure engineering competencies.

---

## 1. Executive Summary

**ShopCore** is a production-grade, full-stack transactional commerce platform built for the Indian computer hardware vertical (laptops, components, electronics).

Rather than presenting as a generic CRUD storefront or tutorial project, ShopCore is engineered around the rigorous operational concerns of real-world financial systems: **integer-currency accounting, zero-trust client pricing, atomic inventory race-condition protection, mutation idempotency, dual-cookie privilege separation, and self-contained background task orchestration.**

---

## 2. Key Technical Signals & Architecture Highlights

| Engineering Dimension | Implementation in ShopCore | Hiring Signal / Competency |
| --------------------- | -------------------------- | -------------------------- |
| **Financial Accuracy** | All currency is stored and calculated as 64-bit integers in Indian paise (`₹1 = 100 paise`). Floating-point arithmetic is banned from monetary code paths. | Avoidance of IEEE-754 precision drift; understanding of financial ledger integrity. |
| **Zero-Trust Pricing** | Checkout request bodies containing client-supplied pricing or discount fields are rejected with HTTP 400 (`VALIDATION_ERROR`). All totals are recomputed authoritative from the database. | Security mindset; defense against payload manipulation and client tampering. |
| **Inventory Concurrency** | Stock verification and decrements occur inside an atomic write transaction. SQLite's single-writer architecture serializes checkout races, preventing overselling. | Concurrency awareness; race condition elimination in transactional workflows. |
| **Mutation Idempotency** | Order creation requires an `idempotency-key` header. Payloads are fingerprinted via SHA-256 and locked in an atomic state machine (`PROCESSING` -> `SUCCEEDED` / `FAILED`). | Robust API design; safe retry handling in distributed/unreliable network conditions. |
| **Privilege Isolation** | Distinct physical cookie pairs for customers (`sc_session`, 30 days) and administrators (`sc_admin`, 12 hours) with separate origins and strict rate limits. | Threat modeling; prevention of horizontal/vertical privilege escalation. |
| **Session Lifecycle** | Cryptographic refresh-token family rotation (RFC 6749). Replaying an invalidated token immediately revokes all descendant tokens in the family. | Modern authentication design; defense against token theft and replay attacks. |
| **In-Process Task Engine** | SQLite-backed job queue with atomic job claims, exponential backoff, stuck-job recovery, and graceful `SIGTERM` drain. | Systems thinking; eliminating unnecessary infrastructure dependencies (Redis) when scale does not justify it. |

---

## 3. Recommended Code Review Paths

To evaluate the engineering quality in 5 minutes, inspect these core files:

1. **Transaction Safety**: [`src/lib/checkout/placeOrder.ts`](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/src/lib/checkout/placeOrder.ts)  
   *Inspect the atomic transaction boundary, UTR validation, integer total calculations, and inventory decrement logic.*
2. **Idempotency Engine**: [`src/lib/checkout/idempotency.ts`](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/src/lib/checkout/idempotency.ts)  
   *Inspect the payload fingerprinting, state transitions, and duplicate request caching.*
3. **Session & Token Rotation**: [`src/lib/auth/refresh.ts`](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/src/lib/auth/refresh.ts)  
   *Inspect the refresh token family rotation and compromise detection algorithm.*
4. **Data Model**: [`prisma/schema.prisma`](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/prisma/schema.prisma)  
   *Inspect the 52 relational models, compound indexes, and audit structures.*
5. **Master Test Runner**: [`scripts/run-all-tests.ts`](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/scripts/run-all-tests.ts)  
   *Inspect the self-contained test execution validating domain rules with zero mock servers.*

---

## 4. Key Questions for Technical Interviews

- **"Why SQLite instead of PostgreSQL?"**  
  *Discussed in [docs/design-decisions.md](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/docs/design-decisions.md). Evaluated based on targeted scale (<500 users/month, 100 concurrent), zero hosting cost, single-file atomic backups via `VACUUM INTO`, and microsecond in-process read latency.*
- **"How does the system prevent overselling under high concurrency?"**  
  *Discussed in [docs/architecture.md](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/docs/architecture.md). Evaluated through atomic database transactions and serialized writes in SQLite, verified by the `test:stock` suite.*
- **"How are client-side price tampering attacks mitigated?"**  
  *Discussed in [docs/security.md](file:///c:/Projects/workspace-019e9eb6-581a-736b-93da-8868183da1f0/shopcore/docs/security.md). Handled via strict Zod schema parsing and server-side catalog recomputation, verified by `test:price-integrity`.*
