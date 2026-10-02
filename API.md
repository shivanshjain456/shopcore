# ShopCore — API reference

All responses are JSON in the shape:

```json
{ "ok": true,  "data": { … } }                                              // 2xx
{ "ok": false, "error": "…", "code": "ERROR_CODE",
  "issues": [{ "path": "…", "message": "…" }] }                              // 4xx/5xx
```

**Error envelope (stable public contract):**

- `ok: false` — always present on non-2xx responses
- `error: string` — human-readable, safe-to-display message (NEVER carries stack traces or internal detail)
- `code: string` — stable machine-readable identifier in `SCREAMING_SNAKE_CASE`
  (`EMAIL_TAKEN`, `RATE_LIMITED`, `VALIDATION_ERROR`, `CSRF_ERROR`, etc.).
  **Treat as public API** — clients may switch on these. New codes are
  additive; existing codes are never renamed without deprecation.
- `issues?: Array<{ path, message }>` — present on `VALIDATION_ERROR` for
  form-field-level error rendering
- `retryAfterSeconds?: number` — present on some 429 bodies (alongside
  the `Retry-After` HTTP header)

**Standard status → code mapping** (routed through `src/lib/errors.ts`):

| Status | Code(s) | Cause |
|---|---|---|
| 400 | `VALIDATION_ERROR` + (caller code), `INVALID_CRON`, `INVALID_JOB_PAYLOAD` | Zod / business-rule failure; bad cron expression on `PATCH /api/admin/job-schedules/[id]`; payload doesn't match the worker's Zod schema (Item 7) |
| 401 | `UNAUTHENTICATED` | No session / expired token |
| 403 | `CSRF_ERROR`, `FORBIDDEN`, `ACCOUNT_NOT_ORDER_PERMITTED`, `ACCOUNT_NOT_WRITE_PERMITTED` | CSRF / role insufficient / account state gates ordering or write surfaces (D2.2, D2.3) |
| 404 | `NOT_FOUND`, `RECORD_NOT_FOUND` | Entity missing |
| 409 | `CONFLICT`, `UNIQUE_CONSTRAINT`, `ILLEGAL_TRANSITION`, `FK_CONSTRAINT`, `CONCURRENT_MODIFICATION`, `INSUFFICIENT_STOCK`, `COUPON_EXHAUSTED`, `JOB_NOT_RETRYABLE`, `JOB_NOT_CANCELLABLE` | DB conflict / state-machine refusal / lost a stock or coupon race at commit time (D4.4, D5.2); admin tried to retry a non-FAILED job or cancel a non-PENDING job (Item 7) |
| 429 | `RATE_LIMITED` (+ subclass codes) | Rate-limit exceeded; `Retry-After` header set |
| 502 | `EXTERNAL_SERVICE_ERROR` (+ subclass codes) | Firebase / SMTP / India Post upstream failure |
| 500 | `INTERNAL_ERROR`, `DB_TIMEOUT`, `DB_INIT_FAILURE`, `PRISMA_ERROR` | Truly unexpected |

Response bodies **never** contain stack traces or Prisma column names — both
sit in the server logs (auto-redacted by `src/lib/log.ts`).

Headers in/out:

- `x-csrf-token` — **required** on every `POST/PUT/PATCH/DELETE` (mirrors the `sc_csrf` cookie). Get the value from `GET /api/auth/csrf`.
- `x-request-id` — **server-generated** on every request by middleware and returned in the response. Use the *response* value for log correlation. Inbound `x-request-id` headers are intentionally ignored and overwritten (edge case D9.7 — log-injection mitigation).

Auth cookies:

- `sc_session` — customers + B2B (HttpOnly + SameSite=Strict)
- `sc_admin`   — admin (separate cookie; 12-hour TTL; tighter rate limits)
- `sc_csrf`    — readable double-submit token

---

## Pagination envelope (Item 12)

Every list endpoint marked **[PAGINATED]** or **[CURSOR-PAGINATED]**
below returns one of the two canonical envelopes. The legacy
`{ data: { products|orders|reviews|… } }` shapes are gone — every list
sits behind `data.items` and ships pagination metadata next to it.

**Offset pagination (default)** — `[PAGINATED]`:

```json
{
  "ok": true,
  "data": {
    "items": [ /* …rows… */ ],
    "pagination": {
      "total":       247,
      "page":        3,
      "pageSize":    20,
      "totalPages":  13,
      "hasNextPage": true,
      "hasPrevPage": true
    }
  }
}
```

**Cursor pagination** — `[CURSOR-PAGINATED]` (audit log; admin/orders
when `?cursor=` is present). Trades `total` for cheap O(1) navigation
on growing tables:

```json
{
  "ok": true,
  "data": {
    "items": [ /* …rows… */ ],
    "pagination": {
      "total":       null,
      "nextCursor":  "cl9abcdef…",
      "prevCursor":  "cl9xyz…",
      "pageSize":    50,
      "hasNextPage": true,
      "hasPrevPage": true
    }
  }
}
```

**Query parameters** (accepted on every paginated endpoint):

| Param | Type | Default | Notes |
|---|---|---|---|
| `page`     | positive integer | `1`                                              | Offset mode only. `?page=abc` → `400 INVALID_PAGINATION_PARAMS`. |
| `pageSize` | positive integer | `performance.paginationDefaultSize` (default 20) | Clamped to `performance.paginationMaxSize` (default 100) — silent (server logs `pagination.size_clamped`). |
| `cursor`   | cuid-ish string  | –                                                | Cursor mode. Empty string = first page. Garbage → `400 INVALID_PAGINATION_PARAMS`. |

**Per-endpoint defaults** override `paginationDefaultSize`:

| Endpoint | `defaultPageSize` |
|---|---|
| `/api/products`              | 24 (storefront 4×6 grid) |
| `/api/admin/audit-log`       | 50 |
| `/api/admin/{brands,categories}` | 50 |
| `/api/account/{orders,returns,reviews,tickets}` | 10 |
| everything else              | `performance.paginationDefaultSize` |

