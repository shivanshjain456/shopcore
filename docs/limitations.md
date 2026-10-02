# ShopCore — Known Limitations & Non-Goals

To maintain technical credibility and clear engineering boundaries, this document records the architectural limitations, explicit non-goals, and deliberate constraints of ShopCore.

---

## 1. Explicit Architectural Limitations

### 1.1 Single-Node SQLite Scaling Ceiling
- **Current Architecture**: Single SQLite database file (`data/store.db`) operating in WAL mode.
- **Boundaries**: Well-suited for up to ~100 concurrent active users and ~15 write transactions/second.
- **Limitation**: Not designed for multi-region horizontal scaling or distributed database clusters. Running multiple Next.js server instances pointing to the same SQLite file over network filesystems (e.g. NFS) is strongly discouraged and will cause database lock contention.
- **Upgrade Path**: The application accesses the database strictly through Prisma ORM. Upgrading to a multi-instance PostgreSQL cluster requires altering `datasource db` in `prisma/schema.prisma` and regenerating the client.

### 1.2 Manual Payment Reconciliation vs Automated Payment Gateways
- **Current Architecture**: Customer pays via UPI QR code or bank transfer, submits their 12-digit transaction reference (UTR), and uploads a payment receipt. Store administrators inspect the receipt and approve the payment from `/admin/orders`.
- **Limitation**: Order confirmation is asynchronous. It does not provide sub-second automated payment webhooks.
- **Design Rationale**: Eliminates third-party merchant onboarding friction, recurring gateway commissions (typically 2-3%), and mandatory KYC compliance for indie/local computer hardware merchants.

### 1.3 Geographic & Currency Specialization (India-Only)
- **Current Architecture**: Specialised strictly for the Indian domestic market:
  - Currency: Indian Rupee (₹ INR) denominated in paise.
  - Tax: Goods and Services Tax (GST) with GSTIN format verification and state breakdown.
  - Addresses: 6-digit Indian PIN codes integrated with India Post directories.
- **Limitation**: Multi-currency conversion, international shipping calculations, and multilingual localization are non-goals.

### 1.4 In-Process Background Job Runner
- **Current Architecture**: The job queue runner executes within the same Node.js process as the Next.js web application.
- **Limitation**: CPU-heavy tasks (e.g. batch image resizing, large database dumps) consume memory and CPU cycles shared with HTTP request handling. Under sustained high traffic, background workers should be isolated into a dedicated Node.js process.

### 1.5 Catalog Search Capabilities
- **Current Architecture**: Catalog queries use Prisma parameterized SQL matching (`contains` and compound indexes across `title`, `description`, `category`, and `brand`).
- **Limitation**: Does not feature typo-tolerant fuzzy matching, semantic vector search, or phonetics (e.g. Algolia or Elasticsearch). Sufficient for catalogs up to 10,000 SKUs.

### 1.6 Transactional Email Rate Limits
- **Current Architecture**: Free Gmail SMTP transport over port 465.
- **Limitation**: Gmail imposes a hard delivery cap of 500 emails per rolling 24-hour period. Deployments exceeding this volume must update `SMTP_HOST` in `.env` to point to a high-volume transactional provider (e.g. Amazon SES, Postmark, SendGrid).
