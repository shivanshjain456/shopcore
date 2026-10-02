# Contributing to ShopCore

Thank you for your interest in contributing to ShopCore. This document outlines our development process, code standards, testing discipline, and pull request checklist.

---

## 1. Development Principles

ShopCore is built with production-grade engineering standards. Every contribution is held to high technical rigor:

1. **Financial Precision**: Money is always an integer representing Indian paise (₹1 = 100 paise). Floating-point currency math is prohibited.
2. **Server-Authoritative State**: Never trust client inputs for prices, discounts, inventory levels, or permissions. Recompute state from the database.
3. **Structured Error Handling**: All operational errors must route through the `ShopCoreError` hierarchy. Stack traces and database internal schema names must never leak to HTTP clients.
4. **Discipline over Hacks**: No rogue `console.log` statements in library or API code. No native blocking dialogs (`alert`, `confirm`, `prompt`). Use the native `<AppDialog>` component.
5. **Verified Quality**: Every feature or bugfix must include automated tests that prove the claim or fix.

---

## 2. Local Development Setup

### Prerequisites
- Node.js >= 20.0.0
- npm >= 10.0.0
- Git

### Initial Setup Steps

```bash
# 1. Clone the repository
git clone https://github.com/shivanshjain456/shopcore.git
cd shopcore

# 2. Install dependencies
npm install --no-audit --no-fund

# 3. Configure environment variables
cp .env.example .env
# Open .env and adjust SESSION_SECRET, CSRF_SECRET, and database path if needed

# 4. Initialize Database
npx prisma migrate deploy
npx prisma generate
npm run db:seed

# Optional: seed realistic demo catalog with products and variants
npm run db:seed:products

# 5. Verify local health
npm run preflight

# 6. Start development server
npm run dev
# The storefront will be accessible at http://localhost:3000
# The admin portal will be accessible at http://localhost:3000/admin
```

---

## 3. Code Standards & Architectural Rules

- **Schema-First API Routes**: Every request body must be validated using Zod with `.strict()` where pricing or state mutations are involved.
- **Structured Logging**: Use `log.info()`, `log.warn()`, and `log.error()` from `@/lib/log`. Never use raw `console.log` in `src/lib/**` or `src/app/api/**`.
- **UI & Accessibility**:
  - Interactive elements must have visible `:focus-visible` outlines.
  - Buttons and interactive items on mobile must meet the 44px tap target (`.tap-target` utility class).
  - Animations must respect `prefers-reduced-motion`.
- **Database Migrations**:
  - Never run `prisma migrate dev` on a shared or production database.
  - New schema changes must be committed via versioned migration files in `prisma/migrations/`.

---

## 4. Testing & Verification

Before submitting changes, ensure all automated verification checks pass:

```bash
# Run the master test suite (unit, model, security, and component tests)
npm test

# Run ESLint across all source files
npm run lint

# Run preflight database and migration integrity check
npm run preflight

# Verify that the production build compiles without errors
npm run build
```

Individual test suites can be run for specific features:
- `npm run test:auth`: Authentication lifecycle, OTP, password policies
- `npm run test:loyalty`: Integer point math, cashback rules, and order ledger
- `npm run test:variant-price`: Price integrity and variant price resolution
- `npm run test:dialog`: Accessible modal dialog state and promise resolution
- `npm run test:responsive`: Responsive layout contracts and tap target compliance
- `npm run test:no-native-dialogs`: Static audit scanning for unhandled native alerts

---

## 5. Pull Request Guidelines

1. **Branch Naming**: Use descriptive branches like `feature/inventory-reservation`, `fix/loyalty-rounding`, or `docs/architecture-update`.
2. **Commit Messages**: Write clear, descriptive commit messages outlining the problem solved and rationale.
3. **Pull Request Description**:
   - What changed and why?
   - How was it tested? Include command outputs or test references.
   - Any database migrations or schema adjustments involved.
4. **CI Requirement**: Pull requests must pass all checks in GitHub Actions (`.github/workflows/ci.yml`) before being merged.