**Page-out-of-range behaviour** — at the API level,
`page > totalPages` returns `200 { items: [] }`. Server-rendered
storefront pages (`/c/[slug]`, `/search`, `/wishlist`, `/account/orders`)
layer on a `redirect()` to page 1 (Spec §2.8).

**SEO behaviour (Phase 2)** — storefront paginated pages
(`/c/[slug]`, `/search`, `/wishlist`) emit `<link rel="canonical">`
pointing at the **current** page (not page 1 — current Google guidance),
`<link rel="prev">` / `<link rel="next">` for older crawlers, and
`<meta name="robots" content="noindex,follow">` once `currentPage >=
performance.paginationNoindexFromPage` (default 2). The wishlist page
is always `noindex` (per-user content). The `/search` page with empty
`q` is always `noindex` (empty shell).

---

## Public — health & boot

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Always 200 if process up |
| GET | `/api/ready`  | 200 only if DB + StoreConfig + safety checks all green; 503 otherwise |

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| GET  | `/api/auth/csrf` | – | Ensures `sc_csrf` cookie + returns token |
| POST | `/api/auth/signup` | 11 mandatory fields + optional `ref` (referral) | Creates PENDING_OTP user, emails OTP |
| POST | `/api/auth/otp/verify` | `{email,purpose,code}` | Flips PENDING_OTP → **PENDING_PHONE_VERIFICATION** (was ACTIVE); response now includes `nextStep: 'PHONE_VERIFICATION'` + `redirectTo: '/verify-phone'` when more steps are required |
| POST | `/api/auth/phone/verify` | `{idToken,phone}` | Phone Verification — Firebase Admin verifies the SMS-OTP-derived ID token, 3-way phone cross-check, transitions PENDING_PHONE_VERIFICATION → ACTIVE. Errors: `INVALID_FIREBASE_TOKEN` (401), `PHONE_MISMATCH` (400), `PHONE_TAKEN` / `PHONE_ALREADY_LINKED` (409), `INVALID_STATE` (400), `DEV_BYPASS_REJECTED` (400, prod-only). Rate-limit 5/15min/IP + 3/hr/userId |
| POST | `/api/auth/phone/resend-otp` | `{phone}` | Server gate before client re-triggers Firebase SMS (route does NOT send SMS). 3/hr/IP |
| POST | `/api/auth/otp/resend` | `{email,purpose}` | 60 s cooldown, 5/hour cap |
| POST | `/api/auth/login` | `{email,password}` | Password OK → emails LOGIN OTP |
| POST | `/api/auth/admin/login` | `{email,password}` | ADMIN only; tighter rate limit (3/15 min) |
| POST | `/api/auth/logout` | – | Revokes session row, clears both cookies |
| GET  | `/api/auth/me` | – | Current user summary (incl. B2B tier if applicable) |
| POST | `/api/auth/check-email` | `{email}` | Feature #11 — `{available: bool\|null}`, 10/min/IP, same-origin |
| POST | `/api/auth/forgot-password/initiate`   | `{email}`                                      | Feature #12 — generic envelope (enumeration-safe); 10/hr/IP + 3/hr/(IP+email) |
| POST | `/api/auth/forgot-password/verify-otp` | `{requestId,code}`                             | Feature #12 — returns single-use `resetToken` on success; 30/10-min/IP |
| POST | `/api/auth/forgot-password/resend`     | `{requestId}`                                  | Feature #12 — 60s cooldown + per-IP cap; obeys `maxOtpIssue` request ceiling |
| POST | `/api/auth/forgot-password/reset`      | `{resetToken,newPassword,confirmPassword}`     | Feature #12 — runs Feature #11 validator; revokes all refresh families |
| POST | `/api/account/password` | `{currentPassword,newPassword,confirmPassword}` | Feature #11 — change pw; revokes all sessions |
| PATCH | `/api/account/profile` | `{firstName?,lastName?,email?,phone?}` | Feature #11 — uniqueness check excludes self |
| PATCH | `/api/account/phone` | `{phone}` | Phone Verification — updates phone, clears verification, transitions ACTIVE → PENDING_PHONE_VERIFICATION, revokes ALL refresh families (forces re-login). 3/hr/userId |

## Catalog

| Method | Path | Notes |
|---|---|---|
| GET | `/api/categories` | with product counts. Item 17 — also surfaces `imageUrl`, `bannerUrl`, `iconUrl`, `description` per category for the storefront tiles / nav / banner. |
| GET | `/api/brands`     | active brands. Item 17 — also surfaces `logoUrl` + `description` so the homepage brand band and brand filter chips render real logos. |
| GET | `/api/products?q=&category=&brand=&min=&max=&sort=&instock=&page=&pageSize=` | role-aware pricing **[PAGINATED]** (default `pageSize=24` — storefront 4×6 grid) |
| GET | `/api/products/[slug]` | full detail + variants + ACTIVE-filtered gallery images (Item 19 — `isPrimary desc, sortOrder asc`) |

## Homepage CMS (Item 18)

The storefront homepage is admin-composable. Sections are typed by `kind` (one of 13: `HERO`, `FEATURED_BRANDS`, `TOP_CATEGORIES`, `PRODUCT_COLLECTION`, `MOST_RATED_PRODUCTS`, `TRENDING_PRODUCTS`, `WIDE_PROMO_BANNER`, `DUAL_PROMO_CARDS`, `BRAND_SHOWCASE`, `STORE_METRICS`, `WHY_SHOP_WITH_US`, `BRANCHES`, `NEWSLETTER`); each kind's `config` JSON is validated by a dedicated Zod schema in `src/lib/cms/homepageSchemas.ts`. Sections support display order, soft-disable, and scheduling windows (`startsAt` / `endsAt`). The admin editor lives at `/admin/homepage` (Sections / Metrics / Branches tabs).

### Public

| Method | Path | Notes |
|---|---|---|
| GET | `/api/homepage` | Server-resolved composition: `{ enabled, sections: [{ id, kind, slug, config, …per-kind-data }] }`. Public; gated by `features.homepageRevampEnabled` (returns `{ enabled: false, sections: [] }` when off). `Cache-Control: public, max-age=30, stale-while-revalidate=60`. Resolved data (products / brands / categories / metrics / branches) is batched into one `Promise.all` server-side — no N+1. Per-section resolution is best-effort: one bad config row is logged + dropped, never crashes the page. |
| POST | `/api/newsletter/subscribe` | Item 18 Phase 2 — public newsletter capture. Body: `{ email }` (plus optional `website` honeypot field). CSRF required. Rate-limited per IP (`newsletter.subscribe` policy — 5 / hour). Response is **uniform** `{ ok: true, data: { received: true } }` regardless of whether the email matches an existing account — this prevents enumeration. Internally: if a `User` with this email exists, flips `emailSubscribed=true` (idempotent); otherwise enqueues a `SEND_EMAIL` job to `notifications.adminEmail` so the operator can fold the lead into their CRM. Honeypot triggers silent 200. Bad email returns `400 VALIDATION_ERROR`. |

### Admin — sections

| Method | Path | Notes |
|---|---|---|
| GET    | `/api/admin/homepage/sections`         | List every section (incl. inactive + future) + `availableKinds` enum. Admin-only. |
| POST   | `/api/admin/homepage/sections`         | Create a section. Body: `{ kind, slug, title?, displayOrder?, isActive?, startsAt?, endsAt?, config }`. `kind` is rejected if not in `HOMEPAGE_SECTION_KINDS`; `config` is Zod-validated per-kind. Audits `HOMEPAGE_SECTION_CREATE`. |
| PATCH  | `/api/admin/homepage/sections/[id]`    | Patch any subset of `{ title, displayOrder, isActive, startsAt, endsAt, config }`. Audits `HOMEPAGE_SECTION_UPDATE`. |
| DELETE | `/api/admin/homepage/sections/[id]`    | Idempotent delete. Audits `HOMEPAGE_SECTION_DELETE`. |
| POST   | `/api/admin/homepage/sections/reorder` | Atomic reorder: `{ orderedIds: string[] }`. Re-numbers `displayOrder` in 10s. Audits `HOMEPAGE_SECTION_REORDER`. |

### Admin — metrics + branches

| Method | Path | Notes |
|---|---|---|
| GET    | `/api/admin/homepage/metrics`          | List trust-metric tiles. |
| POST   | `/api/admin/homepage/metrics`          | Create a metric `{ label, value, caption?, iconUrl?, displayOrder?, isActive? }`. Audits `HOMEPAGE_METRIC_UPDATE`. |
| PATCH  | `/api/admin/homepage/metrics/[id]`     | Patch a metric. Audits `HOMEPAGE_METRIC_UPDATE`. |
| DELETE | `/api/admin/homepage/metrics/[id]`     | Delete a metric. Audits `HOMEPAGE_METRIC_UPDATE`. |
| GET    | `/api/admin/homepage/branches`         | List physical-store branches. |
| POST   | `/api/admin/homepage/branches`         | Create a branch `{ name, city, address?, phone?, imageUrl?, linkUrl?, displayOrder?, isActive? }`. Audits `HOMEPAGE_BRANCH_UPDATE`. |
| PATCH  | `/api/admin/homepage/branches/[id]`    | Patch a branch. Audits `HOMEPAGE_BRANCH_UPDATE`. |
| DELETE | `/api/admin/homepage/branches/[id]`    | Delete a branch. Audits `HOMEPAGE_BRANCH_UPDATE`. |

### Admin-only preview mode

Anonymous + non-admin viewers hitting the storefront root see the published composition (active + in-window sections only). A signed-in `ADMIN` can append `?preview=admin` to `/` (or any storefront page that renders the gallery) to bypass the active + window filter — disabled / scheduled-future / scheduled-past sections render with an amber "Preview mode" banner. The query param is verified server-side via `getCurrentUser({ requireAdmin: true })`; it is silently ignored for non-admin sessions (no error, no banner).

## Product Gallery (Item 19 + 20)

Per-product gallery powered by the existing `ProductImage` model (extended by Item 19 with `isActive` + `createdAt` + `updatedAt` + compound index `(productId, isActive, sortOrder)`). The admin manager lives inline on the product edit page (`/admin/products/[id]`); the storefront renders `<ProductGallery>` on the PDP. Item 20 layers a client interactive experience (click-to-swap thumbs, prev/next + counter, ArrowLeft/Right/Home/End keyboard nav, touch swipe, hover/tap zoom, focus-trapped fullscreen lightbox) on top.

| Method | Path | Notes |
|---|---|---|
| GET    | `/api/admin/products/[id]/images`                      | List every gallery image for a product (admin view: includes inactive rows). Response: `{ product, items, maxImages, galleryEnabled }` where `maxImages` is the live `products.maxGalleryImages` cap and `galleryEnabled` mirrors `products.galleryEnabled`. Admin-only. |
| POST   | `/api/admin/products/[id]/images`                      | Register a new gallery image. Two body modes: **multipart** (`file=<binary>`, optional `alt`) routes through `saveAdminImage('product')` (sharp re-encode + EXIF strip + 2400 px / 5 MB cap) and records a `StoreAsset` row; **JSON** (`{ url, alt? }`) registers an externally-hosted URL. First image of a product auto-becomes primary. Rate-limited via `admin.uploads` (40 / 10 min / admin). Returns `400 PRODUCT_GALLERY_LIMIT_REACHED` once `products.maxGalleryImages` is hit. Audits `PRODUCT_IMAGE_UPLOAD`. |
| PATCH  | `/api/admin/products/[id]/images/[imageId]`            | Patch any subset of `{ alt, isActive, sortOrder }`. Disabling the current primary auto-promotes the next active image. Audits `PRODUCT_IMAGE_UPDATE`. |
| DELETE | `/api/admin/products/[id]/images/[imageId]`            | Idempotent delete (returns `{ ok: true, data: { deleted: false } }` if already gone). Deleting the primary auto-promotes the next active image. Audits `PRODUCT_IMAGE_DELETE`. |
| POST   | `/api/admin/products/[id]/images/[imageId]/primary`    | Mark this image as the product's primary. Transactional exactly-one-primary invariant. Rejects with `400 PRODUCT_IMAGE_INACTIVE_PRIMARY` if the target image is disabled. Audits `PRODUCT_IMAGE_PRIMARY_CHANGED`. |
| POST   | `/api/admin/products/[id]/images/reorder`              | Atomically renumber `sortOrder` (10 / 20 / 30 / …) according to `{ orderedIds: string[] }`. Unknown IDs are silently dropped; missing IDs slot at the tail. Audits `PRODUCT_IMAGE_REORDER` with before/after snapshots. |

### Gallery store-config knobs (no endpoints — admin via `/admin/store-config` → `products` tab)

The `products` category in store config carries **9 admin-tunable knobs** for the gallery. The PDP reads them via `getStoreConfig()` and threads them into `<ProductGallery>` as a prop — no client-side polling. Master flag `products.galleryEnabled = false` reverts to primary-image-only; `products.galleryInteractionsEnabled = false` reverts to the Item-19 static markup (no JS-driven swap / zoom / fullscreen). See `DEPLOY.md §5d` for the full operator-facing table.

## Cart + wishlist + compare

| Method | Path | Notes |
|---|---|---|
| GET | `/api/cart` | authed only |
| POST | `/api/cart/add` `{productId,variantId?,quantity}` | B2C cap 10, B2B cap 500 (server-clamped) |
| POST | `/api/cart/update` `{itemId,quantity}` | qty 0 = delete |
| POST | `/api/cart/merge` `{items[]}` | guest→user merge on login |
| POST | `/api/cart/preview` `{items[]}` | server-priced view without persistence |
| GET  | `/api/wishlist` | ids only |
| POST | `/api/wishlist/toggle` `{productId}` | |
| GET    | `/api/compare`               | Item 14 — returns `{ items: [{ product, addedAt }], maxItems }`. Anonymous → cookie path; authed → `CompareItem` rows. Each `product` is the full `CompareProduct` shape (images, brand, category, variants, reviews aggregate, parsed `attributes` JSON). Gated by `features.compareEnabled`. |
| POST   | `/api/compare` `{productId}` | Item 14 — add a product. Anonymous → writes the `sc_compare_v1` cookie; authed → inserts `CompareItem`. Idempotent (re-adding the same product is a no-op). `409 COMPARE_FULL` once the list hits `compare.maxItems` (default 4). `400 COMPARE_INVALID_PRODUCT` for unknown/inactive ids. Rate-limited: `compare.add` (20/hr/user + 60/hr/ip). |
| DELETE | `/api/compare`               | Item 14 — clear the entire list. |
| DELETE | `/api/compare/[productId]`   | Item 14 — remove one product. Idempotent. |
| POST   | `/api/compare/sync` `{productIds: string[]}` | Item 14 — login-merge endpoint. Authed only (`401 UNAUTHENTICATED` otherwise). De-duplicates against existing rows; silently drops unknown / inactive ids; respects `compare.maxItems`. Clears the cookie on success. Rate-limited: `compare.sync` (10/hr/user). |

### Compare share URLs (Item 14)

`/compare?products=slug1,slug2,slug3` renders a read-only side-by-side
view of those exact products without touching the viewer's own compare
list. The slug list is validated against `/^[a-z0-9-]+$/`, capped at 4
slugs, and silently filters unknown / inactive products. The page
displays a "Save to my compare" CTA that POSTs each product to
`/api/compare` if the viewer wants to keep them.

`/compare?diff=1` opens the page with the "Show only differences"
toggle pre-selected — the toggle is also URL-synced via `router.replace`
so customers can share filtered views directly.

## Addresses

| Method | Path | Notes |
|---|---|---|
| GET    | `/api/addresses` | list (default first) |
| POST   | `/api/addresses` | full address |
| PATCH  | `/api/addresses/[id]` `{isDefault?, … fields}` | |
| DELETE | `/api/addresses/[id]` | refuses if used in any order |

## Pincode (Feature #13 — India-Wide PIN code verification + autofill)

| Method | Path | Notes |
|---|---|---|
| GET    | `/api/pincode/[pincode]` | Server-side proxy → India Post API (`api.postalpincode.in`). Validates `/^\d{6}$/` at the edge. 24h in-memory cache + `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`. Same-origin guarded. Per-IP rate limit 60/min. Always returns `200 { ok:true, data: PincodeVerification }` for valid format — `data.found:false` on lookup miss/timeout so the UI never blocks. |

## Hero carousel (Feature #15 — homepage hero CMS)

| Method | Path | Body | Notes |
|---|---|---|---|
| GET    | `/api/hero-banners`                          | – | Public list of active+in-window banners + carousel config. 60s `Cache-Control` with SWR. |
| GET    | `/api/admin/hero-banners`                    | – | Admin list (all rows incl. drafts / expired). |
| POST   | `/api/admin/hero-banners`                    | `HeroBannerCreateInput` | Create a banner. CSRF + admin. Audit-logged. |
| GET    | `/api/admin/hero-banners/[id]`               | – | Admin single-row read. |
| PATCH  | `/api/admin/hero-banners/[id]`               | `HeroBannerUpdateInput` (strict) | Update. CSRF + admin. Unknown keys → 400. |
| DELETE | `/api/admin/hero-banners/[id]`               | – | Hard delete. CSRF + admin. |
| POST   | `/api/admin/hero-banners/reorder`            | `{ ids: string[] }` | Bulk rewrite of `displayOrder` in a single transaction. |

## Admin image uploads (Feature #16 + Item 17 + Item 19)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/admin/uploads?kind=<kind>` | `multipart/form-data` `file=<binary>` | Admin-only image upload. **12 declarative kinds** (canonical list: `src/lib/uploads/imageKinds.ts`): `logo`, `favicon`, `og_image`, `app_icon`, `brand`, `category`, `category_banner`, `category_icon`, `hero`, `promotion`, `product` (Item 19), `misc`. CSRF + admin guard, 40/10-min/admin rate-limit (`admin.uploads` policy). Files are sharp-re-encoded — EXIF stripped, resized to the kind's `maxPx`, output format branches per kind (PNG for transparent kinds: logo / favicon / app_icon / brand / category_icon; JPG for photographic kinds: og_image / category / category_banner / hero / promotion / product / misc). Returns `{ url, mime, bytes, width, height, maxMb }`. Files are stored under `data/uploads/public-images/<kind>/<random>.<png\|jpg>`. Audit-logged as `ADMIN_IMAGE_UPLOAD`. On success the upload is also recorded in the `StoreAsset` registry (Item 17 P2 — see `/api/admin/assets`). |
| GET  | `/api/uploads/public-images/<kind>/<file>` | – | **Public** static-asset serving for admin-uploaded marketing + product images. `Cache-Control: public, max-age=31536000, immutable` (admins replace by uploading a NEW file — never overwriting). Unknown `<kind>` → 403. Filenames are random/non-guessable. |
| GET    | `/api/admin/assets?kind=&page=&pageSize=&include=health` | – | **[PAGINATED]** Item 17 P2 — paginated `StoreAsset` registry + (when `?include=health`) coverage stats for store identity / brands / categories. Filter by `kind` (any `AdminImageKind` or `all`). Admin only. |
| DELETE | `/api/admin/assets/[id]` | – | Item 17 P2 — delete a StoreAsset (DB row + disk file). Refuses with `409 ASSET_IN_USE` + a `references` array listing every Brand / Category / store-config key pointing at the URL — admin must clear those first, or retry with `?force=1` (audited as `ASSET_DELETED_FORCED`). |

## Checkout & orders (customer)

| Method | Path | Notes |
|---|---|---|
| GET  | `/api/checkout/summary?coupon=&redeem=` | totals (paise) + addresses + payment config |
| POST | `/api/checkout/upload-receipt` (multipart `file`) | sharp re-encode, 5 MB cap |
| POST | `/api/checkout/place-order` `{shippingAddressId, billingAddressId?, couponCode?, redeemPoints?, utrNumber, receiptUrl, customerNote?, gstinAtOrder?}` | atomic; returns `{orderId, orderNumber, totalPaise}` |
| GET  | `/api/orders` | current user's orders |
| GET  | `/api/orders/[id]` | owner-only |
| POST | `/api/orders/[id]/cancel` `{reason?}` | window/status enforced |
| GET  | `/api/uploads/[...path]` | gated file server (owner or admin only) |

## Customer account

| Method | Path | Notes |
|---|---|---|
| POST | `/api/account/reorder` `{orderId}` | recreates cart |
| GET/POST | `/api/account/saved-carts` | snapshot |
| POST/DELETE | `/api/account/saved-carts/[id]` | restore (POST) / delete |
| GET/POST | `/api/account/returns` | list / create |
| GET | `/api/account/returns/[id]` | detail |
| GET | `/api/account/returns?page=&pageSize=` | list **[PAGINATED]** (default size 10) |
| GET | `/api/account/reviews?which=eligible\|mine&page=&pageSize=` | gated to delivered purchases **[PAGINATED]** (both views; default size 10) |
| POST | `/api/account/reviews` `{productId,rating,title?,body?,imageUrls?}` | |
| GET | `/api/account/loyalty` | balance + full ledger |
| GET | `/api/account/referrals` | link + counts + list |
| GET/POST | `/api/account/tickets` | list / create |
| GET/PATCH | `/api/account/tickets/[id]` | detail |
| POST | `/api/account/tickets/[id]/messages` | reply |
| GET | `/api/account/chat?since=&wait=` | long-poll inbound |
| POST | `/api/account/chat` `{body}` | send customer message |
| GET/POST | `/api/account/subscriptions` | list / create |
| PATCH/DELETE | `/api/account/subscriptions/[id]` | edit / cancel |
| POST | `/api/account/upload?kind=return\|review\|ticket\|chat` (multipart `file`) | gated like receipts |

## B2B

| Method | Path | Notes |
|---|---|---|
| POST | `/api/b2b/apply` `{companyName,gstin,pan}` | strict GSTIN format + checksum |
| GET  | `/api/b2b/me` | profile + tier + state |
| GET/POST | `/api/b2b/quotes` | list / create |
| GET | `/api/b2b/quotes/[id]` | detail |
| POST | `/api/b2b/quotes/[id]/accept` | adds lines to cart + generates one-time coupon |
| POST | `/api/b2b/quotes/[id]/decline` `{reason?}` | |
| POST | `/api/b2b/bulk-add` `{csv}` or `{rows[]}` | up to 500 lines |

## Admin (all routes require `sc_admin` session)

### Catalog
| Method | Path |
|---|---|
| GET/POST | `/api/admin/products` |
| GET/PATCH/DELETE | `/api/admin/products/[id]` |
| GET/POST | `/api/admin/categories` |
| GET/POST | `/api/admin/brands` |
| GET | `/api/admin/tiers` |

### Excel I/O
| Method | Path |
|---|---|
| GET  | `/api/admin/excel/products/export` |
| POST | `/api/admin/excel/products/import` (multipart `file`) |
| POST | `/api/admin/excel/inventory/import` (multipart `file` + `mode=absolute\|delta`) |
| GET  | `/api/admin/excel/users/export?format=xlsx\|csv` |

### Orders
| Method | Path |
|---|---|
| GET | `/api/admin/orders?q=&status=&paymentStatus=&page=&pageSize=` | **[PAGINATED]** (default 20) |
| GET | `/api/admin/orders?cursor=&pageSize=` | **[CURSOR-PAGINATED]** (opt-in via `cursor=`) |
| GET | `/api/admin/orders/[id]` |
| POST | `/api/admin/orders/[id]/verify-payment` `{note?}` |
| POST | `/api/admin/orders/[id]/reject-payment` `{reason,restoreStock?}` |
| POST | `/api/admin/orders/[id]/shipping` `{courierName,trackingNumber?,trackingUrl?}` |
| POST | `/api/admin/orders/[id]/status` `{to,note?}` (validated state machine) |
| POST | `/api/admin/orders/[id]/refund` `{reason,restoreStock?}` |

### Customers, returns, reviews, B2B, quotes
| Method | Path |
|---|---|
| GET | `/api/admin/customers?q=&role=&status=&page=&pageSize=` | **[PAGINATED]** (default 20) |
| GET/PATCH | `/api/admin/customers/[id]` (`{status?,loyaltyAdjust?}`) |
| POST | `/api/admin/customers/[id]/verify-phone` | Phone Verification — admin override marks `phoneVerified=true`, transitions PENDING_PHONE_VERIFICATION → ACTIVE, writes `ADMIN_PHONE_VERIFY_OVERRIDE` AuditLog row |
| GET | `/api/admin/returns?status=&page=&pageSize=` | **[PAGINATED]** (default 20) |
| GET | `/api/admin/returns?status=&cursor=&pageSize=` | **[CURSOR-PAGINATED]** (opt-in via `cursor=`) |
| GET/PATCH | `/api/admin/returns/[id]` (`{status?,adminNote?,refundAmountPaise?}`) |
| GET | `/api/admin/reviews?approved=0\|1&page=&pageSize=` | **[PAGINATED]** (default 20) |
| GET | `/api/admin/reviews?approved=0\|1&cursor=&pageSize=` | **[CURSOR-PAGINATED]** (opt-in via `cursor=`) |
| PATCH/DELETE | `/api/admin/reviews/[id]` (`{isApproved}`) |
| GET | `/api/admin/b2b-applications` |
| POST | `/api/admin/b2b-applications/[id]/approve` `{tierId}` |
| POST | `/api/admin/b2b-applications/[id]/reject` `{reason?}` |
| GET | `/api/admin/quotes?status=&page=&pageSize=` | **[PAGINATED]** (default 20) |
| GET/POST | `/api/admin/quotes/[id]` (POST = counter-quote) |

### Marketing
| Method | Path |
|---|---|
| GET/POST | `/api/admin/coupons` |
| PATCH/DELETE | `/api/admin/coupons/[id]` |
| GET/POST | `/api/admin/promotions` |
| GET/POST | `/api/admin/campaigns` (sendNow triggers real SMTP) |
| GET/POST | `/api/admin/push` |

### Support + chat
| Method | Path |
|---|---|
| GET | `/api/admin/tickets?status=&page=&pageSize=` | **[PAGINATED]** (default 20) |
| GET | `/api/admin/tickets?status=&cursor=&pageSize=` | **[CURSOR-PAGINATED]** (opt-in via `cursor=`) |
| GET/PATCH | `/api/admin/tickets/[id]` |
| POST | `/api/admin/tickets/[id]/messages` |
| GET | `/api/admin/chat[?roomId=&since=&wait=]` |
| POST | `/api/admin/chat` `{roomId,body}` |

### Public contact form (Item 13)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/contact` | Public-facing contact form endpoint. CSRF required. Rate-limited per IP (`contact.form` policy — 3 / hour). Honeypot field `website`: non-empty value silently returns `200` (bots get the same shape as humans). Validation: `name ≤ 100`, `email` valid format, `subject ≤ 120`, `message` 20 – 2000 chars. On success enqueues a `SEND_EMAIL` background job to `notifications.adminEmail`; for authenticated submitters, also creates a `SupportTicket` (subject prefixed `[CONTACT_FORM]`) and returns `{ ok: true, data: { ticketId } }`. When `notifications.adminEmail` is empty, returns `503 CONTACT_FORM_UNAVAILABLE` (the page itself still renders — only submission fails). Email-pinning: authenticated callers' `email` field is overridden with the session email server-side. |

### Config / audit / analytics / AI
| Method | Path |
|---|---|
| GET/PATCH | `/api/admin/store-config` |
| POST | `/api/admin/store-config/export` |
| POST | `/api/admin/store-config/import` |
| POST | `/api/admin/store-config/reset` |
| GET | `/api/admin/audit-log?entity=&action=&page=&pageSize=` | **[PAGINATED]** (default 50) |
| GET | `/api/admin/audit-log?entity=&action=&cursor=&pageSize=` | **[CURSOR-PAGINATED]** (opt-in via `cursor=`) |
| GET | `/api/admin/analytics` |
| POST | `/api/admin/ai/suggest-tags` `{text}` |

### Store config + feature toggles (Item 8)

The `/api/admin/store-config/*` family is the operator control plane
for the entire platform — every admin-tunable setting lives in a single
typed schema (see `src/lib/storeConfig/schema.ts`).

| Method | Path | Body / behaviour |
|---|---|---|
| GET   | `/api/admin/store-config` | `{ data: { config, schema } }` — full merged config (defaults + DB overrides) + every schema entry's metadata (label, description, category, section, default, dangerLevel, requiresRestart, enumOptions). Schema length equals `ALL_CONFIG_KEYS` so the admin UI can render dynamically. |
| PATCH | `/api/admin/store-config` | **New shape**: `{ changes: { 'features.b2bEnabled': false, 'maintenance.maintenanceMode': true, ... } }` — flat dot-key map. Validated atomically against the schema (all-or-nothing). On success: writes `AuditLog(action='STORE_CONFIG_UPDATED')`, invalidates the in-process cache, syncs `data/maintenance.json` if any `maintenance.*` key changed, and enqueues every `affectsJobs` JobType union (deduplicated, priority 1). **Legacy shape**: the pre-Item-8 nested body `{ store: {...}, policies: {...}, ... }` is still accepted (deep-merged, unvalidated) for backwards compat with the Phase-1-untouched admin page — to be removed once the Phase-2 tabbed UI ships. |
| POST  | `/api/admin/store-config/export` | Returns the current unified config as JSON with `Content-Disposition: attachment; filename="shopcore-config-<timestamp>.json"`. Audited. |
| POST  | `/api/admin/store-config/import` | Two-phase. **Phase A** `{ config: <exported JSON> }` returns `{ data: { preview: true, diff: [{key, before, after}], totalCandidateKeys } }` — NO write. **Phase B** `{ config, confirmed: true }` runs the diff as a single atomic PATCH. Unknown keys silently ignored (forward-compat). |
| POST  | `/api/admin/store-config/reset` | Resets the whole config to defaults. Body MUST be `{ confirm: 'RESET_ALL_CONFIG' }` — any other value returns `400`. Captures full before-state in the audit row so an admin can undo by re-importing a fresh export. |

**New stable error codes:**

| Code | Status | Surface |
|---|---|---|
| `CONFIG_VALIDATION_ERROR` | 400 | PATCH / import — at least one value failed Zod validation. `issues[]` array carries the per-field messages. |
| `INVALID_CONFIG_FILE`     | 400 | import — uploaded body was not a JSON object. |

**Maintenance mode & announcement banner** (toggle-driven, no separate
endpoint): see `maintenance.maintenanceMode` / `maintenance.bannerEnabled`
in the schema. When `maintenanceMode` flips on, the storefront layout
(NOT middleware — Edge runtime can't reach Prisma) redirects every
non-admin request to `/maintenance` unless the client IP is on
`maintenance.allowedMaintenanceIps`. Admin panel and auth endpoints are
unaffected (different layout segment).

### Background jobs (Item 7)

The job runner + scheduler operate inside the Next.js process — there is
no separate worker daemon. These endpoints are the operator surface
(also accessible from `/admin/jobs`).

| Method | Path | Purpose |
|---|---|---|
| GET   | `/api/admin/jobs?status=&type=&queueName=&page=&pageSize=` | Paginated job list. `status ∈ {PENDING,PROCESSING,COMPLETED,FAILED,CANCELLED}`. Unknown `type` values are silently dropped (no echo of attacker-supplied strings into the WHERE clause). Default `pageSize=25`, max `100`. |
| GET   | `/api/admin/jobs/stats` | Counts by status + `oldestPending` ISO timestamp + rolling `avgCompletionMs` over the last 100 COMPLETED jobs. |
| GET   | `/api/admin/jobs/[id]` | Full row: parsed `payload`, `result`, `error`. Email/phone fields in payloads are masked the same way the structured logger masks them. The reserved `__dedupKey` field is stripped. |
| POST  | `/api/admin/jobs/[id]/retry`  | FAILED → PENDING, `attempts=0`, `runAt=now`. Rejects non-FAILED rows with `409 JOB_NOT_RETRYABLE`. Writes `AuditLog(action='JOB_RETRY')`. |
| POST  | `/api/admin/jobs/[id]/cancel` | PENDING → CANCELLED. Atomic `WHERE status='PENDING'` — refuses with `409 JOB_NOT_CANCELLABLE` if the runner claimed it first. Writes `AuditLog(action='JOB_CANCEL')`. |
| GET   | `/api/admin/job-schedules` | Every recurring schedule (built-in + admin-added). |
| PATCH | `/api/admin/job-schedules/[id]` | Toggle `isActive` and/or update `cronExpression`. Bad cron → `400 INVALID_CRON`. Writes `AuditLog(action='JOB_SCHEDULE_UPDATE')`. |

All routes require `sc_admin` session via `requireAdminUser()`. All
`POST`/`PATCH` routes require the standard CSRF token (`x-csrf-token`
header mirroring the `sc_csrf` cookie).

---

## Rate limits

All limits are defined in a single typed registry —
[`src/lib/security/rateLimitPolicies.ts`](src/lib/security/rateLimitPolicies.ts).
**30 policies total** (+ `global`). Rate-limit numbers are deliberately
NOT environment variables: changing a limit requires a deployment (a
security-posture change deserves a PR).

### Response headers (every rate-limited route)

Every successful response from a rate-limited route includes:

- `X-RateLimit-Limit` — the policy's max for the most-restrictive active window
- `X-RateLimit-Remaining` — requests remaining in the current window
- `X-RateLimit-Reset` — Unix seconds timestamp when the window resets

Every 429 response additionally includes:

- `Retry-After` — seconds to wait before retrying (always ≥ 1)
- Body: `{ "ok": false, "error": "Too many requests. Please try again later.", "code": "RATE_LIMITED" }`

### Policy table

| Policy | Key | Window(s) | Applies to |
|---|---|---|---|
| `global` | IP | 120 / 60 s | Every `/api/*` route (applied as the first step of `withErrorHandling`) |
| **Auth — credential surfaces** | | | |
| `auth.login` | IP | 5 / 15 min + 20 / 24 hr | `POST /api/auth/login` |
| `auth.login.email` | IP + email | 5 / 15 min | `POST /api/auth/login` (companion — per-account brute-force defence) |
| `auth.signup` | IP | 5 / 60 min | `POST /api/auth/signup` |
| `auth.admin.login` | IP | 3 / 15 min | `POST /api/auth/admin/login` |
| **Auth — OTP** | | | |
| `auth.otp.verify` | IP | 30 / 10 min | `POST /api/auth/otp/verify` |
| `auth.otp.resend` | IP | 3 / 60 min | `POST /api/auth/otp/resend` |
| `auth.check_email` | IP | 10 / 60 min | `POST /api/auth/check-email` (enumeration mitigator — `skipInTest: false`) |
| **Auth — phone verification (Item 2)** | | | |
| `auth.phone.verify` | IP + userId | 5 / 15 min (IP) + 3 / 60 min (user) | `POST /api/auth/phone/verify` |
| `auth.phone.resend` | IP | 3 / 60 min | `POST /api/auth/phone/resend-otp` (`skipInTest: false`) |
| **Auth — forgot password (Feature #12)** | | | |
| `auth.forgot_password.initiate` | IP | 10 / 60 min | `POST /api/auth/forgot-password/initiate` (hard 429) |
| `auth.forgot_password.per_email` | IP + email | 3 / 60 min | `POST /api/auth/forgot-password/initiate` (SOFT — returns generic 200 to avoid enumeration) |
| `auth.forgot_password.verify` | IP | 5 / 15 min | `POST /api/auth/forgot-password/verify-otp` |
| `auth.forgot_password.resend` | IP | 10 / 60 min | `POST /api/auth/forgot-password/resend` |
| `auth.forgot_password.reset` | IP | 5 / 15 min | `POST /api/auth/forgot-password/reset` |
| **Auth — session refresh** | | | |
| `auth.refresh` | IP | 30 / 1 min | `POST /api/auth/refresh` |
| **Account self-service** | | | |
| `account.phone_update` | userId | 3 / 60 min | `PATCH /api/account/phone` |
| `account.password` | userId | 5 / 60 min | `POST /api/account/password` |
| `account.upload` | userId | 40 / 10 min | `POST /api/account/upload` |
| **Checkout** | | | |
| `checkout.place_order` | userId | 6 / 1 min | `POST /api/checkout/place-order` |
| `checkout.upload_receipt` | userId | 20 / 10 min | `POST /api/checkout/upload-receipt` |
| `checkout.express` | userId | 30 / 1 min | `POST /api/checkout/express` |
| **Catalog + storefront** | | | |
| `pincode.lookup` | IP | 60 / 1 min | `GET /api/pincode/[pincode]` (`skipInTest: false`) |
| **Admin** | | | |
| `admin.uploads` | userId | 40 / 10 min | `POST /api/admin/uploads`, `POST /api/admin/products/[id]/images` (multipart) |
| **Misc** | | | |
| `client.error_beacon` | IP | 30 / 1 min | `POST /api/client-errors` (silent 204 on exceed; `skipInTest: false`) |
| **Public contact form (Item 13)** | | | |
| `contact.form` | IP | 3 / 60 min | `POST /api/contact` (`skipInTest: false`) |
| **Compare (Item 14)** | | | |
| `compare.add`  | IP + userId | 20 / 60 min (user) + 60 / 60 min (IP) | `POST /api/compare` |
| `compare.sync` | userId | 10 / 60 min | `POST /api/compare/sync` (login-merge) |
| **Newsletter subscribe (Item 18 P2)** | | | |
| `newsletter.subscribe` | IP | 5 / 60 min | `POST /api/newsletter/subscribe` (`skipInTest: false` — the integration test asserts the 6th request 429s) |

`skipInTest: false` means the policy is **active in `NODE_ENV=test`**
(most policies short-circuit in tests to keep harnesses from tripping
themselves). These are surfaces where the limit's existence is itself a
security property and the test suite asserts the 429 behaviour.

### Admin inspection

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/rate-limits` | Returns full policy registry + active keys + counts. Hashed keys only — never raw IPs. |
| DELETE | `/api/admin/rate-limits/[...key]` | Resets one bucket. Writes `RATE_LIMIT_RESET` to AuditLog. Catch-all path segment because keys contain colons. |

---

## Audit action reference

Every admin mutation writes an `AuditLog` row. The `action` column is a
stable public string in `ENTITY_VERB` form. The list below is the
canonical set of actions surfaced by `/api/admin/audit-log` (the schema
itself doesn't constrain `action` — admins / scripts can introduce new
values; this is just the inventory the platform itself emits today).

| Entity | Actions |
|---|---|
| `Product`         | `PRODUCT_CREATE`, `PRODUCT_UPDATE`, `PRODUCT_DELETE`, `PRODUCT_DEACTIVATE` |
| `ProductImage` (Item 19) | `PRODUCT_IMAGE_UPLOAD`, `PRODUCT_IMAGE_UPDATE`, `PRODUCT_IMAGE_DELETE`, `PRODUCT_IMAGE_REORDER`, `PRODUCT_IMAGE_PRIMARY_CHANGED` |
| `Brand` (Item 17) | `BRAND_CREATE`, `BRAND_UPDATE`, `BRAND_DELETE` |
| `Category` (Item 17) | `CATEGORY_CREATE`, `CATEGORY_UPDATE`, `CATEGORY_DELETE` |
| `HomepageSection` (Item 18) | `HOMEPAGE_SECTION_CREATE`, `HOMEPAGE_SECTION_UPDATE`, `HOMEPAGE_SECTION_DELETE`, `HOMEPAGE_SECTION_REORDER` |
| `HomepageMetric` (Item 18) | `HOMEPAGE_METRIC_UPDATE` (covers create + patch + delete — single canonical verb per the Phase 1 design) |
| `HomepageBranch` (Item 18) | `HOMEPAGE_BRANCH_UPDATE` (same — single canonical verb) |
| `HeroBanner` (Feature #15) | `HERO_BANNER_CREATE`, `HERO_BANNER_UPDATE`, `HERO_BANNER_DELETE`, `HERO_BANNER_REORDER` |
| `Order`           | `ORDER_VERIFY_PAYMENT`, `ORDER_REJECT_PAYMENT`, `ORDER_REFUND`, `ORDER_STATUS_CHANGE`, `ORDER_SHIPPING_UPDATE` |
| `Return`          | `RETURN_STATUS_CHANGE` |
| `Review`          | `REVIEW_APPROVE`, `REVIEW_DELETE` |
| `Coupon` / `Promotion` / `Campaign` / `Push` | `<ENTITY>_CREATE`, `<ENTITY>_UPDATE`, `<ENTITY>_DELETE` |
| `Customer`        | `CUSTOMER_STATUS_CHANGE`, `CUSTOMER_LOYALTY_ADJUST`, `ADMIN_PHONE_VERIFY_OVERRIDE` |
| `B2BApplication`  | `B2B_APPLICATION_APPROVE`, `B2B_APPLICATION_REJECT` |
| `QuoteRequest`    | `QUOTE_COUNTER`, `QUOTE_STATUS_CHANGE` |
| `StoreConfig` (Item 8) | `STORE_CONFIG_UPDATED`, `STORE_CONFIG_EXPORTED`, `STORE_CONFIG_IMPORTED`, `STORE_CONFIG_RESET` |
| `Job` / `JobSchedule` (Item 7) | `JOB_RETRY`, `JOB_CANCEL`, `JOB_SCHEDULE_UPDATE` |
| `StoreAsset` (Item 17 P2) | `ADMIN_IMAGE_UPLOAD`, `ASSET_DELETED`, `ASSET_DELETED_FORCED` |
| `RateLimit`       | `RATE_LIMIT_RESET` |

Each row carries `actorId`, `action`, `entity`, `entityId`, `before`
(JSON snapshot pre-mutation), `after` (JSON snapshot post-mutation), and
`ipAddress`. The audit log itself is paginated via the standard
`[CURSOR-PAGINATED]` envelope on `/api/admin/audit-log?cursor=`.
