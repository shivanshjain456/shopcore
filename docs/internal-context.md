# ShopCore — Internal Engineering Context

> **Audience:** Core contributors, maintainers, and reviewers working in this repository.
> **Goal:** Comprehensive technical reference explaining core systems, invariants, data schemas, and design constraints.
>
> For chronological architectural decisions and phase milestones, refer to `docs/engineering-history.md`.

---

## 1. Project overview

| | |
|---|---|
| **Name** | ShopCore |
| **Purpose** | Production-grade, India-only e-commerce platform: B2C storefront + B2B portal + admin CMS + integrated checkout. |
| **Vertical** | Laptops · desktops · computer accessories · electronics. |
| **Geography** | **India only.** ₹ INR everywhere, paise (integer) on the wire, Indian states/PIN, GSTIN validation, UPI/QR + UTR + receipt for payment. |
| **Users** | (a) Anonymous shoppers, (b) Registered customers (CUSTOMER), (c) Verified businesses (B2B), (d) Store admins (ADMIN). |
| **Scale target** | ~500 users/month, ~100 concurrent, 1 admin. Single-VPS / single-Node / single-SQLite-file deployment. |
| **Constraints** | **No paid third-party services.** Free Gmail SMTP for OTP, optional Firebase Admin, ExcelJS for I/O, sharp for images, India Post free API for PIN lookups. |

ShopCore was built in 8 explicit phases (Foundation → Auth → Storefront → Checkout → Customer dashboard → B2B → Admin → Hardening), then extended with a stream of numbered Features (#9 through #35+). Every phase/feature ends with HTTP-level tests against `next start`.

---

## 2. Current state — built features inventory

### Foundational phases (all complete)

| Phase | What ships |
|---|---|
| 1 — Foundation | Next.js app skeleton, Prisma schema, env config (`lib/config.ts` with Zod env validation), tailwind, base layouts. |
| 2 — Auth & accounts | Signup → OTP → verify, login → OTP → verify, sessions, password hashing (bcryptjs cost 12), Firebase mirror, lockouts. |
| 3 — B2C storefront | Homepage, category pages, search, PDP, cart, wishlist, compare, header/footer. |
| 4 — Checkout | UPI QR + UTR + receipt upload + idempotent place-order + summary endpoint. |
| 5 — Customer dashboard | `/account/*` — orders, addresses, returns, reviews, loyalty, referrals, support tickets, live chat, subscriptions, saved carts, compare. |
| 6 — B2B portal | `/b2b/*` — apply, tier pricing, GSTIN, quote requests, bulk-order. |
| 7 — Admin dashboard | `/admin/*` — products (with multi-image gallery manager — Item 19), categories, brands, inventory, bundles, orders, returns, reviews, tickets, chat, customers, B2B applications, coupons, promotions, hero banners, campaigns, push, store config, audit log, analytics, Excel import/export, **homepage CMS** (Item 18 — `/admin/homepage` Sections / Metrics / Branches tabs), **assets** (Item 17 P2). |
| 8 — Hardening | Structured logger, CSP, security headers, /api/health + /api/ready, backups (VACUUM INTO), restore, preflight, systemd unit, Nginx + Certbot in DEPLOY.md. |

### Numbered features / hotfixes (latest → oldest)

| # | What it adds | Key files |
|---|---|---|
| **#20** Product Gallery Interaction | Builds on top of the Item-19 foundation — no second gallery system, no duplicated image pipeline, no architectural rewrite. New `<InteractiveProductGallery>` client island (mounted by the existing `<ProductGallery>` shell when `products.galleryInteractionsEnabled` is on) owns the `(activeIdx, fullscreen, zoomOn)` state and delivers: click-to-swap thumbnails (each thumb is a real `role="tab"` button with `aria-selected` + `aria-current`); prev/next buttons (hidden until hover on desktop, always visible on mobile, disabled at the ends when loop is off); keyboard navigation on the gallery container (ArrowLeft / ArrowRight / Home / End); touch-swipe (40 px horizontal threshold + 30 px vertical reject — pointer events with touch fallback); hover-to-zoom (desktop) / tap-to-zoom (mobile) via pure-CSS `transform: scale(2)` with `transform-origin` tracking the pointer; focus-trapped fullscreen lightbox via native `<dialog>.showModal()` (free focus-trap + Escape + ::backdrop + top-layer rendering) with its own thumb rail + counter + body-scroll-lock + focus restore on close; counter overlay (`3 / 8`); neighbour-image preload on every active-image change (perf). Accessibility: `role="tablist"` + `role="tab"` + `aria-selected` + `aria-current` + `aria-live="polite"` status region that narrates "Image 3 of 8: <alt>" on every change + `aria-label` on every prev/next/fullscreen/close button + visible focus rings. `prefers-reduced-motion` is detected via `matchMedia` and ALWAYS overrides the admin's `transitionMs` to 0 regardless of config. Six new store-config keys under the existing `'products'` category (`Gallery interaction` section): `galleryInteractionsEnabled` (master switch — default true), `galleryZoomEnabled` (default true), `galleryFullscreenEnabled` (default true), `galleryLoopEnabled` (Amazon-style stop-at-end OFF by default), `galleryTransitionMs` (0-500 ms, default 150), `galleryThumbnailPosition` (`bottom` \| `left`, default `bottom` — `left` activates on `sm:` desktop only). featureGate exports `isGalleryInteractionsEnabled / isGalleryZoomEnabled / isGalleryFullscreenEnabled / isGalleryLoopEnabled`. New service helper `readGalleryInteractionSettings(cfg)` clamps `transitionMs` to 0-500 and falls back unknown enum values. The Item-19 static gallery is preserved verbatim as a fallback — disabling the master switch reverts the storefront to the foundation behaviour with the same `data-testid` hooks intact. `npm run test:product-gallery-interaction` ships **96 assertions** across unit (defaults / clamps), static audit (file presence + 6 keys + 4 helpers + reduced-motion gate + ARIA scaffolding + no native dialogs / `console.*` / `: any` / `as any` / `key={i\|idx\|index}`), component (thumbnail click + counter + aria-selected flip; prev/next disabled at ends without loop + enabled with loop + wrap behaviour; ArrowLeft/Right/Home/End keyboard nav; empty-state branch; single-image branch hides counter/prev/next/thumb-rail; fullscreen affordance respects flag; fullscreen open + Close cycle; touch-swipe advances; aria-live announces; images-prop change clamps activeIdx), integration (PDP renders interactive by default; flipping each flag changes the storefront markup; regression covers `/api/products`, `/`, `/admin/homepage`). | `src/components/storefront/{InteractiveProductGallery,ProductGallery}.tsx`, `src/lib/cms/productGallery.ts` (extended with `GalleryInteractionSettings` + `readGalleryInteractionSettings`), `src/lib/storeConfig/{schema,featureGate}.ts` (6 new keys + 4 helpers), `src/app/(storefront)/p/[slug]/page.tsx` (reads + passes interaction settings), `scripts/test-product-gallery-interaction.tsx`. |
| **#19** Product Gallery (foundation) | Every product can now carry multiple images, surfaced through a proper PDP gallery (primary + thumb rail) and a drag-reorder admin manager. Migration `20260609120000_product_gallery_columns` extends the existing `ProductImage` model with `isActive` (soft-disable), `createdAt`, `updatedAt` + a new compound index `(productId, isActive, sortOrder)` that covers both the PDP read path AND every card surface's primary-image projection. New `'product'` image kind (JPG q90, 2400 px, 5 MB cap) routes through the existing `saveAdminImage` pipeline so EXIF stripping + sharp re-encode apply unchanged. New service `src/lib/cms/productGallery.ts` is the single source of truth for gallery CRUD: `listGalleryForAdmin / listGalleryForPdp / countGallery / registerImage / updateImage / setPrimary / reorderImages / deleteImage` — enforces exactly-one-primary in a transaction, auto-promotes the next active image when the primary is removed or disabled, and caps per-product image count via `products.maxGalleryImages` store config. 5 new admin API endpoints (`GET / POST /api/admin/products/[id]/images`, `PATCH / DELETE .../[imageId]`, `POST .../[imageId]/primary`, `POST .../reorder`) — all CSRF-guarded, rate-limited via the existing `admin.uploads` policy, audit-wired (`PRODUCT_IMAGE_UPLOAD / UPDATE / DELETE / REORDER / PRIMARY_CHANGED`). Admin UI (`ProductGalleryManager`) ships drag-reorder (HTML5 native DnD + keyboard ↑/↓ fallback), per-row Set-primary / Disable-Enable / Remove, inline alt-text editor (blur-or-Enter saves), multi-file upload (file-picker + drag-and-drop zone), per-cap warning, dialog-based confirm-delete. New `<ProductGallery>` server component renders the storefront gallery: main image is `loading="eager"` + `fetchpriority="high"` (LCP candidate), secondary thumbs respect `products.galleryLazyLoadEnabled`. Stable `data-product-image-id` / `data-product-image-primary` attributes scaffold the click-to-swap / zoom / fullscreen interactions that land in Item 20. Three new store-config keys under a new `'products'` category: `products.galleryEnabled` (master kill-switch; PDP renders only the primary image when off), `products.maxGalleryImages` (1-40, default 12), `products.galleryLazyLoadEnabled` (default true). featureGate exports `isProductGalleryEnabled` / `isProductGalleryLazyLoadEnabled`. Phase-3 backward-compat pass migrated every existing single-image projection (12 files: queries.ts, homepage.ts, compareData.ts, cart.ts, account/reviews.ts, b2b/quotes.ts, checkout/express.ts, wishlist/orders/account-reviews/account-subscriptions/cart-preview routes) to `{ where: { isActive: true }, take: 1, orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] }` so soft-disabled images vanish everywhere consistently. `npm run test:product-gallery` ships **124 assertions** across unit / service / static-audit / integration / regression (admin CRUD round-trip + audit-log presence + cap enforcement + idempotent delete + PDP renders gallery + `galleryEnabled=false` hides thumb rail + soft-disabled images filtered from public APIs). | `prisma/migrations/20260609120000_product_gallery_columns/migration.sql`, `prisma/schema.prisma` (ProductImage extended), `src/lib/cms/productGallery.ts`, `src/lib/uploads/imageKinds.ts` (new product kind), `src/lib/storeConfig/{schema,featureGate}.ts` (3 keys + helpers), `src/app/api/admin/products/[id]/images/{route,[imageId]/route,[imageId]/primary/route,reorder/route}.ts`, `src/components/storefront/ProductGallery.tsx`, `src/app/admin/(app)/products/[id]/{page,ProductGalleryManager}.tsx`, `src/app/(storefront)/p/[slug]/page.tsx` (modified — uses ProductGallery), `src/lib/catalog/queries.ts` + `src/lib/cms/homepage.ts` + `src/lib/compare/compareData.ts` + 9 more (modified — isActive-filtered single-image projection), `scripts/test-product-gallery.ts`. |
| **#18** Homepage CMS revamp (Phase 2) | Ships the visual admin editor at `/admin/homepage` — a three-tab shell (`Sections` / `Metrics` / `Branches`) wired to the Phase-1 admin CRUD endpoints. Sections tab is a drag-reorder list (HTML5 native DnD — no library) with a keyboard-accessible ↑/↓ fallback that hits the same `/api/admin/homepage/sections/reorder` endpoint. `+ Add section` opens a kind-picker grid; selecting a kind opens the `<SectionEditor>` (combines `<SectionMetaForm>` for slug/title/order/isActive/scheduling with the per-kind config form picked from a TS-enforced registry — adding a new kind in `homepageSchemas.ts` hits a compile error in `sectionFormRegistry.ts` until the form is wired). 13 per-kind forms shipped: `HeroSectionForm` (pointer to live `/admin/hero-banners`), `FeaturedBrandsSectionForm` / `TopCategoriesSectionForm` / `BrandShowcaseSectionForm` (auto/manual source + chip picker), `ProductCollectionSectionForm` (the workhorse — mode dropdown swaps inputs across `featured` / `newest` / `top_rated` + minReviews / `trending` / `by_category` + slug + browse helper / `by_brand` + slug + browse helper / `manual` + product chip picker), `WidePromoBannerSectionForm` / `DualPromoCardsSectionForm` (image-upload + CTA pair + theme), `StoreMetricsSectionForm` / `BranchesSectionForm` (heading/theme + pointer to data tab), `WhyShopWithUsSectionForm` (repeatable cards array, max 8, with stable keys + ↑/↓ + remove + icon upload), `NewsletterSectionForm` (heading + description + button label + background upload), plus `MostRatedProductsSectionForm` / `TrendingProductsSectionForm` thin wrappers locking the mode. Shared inputs module (`sharedInputs.tsx`) ships `<TextField>` / `<TextareaField>` / `<SelectField>` / `<NumberField>` / `<CtaPair>` / `<ThemePicker>` (radiogroup) / `<SourcePicker>` (radiogroup) / `<ChipPicker>` (debounced remote search + max-cap + ↑/↓ reorder) plus typed fetchers (`searchBrands` / `searchCategories` / `searchProducts`) that hit the existing admin GET endpoints. **Metrics** + **Branches** tabs are full CRUD over the matching tables (image upload via existing `<ImageUploadInput kind="misc">`, dialog-based confirm-delete — no `window.confirm`). **Newsletter subscription** is now real: the Phase-1 `<NewsletterBlock>` deep-link to `/signup?marketing=1` is replaced with the new `<NewsletterForm>` client island that POSTs to the new `POST /api/newsletter/subscribe` endpoint (CSRF + per-IP rate limit `newsletter.subscribe` 5/hour + honeypot + uniform-success response to prevent account enumeration — internally flips `User.emailSubscribed=true` if the address matches, otherwise enqueues an admin-notification email via the existing `SEND_EMAIL` job). **Preview mode**: `/?preview=admin` lets a signed-in admin see EVERY section (including disabled / scheduled-future / scheduled-past) so they can sanity-check unpublished edits; admin role is verified server-side via `getCurrentUser({ requireAdmin: true })` — the query param is ignored for anonymous + non-admin users. An amber banner renders when active. Sidebar entry added under Settings between Assets and Background jobs. `npm run test:homepage-p2` ships **250 assertions** (static audit: file presence + sidebar entry + registry coverage + no native dialogs + no `console.*` in new endpoint + no `: any` / `as any` + no `key={i|idx|index}` + rate-limit policy registered + no legacy `/signup?marketing=1` leak + preview-mode wiring; component: jsdom mounts every form + schema round-trip + Why-cards add/remove + ProductCollection mode swap + NewsletterForm POST happy/CSRF/success/429; integration: admin route exists + newsletter happy/bad-email/honeypot/rate-limit + preview-mode-ignored-for-anon + storefront HTML scrubbed of legacy deep-link). | `src/app/admin/(app)/homepage/{page,HomepageAdminApp,SectionsTab,SectionEditor,MetricsTab,BranchesTab}.tsx`, `src/app/admin/(app)/homepage/forms/{types,sharedInputs,sectionFormRegistry,SectionMetaForm,HeroSectionForm,FeaturedBrandsSectionForm,TopCategoriesSectionForm,ProductCollectionSectionForm,WidePromoBannerSectionForm,DualPromoCardsSectionForm,BrandShowcaseSectionForm,StoreMetricsSectionForm,WhyShopWithUsSectionForm,BranchesSectionForm,NewsletterSectionForm,MostRatedProductsSectionForm,TrendingProductsSectionForm}.{ts,tsx}`, `src/app/api/newsletter/subscribe/route.ts`, `src/components/storefront/homepage/NewsletterForm.tsx`, `src/components/storefront/homepage/blocks.tsx` (modified — NewsletterBlock now uses the form island), `src/components/admin/SideNav.tsx` (modified — adds `/admin/homepage`), `src/lib/cms/homepage.ts` (modified — `getHomepageComposition({ preview })` bypasses active-filter when admin asks), `src/app/(storefront)/page.tsx` (modified — preview-mode gating), `src/lib/security/rateLimitPolicies.ts` (new `newsletter.subscribe` policy), `scripts/test-homepage-p2.tsx`. |
| **#18** Homepage CMS revamp (Phase 1) | The storefront homepage is no longer hardcoded — every section is admin-composable via a new `HomepageSection` table (`kind` discriminator + per-kind Zod-validated JSON `config` + scheduling + display order). 13 section kinds shipped (`HERO`, `FEATURED_BRANDS`, `TOP_CATEGORIES`, `PRODUCT_COLLECTION`, `MOST_RATED_PRODUCTS`, `TRENDING_PRODUCTS`, `WIDE_PROMO_BANNER`, `DUAL_PROMO_CARDS`, `BRAND_SHOWCASE`, `STORE_METRICS`, `WHY_SHOP_WITH_US`, `BRANCHES`, `NEWSLETTER`). Adding a new kind is a one-line edit in `homepageSchemas.ts` plus a render branch in `<HomepageRenderer>`. New `HomepageMetric` (trust tiles like "170+ brands") + `HomepageBranch` (physical store locations) tables with full admin CRUD. New service `src/lib/cms/homepage.ts` exposes one storefront read path (`getHomepageComposition()`) that batches lookups into a single Promise.all; `safeParseConfig` makes a single bad row a logged warning rather than a page-crash. Public `GET /api/homepage` returns the resolved composition with `Cache-Control: public, max-age=30`. Admin CRUD: `GET/POST /api/admin/homepage/sections` + `PATCH/DELETE /api/admin/homepage/sections/[id]` + `POST /reorder` + metrics CRUD + branches CRUD (all audited with `HOMEPAGE_*` actions). Four new feature flags (`features.homepageRevampEnabled` + `homepageBrandsEnabled` + `homepageMetricsEnabled` + `homepageBranchesEnabled`) — disable the master switch and the page falls back to the legacy hand-coded layout (`(storefront)/_legacy-page.tsx`) preserved as `LegacyHomePage`. First-boot seed (`seedDefaultsIfEmpty`) populates the CMS with a sensible default composition (hero → categories → brands → featured → most-rated → latest → metrics) so a fresh install renders immediately. Storefront renderer (`<HomepageRenderer>`) is a server component that dispatches per-kind to one of 11 server blocks in `src/components/storefront/homepage/blocks.tsx` — every section is SSR'd; the hero alone has an inner client island (the existing `HeroCarousel`). `npm run test:homepage-revamp` ships **147 assertions** (unit: schema, parsing, scheduling; service: seed, CRUD, composition filter; static: file presence + audit wiring + flag exports + findMany discipline; integration: GET /api/homepage envelope, admin CRUD round-trip, reorder, feature-flag fallback). **Phase 2 has shipped** — see the Item 18 P2 row above for the admin editor, per-kind forms, newsletter subscription endpoint, and preview mode. | `prisma/migrations/20260608120000_homepage_cms/migration.sql`, `src/lib/cms/{homepage,homepageSchemas,homepageDefaults}.ts`, `src/lib/storeConfig/{schema,featureGate}.ts`, `src/app/api/homepage/route.ts`, `src/app/api/admin/homepage/{sections,metrics,branches}/{route,[id]/route,reorder/route}.ts`, `src/components/storefront/homepage/{HomepageRenderer,blocks}.tsx`, `src/app/(storefront)/{page,_legacy-page}.tsx`, `src/lib/db/client.ts` (boot-seed hook), `scripts/test-homepage-revamp.ts`. |
| **#17** Real brand assets (Phase 1 + 2) | Replaces every placeholder image with a real, admin-configurable asset pipeline. Migration `20260607120000_brand_assets`: `Brand.bannerUrl`, `Category.{bannerUrl,iconUrl}`, new `StoreAsset` table (every upload recorded with kind / dimensions / bytes / uploader). New `src/lib/uploads/imageKinds.ts` declarative kind registry (11 kinds — logo / favicon / og_image / app_icon / brand / category / category_banner / category_icon / hero / promotion / misc); `saveAdminImage` now branches output format per kind (PNG for transparent kinds: logos / icons / favicon; JPG for photographic kinds: hero / category / OG). Five new `store.*` config keys (`logoUrl` upgraded + `logoDarkUrl`, `logoAlt`, `faviconUrl` upgraded, `ogImageUrl`, `appIconUrl`); schema's `fieldType` extended to accept ``image:`<kind>`` so the admin store-config UI automatically renders `<ImageUploadInput>` for every asset key. New `<StoreLogo>` (real `<img>` → inline-SVG word-mark fallback → "ShopCore" text — never broken), `<BrandLogo>` (real logo → deterministic-coloured initial tile), `<CategoryImage>` (real image → designed gradient with initial). Dynamic favicon / Apple touch icon / Open Graph image via `src/app/{icon,apple-icon,opengraph-image}.tsx` — every one reads `getStoreConfig()` and redirects to the admin-uploaded asset if set, otherwise generates a 64×64 / 180×180 / 1200×630 PNG with the store's first letter / name / tagline on a brand-derived palette via `next/og`. Root `layout.tsx` now uses `generateMetadata` (no hardcoded title / tagline) so OG previews + tab titles reflect admin config. Brand + category admin forms now wire `<ImageUploadInput>` for every asset field; both POST endpoints accept the new fields; both public endpoints (`/api/brands`, `/api/categories`) surface them. Homepage gained a brand band (`<BrandLogo>`-based) and upgraded category tiles (`<CategoryImage>`-based). Category listing page renders the admin-uploaded `bannerUrl` above the title. `npm run test:brand-assets` ships **208 assertions** (Phase 1: 150 + Phase 2: 58 — adds asset-health computation, `StoreAsset` registry GET / DELETE, bulk-upload filename matching). Phase 2 ships the admin /admin/assets dashboard (coverage cards, bulk upload, recent uploads table with reference-check delete) + `GET /api/admin/assets?include=health` + `DELETE /api/admin/assets/[id]` (409 `ASSET_IN_USE` with `references[]` + `?force=1` override). | `prisma/migrations/20260607120000_brand_assets/migration.sql`, `src/lib/assets/colorFromString.ts`, `src/lib/uploads/imageKinds.ts`, `src/lib/uploads/adminImages.ts`, `src/components/storefront/{StoreLogo,StoreLogoImage,BrandLogo,CategoryImage}.tsx`, `src/app/{icon,apple-icon,opengraph-image}.tsx`, `src/app/layout.tsx`, `src/lib/storeConfig/schema.ts`, `src/app/admin/(app)/store-config/page.tsx`, `src/app/admin/(app)/brands/page.tsx`, `src/app/admin/(app)/categories/page.tsx`, `src/app/api/admin/{brands,categories,uploads}/route.ts`, `src/app/api/{brands,categories}/route.ts`, `src/app/(storefront)/{layout,page,c/[slug]/page}.tsx`, `src/components/storefront/StorefrontHeader.tsx`, `scripts/test-brand-assets.ts`. |
| **#14** Comprehensive Compare Feature | Complete rewrite of `/compare` into a multi-product, row-grouped, side-by-side spec sheet (up to 4 products). New `Product.attributes` JSON column + `CompareItem` table (migration `20260606120000_compare_feature`). Dual backend: anonymous via the `sc_compare_v1` cookie, authed via the table — `POST /api/compare/sync` merges + de-dupes the local list into the DB on login. Declarative `attributeGroups.ts` map (universal `overview` / `pricing` / `ratings` / `availability` + category-specific `display` / `performance` / `connectivity` / `physical` / `architecture` / `cores`) + synthetic "Other specifications" catch-all for un-mapped keys. Pure `unionAttributeKeys` + `detectDifference` (case-insensitive, array-aware, struct-aware via `JSON.stringify`). New `<CompareProvider>` context; `<CompareTray>` floating panel (slide-up, `prefers-reduced-motion` aware, hidden on `/compare`); rewritten `<CompareButton>` (in-compare / full / default states); `<CompareTable>` + `<CompareProductHeader>` + `<CompareActionRow>` (reuses `<AddToCartButton>` / `<BuyNowButton>` / `<WishlistButton>` unchanged) + `<CompareRatingBreakdown>` + `<CompareVariantsTable>` + `<CompareAttributeRow>` (cell-level diff highlighting with `font-semibold + border-l-4 border-blue-500 + bg-blue-50`). "Show only differences" toggle URL-synced via `?diff=1`. Share URLs at `/compare?products=slug1,slug2,...` (validates each slug against `/^[a-z0-9-]+$/`, caps at 4, drops unknown silently; renders a "Save to my compare" CTA without mutating the viewer's list). New error codes: `COMPARE_FULL` (409), `COMPARE_INVALID_PRODUCT` (400). New rate-limit policies `compare.add` (20/hr/user + 60/hr/ip) and `compare.sync` (10/hr/user). New `compare.maxItems` config entry (default 4, hard ceiling 4). `npm run test:compare` (127 assertions: 47 unit + 29 static + 51 integration). | `prisma/migrations/20260606120000_compare_feature/migration.sql`, `src/lib/compare/{attributeGroups,attributeKeyResolver,differenceDetector,compareData}.ts`, `src/lib/account/compare.ts`, `src/app/api/compare/route.ts` + `[productId]/route.ts` + `sync/route.ts`, `src/components/storefront/{CompareProvider,CompareTray,CompareButton,CompareTable,CompareProductHeader,CompareActionRow,CompareRatingBreakdown,CompareVariantsTable,CompareAttributeRow}.tsx`, `src/app/(storefront)/compare/{page,CompareClient}.tsx`, `scripts/test-compare.ts`. |
| **#12** Pagination — canonical envelope + components (Phase 1 + 2) | **Phase 1** (canonical envelope): standardises every list endpoint behind `{ items, pagination: { total, page, pageSize, totalPages, hasNextPage, hasPrevPage } }` — legacy `data.products` / `data.orders` / `data.reviews` shapes gone. New `src/lib/pagination.ts` (utility module — `parsePaginationParams`, `parseCursorParams`, `paginatedQuery`, `buildPagination`, `buildCursorPagination`, `buildPageWindow`). New stable error code `INVALID_PAGINATION_PARAMS` (400). Two new components: `<Pagination>` (dual mode — link mode preserves all query params; callback mode wires `onPageChange`; mobile collapses to prev/next + "Page N of M"; `aria-current="page"`, `<nav aria-label="Pagination">`) and `<PageSizeSelector>` (visible `<label>`, options filtered against `paginationMaxSize`). 22 list endpoints migrated. Cursor mode opt-in via `?cursor=` on `/api/admin/orders` + `/api/admin/audit-log` (skips `COUNT`). All defaults from `getStoreConfig().performance.{paginationDefaultSize,paginationMaxSize}` — no hardcoded sizes. Spec §2.8 `page > totalPages` → server-rendered storefront pages issue `redirect()`. **Phase 2** (UX polish + SEO + InfiniteScroll): `<Pagination>` gains `jumpInputThreshold` (in-line "Go to page …" numeric input above N pages), `keyboardNav` (ArrowLeft / ArrowRight on the nav with `aria-keyshortcuts`), `urlSync` (callback-mode page/size pushed to URL via `router.push({ scroll: false })`). New `<PaginationSeoLinks>` server component (canonical / rel=prev/next / per-page noindex; controlled by `performance.paginationNoindexFromPage` — default 2). New `<InfiniteScroll<T>>` (IntersectionObserver; auto-falls-back to a `Load more` button under `prefers-reduced-motion`; aria-live; idempotent page tracking via `Set`; gated behind `performance.paginationInfiniteScrollEnabled`, default off). New `<ProductGrid>` switcher; new `usePageSizePreference(scope, default)` hook backed by `sc_ps_<scope>` cookie (1-year `Max-Age`, `SameSite=Lax`, scope sanitised). Cursor mode extended to `/api/admin/{reviews,returns,tickets}`. New `npm run test:pagination` now ships **136 assertions** (87 Phase 1 + 49 Phase 2 across unit + static + integration). | `src/lib/pagination.ts`, `src/lib/seo/paginationSeo.ts`, `src/lib/pageSizePreference.ts`, `src/lib/client/usePageSizePreference.ts`, `src/components/{Pagination,PageSizeSelector,InfiniteScroll}.tsx`, `src/components/seo/PaginationSeoLinks.tsx`, `src/components/storefront/ProductGrid.tsx`, every paginated API route under `src/app/api/**`, every consumer under `src/app/admin/(app)/**` + `src/app/(storefront)/**`, `scripts/test-pagination.ts`. |
| **#13** Missing page routes `/contact` + `/support` | Replaces the two highest-visibility 404s in the storefront. `/contact` (server component shell + `<ContactForm>` client) renders all contact info from `getStoreConfig()` (email/phone/address rows omitted when empty) with a Google-Maps link card and a public form. `POST /api/contact` is rate-limited (`contact.form` — 3/hr/IP, new policy), CSRF-protected, honeypot-filtered (`website` field — silent 200), and on success enqueues a `SEND_EMAIL` job to `notifications.adminEmail` + (for authed users) creates a `SupportTicket` with subject `[CONTACT_FORM] …`. Email-pinning: authed callers can't spoof a different `from`. `/support` shows hero + 4 quick-action cards + FAQ accordion (8 items, B2B item gated on `features.b2bEnabled`, payment-methods copy from `payments.upiEnabled`) + ticket list/form (gated `features.supportTickets`) + live chat card (gated `features.liveChat`). Both feature-flag sections are removed from the DOM when off — never CSS-hidden. New `<FaqAccordion>` (WAI-ARIA pattern, keyboard navigable, `prefers-reduced-motion` aware), `<SupportTicketList>`, `<SupportTicketForm>` (reuses existing `POST /api/account/tickets`). Footer now carries Support + Contact links. New `npm run test:contact-support` (61 assertions: unit + static + integration). | `src/app/(storefront)/{contact,support}/page.tsx`, `src/app/api/contact/route.ts`, `src/components/storefront/{ContactForm,FaqAccordion,SupportTicketForm,SupportTicketList}.tsx`, `src/lib/contact/schema.ts`, `scripts/test-contact-support.ts`. |
| **#9** Permanent `+91` country code in phone fields | India-only UX + data contract. New `<PhoneField>` (locked `+91` prefix, 10-digit input, composite focus ring, paste-normalises permissive formats, full a11y with hidden "Country code plus ninety one" span). Canonical `normalisePhone` / `isValidIndianMobile` / `formatPhone` / `maskPhoneForDisplay` / `stripIndianPrefix` extracted to `src/lib/utils/phone.ts` (single source of truth — static audit asserts no duplicate definition). `phoneSchema` in `lib/auth/schemas.ts` now uses the canonical normaliser as a Zod transform; every `/api/**` route with a `phone:` field uses `phoneSchema` (no rogue regex copies). Three inline phone Zods (`/api/addresses`, `/api/addresses/[id]`, `/api/account/profile`) collapsed to imports. New `fieldType: 'phone'` hint on `ConfigEntry` — `store.supportPhone` declares it; admin store-config UI swaps in `<PhoneField>` for that key. Six display sites switched to `formatPhone()`. New `npm run test:phone-field` (75 assertions: unit + static + integration). | `src/lib/utils/phone.ts`, `src/components/forms/PhoneField.tsx`, `src/lib/auth/schemas.ts`, `src/lib/auth/phoneVerification.ts`, `src/app/signup/page.tsx`, `src/app/(storefront)/account/addresses/page.tsx`, `src/app/(storefront)/checkout/page.tsx`, `src/app/admin/(app)/store-config/page.tsx`, `scripts/test-phone-field.ts`. |
| **#8** Admin Power Features / Store Config + Feature Toggles | Schema-first admin control plane. **123+ typed entries** across 12 categories (`store`, `features`, `products` — added by Item 19, hosts the 9 gallery knobs from Items 19+20, `payments`, `shipping`, `checkout`, `loyalty`, `b2b`, `notifications`, `security`, `performance`, `maintenance`). `getStoreConfig()` returns a unified view: legacy nested shape (policies/hero) PLUS new flat-key schema, both backed by the same DB row. 30s in-process cache invalidated on every PATCH. 4 admin endpoints (`GET/PATCH /api/admin/store-config`, `POST .../export`, `POST .../import` two-phase, `POST .../reset` with typed confirmation). Schema-driven tabbed admin UI at `/admin/store-config` — every field renders from its schema entry; per-field danger confirmations; export/import/reset all wired. Maintenance mode redirects non-admin storefront traffic via root server layout (Edge middleware can't reach Prisma). Announcement banner (server-rendered + client dismiss with hashed key). `featureGate.ts` helper (`requireFeature` / `isFeatureOn` / `getCheckoutLimits`) gates **15 route handlers**: auth/signup, wishlist toggle, compare GET+POST, account/reviews, account/chat, account/tickets, all `/api/b2b/*`, checkout place-order + express, cart add+update + their numeric limits. New `FeatureFlagProvider` React context for client components. New stable error codes: `FEATURE_DISABLED`, `FEATURE_PAUSED`, `CONFIG_VALIDATION_ERROR`, `INVALID_CONFIG_FILE`, `CART_FULL`, `QUANTITY_LIMIT_EXCEEDED`. Two test suites: `test:store-config` (now **964 assertions** — schema + service + integration; bumped from the original 817 as new categories landed) and `test:store-config-gating` (66 assertions exercising every gate end-to-end with `SHOPCORE_ENFORCE_FEATURE_GATES=1`). | `src/lib/storeConfig/{schema,defaults,types,cache,validation,index,maintenance,featureGate,clientFlags}.ts`, `src/components/storefront/{FeatureFlagProvider,AnnouncementBanner,AnnouncementBannerClient}.tsx`, `src/app/maintenance/page.tsx`, `src/app/api/admin/store-config/**`, `src/app/admin/(app)/store-config/page.tsx`, `scripts/test-store-config{,-gating}.ts`. |
| **#7** Background Jobs System | Self-contained, SQLite-backed job queue: `Job` + `JobSchedule` models, `enqueueJob<T>()` typed producer, `JobRunner` with atomic claim + exponential backoff + lock-expiry recovery + graceful SIGTERM drain, `JobScheduler` with hand-rolled 5-field cron parser (UTC), 10 built-in schedules seeded, 11 active worker handlers (cleanup OTPs/sessions/reset-tokens/idempotency, abandoned-cart, low-stock, B2B quote expiry, send-email, DB vacuum/backup, audit archive), 7 stub handlers for future types. Runner starts via `db/client.ts` dynamic-import guarded by `NODE_ENV !== 'test'` + `JOB_RUNNER_ENABLED`. New `User.emailSubscribed` column. **Phase 2 (operator surface)**: 7 admin endpoints (`/api/admin/jobs/*`, `/api/admin/job-schedules/*`) with PII masking + atomic-safe cancel; admin UI at `/admin/jobs` (stats cards + filterable jobs table + per-row retry/cancel + schedule on/off toggles); SideNav "Background jobs" entry. New error codes: `JOB_NOT_RETRYABLE`, `JOB_NOT_CANCELLABLE`, `INVALID_CRON`, `INVALID_JOB_PAYLOAD`. `npm run test:background-jobs` (162 assertions incl. 41 integration tests via spawned `next start`). | `src/lib/jobs/{jobTypes,cronParser,producer,runner,scheduler,startup,adminSerializers}.ts`, `src/lib/jobs/workers/*.ts`, `src/app/api/admin/jobs/**`, `src/app/api/admin/job-schedules/**`, `src/app/admin/(app)/jobs/page.tsx`, `prisma/migrations/20260605120000_background_jobs/`, `scripts/test-background-jobs.ts`. |
| **Edge-Case Audit Sprint** | 8 fixes across 5 domains: D2.2 + D2.3 (state-machine gating on order/write surfaces), D4.4 (stock decrement race), D5.2 (coupon increment race), D1.4 (OTP timing attack), D9.7 (`x-request-id` log injection), D9.5 (production env-leak preflight), D7.4 (`b2b/quotes/new` stable keys). New `src/lib/auth/guards.ts` composable gate module. New `npm run test:edge-cases` harness (51 assertions, port 3057). New stable error codes: `ACCOUNT_NOT_ORDER_PERMITTED`, `ACCOUNT_NOT_WRITE_PERMITTED`, `INSUFFICIENT_STOCK`, `COUPON_EXHAUSTED`. | `src/lib/auth/guards.ts`, `src/lib/checkout/placeOrder.ts`, `src/lib/auth/otp.ts`, `src/middleware.ts`, `src/lib/boot.ts`, `scripts/test-edge-cases.ts`. |
| **#35** Product Shareable URL System | Share button on PDP · native `navigator.share` · fallback modal (WhatsApp/Telegram/Facebook/X/Email/Copy Link) · Open Graph + Twitter Card + canonical · UTM per channel · `ProductSlugAlias` table → 307 redirect on slug change. | `src/lib/share/productUrl.ts`, `src/lib/cms/productSlugAlias.ts`, `src/components/storefront/ShareButton.tsx`, PDP `generateMetadata`. |
| **#16** Admin "upload from computer" | `<ImageUploadInput>` drop-in replacement for "image URL" inputs · server endpoint `POST /api/admin/uploads?kind=…` · sharp re-encode · public `/api/uploads/public-images/*` lane. | `src/lib/uploads/adminImages.ts`, `src/components/admin/ImageUploadInput.tsx`. |
| **#15** Hero Banner Carousel + CMS | `HeroBanner` model · public `/api/hero-banners` · admin CRUD + reorder + schedule · pure native React carousel with pause-cause aggregation + swipe + keyboard + `<picture>` desktop/mobile. | `src/components/storefront/HeroCarousel.tsx`, `src/lib/cms/heroBanners.ts`. |
| **#14** Comprehensive responsiveness overhaul | `xs:380px` breakpoint · fluid type via `clamp()` CSS vars · `.tap-target` utility · `<MobileNavDrawer>` · `<ResponsiveTable>` · iOS-zoom-on-focus fix · safety-net bare-`<table>` CSS · `<AdminShell>`. | `tailwind.config.ts`, `src/app/globals.css`, `src/components/MobileNavDrawer.tsx`, `src/components/ResponsiveTable.tsx`. |
| **#13** India-Wide PIN Code verification + autofill | `PincodeService` interface · India Post upstream + 24h cache · `/api/pincode/[pincode]` proxy · `<PincodeField>` (debounced, race-safe, multi-PO dropdown, "Verified by India Post" card). | `src/lib/pincode/*`, `src/lib/shipping/serviceableStates.ts`, `src/components/forms/PincodeField.tsx`. |
| **#12** Forgot/Reset Password (OTP) | `PasswordResetRequest` + `PasswordResetToken` · 4 endpoints (initiate / verify-otp / resend / reset) · 4-step UI with `<OtpInput>` + reuse of Feature #11 password meter. | `src/lib/auth/passwordReset.ts`, `src/app/api/auth/forgot-password/*`, `src/app/forgot-password/page.tsx`, `src/components/auth/OtpInput.tsx`. |
| **#11** Account uniqueness + strong-password UX | `User.phone @unique` · 13,728-entry blocklist · `validatePassword()` shared validator · `/api/auth/check-email` · `<PasswordStrengthMeter>` · `<PasswordField>` (👁/🙈). | `src/lib/auth/passwordPolicy.ts`, `commonPasswords.ts`, `src/components/auth/Password*`. |
| **#10** Strict email-allowlist policy | Anti-farming: plus-alias, Gmail dot-obfuscation, fragmentation checks. | `src/lib/auth/emailPolicy.ts`. |
| **#9** Secure user logout | `revokeAllFamilies`, `revokeOtherFamilies` · logout-all / logout-others endpoints · `<LogoutButton>` variants. | `src/lib/auth/refresh.ts`, `src/components/LogoutButton.tsx`. |
| **Buy Now** express checkout | `ExpressCheckout` row bypasses the user's cart for a one-shot purchase. | `src/lib/checkout/express.ts`. |
| Hotfix — AppDialog | Replaced every `window.{alert,confirm,prompt}` with `<AppDialog>` (native `<dialog>`-backed). Audited by `test:no-native-dialogs`. | `src/components/dialog/*`. |
| Hotfix — Refresh-token rotation | Family-based reuse detection · single-use opaque refresh tokens · admin/customer cookie separation. | `src/lib/auth/refresh.ts`. |
| Hotfix — UTR verification | UTR de-dup + receipt magic-byte sniff + audit. | `src/lib/checkout/utr.ts`. |
| Hotfix — Real-time stock validation | Per-add server clamp + reservation logic. | `src/app/api/cart/add/route.ts`. |
| Hotfix — Idempotent checkout | `IdempotencyKey` row + 10 parallel POSTs → 1 order. | `src/lib/checkout/idempotency.ts`. |
| Hotfix — Server-side price integrity | Cart / order totals are recomputed server-side; client-supplied prices rejected. | `src/lib/catalog/pricing.ts`, `src/lib/checkout/totals.ts`. |
| Hotfix — Variant price not updating | `selectVariantPrice()` pure selector shared by server + client; live headline price. | `src/lib/catalog/variantPrice.ts`. |
| Hotfix — Loyalty over-credit | Admin-configurable formula with fail-safe defaults. | `src/lib/account/loyaltyFormula.ts`. |

### Test suite tally (current — all green)

**44 test scripts** in `scripts/test-*.{ts,tsx}` totalling **~4,090+ dynamic assertions + 446 source-file audits** (52 Prisma models · 16 migrations · 30 rate-limit policies · 123+ store-config entries). Item-by-item contribution table for the recent stack:

| Item | Test script | Assertions |
|---|---|---|
| **#20 Gallery Interaction**          | `test:product-gallery-interaction` | 96 |
| **#19 Product Gallery (foundation)** | `test:product-gallery`             | 124 |
| **#18 Homepage CMS Phase 2**         | `test:homepage-p2`                 | 250 |
| **#18 Homepage CMS Phase 1**         | `test:homepage-revamp`             | 147 |
| **#17 Real Brand Assets**            | `test:brand-assets`                | 213 |
| **#14 Compare**                      | `test:compare`                     | 127 |
| **#13 Contact / Support**            | `test:contact-support`             | 61 |
| **#12 Pagination**                   | `test:pagination`                  | 136 |
| **#8 Store Config**                  | `test:store-config`                | 964 |
| **#8 Store Config Gating**           | `test:store-config-gating`         | 66 |
| **#7 Background Jobs**               | `test:background-jobs`             | 162 |
| Edge-Case Audit Sprint               | `test:edge-cases`                  | 51 |
| Error-handling discipline            | `test:error-handling`              | 144 |
| Logging discipline                   | `test:logging`                     | 122 |
| Rate-limiting discipline             | `test:rate-limiting`               | 217 |
| Native-dialog audit                  | `test:no-native-dialogs`           | 446 source files |
| Rest (auth / hero / cart / OTP / …) | per-feature suites                 | the remainder |

Each script is standalone (`npm run test:<name>`). See **Section 9. Testing strategy** for the runner architecture and harness conventions.

---

## 3. Technology stack

### Runtime + framework

- **Node.js**: `>=20.0.0` (current dev: 20.20.2). `engines` enforced in `package.json`.
- **Next.js**: **14.2.18** (App Router only; no Pages Router). Locked — do not bump without coordinated migration.
- **React**: 18.3.1, **strict mode on** (`next.config.mjs` → `reactStrictMode: true`).
- **TypeScript**: 5.6.3, `strict: true`, `target: ES2022`, `module: esnext`, `moduleResolution: bundler`. Path alias **`@/* → src/*`**.

### Data layer

- **Prisma**: 5.22.0 (NOT 7.x — Prisma 7 will fail to read the schema; do not auto-upgrade).
- **Database**: **SQLite**, single file at `data/store.db`. Connection string: `file:../data/store.db` relative to `prisma/`.
- **Migrations**: hand-written SQL under `prisma/migrations/<timestamp>_<name>/migration.sql` because `prisma migrate dev` is non-interactive-blocked in this sandbox. **Always apply with `npx prisma migrate deploy && npx prisma generate`**.

### Auth + crypto

- **jose** 5.9.6 — JWT HS256 access tokens.
- **bcryptjs** 2.4.3 — password hashing (cost 12). Note: `bcryptjs`, NOT native `bcrypt`.
- **crypto** (node:crypto) — refresh tokens, OTP randomness, SHA-256 token hashing.

### Email / images / files

- **nodemailer** 6.9.16 — SMTP via Gmail App Password (free, ≤500/day).
- **sharp** 0.33.5 — image re-encoding (EXIF strip, resize ≤2400 px, JPG q85 mozjpeg).
- **exceljs** 4.4.0 — admin bulk Excel import/export (products, inventory, users).
- **firebase-admin** 12.7.0 — OPTIONAL identity mirror (does not gate any flow if unconfigured).

### Validation, styling, tooling

- **Zod** 3.23.8 — every request boundary.
- **Tailwind CSS** 3.4.15 + autoprefixer + postcss. Brand colour palette in `tailwind.config.ts`. Custom utilities: `.tap-target`, `text-fluid-*`.
- **ESLint** 8.57.1 with `eslint-config-next`. `.eslintrc.json`: `{ "extends": "next/core-web-vitals" }`.
- **tsx** 4.19.2 — runs `.ts`/`.tsx` test scripts.
- **jsdom** 24.1.3 — for component test scripts (`scripts/test-*.tsx`).
- **@testing-library/react** + **@testing-library/dom** — available but not heavily used; most tests render via `createRoot` + `react-dom/test-utils.act` directly.

No paid libraries. No `bcrypt`/`argon2`. No `zustand`/`redux`/`react-query`/`swr` — state is local + small client-fetch helper.

---

## 4. Project structure

```
/                          ← repo root
├── prisma/
│   ├── schema.prisma      ← single Prisma schema (52 models — see Section 12)
│   ├── seed.ts            ← creates bootstrap admin + B2B tiers + cats + brands + StoreConfig
│   ├── seed-products.ts   ← 22 demo products + variants + images
│   └── migrations/        ← hand-rolled SQL per migration folder
├── data/
│   ├── store.db           ← SQLite DB file (gitignored)
│   ├── uploads/           ← user-uploaded receipts/attachments/public-images
│   └── backups/           ← VACUUM INTO snapshots
├── docs/
│   └── excel-templates/   ← regenerated by `npm run excel:templates`
├── public/                ← static assets (logos, QR placeholder)
├── scripts/               ← TS scripts run via tsx (tests, backup, restore, preflight, excel)
├── src/
│   ├── middleware.ts      ← request-id + security headers + cookie-presence gates for /admin, /account, /b2b
│   ├── app/               ← Next.js App Router (see below)
│   ├── components/        ← React components (client + server)
│   └── lib/               ← business + infrastructure logic
├── .env / .env.example
├── tailwind.config.ts
├── next.config.mjs        ← CSP, security headers, server-actions body limit
├── tsconfig.json
├── postcss.config.js
├── package.json
├── README.md              ← human onboarding
├── DEPLOY.md              ← single-VPS systemd + Nginx + Certbot + backup cron
├── API.md                 ← every endpoint catalogued
├── BUILD_LOG.md           ← phase-by-phase + feature-by-feature record (authoritative)
└── CONTEXT.md             ← this file
```

### `src/app/` — Next.js App Router routes

Two route groups bracketed in parentheses (do NOT appear in URLs):

```
src/app/
├── layout.tsx                      ← root layout — DialogProvider, viewport, body overflow-x-hidden
├── globals.css                     ← fluid type vars, table safety-net, dialog/drawer keyframes, iOS-zoom fix
├── login/  signup/  verify/  forgot-password/   ← public auth pages
├── icon.tsx                        ← Item 17 — dynamic favicon (next/og ImageResponse → admin asset OR generated PNG)
├── apple-icon.tsx                  ← Item 17 — 180×180 Apple touch icon (same pattern)
├── opengraph-image.tsx             ← Item 17 — default 1200×630 OG card (admin asset OR generated)
├── (storefront)/                   ← B2C + B2B + customer dashboard share this layout
│   ├── layout.tsx                  ← FeatureFlagProvider + CompareProvider + CartProvider + <CompareTray /> + StorefrontHeader (with admin-configured <StoreLogo>) + StorefrontFooter
│   ├── page.tsx                    ← homepage — Item 18 CMS-driven composition: reads `HomepageSection` rows via `getHomepageComposition()` and dispatches per-kind to 11 SSR blocks via `<HomepageRenderer>`. Feature-flag fallback to `_legacy-page.tsx` (Item-1-era hand-coded layout) when `features.homepageRevampEnabled=false` or composition is empty. `/?preview=admin` (admin-only) bypasses the active+window filter so admins can sanity-check unpublished sections.
│   ├── c/[slug]/                   ← category listing (admin banner + description) — paginated (Item 12) + SEO links (Item 12 P2)
│   ├── p/[slug]/                   ← PDP — generateMetadata reads store name from config; OG falls back to /opengraph-image; slug-alias 307 redirect; renders Item 19+20 `<ProductGallery>` (static branch when interactions disabled, interactive island when enabled)
│   ├── search/                     ← paginated, SEO link tags, optional InfiniteScroll
│   ├── cart/, checkout/, wishlist/ ← wishlist paginates via Pagination component (Item 12)
│   ├── compare/                    ← Item 14 — multi-product spec sheet (page.tsx server + CompareClient.tsx client)
│   ├── contact/, support/          ← Item 13 — public contact form + support hub (FAQ accordion, tickets, live chat card)
│   ├── account/                    ← customer dashboard (orders, addresses, returns, reviews, loyalty, support, …)
│   ├── b2b/                        ← B2B portal (dashboard, quotes, bulk)
│   └── orders/[id]/                ← order detail + /invoice
├── b2b/apply/                      ← public B2B application page (unauthenticated)
├── admin/
│   ├── login/                      ← admin sign-in
│   └── (app)/                      ← gated admin shell
│       ├── layout.tsx              ← server-side admin gate → renders <AdminShell> (client component, hamburger + sidebar)
│       ├── page.tsx                ← dashboard
│       └── <every admin section>/  ← products, categories, brands, inventory, orders, returns, reviews, tickets, chat, coupons, promotions, hero-banners, campaigns, push, quotes, customers, b2b, excel,
│                                       store-config (Item 8 — schema-driven tabbed UI with <ImageUploadInput> for image: fieldType; new `products` tab hosts Items 19+20 gallery knobs),
│                                       jobs (Item 7 — background-job dashboard, stats + filter + retry/cancel + schedule toggles),
│                                       assets (Item 17 P2 — asset health dashboard + bulk upload),
│                                       homepage (Item 18 P2 — tabbed Sections / Metrics / Branches with drag-reorder + 13 per-kind config forms),
│                                       products/[id] (Item 19 — gallery manager inline on the product edit page: drag-reorder + multi-upload + Set-primary + alt-text + disable + delete),
│                                       audit-log, analytics
└── api/                            ← all API route handlers (every file is a Next.js Route Handler)
    ├── health/, ready/             ← liveness + readiness
    ├── auth/                       ← signup, login, otp/{verify,resend}, csrf, me, logout, logout-all, logout-others, refresh, sessions, check-email, forgot-password/*, admin/login
    ├── account/                    ← password, profile, orders, returns, reviews, tickets, subscriptions, saved-carts, reorder, loyalty, referrals, chat, upload — every list paginated (Item 12)
    ├── addresses/                  ← list/create + [id] PATCH/DELETE
    ├── cart/                       ← add, update, merge, preview, validate, list
    ├── checkout/                   ← summary, place-order (idempotent), upload-receipt, express
    ├── orders/[id]/                ← get, cancel
    ├── products/, products/[slug]/ ← catalog read
    ├── categories/, brands/        ← Item 17 surfaces logoUrl/imageUrl/bannerUrl/iconUrl/description
    ├── compare/                    ← Item 14 — GET/POST/DELETE + DELETE /[productId] + POST /sync (login-merge)
    ├── wishlist/toggle
    ├── pincode/[pincode]/          ← Feature #13 India Post proxy
    ├── hero-banners/               ← Feature #15 public list
    ├── contact/                    ← Item 13 — public POST (CSRF, rate-limited, honeypot, enqueues SEND_EMAIL job)
    ├── b2b/                        ← apply, bulk-add, me, quotes/{[id],accept,decline}
    ├── uploads/[...path]/          ← gated file server (receipts + attachments private; public-images public)
    └── admin/                      ← all admin CRUD endpoints; every one calls requireAdminUser + assertCsrf
        ├── products, categories (+ brand/banner/icon fields — Item 17), brands (+ logo/banner/description — Item 17),
        ├── customers, b2b-applications, orders/[id]/{status,verify-payment,reject-payment,refund,shipping},
        ├── returns, reviews, coupons, promotions, hero-banners, campaigns, push, tickets, chat, quotes,
        ├── excel/{products,inventory,users}, analytics, audit-log (Item 12 — cursor mode),
        ├── store-config/{GET,PATCH,export,import,reset} (Item 8),
        ├── jobs/* + job-schedules/* (Item 7 — admin job ops),
        ├── assets (Item 17 P2 — paginated registry GET + DELETE /[id] with reference check + ?force=1 override),
        ├── rate-limits (admin inspection + reset),
        ├── ai/suggest-tags, tiers, uploads (Item 17 — extended kind registry, records StoreAsset on success)
```

### `src/lib/` — business + infrastructure

```
src/lib/
├── config.ts              ← Zod-validated env; re-exports DEFAULT_STORE_CONFIG (legacy nested shape)
├── enums.ts               ← String-backed enums (SQLite has no enums) + Zod parsers (UserRole, OrderStatus, INDIAN_STATES, …)
├── api.ts                 ← jsonOk(), jsonError(), handleError(), withErrorHandling() — central error router for every route handler
├── errors.ts              ← typed `ShopCoreError` hierarchy (8 subclasses), `mapPrismaError`, `wrapExternal`, `registerProcessErrorHandlers`
├── log.ts                 ← structured JSON logger (auto requestId + PII redaction, never throws)
├── log/
│   └── context.ts         ← AsyncLocalStorage-backed request context (`runWithRequestContext`, `getRequestContext`)
├── boot.ts                ← production preflight (refuses to start if SHOPCORE_DISABLE_RATE_LIMITS=1 etc.)
├── auth/                  ← session.ts, refresh.ts (family rotation), password.ts (bcrypt), passwordPolicy.ts (#11), commonPasswords.ts (13,728-entry blocklist), passwordReset.ts (#12), otp.ts, emailPolicy.ts (#10), firebase.ts (optional mirror), firebasePhone.ts (Phone Verification), phoneVerification.ts + phoneConstants.ts, accountStateMachine.ts + accountStateHelpers.ts (the ONLY legitimate User.status writer at runtime), guards.ts (composable route gates — requireWritePermitted/requireOrderPermitted), schemas.ts (Zod)
├── security/              ← csrf.ts (double-submit cookie), ratelimit.ts (typed `applyRateLimit`), rateLimitStore.ts (in-memory; Redis-ready adapter), rateLimitPolicies.ts (single source of truth — **30 policies** incl. compare.add/sync, contact.form, newsletter.subscribe), rateLimitHeaders.ts, ip.ts, headers.ts
├── catalog/               ← queries.ts (Prisma read helpers — getBrands, getCategoriesWithCounts, listProducts, etc.), pricing.ts (priceCtxForUser, effectivePricePaise, rupees), variantPrice.ts, cart.ts, cartView.ts, imageTile.ts
├── checkout/              ← totals.ts, coupon.ts, idempotency.ts, placeOrder.ts, orderNumber.ts, utr.ts, storeConfig.ts (legacy nested view), express.ts (Buy Now)
├── account/               ← loyalty.ts, loyaltyFormula.ts, reorder.ts, returns.ts, reviews.ts, compare.ts (Item 14 — dual cookie/DB backend + sync)
├── b2b/                   ← apply.ts, bulk.ts, gstin.ts (checksum), quotes.ts
├── admin/                 ← guards.ts (requireAdminUser, AdminGuardError, audit), analytics.ts, excel.ts, orders.ts, quotes.ts
├── cms/                   ← heroBanners.ts (#15), productSlugAlias.ts (#35), homepage.ts + homepageSchemas.ts + homepageDefaults.ts (Item 18 — section composition service, 13 per-kind Zod configs, first-boot seed), productGallery.ts (Item 19 + 20 — gallery CRUD service + interaction-settings reader), schemas.ts
├── share/                 ← productUrl.ts (Feature #35 pure URL service)
├── pincode/               ← types.ts, indiaPost.ts (IndiaPostPincodeService + 24h cache)
├── shipping/              ← serviceableStates.ts
├── uploads/               ← receipts.ts, attachments.ts, adminImages.ts (#16; Item 17 — branches PNG vs JPG per kind), imageKinds.ts (Item 17 — declarative kind registry, 11 kinds)
├── compare/               ← Item 14 — attributeGroups.ts (declarative groups per category), attributeKeyResolver.ts (union-of-keys), differenceDetector.ts (case-insensitive, array-aware), compareData.ts (single-query Prisma aggregator)
├── contact/               ← Item 13 — schema.ts (`ContactFormSchema`)
├── pagination.ts          ← Item 12 — `parsePaginationParams`, `parseCursorParams`, `paginatedQuery`, `buildPagination`, `buildCursorPagination`, `buildPageWindow`
├── pageSizePreference.ts  ← Item 12 P2 — cookie reader/writer (`sc_ps_<scope>`)
├── seo/                   ← Item 12 P2 — paginationSeo.ts (canonical / rel=prev/next / per-page noindex)
├── storeConfig/           ← Item 8 control plane — schema.ts (**123+ typed entries** across 12 categories: `store`, `features`, `products` (NEW — Item 19+20 gallery knobs), `payments`, `shipping`, `checkout`, `loyalty`, `b2b`, `notifications`, `security`, `performance`, `maintenance`; supports `fieldType: 'image:<kind>'`), defaults.ts (legacy nested), types.ts (derived `StoreConfigValues`), cache.ts (30s in-process), validation.ts, index.ts (`getStoreConfig`), maintenance.ts, featureGate.ts (`requireFeature`, `isFeatureOn`, `requireCompareEnabled`, Item 18: `isHomepage{Revamp,Brands,Metrics,Branches}Enabled`, Item 19+20: `isProductGalleryEnabled / isProductGalleryLazyLoadEnabled / isGalleryInteractionsEnabled / isGalleryZoomEnabled / isGalleryFullscreenEnabled / isGalleryLoopEnabled`, …), clientFlags.ts (`buildClientFlags` for `<FeatureFlagProvider>`)
├── assets/                ← Item 17 — colorFromString.ts (deterministic palette + initials), assetHealth.ts (coverage), storeAsset.ts (list, findReferences, deleteAsset), filenameMatch.ts (Levenshtein bulk-upload matching)
├── jobs/                  ← Item 7 — jobTypes.ts (typed JobPayloadMap), cronParser.ts (5-field UTC), producer.ts (`enqueueJob<T>`), runner.ts (atomic claim + backoff + lock-expiry), scheduler.ts (BUILT_IN_SCHEDULES), startup.ts (singleton runner; gated on NODE_ENV !== 'test' + JOB_RUNNER_ENABLED), adminSerializers.ts (PII masking), workers/*.ts (11 active + 7 stub)
├── email/                 ← send.ts (Nodemailer; dev-console fallback; test hooks)
├── ai/                    ← tagger.ts (offline keyword tagger)
├── utils/                 ← phone.ts (Item 9 — canonical normalisePhone/isValidIndianMobile/formatPhone/maskPhoneForDisplay)
├── client/                ← api.ts (browser fetch wrapper with CSRF; `api()` tagged + `apiOrThrow()` throw forms), logout.ts, usePageSizePreference.ts (Item 12 P2 — cookie-backed page-size hook)
└── db/
    └── client.ts          ← Prisma singleton (hot-reload-safe via global.__prisma__); kicks off the JobRunner on first import (production only)
```

### `src/components/`

```
src/components/
├── AuthForm.tsx              ← <AuthShell>, <Field>, <Alert>, <SubmitButton>
├── LogoutButton.tsx          ← ghost / solid / danger / menu variants
├── MobileNavDrawer.tsx       ← left-edge slide-in <dialog>, focus trap
├── ResponsiveTable.tsx       ← scrollable wrapper with role=region
├── ErrorBoundary.tsx         ← per-segment React error boundary (storefront + admin layouts both use)
├── Pagination.tsx            ← Item 12 — canonical pagination (LINK + CALLBACK modes; mobile/desktop variants; jumpInputThreshold, keyboardNav, urlSync; aria-current/aria-keyshortcuts)
├── PageSizeSelector.tsx      ← Item 12 — visible <label>, filters options against paginationMaxSize
├── InfiniteScroll.tsx        ← Item 12 P2 — IntersectionObserver wrapper, prefers-reduced-motion fallback to "Load more" button, aria-live, idempotent Set-tracked pages
├── seo/
│   └── PaginationSeoLinks.tsx ← Item 12 P2 — server component, emits <link rel="canonical/prev/next"> + <meta name="robots" content="noindex,follow">
├── dialog/                   ← AppDialog.tsx + DialogProvider.tsx (useDialog hook — single source of truth, no native window.alert/confirm)
├── auth/                     ← OtpInput.tsx, PasswordField.tsx, PasswordStrengthMeter.tsx, BackButtonGuard.tsx, PhoneVerificationForm.tsx
├── forms/                    ← PincodeField.tsx, PhoneField.tsx (Item 9 — locked +91 prefix)
├── admin/                    ← AdminShell.tsx, SideNav.tsx (Settings → Store config / Assets / Homepage CMS / Background jobs — Item 18 added /admin/homepage), Helpers.tsx (PageHeader/Card/Button/StatusBadge), ImageUploadInput.tsx (Feature #16; type widened to imageKinds.AdminImageKind — now supports the `'product'` kind)
├── storefront/
│   ├── StorefrontHeader.tsx + StorefrontFooter.tsx + UserMenu.tsx
│   ├── CartProvider.tsx + AddToCartButton.tsx + BuyNowButton.tsx + QuantityControl.tsx
│   ├── ProductCard.tsx + ProductPriceAndPicker.tsx + ProductGrid.tsx (Item 12 P2 switcher: SSR grid vs InfiniteScroll)
│   ├── ProductGallery.tsx + InteractiveProductGallery.tsx ← Items 19 + 20 — server shell delegates to client island when `products.galleryInteractionsEnabled` is on; static branch preserves Item-19 markup verbatim. Interactive island: click-to-swap thumbs (role=tab/aria-selected/aria-current), prev/next + counter overlay, ArrowLeft/Right/Home/End keyboard, 40 px touch swipe, hover/tap CSS zoom, focus-trapped fullscreen `<dialog>.showModal()` lightbox, `prefers-reduced-motion` always overrides admin transition. |
│   ├── WishlistButton.tsx + SubscribeWidget.tsx + HeroCarousel.tsx + ShareButton.tsx
│   ├── StoreLogo.tsx + StoreLogoImage.tsx + BrandLogo.tsx + CategoryImage.tsx ← Item 17 — designed-fallback components (real img → inline SVG / initial tile / gradient; never broken)
│   ├── homepage/HomepageRenderer.tsx + homepage/blocks.tsx + homepage/NewsletterForm.tsx ← Item 18 — CMS-driven storefront homepage: HomepageRenderer dispatches per-kind to 11 SSR blocks (HERO / FEATURED_BRANDS / TOP_CATEGORIES / PRODUCT_COLLECTION / WIDE_PROMO_BANNER / DUAL_PROMO_CARDS / BRAND_SHOWCASE / STORE_METRICS / WHY_SHOP_WITH_US / BRANCHES / NEWSLETTER). NewsletterForm is the client island for `POST /api/newsletter/subscribe`.
│   ├── CompareProvider.tsx + CompareTray.tsx + CompareButton.tsx + CompareTable.tsx + CompareProductHeader.tsx + CompareActionRow.tsx + CompareRatingBreakdown.tsx + CompareVariantsTable.tsx + CompareAttributeRow.tsx ← Item 14
│   ├── ContactForm.tsx + FaqAccordion.tsx + SupportTicketList.tsx + SupportTicketForm.tsx ← Item 13
│   ├── FeatureFlagProvider.tsx + AnnouncementBanner.tsx + AnnouncementBannerClient.tsx + StorefrontErrorFallback.tsx ← Item 8
├── account/                  ← SideNav.tsx + per-section UI
├── b2b/                      ← B2B-only UI
└── orders/                   ← order-line widgets, invoice fragments
```

---

## 5. Architecture patterns

### Monolith, layered

- **Single Next.js app** running both server (RSC + API route handlers) and client (React 18) — no microservices.
- Layered:
  1. **Route handler / Server component** (thin) — `src/app/.../route.ts` or `page.tsx`. Parses input via Zod, calls service, returns response.
  2. **Service / pure module** (thick) — `src/lib/*` (e.g. `lib/auth/passwordReset.ts`, `lib/cms/heroBanners.ts`, `lib/share/productUrl.ts`). All business rules live here. Pure where possible.
  3. **Data layer** — Prisma client (`src/lib/db/client.ts`).
- **Server is authoritative for everything that matters**: pricing recompute, stock decrement, idempotency, payment verification, RBAC. The client is the experience.

### Auth model

- **Two cookie pairs**, never share between roles:
  - `sc_session` (access JWT, 15 min, HttpOnly + SameSite=Strict) + `sc_refresh` (opaque 32-byte secret, HttpOnly, `Path=/api/auth`) — CUSTOMER / B2B.
  - `sc_admin` + `sc_admin_refresh` — ADMIN (separate cookies prevent privilege bridging from a storefront session).
- **JWT**: HS256 via `jose`, secret `SESSION_SECRET`. Claims: `{ sub, role, email, jti, fam }`.
- **Refresh-token rotation** (`src/lib/auth/refresh.ts`): single-use opaque secrets, hashed at rest (SHA-256, UNIQUE), family-based reuse detection — a re-presented rotated token invalidates the whole family and audits.
- **`getCurrentUser()`** is the single hot-path accessor. Optionally `{ requireAdmin: true }`.

### Why not a separate API service?

The Next.js App Router gives both SSR pages (SEO, first paint, Open Graph) and JSON endpoints from one process. SQLite + Node fits the scale target (≤500 users/month). No reason to split.

### Patterns to imitate when adding a new feature

1. **Schema first** — add Prisma model with explicit indexes, write a hand-rolled SQL migration under `prisma/migrations/<timestamp>_<name>/migration.sql`, deploy.
2. **Service module** — pure `lib/<area>/<feature>.ts` exports `function doThing(...)` returning a tagged result `{ ok: true, data } | { ok: false, reason }` whenever a failure is expected. Throw only for "this shouldn't happen".
3. **Zod schema** — colocated in `lib/<area>/schemas.ts` (or `lib/auth/schemas.ts`).
4. **Route handler** — `src/app/api/.../route.ts`: `assertCsrf()` (mutations), `requireAdminUser()` (admin), `rateLimit(...)`, `Schema.parse(await req.json())`, call service, `return jsonOk({...})` or `jsonError(...)`. Wrap in try/catch + `handleError(e)`.
5. **Audit log** — every admin mutation calls `audit({ actorId, action: 'ENTITY_VERB', entity, entityId, before, after })`.
6. **Tests** — add `scripts/test-<feature>.{ts,tsx}` and a `package.json` script. Cover UNIT + SERVICE (direct DB) + INTEGRATION (real `next start`) + REGRESSION.
7. **BUILD_LOG entry** with before/after table, file inventory, spec-compliance checklist, and a 🫡 sign-off.

---

## 6. Code conventions

### Files

- **TypeScript everywhere**. No `.js` source files except `postcss.config.js` and `next.config.mjs`.
- **`'use client'`** at the top of any client-only component. Server components are the default (App Router default).
- **kebab-case** for route folders (`/forgot-password`), **PascalCase** for components (`ShareButton.tsx`), **camelCase** for lib files (`productUrl.ts`).
- One main exported entity per file when possible (`export default function …` for components, named exports for services).

### Imports

- Always use the path alias **`@/...`** for cross-tree imports (`import { prisma } from '@/lib/db/client'`). Relative imports only within the same folder.
- Group: external → `@/lib/*` → `@/components/*` → local relative. (Not strictly enforced by lint, but every file follows it.)

### Types

- Strict TS. **No `any` in checked-in code.** When forced to bridge, use `unknown` + an explicit cast comment.
- For Prisma rows, import the generated types from `@prisma/client` (`import type { User } from '@prisma/client'`).
- `interface` for object shapes consumed across module boundaries; `type` for unions / mapped types.

### React patterns

- **Controlled inputs** wherever a parent needs to read the value (every form that opens a dialog or runs validation). FormData reads (`new FormData(e.currentTarget)`) are used for static admin forms only.
- **`useId()`** for accessible label association (BUT not as a CSS selector — IDs contain `:` and break `querySelector`).
- **Async `onSubmit`**: capture `const form = e.currentTarget` BEFORE the first `await` — React 18 nullifies `e.currentTarget` after async boundaries.
- **Reset prefers `motion-reduce:`** variants on every animation: `class="transition-transform duration-300 motion-reduce:transition-none"`.
- **Tap targets**: every interactive control on a small viewport carries `.tap-target` (44×44 minimum — WCAG-AA 2.5.5).
- **Icons**: inline SVG components, no external icon library.

### Server responses

- **All JSON responses** use `jsonOk(data)` / `jsonError(message, status, extra)` from `src/lib/api.ts`. Envelope shape: `{ ok: true, data: ... }` or `{ ok: false, error: "...", code?: "...", issues?: [...] }`.
- **Status codes** are intentional:
  - 200 — normal
  - 400 — Zod / validation
  - 401 — missing/invalid session
  - 403 — CSRF / cross-origin / forbidden
  - 404 — entity not found
  - 409 — uniqueness conflict (e.g. EMAIL_TAKEN, PHONE_TAKEN)
  - 429 — rate-limited
  - 500 — `handleError` catch-all (with stack to logs, generic message to client)

### Money

- Store as **`paise` (integer)**, never floats. `pricePaise: Int` in Prisma. Display via `rupees(paise)` from `lib/catalog/pricing.ts`.

### Dates

- ISO strings on the wire, `DateTime` in Prisma, `Date` in TS. Timezone display is IST (`en-IN` locale).

### Phone numbers

- E.164 with `+91` prefix in storage: `+91XXXXXXXXXX`. Validated by Zod schema in `src/lib/auth/schemas.ts`.

### Slugs

- Lowercase, `[a-z0-9-]`. Unique on `Product.slug`, `Category.slug`, `Brand.slug`. Renaming a product slug should call `recordSlugChange(productId, oldSlug)` from `lib/cms/productSlugAlias.ts` (NOT yet wired into the admin edit page — slug edits aren't currently allowed in the UI).

### Linting

- **`npm run lint`** runs `next lint`. Build will fail on errors. The project uses `eslint-config-next` with `core-web-vitals` rules. No Prettier in CI; rely on EditorConfig + Tailwind sort plugin in editors.

---

## 7. Development setup

### Prerequisites

- Node.js ≥ 20
- npm (the project uses `npm ci`-style installs; lockfile is committed)
- A working shell for tsx scripts (most tests spawn `npx next start`)

### Bootstrap

```bash
git clone <repo> && cd shopcore
npm install --no-audit --no-fund --loglevel=error
cp .env.example .env       # fill SESSION_SECRET, CSRF_SECRET, SMTP_*, BOOTSTRAP_ADMIN_*

# DB setup — IMPORTANT: this project uses migrate deploy, not migrate dev
npx prisma migrate deploy
npx prisma generate
npm run db:seed                # bootstrap admin + B2B tiers + cats + brands + StoreConfig
npm run db:seed:products       # optional: 22 demo products

# Run
npm run dev                    # http://localhost:3000
```

Default admin (change immediately): **`admin@yourdomain.in` / `change_me_immediately`** (from `BOOTSTRAP_ADMIN_*` env vars; defined in `prisma/seed.ts`).

### `node_modules` lives outside the snapshot

In the sandboxed Arena environment, `node_modules` is in the snapshot-excluded list. Reinstall at the start of every fresh session:

```bash
test -d node_modules || npm install --no-audit --no-fund --loglevel=error
```

### Common dev commands

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Generates Prisma client → applies migrations → Next.js build |
| `npm run start` | Production server |
| `npm run lint` | Next + ESLint |
| `npm run preflight` | Boot-time safety, integrity, migrations check |
| `npm run db:studio` | Prisma Studio (GUI) |
| `npm run db:backup` | VACUUM INTO snapshot + integrity verify (writes to `data/backups/`) |
| `npm run db:restore -- <file>` | Restore from snapshot |
| `npm run excel:templates` | Regenerate sample `.xlsx` templates |
| `npx tsc --noEmit` | Type-check the entire tree (always run before committing) |

---

## 8. Build & deployment

### Build pipeline (`npm run build`)

```
prisma generate → prisma migrate deploy → next build
```

The `build` step embeds the Prisma client AND applies any pending migrations to the SQLite file. Production deploys should run `build` BEFORE flipping the systemd unit to the new release.

### Environments

- **dev** — local laptop / `next dev`. `.env` has `NODE_ENV=development`.
- **prod** — single VPS, systemd unit, Nginx + Certbot. Full runbook in `DEPLOY.md`.
- **No staging** — the project's scale doesn't warrant one. Use a feature branch + a throwaway VPS if a staging surface is needed.

### CI/CD

No CI pipeline is checked into the repo. Manual deploy via SSH + git pull + `npm ci && npm run build && sudo systemctl restart shopcore` per `DEPLOY.md`. Add CI as a future enhancement.

### Production safety net

`scripts/preflight.ts` (`npm run preflight`) refuses to declare the app ready unless:

- env passes Zod parsing
- `checkProductionSafety()` (SESSION/CSRF secret length + distinctness, SMTP set in prod, bootstrap admin password rotated, HTTPS APP_URL)
- DB query OK
- StoreConfig row exists
- `prisma migrate status` is clean
- at least 1 active admin

`systemd` runs `preflight` as `ExecStartPre` so a failing prod refuses to come up. Detailed in `DEPLOY.md`.

---

## 9. Testing strategy

### Approach

**No Jest, no Vitest, no test runner.** Each test is a standalone `tsx` script under `scripts/test-<feature>.{ts,tsx}` with its own tiny `ok/fail/eq/assert` harness. This is intentional:

- **Real `next start`** — every integration test spawns a real Next.js server on a unique port (3019, 3021, 3023, …) and exercises it via `fetch`.
- **Real SQLite** — services hit the same `data/store.db` the dev server uses. Tests clean up after themselves with a deterministic tag (`TAG = '<feature>_${Date.now()}_<rand>'`) and `cleanup()` `finally` block.
- **jsdom** for component tests (`.tsx`). React 18 mounts via `createRoot` + `react-dom/test-utils.act`.

### Test categories (every feature ships these)

1. **UNIT** — pure functions (schemas, validators, URL builders, parsers).
2. **SERVICE / SCHEMA / DATABASE** — call lib modules directly against real DB.
3. **INTEGRATION** — spawn `next start`, perform real HTTP, including CSRF cookie jar and admin session minting (via `issueRefreshFamily` + `SignJWT`).
4. **REGRESSION** — assert that touching this feature didn't break neighbouring endpoints.

### Running tests

Every test has its own `npm run test:<name>` script. **44 suites on disk** (one .ts/.tsx file each). Highlights below; full list in `package.json`:

| Script | Coverage |
|---|---|
| `test:auth` | signup → OTP → verify → login → lockout (no server) |
| `test:account-policy` | Feature #11: uniqueness + password policy + /check-email + /account/profile + /account/password |
| `test:account-state-machine` | The state-machine module + the static A1 audit that forbids untagged `User.status` writes anywhere in `src/` |
| `test:forgot-password` | Feature #12 end-to-end |
| `test:phone-verification` | Phone Verification — 3-way cross-check, dev-bypass triple-guard, ACTIVE/SUSPENDED gating |
| `test:phone-field` | Item 9 — `<PhoneField>`, canonical normaliser, `phoneSchema` reuse audit |
| `test:pincode` / `test:pincode-ui` | India Post service + proxy + jsdom field |
| `test:hero-banners` / `test:hero-carousel` | CMS backend + jsdom carousel (timer-leak spy) |
| `test:admin-uploads` | Feature #16 — sharp re-encode + auth + cache headers (PNG/JPG per kind — Item 17) |
| `test:image-upload-input` | jsdom upload component |
| `test:product-share` / `test:share-dialog` | Feature #35 service + OG / a11y |
| `test:no-native-dialogs` | **static audit** — fails if any source file calls `window.{alert,confirm,prompt}` (446 source files scanned) |
| `test:responsive` | static-audit + jsdom for drawer / table foundations |
| `test:logging` | Logger contract — auto-redaction, ALS-driven requestId, console.* forbidden in src/lib + src/app/api |
| `test:error-handling` | Typed error hierarchy, Prisma mapping, the `withErrorHandling` wrapper, A1: no `throw new Error` in src/lib/** |
| `test:rate-limiting` | All 30 policies + admin inspection/reset + A1/A3 audits (no rate-limit numbers outside the policy file) |
| `test:store-config` / `test:store-config-gating` | Item 8 — 123+ entries: schema + service + integration; `SHOPCORE_ENFORCE_FEATURE_GATES` end-to-end |
| `test:background-jobs` | Item 7 — producer, runner (atomic claim + backoff), scheduler (cron parser + built-ins), 11 worker handlers, admin endpoints, integration |
| `test:edge-cases` | Cross-cutting D1–D9 audit sprint (stock decrement race, coupon race, OTP timing, log injection, env-leak preflight, stable keys) |
| `test:contact-support` | Item 13 — /contact + /support pages, schema, honeypot, rate limit, feature flags |
| `test:pagination` | Item 12 — utility unit tests, static audit (`findMany` discipline), integration on /api/products + admin endpoints + cursor mode + /c/[slug] redirect + SEO links |
| `test:compare` | Item 14 — attribute groups, union-of-keys, diff detector, dual cookie/DB backend, share URL, max-items 409, feature flag |
| `test:brand-assets` | Item 17 — colour helper + initials + kind registry; sharp PNG/JPG branching; StoreAsset recording; dynamic /icon /apple-icon /opengraph-image; admin assets dashboard + reference-checked DELETE + bulk-upload filename matching |
| `test:homepage-revamp` | **Item 18 Phase 1** — 13 section kinds + per-kind Zod schemas + service + `/api/homepage` + 11 admin endpoints + storefront renderer + first-boot seed + feature-flag fallback |
| `test:homepage-p2` | **Item 18 Phase 2** — `/admin/homepage` admin UI (Sections / Metrics / Branches tabs); 13 per-kind config forms; drag-reorder + ↑/↓ keyboard; `POST /api/newsletter/subscribe` (uniform-success + 5/hr/IP rate limit + honeypot); `?preview=admin` admin-gated storefront preview mode |
| `test:product-gallery` | **Item 19** — `ProductImage` extended (`isActive`/`createdAt`/`updatedAt` + compound index); new `'product'` image kind; `lib/cms/productGallery.ts` service (`registerImage` / `setPrimary` / `reorderImages` / `deleteImage` — exactly-one-primary + auto-promotion); 5 admin API endpoints + admin manager UI; `<ProductGallery>` SSR with LCP-eager primary; 3 new store-config keys |
| `test:product-gallery-interaction` | **Item 20** — `<InteractiveProductGallery>` client island: click-to-swap thumbnails (role=tab + aria-selected + aria-current); prev/next buttons + ArrowLeft/Right/Home/End keyboard; touch swipe (40 px); hover/tap zoom; focus-trapped fullscreen lightbox via native `<dialog>.showModal()`; reduced-motion gate; 6 new store-config keys (master switch / zoom / fullscreen / loop / transitionMs / thumbnailPosition) |
| `test:dialog` `test:logout` `test:logout-ui` `test:utr` `test:refresh` `test:idempotency` `test:stock` `test:variant-price` `test:price-integrity` `test:loyalty` `test:buy-now` `test:email-policy` `test:otp-input` | per-feature suites — see `package.json` |

**Total: 44 scripts · ≈ 4,090+ dynamic assertions · 446 source-file audits.** When in doubt, run the suite touching your changes + the cross-cutting ones (`edge-cases`, `error-handling`, `logging`, `no-native-dialogs`, `rate-limiting`, `store-config`).

### Common test helpers (study before writing a new one)

- `interface Jar` + `applySetCookies` + `cookieHeader` + `api(jar, path, init)` — cookie-jar style HTTP harness used by every integration test (e.g. `scripts/test-account-policy.ts`).
- `makeAdminJar()` / `makeAuthedUser()` — mint a real session (`prisma.session.create` + signed JWT) so admin routes work without a full login dance.
- `_enableOtpCaptureForTests()` + `_otpCaptureForTests.items` for in-process OTP capture.
- `SHOPCORE_TEST_OTP_FILE` env var for cross-process OTP capture (child-spawned server writes captured OTPs to a JSON-lines file).
- jsdom test scripts polyfill `Element.attachEvent`/`detachEvent` (React 18 dev-build IE-fallback) and `HTMLDialogElement.showModal/close`.

### What to assert

- For services: every success + every failure branch.
- For routes: status codes are deterministic — assert them exactly.
- For UI: ARIA attributes, focus order, `aria-live` text, tap-target classes.
- For animations: don't assert visual frames; assert reduced-motion class is present.

---

## 10. Key modules — responsibilities + deps

| Module | What it does | Depends on | Consumed by |
|---|---|---|---|
| `lib/db/client.ts` | Prisma singleton (hot-reload-safe). | `@prisma/client` | every service |
| `lib/api.ts` | `jsonOk`/`jsonError` + **`handleError`** (central error router — maps ZodError / CsrfError / Prisma errors / ShopCoreError hierarchy to envelope + status) + **`withErrorHandling`** (route-handler wrapper that establishes request-id ALS for logging and catches every thrown error). EVERY route handler in `src/app/api/**` is wrapped. | `lib/log`, `lib/log/context`, `lib/security/csrf`, `lib/admin/guards`, `lib/errors` | every route handler |
| `lib/errors.ts` | **Typed error hierarchy** (`ShopCoreError` + 8 subclasses), `mapPrismaError(e)` (P2002/P2025/P2003/P2024/init/other → typed errors with generic client messages), `wrapExternal(service, op, fn)` helper for third-party calls, `registerProcessErrorHandlers()` (binds `unhandledRejection` + `uncaughtException` — idempotent). Static audit forbids `throw new Error(` anywhere in `src/lib/**` except `log.ts` / `config.ts` / `boot.ts`. | none (zero deps) | every service module, `lib/api.ts`, `lib/db/client.ts` (calls register fn) |
| `lib/client/api.ts` | Browser fetch wrapper with TWO surfaces: `api()` (tagged-result, backwards-compatible) + `apiOrThrow()` (throws `ClientApiError` on failure). `ClientApiError` carries `status` / `code` / `clientMessage` / `issues`; status 0 = network/offline. `isClientApiError(e)` type guard for catch blocks. | none | every client component |
| `lib/log.ts` | **Structured JSON logger** — one line per event, stdout for debug/info, stderr for warn/error. AUTO-attaches `requestId` (via `next/headers()` or our ALS), AUTO-redacts PII / secrets (phone/email/token/otp/utr/...), AUTO-handles cycles / BigInt / Errors. Exports `log.{debug,info,warn,error}` + `log.child(bindings)` + `runWithRequestContext` + `newRequestId`. Silenced in `NODE_ENV=test` (except error). Never throws. | `lib/log/context` (lazy ALS) | everything |
| `lib/log/context.ts` | `runWithRequestContext({requestId, bindings}, fn)` + `getRequestContext()`. Backed by `node:async_hooks` AsyncLocalStorage on Node; degrades to no-op in Edge / browser bundles. | `node:async_hooks` (dynamic require) | `lib/log` only |
| `lib/config.ts` | Zod env + `DEFAULT_STORE_CONFIG`. | `zod` | everywhere |
| `lib/enums.ts` | String enums + Zod parsers (`UserRole`, `OrderStatus`, `INDIAN_STATES`). | `zod` | services + schemas |
| `lib/security/csrf.ts` | `assertCsrf()`, `ensureCsrfCookie()`. Double-submit cookie pattern. | `next/headers` | every mutating route |
| `lib/security/ratelimit.ts` | **`applyRateLimit(policyName, req, ctx?)`** — typed, throws `RateLimitError` on exceed. Also `checkRateLimit(...)` for enumeration-safe surfaces that must return generic 200 on cap. Legacy `rateLimit(key, max, windowSec)` is `@deprecated` shim. Stashes `X-RateLimit-*` budget on AsyncLocalStorage for `withErrorHandling` to attach. | `lib/errors`, `lib/log`, `lib/log/context`, `lib/security/rateLimitStore`, `lib/security/rateLimitPolicies`, `lib/security/rateLimitHeaders` | every route handler |
| `lib/security/rateLimitPolicies.ts` | **Single source of truth** for every rate-limit number. Typed `RATE_LIMIT_POLICIES` registry — `applyRateLimit('auth.login', req)` is compile-checked. Per-window `appliesTo` lets compound (ip+userId) policies pin different limits to different keys. `skipInTest` bypasses in `NODE_ENV=test`; `global` + a few security-sensitive policies (`check_email`, `phone.resend`, `pincode.lookup`) are `false` so their behaviour is tested in real conditions. | none | `lib/security/ratelimit` only |
| `lib/security/rateLimitStore.ts` | `RateLimitStore` interface + `InMemoryRateLimitStore` (fixed-window counter, hot-reload-safe singleton). Adapter-shaped so a Redis replacement is a one-file swap. Exposes `increment` / `peek` / `remaining` / `reset` / `keys` for the admin inspection surface. Cleanup interval uses `unref()` so test scripts can spawn-and-kill servers cleanly. | `lib/errors` (only for `InternalError` on invalid windowSec) | `lib/security/ratelimit` |
| `lib/security/rateLimitHeaders.ts` | `stashRateLimitHeaders` (called by `applyRateLimit` on success) + `attachRateLimitHeaders` (called by `withErrorHandling` on response). Stored on `ctx.state` (not `ctx.bindings`) so they don't pollute log lines. | `lib/log/context` | `lib/security/ratelimit`, `lib/api` |
| `lib/auth/session.ts` | `getCurrentUser`, `createSession`, `destroySession`. | `jose`, `lib/auth/refresh`, `prisma` | every authed route |
| `lib/auth/refresh.ts` | Family-based rotation, `revokeAllFamilies`, `revokeOtherFamilies`. | `prisma`, `node:crypto` | session.ts, logout endpoints, password change/reset |
| `lib/auth/password.ts` | `hashPassword`, `verifyPassword` (bcryptjs cost 12). | `bcryptjs` | signup, login, password change/reset |
| `lib/auth/accountStateMachine.ts` | **The only legitimate writer of `User.status` at runtime.** Declarative transition graph + `transitionAccountState(userId, targetStatus, actor, { reason? })` + `canTransition`. Re-exports pure helpers from `accountStateHelpers.ts`. Writes AuditLog (admin actors) + UserActivity atomically; revokes refresh families on `ACTIVE → SUSPENDED/DELETED`. | `prisma`, `lib/auth/session` (revokeAllSessions), `lib/auth/accountStateHelpers`, `lib/log` | OTP verify route, admin customers PATCH; future phone-verification, account-deletion flows |
| `lib/auth/accountStateHelpers.ts` | Pure predicates: `isLoginPermitted`, `isOrderPermitted`, `isWritePermitted`, `isTerminal`, `isKnownStatus`. Extracted from `accountStateMachine.ts` to break the `session.ts ↔ accountStateMachine.ts` import cycle. | `lib/enums` only | `session.ts`, `guards.ts`, `accountStateMachine.ts` re-exports |
| `lib/auth/guards.ts` | **Composable route-handler auth gates** (added by Edge-Case Sprint, D2.2 + D2.3). `requireAuthenticated(req)` → 401 if no session; `requireWritePermitted(user)` → 403 (`ACCOUNT_NOT_WRITE_PERMITTED`) if user is not write-permitted; `requireOrderPermitted(user)` → 403 (`ACCOUNT_NOT_ORDER_PERMITTED`) if user is not order-permitted. Each returns `NextResponse | null` so handlers chain top-down: `const guard = await requireOrderPermitted(user); if (guard) return guard;`. | `lib/auth/session`, `lib/auth/accountStateHelpers`, `lib/api`, `next/server` | 2 checkout routes (`place-order`, `express`) + 6 account write routes (`reviews`, `returns`, `tickets`, `tickets/[id]/messages`, `saved-carts`, `wishlist/toggle`) |
| `lib/auth/passwordPolicy.ts` | `validatePassword(pw, { email? })`, `assertPasswordOk()`, `PASSWORD_POLICY`. Score 0-5 with honest clamping. | `lib/auth/commonPasswords` (13,728 entries) | signup schema, password change, password reset |
| `lib/auth/passwordReset.ts` | Feature #12 — `initiateReset`, `verifyResetOtp`, `resendResetOtp`, `consumeResetToken`. | `lib/auth/otp`, `lib/auth/refresh`, `lib/auth/passwordPolicy`, `lib/auth/password` | 4 `forgot-password` routes |
| `lib/auth/otp.ts` | `issueOtp({email, purpose, userId, ipAddress})`, `verifyOtp(...)`. Bcrypt-hashed at rest, attempt-bounded. | `bcryptjs`, `prisma`, `lib/email/send` | signup, login, forgot-password |
| `lib/auth/emailPolicy.ts` | Feature #10 — allowlist, plus-alias, gmail dot-obfuscation, fragmentation. | none | email Zod schema |
| `lib/auth/firebase.ts` | Optional mirror to Firebase Auth (no-op if unconfigured). | `firebase-admin` | OTP verify |
| `lib/auth/firebasePhone.ts` | **Phone Verification** — `verifyFirebasePhoneToken(idToken)` calls `verifyIdToken(token, checkRevoked=true)` and extracts `{uid, phone_number}`. Returns `null` when Admin SDK is unconfigured (dev). Throws typed `PhoneTokenVerificationError` on cryptographic / semantic failures. Reuses the existing Admin SDK app — does NOT initialise a second instance. The ONLY file allowed to call `verifyIdToken` (static audit `A3`). | `firebase-admin`, `lib/log`, `lib/config` | `lib/auth/phoneVerification` |
| `lib/auth/phoneVerification.ts` | **Phone Verification** — `verifyPhoneCredential`, `updateUserPhone`, `markPhoneVerifiedByAdmin` (all tagged-result returns). Also exports pure helpers `normalisePhone` + `maskPhone` (used by Zod schemas + log lines). 3-way phone cross-check (Firebase claim / submitted / DB). Triple-guards `'dev-bypass-token'` against production. Re-exports `DEV_BYPASS_TOKEN` from `phoneConstants.ts`. | `prisma`, `lib/auth/firebasePhone`, `lib/auth/accountStateMachine`, `lib/auth/refresh`, `lib/auth/phoneConstants` | 4 phone routes + `<PhoneVerificationForm>` |
| `lib/auth/phoneConstants.ts` | Single-source-of-truth for the `DEV_BYPASS_TOKEN` literal `'dev-bypass-token'`. Safe to import from BOTH client and server (no Prisma / Node imports). The literal appears in ONLY this file + `phoneVerification.ts` + `/api/auth/phone/verify/route.ts` — enforced by static audit `A1`. | none | service, route handler, client form |
| `lib/client/firebase.ts` | Browser-only Firebase JS SDK singleton. `getFirebaseAuth()` returns `Auth | null`; `isFirebaseConfigured()` checks the three `NEXT_PUBLIC_FIREBASE_*` env vars. Safe to import from any component — never throws on import. SEPARATE app registry from `firebase-admin`. | `firebase` (JS SDK, dynamic-imported) | `<PhoneVerificationForm>` |
| `lib/catalog/queries.ts` | `getProductBySlug`, `listProducts`, `getCategoriesWithCounts`, `getFeaturedProducts`. | prisma | storefront pages, search |
| `lib/catalog/pricing.ts` | `priceCtxForUser`, `effectivePricePaise`, `rupees`. Role-aware (B2C / B2B + tier). | prisma | catalog + checkout |
| `lib/catalog/variantPrice.ts` | **Pure** `selectVariantPrice()` used by SSR + client `<ProductPriceAndPicker>`. Single source of truth so display never drifts from server. | none | PDP server + client |
| `lib/checkout/totals.ts` | Server-authoritative recompute of subtotal/discount/shipping/tax/total. Client-supplied totals are rejected. | `lib/catalog/pricing`, prisma | summary, place-order |
| `lib/checkout/placeOrder.ts` | Idempotent place-order: cart→order, stock decrement, UTR + receipt + activity, loyalty credit. | `lib/checkout/{idempotency,totals,utr}` | `/api/checkout/place-order` |
| `lib/checkout/idempotency.ts` | `IdempotencyKey` lifecycle: PROCESSING → SUCCEEDED/FAILED. | prisma | place-order |
| `lib/cms/heroBanners.ts` | Feature #15 — `listVisibleBanners`, `listAllBanners`, `createBanner`, `updateBanner`, `deleteBanner`, `reorderBanners`, `toView`. | prisma, `lib/shipping/serviceableStates` | hero CRUD admin + public route |
| `lib/cms/productSlugAlias.ts` | Feature #35 — `findProductIdBySlug`, `recordSlugChange`, `removeAlias`. | prisma | PDP page |
| `lib/share/productUrl.ts` | Feature #35 — pure: `buildProductUrl`, `appendUtm`, `encodeSlugForUrl`, `buildShareLinks`, `buildProductUrlForChannel`, `channelLabel`. | none | PDP `generateMetadata`, `<ShareButton>` |
| `lib/pincode/indiaPost.ts` | Feature #13 — `IndiaPostPincodeService` with 24h in-memory TTL cache + 5s `AbortController` timeout + defensive parser. | `lib/shipping/serviceableStates` | `/api/pincode/[pincode]` |
| `lib/uploads/receipts.ts` | Customer receipt upload: sharp re-encode, PDF magic-byte sniff, owner-only retrieval. | sharp | `/api/checkout/upload-receipt` |
| `lib/uploads/attachments.ts` | Generic per-user attachment upload (returns / reviews / tickets / chat). | sharp | `/api/account/upload` |
| `lib/uploads/adminImages.ts` | Feature #16 — admin-uploaded **public** images (hero, promotion, brand, category, misc). sharp re-encode → JPG q85, ≤2400 px. | sharp | `/api/admin/uploads` |
| `lib/email/send.ts` | Nodemailer wrapper. Dev fallback prints OTPs to console. Two test hooks: `_enableOtpCaptureForTests` (in-process) + `SHOPCORE_TEST_OTP_FILE` env (cross-process). | `nodemailer` | OTP flows |
| `lib/admin/guards.ts` | `requireAdminUser()`, `AdminGuardError`, `audit({ actorId, action, entity, entityId, before?, after? })`. | prisma | every admin route |
| `lib/compare/attributeGroups.ts` | **Item 14 — declarative compare attribute map.** `UNIVERSAL_GROUPS` (overview / pricing / ratings / availability — always present) + `CATEGORY_GROUPS` (laptops, processors, accessories) + `getAttributeGroupsForCategory(slug)` / `getAttributeGroupsForCategories(slugs[])` helpers. Adding a new spec key is a one-line edit. Pure module — no Prisma. | none | `<CompareTable>` |
| `lib/compare/attributeKeyResolver.ts` | **Item 14 — union-of-keys algorithm.** `parseAttributes(raw)` (defensive JSON parse → `{}` on null/garbage), `unionAttributeKeys(productAttrs[])` (first-seen ordering), `leftoverAttributeKeys(all, covered)` (drives the "Other specifications" synthetic group). | none | `lib/compare/compareData.ts`, `<CompareTable>` |
| `lib/compare/differenceDetector.ts` | **Item 14 — pure diff detector.** `normaliseForCompare(v)` (lowercase / trim / array-flatten / JSON-stringify), `isEqualValue(a, b)`, `detectDifference(values[])` (true iff any pair differs; all-empties → false). | none | `<CompareTable>` |
| `lib/compare/compareData.ts` | **Item 14 — single-query Prisma aggregator.** `fetchCompareProducts(ids[])` returns the full `CompareProduct[]` shape (image, brand, category, variants, parsed attributes, ratings via `Review.groupBy`); `resolveSlugsToIds(slugs[])` for the share-URL path. PAGINATION-EXEMPT (bounded by COMPARE_HARD_CAP=4). | `prisma`, `lib/catalog/pricing`, `lib/compare/attributeKeyResolver` | `/compare` page + `/api/compare` |
| `lib/assets/assetHealth.ts`   | **Item 17 P2** — coverage computation (`getStoreIdentityHealth`, `getBrandHealth`, `getCategoryHealth`). One DB read per surface; no caching. | `prisma`, `lib/storeConfig` | `/api/admin/assets` |
| `lib/assets/storeAsset.ts`    | **Item 17 P2** — registry ops: `listAssets` (paginated), `findAssetReferences` (scans Brand/Category/store-config for URL refs), `deleteAsset` (unlinks file under `env.UPLOAD_DIR` then deletes the row). | `prisma`, `lib/storeConfig`, `lib/errors`, `lib/log`, `lib/uploads/imageKinds` | `/api/admin/assets/[id]` |
| `lib/assets/filenameMatch.ts` | **Item 17 P2** — pure helpers for bulk upload: `normaliseFilename` (slug-form base name), `editDistance` (Levenshtein, early-exit at max), `matchFilenameToCandidate` (exact → unique-fuzzy → unmatched; never guesses on ambiguous). | none | `<BulkUploadCard>` |
| `lib/account/compare.ts` | **Item 14 — compare list service (rewrite).** Dual backend: anonymous → `sc_compare_v1` cookie; authed → `CompareItem` table. `addCompare`, `removeCompare`, `listCompare`, `clearCompare`, `syncCompare`, `getMaxItems`, `CompareListFullError` (`COMPARE_FULL`, 409). Pre-fetches existing IDs in `syncCompare` so we never trigger Prisma's P2002. | `prisma`, `lib/storeConfig`, `lib/errors`, `lib/log` | `/api/compare/**` |
| `lib/pagination.ts` | **Item 12 — canonical pagination layer.** `parsePaginationParams(searchParams, config, opts?)` (offset; `INVALID_PAGINATION_PARAMS` on bad input; silent clamp to `paginationMaxSize`), `parseCursorParams(...)` (cursor regex validates against cuid OR liberal token regex; rejects injection), `paginatedQuery(model, opts)` (generic Prisma `findMany` + `count` runner — caller keeps full type inference), `buildPagination(items, total, page, pageSize)` (envelope builder for routes that already have both numbers), `buildCursorPagination(fetched, pageSize, cursorField, prevCursor)` (expects `take: pageSize + 1` probe), `buildPageWindow(page, totalPages)` (pure — `[1, "ellipsis", N-2, N-1, N, N+1, N+2, "ellipsis", last]`, 5-wide constant window). Accepts either `URLSearchParams` or Next.js `searchParams` prop shape via `AnySearchParams`. Defaults from `getStoreConfig().performance.{paginationDefaultSize,paginationMaxSize}` — no hardcoded sizes anywhere in the codebase. | `zod`, `lib/errors`, `lib/log`, `lib/storeConfig` (types only) | 22 list endpoints + every consumer + `<Pagination>` component |
| `lib/jobs/jobTypes.ts` | **Background Jobs System (Item 7)** — `JOB_TYPES` registry + `JobPayloadMap` (compile-time payload typing). Single source of every job type string in the codebase. | none | producer, runner, scheduler, all workers |
| `lib/jobs/cronParser.ts` | Hand-rolled 5-field cron parser + `computeNextRun(expr, from): Date` (UTC, strictly returns future time). Subset: `*`, `n`, `*/step`, `n,m` lists. No range/named-alias syntax. | `lib/errors` | `scheduler.ts` |
| `lib/jobs/producer.ts` | `enqueueJob<T extends JobType>(type, payload, opts)` — generic-typed producer. Deduplication via reserved `__dedupKey` property embedded in payload JSON (no second table). Rejects unknown job types at enqueue time (fail-fast). | `prisma`, `lib/log`, `lib/errors`, `lib/jobs/{jobTypes,workers}` | every route/service that needs async work |
| `lib/jobs/runner.ts` | `JobRunner` class — recursive-setTimeout poll loop, atomic claim via `updateMany WHERE status='PENDING'`, exponential backoff (`30s · 2^(n-1)`, cap 1 h), MAX_CONCURRENT cap, graceful drain on stop. `backoffMs(attempts)` exported for tests. | `prisma`, `lib/log`, `lib/errors`, `lib/config`, `lib/jobs/{jobTypes,workers}` | `startup.ts` (production), test harness (tests) |
| `lib/jobs/scheduler.ts` | `JobScheduler` class — ticks the JobSchedule table, enqueues due jobs. `BUILT_IN_SCHEDULES` constant + `seedJobSchedules()` idempotent upsert. | `prisma`, `lib/log`, `lib/config`, `lib/jobs/{cronParser,producer,jobTypes,workers}` | `startup.ts`, `prisma/seed.ts` |
| `lib/jobs/startup.ts` | `startJobRunner()` singleton — verifies Job table exists, seeds schedules, starts runner + scheduler, registers SIGTERM/SIGINT shutdown hooks. Guards on `NODE_ENV !== 'test'` AND `JOB_RUNNER_ENABLED !== 'false'`. | `prisma`, `lib/log`, `lib/config`, `lib/jobs/{runner,scheduler}` | `lib/db/client.ts` (dynamic import) |
| `lib/jobs/workers/*.ts` | One handler per JobType. `index.ts` is the central registry with `JobContext` (carries `jobId`, `jobType`, `attempts`, child `log`, `extendLock()` for long-running jobs). Active: email, cleanup (4), cart, inventory, b2b, maintenance (3). Stubs: 7 future types. | `prisma`, `lib/log`, `lib/errors`, `lib/email`, `lib/checkout`, `lib/auth` | `runner.ts` |
| `lib/jobs/adminSerializers.ts` | Projections for the admin job dashboard: `toJobRow` (list), `toJobDetail` (full + parsed payload + masked PII), `toScheduleRow`. Recursively masks email/phone fields and strips the reserved `__dedupKey` payload property — admins see structural payload without raw addresses. | `@prisma/client`, `lib/jobs/producer` (constant `DEDUP_KEY_FIELD`) | `src/app/api/admin/jobs/**`, `src/app/api/admin/job-schedules/**` |
| `lib/storeConfig/schema.ts` | **Item 8 — control plane.** Single dot-keyed `CONFIG_SCHEMA` record with **107 entries** (label / description / category / section / Zod validator / dangerLevel / requiresRestart / enumOptions / affectsJobs). All admin-tunable settings — features, payments, shipping, checkout, loyalty, B2B, notifications, security, performance, maintenance. | `zod`, `lib/jobs/jobTypes` (for `affectsJobs`) | `index.ts`, `validation.ts`, admin API, admin UI (via API schema payload) |
| `lib/storeConfig/types.ts` | `StoreConfigValues` derived FROM `CONFIG_SCHEMA` via TS type magic (`Split` + `NestifyPath` + `UnionToIntersection`). Adding a key to the schema automatically widens the type — drift impossible. | (type-only) | `index.ts`, every caller of `getStoreConfig` |
| `lib/storeConfig/defaults.ts` | `DEFAULT_STORE_CONFIG` — the LEGACY nested shape (policies / hero / sub-fields). Moved here from `lib/config.ts` (re-exported there for back-compat). Coexists with the new flat schema. | none | `index.ts`, `lib/checkout/storeConfig.ts` (shim) |
| `lib/storeConfig/cache.ts` | 30-second in-process singleton. `readCache` / `writeCache` / `invalidateConfigCache`. Invalidated on every successful PATCH. | (none — pure) | `index.ts` |
| `lib/storeConfig/validation.ts` | `validateConfigPatch(patch)` — atomic, never throws. Reports ALL field errors at once + cross-field rules (`payments.maxOrderPaise ≥ minOrderPaise`). | `zod`, `lib/storeConfig/schema` | `lib/storeConfig/index.applyConfigPatch` |
| `lib/storeConfig/index.ts` | `getStoreConfig()` — server-only unified reader (new flat schema + legacy nested shape over the same DB blob). Lazy-creates the singleton row. `applyConfigPatch()` — atomic write + cache invalidation. `resetStoreConfigToDefaults()`. Exports `flattenObject` / `nestifyFlat` for the API handler + tests. | `prisma`, `lib/log`, `lib/storeConfig/{schema,defaults,validation,cache}` | every server route + service module that needs config |
| `lib/storeConfig/maintenance.ts` | `syncMaintenanceFile(config)` writes `data/maintenance.json` (observability artefact for cron / ops scripts). `readMaintenanceFile()` reads it. `isIpAllowedDuringMaintenance(config, ip)` — pure helper used by the storefront-layout redirect. | `node:fs`, `lib/log` | admin PATCH/import/reset handlers, storefront layout |
| `lib/storeConfig/featureGate.ts` | **Item 8 — runtime gate helper.** `requireFeature(key)` throws `ForbiddenError(FEATURE_DISABLED \| FEATURE_PAUSED)` with per-feature client copy. `isFeatureOn(key)` non-throwing for service modules. `getCheckoutLimits()`. Honours `NODE_ENV=test` bypass (overridable via `SHOPCORE_ENFORCE_FEATURE_GATES=1`). 12+ convenience wrappers (`requireWishlistEnabled` etc.). | `lib/errors`, `lib/log`, `lib/storeConfig` | 15 gated route handlers + `placeOrder.ts` + `totals.ts` + `auth/otp/verify` |
| `lib/storeConfig/clientFlags.ts` | `buildClientFlags(config)` server-only projection of the boolean feature flags safe to ship to the browser. Defines the `ClientFeatureFlags` type. **Must NOT live in a `'use client'` file** — Next.js wraps client-file named exports as client-component references, which crash when called as plain functions from server code. | (pure, types-only deps) | storefront layout, `FeatureFlagProvider` (type re-export) |
| `lib/utils/phone.ts` | **Item 9 — canonical India-mobile utilities.** Single source of truth: `normalisePhone(raw)` (permissive → `+91XXXXXXXXXX` or null, never throws), `isValidIndianMobile`, `formatPhone(e164)` → `+91 98765 43210`, `maskPhoneForDisplay(e164)` → `+91 ••••• ••1234`, `stripIndianPrefix(e164)` (used by `<PhoneField>` for display derivation). Static audit asserts NO other file defines `normalisePhone`. | (pure — no Prisma, no log, no network) | every `phone:` Zod field, `<PhoneField>` component, 6 display sites |
| `components/forms/PhoneField.tsx` | **Item 9 — locked `+91` prefix component.** Composite group with non-focusable prefix + 10-digit `<input type="tel" inputMode="numeric">`. `focus-within` ring on the wrapper. Visually-hidden span announces the country code to AT. Fully controlled: display derived from `value` prop via `stripIndianPrefix`. Paste handler runs `normalisePhone` on clipboard text. Used by signup, addresses (×2), checkout (×2), admin store-config. | `lib/utils/phone` | every phone-input form |
| `lib/client/api.ts` | Browser fetch wrapper. Auto-attaches CSRF token + Content-Type. Supports `Idempotency-Key` header. | none | client components |

---

## 11. Configuration & environment variables

Defined + validated in `src/lib/config.ts` (Zod). Source: `.env.example`.

| Var | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `production` / `test`. |
| `APP_NAME` | `ShopCore` | Branding (used in email subjects, OG site_name). |
| `APP_URL` | `http://localhost:3000` | Absolute URL of this deployment. **Used by Feature #35 to build canonical URLs.** Must be HTTPS in prod. |
| `DATABASE_URL` | `file:../data/store.db` | SQLite path. Path is relative to `prisma/`. |
| `SESSION_SECRET` | — | 64+ hex chars. Used for JWT HS256 signing. **Required.** |
| `CSRF_SECRET` | — | 64+ hex chars. **Required.** Must differ from `SESSION_SECRET` (preflight enforces). |
| `FIREBASE_SERVICE_ACCOUNT_JSON` / `_PATH` / `FIREBASE_PROJECT_ID` | — | Optional. Set to mirror users to Firebase Auth. |
| `SMTP_HOST` | `smtp.gmail.com` | |
| `SMTP_PORT` | `465` | |
| `SMTP_SECURE` | `true` | |
| `SMTP_USER` / `SMTP_PASS` | — | Gmail App Password (NOT regular password). Required in production. |
| `MAIL_FROM` | `ShopCore <noreply@example.com>` | |
| `OTP_LENGTH` | `6` | Digits in every OTP. |
| `OTP_EXPIRY_MINUTES` | `10` | |
| `OTP_MAX_ATTEMPTS` | `5` | Per-OTP attempts before auto-consume. |
| `OTP_RESEND_COOLDOWN_SECONDS` | `60` | |
| `BOOTSTRAP_ADMIN_*` | — | Used by `prisma/seed.ts` to create the first admin. |
| `PAYMENT_UPI_ID` / `PAYMENT_DISPLAY_NAME` | — | Shown at checkout. QR image lives at `/public/payment/qr.png`. |
| `UPLOAD_DIR` | `./data/uploads` | Root for all uploads (receipts, attachments, public-images). |
| `MAX_UPLOAD_MB` | `5` | File-size cap for every upload pipeline. |
| `RATE_LIMIT_LOGIN_PER_15MIN` | `5` | |
| `RATE_LIMIT_OTP_PER_HOUR` | `5` | |
| `RATE_LIMIT_GLOBAL_PER_MIN` | `120` | |
| `SHOPCORE_ALLOW_TEST_EMAILS` | unset | Tests set this to `1` to bypass the strict `@shopcore.test` email allowlist. **Never set in prod** (preflight in `lib/boot.ts` refuses to start). |
| `SHOPCORE_TEST_OTP_FILE` | unset | Tests set this to a file path; OTP send appends `{email, code, purpose, ts}` JSON lines so a parent test process can read OTPs sent by a child-spawned server. **Never set in prod**. |
| `SHOPCORE_DISABLE_RATE_LIMITS` | unset | Tests set this on burst-style runs so the 120-req/min global cap doesn't trip. **Never set in prod** (preflight refuses). |
| `SHOPCORE_ENFORCE_FEATURE_GATES` | unset | Item 8 — `featureGate.requireFeature` short-circuits in `NODE_ENV=test`; set to `1` to exercise the full enforcement path from `test:store-config-gating`. |
| `JOB_RUNNER_ENABLED` | (unset → `true` in prod) | Item 7 — gate the in-process JobRunner singleton. Set to `false` to disable on a host that's not the worker (e.g. a read-replica web tier). Test scripts that spawn `next start` set this to `false` to keep the test DB clean. |

---

## 12. Database schema

**52 Prisma models** in `prisma/schema.prisma`. **String columns** with application-enforced enums (SQLite has no native enums; see `lib/enums.ts`). All money in **paise** (integer). The on-disk DB file lives at `data/store.db`; `npm run db:backup` does a `VACUUM INTO` to `data/backups/<ts>.db`.

### Core domain

| Model | Purpose | Key fields / relations |
|---|---|---|
| `User` | All identities. | `email @unique`, `phone @unique` (Feature #11), `passwordHash`, `firebaseUid? @unique`, `role` (CUSTOMER/B2B/ADMIN), `status` (PENDING_OTP/ACTIVE/SUSPENDED/DELETED), `companyName/gstin/pan/b2bTierId/b2bApprovedAt` (B2B-only), `loyaltyPoints`, `referralCode @unique`, `referredById` self-FK. |
| `Address` | Multiple per user. | `isDefault Boolean`, full Indian address fields. |
| `Category`, `Brand` | Taxonomy. | `slug @unique`. **Item 17** added asset fields: `Brand.{logoUrl, bannerUrl, description}`; `Category.{imageUrl, bannerUrl, iconUrl, description}`. |
| `Product` | Catalog. | `sku @unique`, `slug @unique`, `mrpPaise`, `pricePaise`, `b2bPricePaise?`, `stock`, `lowStockAt`, `isActive`, `isFeatured`, `metaTitle`/`metaDesc`, `aiTags` (CSV). **Item 14** added `attributes` (JSON string of free-form spec map consumed by /compare). |
| `ProductImage` | Per-product images. | `isPrimary`, `sortOrder`. **Item 19** extended with `isActive Boolean @default(true)` (soft-disable), `createdAt`, `updatedAt`, plus compound `@@index([productId, isActive, sortOrder])` covering the PDP gallery AND every card-surface primary-image projection. Service `lib/cms/productGallery.ts` enforces exactly-one-primary in a transaction + auto-promotes the next active image on primary removal/disable. |
| `ProductSlugAlias` (Feature #35) | Old slugs → current product. | `slug @unique`, `productId` FK with onDelete: Cascade. |
| `Variant` | Per-product variants. | `attributes` JSON, own `stock`, own `pricePaise`. |
| `Bundle`, `BundleItem` | Bundle products. | |
| `InventoryLog` | Audit of stock changes. | `delta`, `reason` (RESTOCK / SALE / RETURN / MANUAL_ADJUST / DAMAGE). |
| `HeroBanner` (Feature #15) | Homepage carousel CMS. | `headline`, `subheadline?`, `ctaLabel?`, `ctaHref?`, `imageDesktopUrl`, `imageMobileUrl?`, `imageAlt?`, `overlayOpacity`, `isActive`, `displayOrder`, `startsAt?`, `endsAt?`. Indexed `(isActive, displayOrder)` + `(startsAt, endsAt)`. |
| `CompareItem` (Item 14) | Server-side compare list per authed user. | `userId + productId @@unique` (idempotent re-add), `@@index([userId, addedAt])`. Anonymous users keep their list in the `sc_compare_v1` cookie until login-merge via `POST /api/compare/sync`. |
| `StoreAsset` (Item 17) | Generic registry of every admin upload. | `kind`, `url @unique`, `width`, `height`, `mimeType`, `bytes`, `altText?`, `uploadedBy` FK → User. Recorded by `/api/admin/uploads` AND by `POST /api/admin/products/[id]/images` on success. Powers `/admin/assets` dashboard + reference-checked DELETE. **Item 19** added the `'product'` kind for product photography. |
| `HomepageSection` (Item 18) | Ordered list of admin-composable storefront homepage sections. | `kind` (one of 13: HERO / FEATURED_BRANDS / TOP_CATEGORIES / PRODUCT_COLLECTION / MOST_RATED_PRODUCTS / TRENDING_PRODUCTS / WIDE_PROMO_BANNER / DUAL_PROMO_CARDS / BRAND_SHOWCASE / STORE_METRICS / WHY_SHOP_WITH_US / BRANCHES / NEWSLETTER), `slug @unique`, `title?`, `displayOrder`, `isActive`, `startsAt? / endsAt?` (scheduling window), `config` (per-kind JSON validated by Zod in `lib/cms/homepageSchemas.ts`). Indexed `(isActive, displayOrder)` + `(startsAt, endsAt)`. |
| `HomepageMetric` (Item 18) | Trust-tile stats ("170+ brands"). | `label`, `value`, `caption?`, `iconUrl?`, `displayOrder`, `isActive`. Indexed `(isActive, displayOrder)`. |
| `HomepageBranch` (Item 18) | Physical store locations. | `name`, `city`, `address?`, `phone?`, `imageUrl?`, `linkUrl?`, `displayOrder`, `isActive`. Indexed `(isActive, displayOrder)`. |

### Cart / order

| Model | Notes |
|---|---|
| `Cart`, `CartItem` | Per-user persistent cart. |
| `SavedCart` | "Save for later". |
| `WishlistItem` | |
| `Order`, `OrderItem`, `OrderStatusHistory` | Full order trail. Order status: PENDING_PAYMENT_REVIEW → PAYMENT_VERIFIED → PROCESSING → PACKED → SHIPPED → OUT_FOR_DELIVERY → DELIVERED, plus CANCELLED / RETURNED / REFUNDED. |
| `ReturnRequest` | Return / exchange flow. |
| `ExpressCheckout` | Buy Now express-session row (bypasses Cart). |
| `IdempotencyKey` | `(userId, key) @@unique`. Status PROCESSING / SUCCEEDED / FAILED. Stores serialised result so retries are deterministic. |
| `UtrSubmission` | UTR + receipt URL submitted by customer. Verified by admin. |

### Auth + sessions

| Model | Notes |
|---|---|
| `OtpCode` | bcrypt-hashed codes. Per-OTP `attempts`/`maxAttempts`. `purpose ∈ SIGNUP \| LOGIN \| RESET \| EMAIL_CHANGE`. `resetRequestId?` binds RESET OTPs to a `PasswordResetRequest` (Feature #12). |
| `PasswordResetRequest` (Feature #12) | One per user-initiated reset. Status PENDING / OTP_VERIFIED / CONSUMED / EXPIRED / CANCELED. `expiresAt` (30 min hard wall), `otpIssueCount`, `maxOtpIssue` (default 5). |
| `PasswordResetToken` (Feature #12) | Issued on successful OTP verify. `tokenHash @unique` (SHA-256 of opaque 32-byte secret). Single-use, 10-min TTL. |
| `Session` | Each `tokenHash @unique` (sha256 of JWT). `expiresAt`, `revokedAt?`, `refreshFamilyId` link. |
| `RefreshTokenFamily` | One per logical login. `absoluteExpiresAt` (30d customer, 12h admin), `revokedAt?`, `revokedReason?`. |
| `RefreshToken` | `tokenHash @unique` (sha256). `rotatedAt?` (theft signal). `parentId?`, `successorId?` for the audit chain. |
| `UserActivity` | Catch-all log: PASSWORD_CHANGE, PASSWORD_RESET_*, OTP_VERIFIED, OTP_FAIL, etc. |

### Loyalty / marketing / B2B / support

| Model | Notes |
|---|---|
| `LoyaltyLedger` | One row per credit/debit with `reason`. Fail-safe; defaults to DISABLED. |
| `Coupon` | Code, % or flat, validity, max uses. |
| `Promotion` | Existing simpler banner table (separate from #15's `HeroBanner`). |
| `EmailCampaign`, `PushNotification` | Admin queues. |
| `Subscription` | Back-in-stock subscriptions per (user × product × variant). |
| `SupportTicket`, `TicketMessage`, `ChatRoom`, `ChatMessage` | Support + live chat. |
| `B2BTier` | Verified-business pricing tiers. `discountPct`. |
| `QuoteRequest` | B2B quote line items + status. |

### Operational

| Model | Notes |
|---|---|
| `StoreConfig` | Single-row (`id="singleton"`). `data: String` JSON blob. Two co-existing shapes on the same row: (a) **legacy nested** (policies / shipping / loyalty / hero — `lib/checkout/storeConfig.ts`); (b) **Item 8 flat schema** with **123+ typed entries** under `store / features / products / payments / shipping / checkout / loyalty / b2b / notifications / security / performance / maintenance / compare`. Item 19 introduced the `products` category and 3 base gallery knobs; Item 20 added 6 interaction knobs. Item 18 added 4 `features.homepage*` flags. Read via `getStoreConfig()` from `src/lib/storeConfig/index.ts` (30s in-process cache, invalidated on every admin PATCH). |
| `AuditLog` | Admin-mutation trail. `actorId`, `action`, `entity`, `entityId`, `before` JSON, `after` JSON, `ipAddress`. Item 12 — cursor-paginated. |
| `Job` (Item 7) | Background-job queue row. `type`, `status` (PENDING/PROCESSING/COMPLETED/FAILED/CANCELLED), `payload` JSON, `priority`, `attempts/maxAttempts`, `runAt`, `lockToken?`, `lockExpiresAt?`. Indexed on `(status, runAt)` for the runner's pick-eligible query and `(status, lockExpiresAt)` for stuck-job reclamation. |
| `JobSchedule` (Item 7) | Cron-driven recurring enqueues. `name @unique`, `jobType`, `cronExpression` (UTC), `lastRunAt?`, `nextRunAt`, `isActive`. 10 built-in schedules seeded at boot. |

### Migration strategy

- Migrations are **hand-written SQL** under `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`.
- After editing `schema.prisma`, write the SQL by hand, then `npx prisma migrate deploy && npx prisma generate`.
- **Do NOT run `prisma migrate dev`** in this sandbox — it blocks on interactive input. Use `migrate deploy` only.
- **Prisma 7.x is incompatible** — its schema format moves `url` out of `schema.prisma`. Pin at 5.22.x (auto-updaters silently install 7).
- Existing migrations chronologically:
  1. `20260602120902_init`
  2. `20260603124300_loyalty_snapshot`
  3. `20260603134500_idempotency_keys`
  4. `20260603150535_utr_verification`
  5. `20260603161841_refresh_token_rotation`
  6. `20260603210650_express_checkout`
  7. `20260604000000_user_phone_unique` (Feature #11)
  8. `20260604100000_password_reset_tokens` (Feature #12)
  9. `20260604200000_hero_banner` (Feature #15)
  10. `20260604300000_product_slug_alias` (Feature #35)
  11. `20260605000000_phone_verification` (Phone Verification)
  12. `20260605120000_background_jobs` (Item 7)
  13. `20260606120000_compare_feature` (Item 14 — adds `Product.attributes` JSON column + `CompareItem` table)
  14. `20260607120000_brand_assets` (Item 17 — adds `Brand.bannerUrl`, `Category.{bannerUrl, iconUrl}`, `StoreAsset` table)
  15. `20260608120000_homepage_cms` (Item 18 — adds `HomepageSection`, `HomepageMetric`, `HomepageBranch` tables)
  16. `20260609120000_product_gallery_columns` (Item 19 — extends `ProductImage` with `isActive`, `createdAt`, `updatedAt` + compound index `(productId, isActive, sortOrder)`)

---

## 13. API endpoints — overview

Full catalogue in `API.md`. Envelope shape is universal:

```json
{ "ok": true,  "data": { ... } }                     // 2xx
{ "ok": false, "error": "...", "code": "OPTIONAL", "issues": [{"path":"...","message":"..."}] }   // 4xx/5xx
```

### Required headers

| Header | When | Source |
|---|---|---|
| `x-csrf-token` | Every `POST/PUT/PATCH/DELETE` | Mirrors `sc_csrf` cookie. Fetched via `GET /api/auth/csrf`. |
| `Idempotency-Key` | Optional, mainly checkout `place-order` | Caller-generated UUID; same key on retry. |
| `x-request-id` | In/out, set by middleware | Cross-reference with log lines. |
| `Origin` | Required for some routes (e.g. `/api/auth/check-email`, `/api/pincode/[pincode]`) to enforce same-origin. | Browser-set. |

### Cookies

| Cookie | Role | Notes |
|---|---|---|
| `sc_session` | CUSTOMER/B2B | HttpOnly, SameSite=Strict, 15-min TTL. |
| `sc_refresh` | CUSTOMER/B2B | HttpOnly, SameSite=Strict, `Path=/api/auth`, 30d TTL. |
| `sc_admin` | ADMIN | Same shape, separate. 12-hour TTL, tighter rate limits. |
| `sc_admin_refresh` | ADMIN | |
| `sc_csrf` | All | Readable double-submit token (not HttpOnly). 1-day TTL. |

### Endpoint groups (one-line each)

> **Pagination envelope (Item 12)**: every list endpoint marked `[PAGINATED]` in API.md returns `{ items, pagination: { total, page, pageSize, totalPages, hasNextPage, hasPrevPage } }`. Cursor endpoints (`/api/admin/audit-log?cursor=`, `/api/admin/orders?cursor=`, `/api/admin/{reviews,returns,tickets}?cursor=`) swap `total: null` for `nextCursor / prevCursor`.

- **Public**: `/api/health`, `/api/ready`
- **Auth**: `/api/auth/{csrf, signup, login, logout, me, refresh, sessions, check-email, admin/login, otp/{verify,resend}, forgot-password/{initiate,verify-otp,resend,reset}, logout-all, logout-others, phone/{verify,resend-otp}, account/{phone,password,profile}}`
- **Account**: `/api/account/{password, profile, phone, orders, returns, reviews, tickets (+[id]/messages), subscriptions, saved-carts, reorder, loyalty, referrals, chat, upload}` — every list paginated
- **Addresses**: `/api/addresses`, `/api/addresses/[id]`
- **Catalog**: `/api/categories` (Item 17 — surfaces imageUrl/bannerUrl/iconUrl/description), `/api/brands` (Item 17 — surfaces logoUrl/description), `/api/products[?q&category&brand&min&max&sort&instock&page&pageSize]`, `/api/products/[slug]`
- **Cart**: `/api/cart/{add, update, merge, preview, validate}`
- **Wishlist**: `/api/wishlist`, `/api/wishlist/toggle`
- **Compare (Item 14)**: `GET /api/compare` (full envelope + maxItems), `POST /api/compare {productId}` (idempotent; 409 `COMPARE_FULL` at max), `DELETE /api/compare` (clear all), `DELETE /api/compare/[productId]` (remove one), `POST /api/compare/sync {productIds}` (login-merge; authed only; clears cookie on success). Gated by `features.compareEnabled`. Rate limits `compare.add` (20/hr/user + 60/hr/ip) and `compare.sync` (10/hr/user).
- **Checkout / orders**: `/api/checkout/{summary, place-order, upload-receipt, express}`, `/api/orders/[id]`, `/api/orders/[id]/cancel`
- **B2B**: `/api/b2b/{apply, bulk-add, me, quotes, quotes/[id], quotes/[id]/{accept,decline}}`
- **Contact (Item 13)**: `POST /api/contact` — public; CSRF; honeypot (`website` field → silent 200); rate-limited (`contact.form` 3/hr/IP); enqueues `SEND_EMAIL` job to `notifications.adminEmail`; creates a `[CONTACT_FORM]` `SupportTicket` for authed callers.
- **Pincode (Feature #13)**: `GET /api/pincode/[pincode]` — 60/min/IP, same-origin, 24h cache.
- **Hero (Feature #15)**: `GET /api/hero-banners`.
- **Homepage CMS (Item 18)**: `GET /api/homepage` — public; returns `{ enabled, sections: [{ id, kind, slug, config, …per-kind-data }] }`; `Cache-Control: public, max-age=30, stale-while-revalidate=60`; gated by `features.homepageRevampEnabled`. `POST /api/newsletter/subscribe` (Item 18 P2) — public; CSRF; honeypot; rate-limited `newsletter.subscribe` 5/hr/IP; uniform-success `{ received: true }` to prevent account enumeration.
- **Admin** (every route under `/api/admin/*`): CSRF + `requireAdminUser` + audit log. Includes:
  - `products`, `categories`, `brands` (Item 17 — accept logo/banner/icon/description fields), `customers`, `b2b-applications`, `coupons`, `promotions`, `hero-banners` (+`/[id]`+`/reorder`), `campaigns`, `push`, `tickets` (+`/[id]/messages`), `chat`, `quotes` (+`/[id]`), `returns` (+`/[id]`), `reviews` (+`/[id]`)
  - `orders/[id]` + `/status`, `/verify-payment`, `/reject-payment`, `/refund`, `/shipping` — dual-mode pagination (cursor opt-in via `?cursor=`)
  - `excel/{products,inventory,users}/{import,export}`, `analytics`, `audit-log` (cursor mode), `tiers`, `ai/suggest-tags`
  - **Store config (Item 8)**: `GET / PATCH /api/admin/store-config`, `POST /export`, `POST /import` (two-phase), `POST /reset` (typed confirmation)
  - **Background jobs (Item 7)**: `GET /api/admin/jobs/{stats,[id]}`, `POST /api/admin/jobs/[id]/{retry,cancel}`, `GET / PATCH /api/admin/job-schedules/[id]`
  - **Rate limits**: `GET /api/admin/rate-limits` (registry + active keys + counts; hashed only — never raw IPs), `DELETE /api/admin/rate-limits/[...key]` (audits `RATE_LIMIT_RESET`)
  - **Uploads (Feature #16 + Item 17)**: `POST /api/admin/uploads?kind=<see ADMIN_IMAGE_KINDS>` (multipart). 11 kinds; sharp branches PNG vs JPG per kind; success records a `StoreAsset` row.
  - **Assets (Item 17 P2)**: `GET /api/admin/assets?kind=&page=&pageSize=&include=health` (paginated registry + coverage), `DELETE /api/admin/assets/[id]` (refuses with 409 `ASSET_IN_USE` + `references[]` when still referenced; `?force=1` overrides + is audited).
  - **Homepage CMS (Item 18)**: 11 endpoints under `/api/admin/homepage/*` — `GET / POST /sections` + `PATCH / DELETE /sections/[id]` + `POST /sections/reorder`; `GET / POST /metrics` + `PATCH / DELETE /metrics/[id]`; `GET / POST /branches` + `PATCH / DELETE /branches/[id]`. Every mutation audits `HOMEPAGE_SECTION_{CREATE,UPDATE,DELETE,REORDER} / HOMEPAGE_METRIC_UPDATE / HOMEPAGE_BRANCH_UPDATE`.
  - **Product Gallery (Item 19)**: 5 endpoints under `/api/admin/products/[id]/images/*` — `GET / POST` (multipart-file → `saveAdminImage('product')` OR JSON `{ url, alt? }`), `PATCH / DELETE /[imageId]`, `POST /[imageId]/primary` (transactional exactly-one-primary), `POST /reorder`. Rate-limited via `admin.uploads`. Audits `PRODUCT_IMAGE_{UPLOAD,UPDATE,DELETE,REORDER,PRIMARY_CHANGED}`. Cap enforced via `products.maxGalleryImages` (returns 400 `PRODUCT_GALLERY_LIMIT_REACHED`).
- **Uploads**: `GET /api/uploads/<...path>` — gated. Two access tiers:
  - `receipts/<userId>/*` + `attachments/<userId>/<kind>/*` → owner-or-admin only, `Cache-Control: private, no-store`.
  - `public-images/<kind>/*` → anonymous, `Cache-Control: public, max-age=31536000, immutable`. `<kind>` must be one of `ADMIN_IMAGE_KINDS` (driven by `lib/uploads/imageKinds.ts`).

---

## 14. External dependencies & integrations

| Integration | Required? | Purpose | Failure mode |
|---|---|---|---|
| **Gmail SMTP** (free, ≤500/day) | Required in prod | OTP email delivery | Dev: prints OTP banner to console; tests: `SHOPCORE_TEST_OTP_FILE` capture |
| **India Post Pincode API** (`https://api.postalpincode.in/pincode/{PINCODE}`) | Soft-required | PIN code autofill (Feature #13) | 24h in-memory cache; on timeout / non-200, return `{found:false}` so UI never blocks |
| **Firebase Admin** | Optional | Identity mirror (`auth/firebase.ts`) | No-op if `FIREBASE_*` env vars unset |
| **UPI / QR code** | Required | Payment is offline-UPI: `/public/payment/qr.png` is the merchant QR. Customer pays via any UPI app, then submits UTR + receipt in checkout. | UTR + receipt go to `data/uploads/receipts/<userId>/`; admin manually verifies via the admin orders page. |

**No paid API.** No Stripe / Razorpay. No CDN. No managed DB. No Mixpanel. No Datadog. All deps are free-tier or self-hosted.

---

## 15. Known limitations / gotchas

| Topic | What to know |
|---|---|
| **SQLite write concurrency** | Single-writer. `prisma/db/client.ts` bumps `transactionOptions: { maxWait: 15_000, timeout: 30_000 }` to absorb stormy concurrent place-order calls. If you need higher concurrency than this, move to Postgres. |
| **In-memory rate limiter** | `lib/security/rateLimitStore.ts` uses a `Map`. Process-local. Replace `InMemoryRateLimitStore` with a Redis-backed `RateLimitStore` implementation for multi-process / multi-instance deployments — the adapter interface is designed for it. Test scripts that need to burst past the 120-req/min global cap set `SHOPCORE_DISABLE_RATE_LIMITS=1` on their spawned `next start` env — preflight refuses to start production with this flag set. |
| **In-memory pincode cache** | Same — process-local 24h Map. Fine for single-VPS. |
| **`node_modules` not snapshotted in this sandbox** | Run `npm install` at the start of every fresh session. The `.arena/*`, `.next`, `node_modules` paths are excluded from snapshots. |
| **`prisma migrate dev` blocks** | Use `migrate deploy` + hand-written SQL only. |
| **`prisma` 7.x is incompatible** | Schema file format changes in Prisma 7 (`url` moves out of `schema.prisma`). Keep at 5.22.x. Auto-update tools will silently install 7.x; pin manually. |
| **React 18 `e.currentTarget` after `await`** | React nullifies the synthetic event after the first await. Always capture `const form = e.currentTarget;` BEFORE `await api(...)`, then use `form.reset()`. The hero-banners and push admin pages both fixed this bug; copy that pattern. |
| **React 18 `useId()` IDs contain `:`** | They're invalid CSS selectors. Use `document.getElementById(id)`, not `querySelector(\`#${id}\`)`. |
| **Test scripts must run sequentially when they share state** | The shared in-memory rate limiter + the single SQLite file mean parallel test execution is unsafe. Always run one test at a time. |
| **OTP tests need TWO capture paths** | In-process (`_enableOtpCaptureForTests` + `_otpCaptureForTests.items`) for direct-service tests, AND file-based (`SHOPCORE_TEST_OTP_FILE` env) for integration tests that spawn a child server. |
| **Slug edits not yet wired in admin UI** | `ProductSlugAlias` table + `recordSlugChange()` exist (Feature #35) but the admin product edit page doesn't expose slug editing. Adding it is a one-line `recordSlugChange()` call in `/api/admin/products/[id]/route.ts` PATCH after `prisma.product.update`. |
| **No real CI** | All testing is manual: `npm run test:<name>`. Hook these into GitHub Actions or similar when ready. |
| **Backups assume single-host** | `npm run db:backup` runs `VACUUM INTO data/backups/<ts>.db` + integrity check. For multi-host, ship the file off-box. |
| **Server-actions body limit 10MB** | Set in `next.config.mjs`. Tightens if needed. |
| **Hero carousel autoplay uses singleton `setInterval`** | `<HeroCarousel>` clears the interval on unmount + on every pause-cause toggle. A test (`test:hero-carousel` T1) spies on `globalThis.setInterval`/`clearInterval` to catch regressions. |
| **No native `<dialog>` close animation polyfill** | jsdom 24 doesn't implement `HTMLDialogElement.showModal/close`. Tests polyfill these (see `scripts/test-dialog.tsx`). |

---

## 16. Common tasks — how-to

### Add a new model

1. Edit `prisma/schema.prisma`. Use `String` for enums; index every column you'll filter on.
2. Create `prisma/migrations/<YYYYMMDDHHMMSS>_<short_name>/migration.sql` with `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX` statements.
3. `npx prisma migrate deploy && npx prisma generate`.
4. Add a service module at `src/lib/<area>/<feature>.ts`.
5. Write tests under `scripts/test-<feature>.ts`.

### Add a new admin CRUD section

1. Service module in `src/lib/<area>/<thing>.ts`.
2. Zod schemas in `src/lib/<area>/schemas.ts`.
3. Route handlers under `src/app/api/admin/<thing>/route.ts` + `[id]/route.ts`. Always:
   - `assertCsrf()`
   - `const admin = await requireAdminUser()`
   - `Schema.parse(await req.json())`
   - call service
   - `await audit({ actorId: admin.id, action: 'X_VERB', entity: 'X', entityId, before, after })`
   - `return jsonOk({...})`
   - wrap in try/catch + `handleError(e)`
4. Admin UI page under `src/app/admin/(app)/<thing>/page.tsx`. Use `<PageHeader>`, `<Card>`, `<Button>`, `<StatusBadge>` from `src/components/admin/Helpers.tsx`. For images, use `<ImageUploadInput kind="…">` from `src/components/admin/ImageUploadInput.tsx`.
5. Wire into `src/components/admin/SideNav.tsx`.
6. Write `scripts/test-<thing>.ts`. Mint an admin session via the helper pattern in `scripts/test-hero-banners.ts` or `scripts/test-admin-uploads.ts`.
7. Run `npx tsc --noEmit && npm run test:<thing>`.
8. Update `API.md` and `BUILD_LOG.md`.

### Add an authenticated customer page

1. Add the route under `src/app/(storefront)/account/<thing>/page.tsx`.
2. Middleware already gates `/account/*`. Inside the page server component, call `await getCurrentUser()` for the user.
3. UI helpers: `<AuthShell>`, `<Field>`, `<Alert>`, `<SubmitButton>` from `src/components/AuthForm.tsx`. Buttons must be `.tap-target`.

### Add a new dialog

- DO NOT use `window.alert`/`confirm`/`prompt` — the audit test `test:no-native-dialogs` will fail.
- For simple alert/confirm/prompt: `const dialog = useDialog(); await dialog.confirm({ title, message, intent });`.
- For rich modal (icon grid, multi-step): build a custom dialog that uses the project's `app-dialog` class on a native `<dialog>` (see `<ShareButton>` for the pattern with full focus trap + Escape + backdrop).

### Add a new image-using model

1. Schema: `imageDesktopUrl String` (+ optionally `imageMobileUrl String?`, `imageAlt String?`).
2. Add `<kind>` to the `AdminImageKind` union AND the `IMAGE_KIND_SPECS` record in `src/lib/uploads/imageKinds.ts` (Item 17 declarative registry; pick PNG output for transparent kinds, JPG for photographic). The `isAdminImageKind` type-guard reads from the same record so no separate edit is needed.
3. Admin form: `<ImageUploadInput name="..." kind="<kind>" value={url} onChange={setUrl} />`.
4. Public route serves the file under `/api/uploads/public-images/<kind>/...`.
5. If the upload is also a `StoreAsset`-tracked asset (every admin upload via `/api/admin/uploads` is — bespoke ad-hoc surfaces like the gallery's `POST /api/admin/products/[id]/images` record it manually), the `/admin/assets` dashboard (Item 17 P2) will surface it + reference-checked DELETE will refuse to remove it while it's still referenced.

### Run + ship a feature

```bash
# work
npx tsc --noEmit          # never commit until clean
npm run lint               # next lint
npm run test:<my-feature>  # standalone test
npx next build             # full build
# regression sweep — run the suites relevant to what you touched
```

---

## 17. Error handling & logging

### Errors

Error handling is **infrastructure** with a single contract — every
service, route, and component participates. See `src/lib/errors.ts` for
the class hierarchy and `src/lib/api.ts` for the central router.

**Server-side typed hierarchy** (`src/lib/errors.ts`):

```
ShopCoreError (base)
├── ValidationError      (400)   VALIDATION_ERROR + caller-supplied codes
├── AuthError            (401)   UNAUTHENTICATED + caller codes
├── ForbiddenError       (403)   FORBIDDEN, CSRF_ERROR
├── NotFoundError        (404)   NOT_FOUND, RECORD_NOT_FOUND
├── ConflictError        (409)   CONFLICT, UNIQUE_CONSTRAINT, FK_CONSTRAINT,
│                                ILLEGAL_TRANSITION, CONCURRENT_MODIFICATION
├── RateLimitError       (429)   RATE_LIMITED — sets Retry-After header
├── ExternalServiceError (502)   FIREBASE_UNAVAILABLE, SMTP_SEND_FAILED, ...
└── InternalError        (500)   INTERNAL_ERROR, DB_TIMEOUT, DB_INIT_FAILURE,
                                 PRISMA_ERROR, ACCOUNT_STATE_CORRUPTED
```

Each subclass carries `statusCode`, `code` (stable public string),
`message` (internal — for logs), `clientMessage` (safe to surface),
`context` (auto-redacted by logger), and optional ES2022 `cause`.

**The contract** (binding for every server module):

1. **Expected business failures → tagged results** `{ ok: false, reason }`.
   Services NEVER throw for these.
2. **Unexpected failures → throw a `ShopCoreError` subclass**.
   Services NEVER throw raw strings or vanilla `new Error('...')`.
   (Static audit in `test:error-handling (A1)` enforces this for
   `src/lib/**` — only `log.ts`, `config.ts`, `boot.ts` are allow-listed
   for vanilla `Error` because they run pre-logger or use throw-to-catch
   internal control flow.)
3. **External-service failures are always `ExternalServiceError`** —
   Firebase, India Post, SMTP. The `wrapExternal(service, op, fn)` helper
   in `lib/errors.ts` does this in one line. Never let a third-party
   error shape leak to a route handler.

**Route handlers**: ALL route handlers under `src/app/api/**` are
wrapped with `withErrorHandling(...)` from `lib/api.ts`. The wrapper:
  - Establishes `runWithRequestContext({ requestId })` so every log
    line inside the handler carries `requestId` automatically
  - Catches every thrown error and routes it through `handleError(e)`
  - Maps `ZodError` / `CsrfError` / `AdminGuardError` / Prisma errors /
    `ShopCoreError` subclasses / vanilla `Error` to the correct status
    code + envelope shape
  - Strips stack traces and internal messages from the response body
  - Reads `e.context.retryAfterSeconds` on `RateLimitError` → sets
    `Retry-After` HTTP header

`jsonError(message, status, extra?)` is for **expected negative
outcomes** that the route deliberately returns (e.g. "OTP not found"
with HTTP 400). `throw new XxxError(...)` is for **unexpected** failures
that escape the service boundary. Don't replace `jsonError` everywhere.

**Prisma error mapping** — `mapPrismaError(e)` in `lib/errors.ts`:

| Prisma code | Maps to | Notes |
|---|---|---|
| `P2002` | `ConflictError` (`UNIQUE_CONSTRAINT`) | Generic client message (never leaks column name) |
| `P2025` | `NotFoundError` (`RECORD_NOT_FOUND`) | Includes optimistic-concurrency where-clause failures |
| `P2003` | `ConflictError` (`FK_CONSTRAINT`) | |
| `P2024` | `InternalError` (`DB_TIMEOUT`) | Pool exhaustion |
| `PrismaClientInitializationError` | `InternalError` (`DB_INIT_FAILURE`) | DB unreachable at boot |
| Other `P*` | `InternalError` (`PRISMA_ERROR`) | Logged with `context.prismaCode` |
| Non-Prisma | `InternalError` (`INTERNAL_ERROR`) | Catch-all |

`handleError` automatically routes Prisma errors through `mapPrismaError`
before envelope generation — service modules don't need to wrap every
`prisma.*` call explicitly.

**Client-side errors** (`src/lib/client/api.ts`):

Two surfaces — pick by ergonomic preference:

- `api()` — tagged-result `{ ok, data, error, code, status, raw }`.
  Backwards compatible with every existing caller. Use when you want
  to branch on `ok` without try/catch.
- `apiOrThrow()` — throws `ClientApiError` on any non-OK response.
  Use for new code that prefers async/await + try/catch ergonomics,
  especially when you need to special-case 401 / 429 / 502 / 0 (offline).

`ClientApiError` carries `status`, `code`, `clientMessage`, `issues?`.
`isClientApiError(e)` is the public type-guard. Special status `0`
indicates network failure (fetch rejected) — distinct from a server-
side 500.

**React error boundaries**:

- `<ErrorBoundary>` in `src/components/ErrorBoundary.tsx` — catches
  CLIENT-component render errors, falls back to a friendly card, and
  beacons a structured POST to `/api/client-errors` (which logs
  `client.error_report` server-side).
- Wired into `src/app/(storefront)/layout.tsx` and
  `src/app/admin/(app)/layout.tsx` around `{children}` only — header,
  footer, and admin shell stay rendered when a page errors.
- Server-component errors are caught by Next.js's segment `error.tsx`
  / root-layout `global-error.tsx` instead. Both files exist; both
  beacon their digest to `/api/client-errors` on mount.

**404 + segment error pages**:

- `src/app/not-found.tsx` (global) + `src/app/(storefront)/not-found.tsx`
  (storefront-styled with header/footer)
- `src/app/error.tsx` (root segment error)
- `src/app/global-error.tsx` (root layout error — minimal inline-styled
  HTML; zero dependencies on the layout tree)
- `src/app/admin/(app)/error.tsx` (admin segment error)

**Process-level safety net**:

`registerProcessErrorHandlers()` in `lib/errors.ts` binds
`unhandledRejection` + `uncaughtException` listeners on Node startup.
Called once from `src/lib/db/client.ts` (a module guaranteed to be
imported early in any request lifecycle). Idempotent — re-registering
during HMR is a no-op via a global Symbol flag. Handlers log
structurally and do NOT call `process.exit()` — Next.js owns shutdown.

### Logging

The logger is **infrastructure** — every feature can rely on automatic request
correlation, PII redaction, and a guaranteed JSON shape.

- One JSON object per line via `src/lib/log.ts`. Envelope shape:
  ```json
  { "ts": "2026-06-04T12:34:56.789Z", "level": "info",
    "msg": "account.state.transition", "requestId": "req_abc123def",
    "env": "production", "pid": 12345, "...": "caller fields" }
  ```
- Use it normally — `requestId` and PII redaction are AUTOMATIC:
  ```ts
  log.info('order.placed',   { orderId, totalPaise });        // requestId auto-attached
  log.warn('rate.limit',     { key, remaining: 0 });
  log.error('handler.crash', { err });                         // Error → {name, message, stack}
  log.info('phone.verify',   { phone: '+91...' });             // phone auto-masked → "+91******1234"
  ```
- **`msg` is the canonical event name** using `domain.action` dot notation.
  Caller-supplied `msg` / `level` / `ts` / `env` / `pid` / `requestId` are
  reserved — the logger overrides them after merge.
- `warn` and `error` go to stderr; `info` / `debug` go to stdout.
- In `NODE_ENV=test`, non-error levels are SILENCED.
- **`log.child({ bindings })`** — returns a new logger whose every call merges
  the bindings. Use for per-call-site context: `const userLog = log.child({ userId })`.
- **`runWithRequestContext(ctx, fn)`** (re-exported from `lib/log`) — wrap
  background jobs / scripts to get a `requestId` on their lines. API routes
  don't need it — the logger reads `next/headers()` `x-request-id` automatically.

### PII / Secret redaction rules (auto-applied to every log call)

| Bucket | Keys (case-insensitive) | Transformation |
|---|---|---|
| **Full redact** | `password`, `passwordHash`, `otp`, `code`, `token`, `idToken`, `accessToken`, `refreshToken`, `csrf`, `secret`, `authorization`, `cookie`, `set-cookie`, `utr`, `receipt`, `firebaseUid`, `firebasePhoneUid` | value → `"[REDACTED]"` |
| **Masked** | `email`, `phone`, `phoneNumber`, `mobile` | email → `**rina@example.com` (last 2 of local + full domain); phone → `+91******1234` |
| **Never redact** | `userId`, `orderId`, `requestId`, `actorId`, `sessionId`, `familyId`, `productId`, `cartId`, `variantId`, `addressId`, `reviewId`, `returnId`, `ticketId`, `paymentId`, `shipmentId`, `bannerId`, `couponId`, `promotionId`, `campaignId`, `roomId`, `messageId`, `subscriptionId`, `tierId`, `categoryId`, `brandId`, `targetUserId`, `adminId`, `referredById`, `status`, `role` | pass-through |

Redaction recurses into nested objects and arrays. The redactor never mutates
the caller's input; it deep-clones during the walk.

### Safety guarantees

- Logger NEVER throws. Circular refs → `"[Circular]"`. BigInt → `"<n>n"`.
  Date → ISO string. Error → `{name, message, stack}`. Unserialisable values
  → minimal fallback line tagged `log.serialization_failed`.
- Lines >10 KB are truncated to envelope-only + `"truncated": true`.
- `console.*` and direct `process.stdout/stderr.write()` are FORBIDDEN in
  `src/lib/**` and `src/app/api/**` (enforced by static audit in
  `test:logging` `(A1)` / `(A2)`). The two allowlisted writers are `log.ts`
  itself and `config.ts` (the latter only for invalid-env at boot, before
  the logger can be safely initialised).

### Audit

Admin mutations call `audit({ actorId, action: 'X_VERB', entity, entityId, before, after })`. Rows go to `AuditLog`. Available in the admin Audit Log page. Notable actions wired in: `BRAND_CREATE`, `CATEGORY_CREATE`, `ADMIN_IMAGE_UPLOAD`, `ASSET_DELETED` (Item 17), `RATE_LIMIT_RESET`, plus per-entity verbs across orders / returns / reviews / tickets / quotes / b2b-applications / store-config.

---

## 18. Performance considerations

- **First paint**: storefront pages are server-rendered. `(storefront)/page.tsx` runs one `Promise.all` for `[featured, categories, latest, banners, storeConfig, brands]`. Storefront layout calls `getStoreConfig()` once (30s in-process cache) and passes derived data into the header — no extra DB roundtrip per request.
- **Pagination (Item 12)**:
  - Every list endpoint takes `take:` — static audit `test:pagination [P2.2]` enforces this across `src/app/api/**` (escape hatch: `// PAGINATION-EXEMPT` comment with reason).
  - Heavy admin tables (`/api/admin/orders`, `/api/admin/audit-log`, `/api/admin/{reviews,returns,tickets}`) support cursor mode via `?cursor=` — skips `COUNT(*)` entirely.
  - Storefront `<Pagination>` is link-mode (full page navigation) so search engines crawl every page; admin uses callback mode with optional URL sync.
  - `<InfiniteScroll>` (Item 12 P2) is opt-in via `performance.paginationInfiniteScrollEnabled`. Idempotent page tracking via a `Set` so the IntersectionObserver firing twice can't double-fetch.
- **SEO (Item 12 P2)**: `<PaginationSeoLinks>` emits `<link rel="canonical">` (pointing at the CURRENT page — Google's post-2019 guidance), `<link rel="prev"/"next">`, and `<meta name="robots" content="noindex,follow">` from `currentPage >= performance.paginationNoindexFromPage` (default 2).
- **Caching**:
  - Pincode proxy: 24h in-memory + `public, max-age=86400, stale-while-revalidate=604800`.
  - Hero list: `public, max-age=60, stale-while-revalidate=300`.
  - Admin-uploaded public images: `public, max-age=31536000, immutable` (random filenames; admins replace by uploading a NEW file + updating the model — never overwriting).
  - Store config: 30s in-process cache, atomically invalidated on every admin PATCH (so tests don't need to sleep — they PATCH the change in).
  - Receipts / attachments: `private, no-store` (PII).
- **Background jobs (Item 7)**: runner polls every 5s with `MAX_CONCURRENT=10`. Exponential backoff: `30s · 2^(n-1)`, capped at 1 hour. Lock-expiry recovery reclaims stuck PROCESSING rows. SIGTERM triggers a graceful drain.
- **Animations** all use `transform`/`opacity` (GPU-friendly). `prefers-reduced-motion` collapses to instant — also gates the `<InfiniteScroll>` IntersectionObserver in favour of an explicit `Load more` button.
- **Carousel** uses a single `setInterval` behind a ref + pause-cause aggregation; tested for timer-leak.
- **Images**: PDP first slide is `loading="eager" fetchpriority="high"` (LCP); the rest `loading="lazy"`. `<picture>` switches between mobile/desktop at the network level. Item 17 — every storefront image goes through `<StoreLogo>` / `<BrandLogo>` / `<CategoryImage>` so a missing or 404'd URL collapses into a designed inline-SVG fallback (never a broken `<img>` icon).
- **Dynamic OG / favicon (Item 17)**: `/icon`, `/apple-icon`, `/opengraph-image` are server-rendered via `next/og`. Generated PNGs use hex colours (vercel/og's CSS parser rejects `hsl()` inside `linear-gradient()`).

---

## 19. Security considerations

- **Authentication**: HS256 JWT in `sc_session` cookie; refresh-token rotation in `sc_refresh`. Separate `sc_admin` cookie pair. Middleware gates `/admin`, `/account`, `/b2b/{dashboard,quotes,bulk}` on cookie presence; route handlers re-verify via `getCurrentUser()`.
- **CSRF**: double-submit cookie. `sc_csrf` set by `GET /api/auth/csrf`. Every mutating route calls `assertCsrf()`. Client `lib/client/api.ts` auto-attaches the header.
- **Rate limits**: `applyRateLimit(policyName, req, ctx?)` from `src/lib/security/ratelimit.ts`. All numbers live in `src/lib/security/rateLimitPolicies.ts` — see the registry there for the canonical table (**30 policies** + global). Notable additions: `contact.form` (3/hr/IP — Item 13), `compare.add` / `compare.sync` (Item 14), `newsletter.subscribe` (5/hr/IP — Item 18 P2). Headers (`X-RateLimit-{Limit,Remaining,Reset}`) auto-attach to every rate-limited response via `withErrorHandling`.
- **CSP**: strict in prod (`script-src 'self'`), relaxed in dev for fast-refresh. See `next.config.mjs`.
- **Security headers** (both `next.config.mjs` + `src/lib/security/headers.ts` via middleware): HSTS, X-Frame-Options=SAMEORIGIN, X-Content-Type-Options=nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP, Cross-Origin-Resource-Policy.
- **Same-origin guards** on read endpoints that could be CORS-abused (`/api/auth/check-email`, `/api/pincode/[pincode]`).
- **Passwords**: bcryptjs cost 12. Plaintext NEVER logged. Validator (`lib/auth/passwordPolicy.ts`) enforces min 8 / max 72 / upper / lower / digit / symbol / blocklist (13,728 entries) / no-email-username.
- **OTPs**: bcrypt-hashed at rest. Per-OTP `attempts` ceiling; last-attempt auto-consumes the row.
- **Reset tokens**: 32-byte opaque secret → SHA-256-hashed at rest. Single-use. 10-min TTL. Bound to a `PasswordResetRequest` via `OtpCode.resetRequestId`.
- **Path traversal**: `/api/uploads/[...path]` resolves the target with `path.resolve` then verifies `target.startsWith(root + path.sep)`.
- **File uploads**: MIME allowlist + sharp re-encode (EXIF strip, max 2400 px) for images; PDF magic-byte sniff for receipts.
- **Audit log** on every admin mutation.
- **Refresh-token reuse detection**: presenting a rotated token kills the entire family + revokes linked sessions.

---

## 20. Documentation standards

| File | Authority | Owner |
|---|---|---|
| `BUILD_LOG.md` | **The truth.** Chronological. Every feature/hotfix has a structured entry: symptoms table, fix architecture, verification table, before/after, files inventory, spec-compliance checklist, 🫡 sign-off. NEW IS AT TOP. | Anyone adding a feature |
| `CONTEXT.md` (this file) | Onboarding + navigation. Should be regenerated after major features. | Anyone |
| `API.md` | One-line-per-endpoint table. Update whenever you add or change a route. | Anyone touching `src/app/api/*` |
| `DEPLOY.md` | Single-VPS runbook (systemd unit, Nginx, Certbot, backup cron, cut-over checklist). | Update when ops change. |
| `README.md` | Human onboarding (stack, quick start, scripts). | Update when stack or scripts change. |

### Code comments

- Heavy header comments on services / route handlers explaining WHY (not WHAT). Pattern: an opening JSDoc block that lays out behaviour, constraints, security notes. See `src/lib/auth/passwordReset.ts`, `src/lib/share/productUrl.ts`, `src/components/storefront/HeroCarousel.tsx` for canonical examples.
- Inline `//` comments at non-obvious branches explain the reasoning. Avoid restating what the code says.

### When adding a new feature

End the BUILD_LOG entry with:

```markdown
🫡

---

## <previous feature heading remains here>
```

The `## <previous feature heading remains here>` line is a literal
placeholder showing the convention — your NEW feature's `##` heading
goes immediately ABOVE the `🫡` sign-off, and the previously-newest
heading slides down to occupy the placeholder's slot. Net effect:
BUILD_LOG.md stacks newest-first at the top.

---

## 21. Git / version control conventions

Not formally documented in the repo. Inferred from history + project culture:

- **Branching**: not enforced. Work on `main` for the sandbox; in a real org, feature branches per spec.
- **Commits**: not enforced; readable English summaries. No conventional-commits parser in use.
- **PR reviews**: not present in the sandbox; would be standard in a real org.
- **`.gitignore`** covers: `node_modules`, `.next`, `out`, `build`, `dist`, `data/`, `.env`, secret JSON, OS junk.

When asked to "ship a feature", finish with:

1. `npx tsc --noEmit` clean
2. The relevant `npm run test:<...>` suites green
3. The full regression sweep where it makes sense
4. BUILD_LOG entry appended
5. API.md updated if endpoints changed
6. Sign-off 🫡

---

## 22. Quick reference card

| You want to … | Look at |
|---|---|
| Change a user's `status` field | **ALWAYS** call `transitionAccountState(...)` from `src/lib/auth/accountStateMachine.ts`. Direct `prisma.user.update({ data: { status } })` is forbidden at runtime (the static audit in `test:account-state-machine` will fail unless tagged `// STATE_MACHINE_BYPASS: <reason>`). Initial-row inserts at signup time are the one legitimate bypass class. |
| Check whether a user can log in / order / write | `isLoginPermitted(status)` / `isOrderPermitted(status)` / `isWritePermitted(status)` from `src/lib/auth/accountStateHelpers.ts` (re-exported from `accountStateMachine.ts`). Never compare `=== 'ACTIVE'` directly — Phase 1 Item 2 will add more login-permitted states. |
| Add a new account status | (a) add it to `UserStatus` + `ZUserStatus` in `lib/enums.ts`; (b) add inbound / outbound entries to the `TRANSITIONS` map in `accountStateMachine.ts`; (c) update the helper booleans if the new state changes their answer; (d) extend `scripts/test-account-state-machine.ts`. |
| Add a new API route | `src/app/api/admin/brands/route.ts` (POST + GET + audit pattern) |
| Add an admin CRUD page | `src/app/admin/(app)/hero-banners/page.tsx` (full pattern incl. `<ImageUploadInput>`) |
| Add a customer-facing dialog (alert/confirm/prompt) | `useDialog()` from `src/components/dialog/DialogProvider.tsx` |
| Add a custom-layout modal | Pattern in `src/components/storefront/ShareButton.tsx` (focus trap, Escape, backdrop, a11y) |
| Add a form with PIN-code autofill | `<PincodeField value onChange onAutofill />` (see `src/app/signup/page.tsx`) |
| Add an OTP input | `<OtpInput value onChange onComplete />` from `src/components/auth/OtpInput.tsx` |
| Add a password input + strength meter | `<PasswordField />` + `<PasswordStrengthMeter password email />` (see `src/app/forgot-password/page.tsx` step 3) |
| Add Open Graph + Twitter Card to a page | Pattern in `src/app/(storefront)/p/[slug]/page.tsx` `generateMetadata` |
| Build a canonical product URL | `buildProductUrl(slug, { utm? })` from `src/lib/share/productUrl.ts` |
| Add a banner / promo / brand image field | `<ImageUploadInput kind="…">` from `src/components/admin/ImageUploadInput.tsx`. Kinds: `logo`, `favicon`, `og_image`, `app_icon`, `brand`, `category`, `category_banner`, `category_icon`, `hero`, `promotion`, `product` (Item 19), `misc` (canonical list: `src/lib/uploads/imageKinds.ts`). Output format (PNG vs JPG) + max-size + max-px are per-kind. |
| Add an image to a product's gallery | Admin: visit `/admin/products/[id]` — the `<ProductGalleryManager>` ships drag-reorder + multi-file upload + Set-primary + alt-text + disable + delete. Service: `lib/cms/productGallery.ts` exposes `registerImage / updateImage / setPrimary / reorderImages / deleteImage / listGalleryForPdp / listGalleryForAdmin`. Files route through `saveAdminImage('product')` (sharp re-encode, EXIF strip, 2400 px / q90 / 5 MB cap). |
| Render a product gallery on a custom surface | Server: pass `images: ProductImageRow[]` to `<ProductGallery productName galleryEnabled lazyLoadEnabled interactionSettings>`. The shell branches between static (Item 19) and interactive (Item 20 `<InteractiveProductGallery>` — click-swap + keyboard + swipe + zoom + lightbox) based on `interactionSettings.interactionsEnabled`. Read settings via `readGalleryInteractionSettings(cfg)` once on the server. |
| Add a new homepage section kind (Item 18) | (1) Add the kind string to `HOMEPAGE_SECTION_KINDS` in `src/lib/cms/homepageSchemas.ts`. (2) Add a Zod schema for its `config` blob in the same file (the `SECTION_CONFIG_SCHEMAS` `Record<HomepageSectionKind, …>` is TS-enforced — TS errors until every kind has a schema). (3) Add a render branch in `src/components/storefront/homepage/HomepageRenderer.tsx` + a block in `blocks.tsx`. (4) Add a per-kind form file under `src/app/admin/(app)/homepage/forms/` + register it in `sectionFormRegistry.ts` (another TS-enforced record). (5) Run `npm run test:homepage-revamp && npm run test:homepage-p2`. |
| Preview unpublished homepage edits | Hit `/?preview=admin` while signed in as an `ADMIN`. The PDP gallery + homepage CMS read paths both honour the `preview` flag — disabled / scheduled-future / scheduled-past sections render with an amber banner. Anonymous + non-admin viewers ignore the param (verified server-side via `getCurrentUser({ requireAdmin: true })`). |
| Build a public-form endpoint with anti-enumeration | Pattern in `src/app/api/newsletter/subscribe/route.ts` (Item 18 P2): CSRF + rate limit + honeypot + **uniform-success response** (`{ received: true }` regardless of whether the email matches an account) — prevents an attacker probing the user table via the subscribe form. Internally flips `User.emailSubscribed=true` if matched, else enqueues an admin-notification email. |
| Show a brand logo / category image with a designed fallback | `<BrandLogo logoUrl name size?>` / `<CategoryImage imageUrl name aspect?>` / `<StoreLogo logoUrl storeName logoAlt? height?>` from `src/components/storefront/`. Real `<img>` → inline-SVG word-mark / coloured-initial tile. NEVER renders a broken image icon. |
| Make a config key user-uploadable in `/admin/store-config` | Set `fieldType: 'image:<kind>'` on the entry in `src/lib/storeConfig/schema.ts` (e.g. `image:logo`). The schema-driven renderer auto-swaps the text input for `<ImageUploadInput>` with the matching kind. |
| Paginate a new list endpoint | Use `parsePaginationParams(searchParams, config, opts?)` + `buildPagination(items, total, page, pageSize)` from `src/lib/pagination.ts`. Defaults from `getStoreConfig().performance.paginationDefaultSize` (hard-capped by `paginationMaxSize`). For huge tables, use `parseCursorParams` + `buildCursorPagination` (skips COUNT). Static audit `test:pagination [P2.2]` will reject any `findMany` without a `take:` clause or `// PAGINATION-EXEMPT` marker. |
| Render a pagination control | `<Pagination currentPage totalPages pageSize totalItems? />` from `src/components/Pagination.tsx`. Pass `basePath` + `searchParams` for link mode, OR `onPageChange` for callback mode. Phase-2 props: `jumpInputThreshold` (numeric input above N pages), `keyboardNav` (ArrowLeft/Right), `urlSync` (callback mode → router.push). |
| Add SEO link tags to a paginated page | `<PaginationSeoLinks {...buildPaginationSeo({ origin, basePath, searchParams, currentPage, totalPages, config })} />` from `src/components/seo/PaginationSeoLinks.tsx`. Emits canonical / prev / next / per-page noindex. |
| Add a feature flag | New entry in `src/lib/storeConfig/schema.ts` (boolean). Pick the right category: `features.*` for user-experience toggles, `products.*` for catalogue/gallery knobs (Items 19+20), `payments.*` / `shipping.*` / etc. for the relevant operational area, `maintenance.*` for pause switches. Extend the `BooleanKey` union in `src/lib/storeConfig/featureGate.ts`. At the gate, call `requireFeature('features.yourFlag')` (throws ForbiddenError with `FEATURE_DISABLED`) or `isFeatureOn(...)` (returns boolean). Add to `clientFlags.ts` if a client component needs it via `useFeatureFlags()`. Test bypass: `NODE_ENV=test && !SHOPCORE_ENFORCE_FEATURE_GATES`. |
| Enqueue a background job | `await enqueueJob('SEND_EMAIL', { to, subject, html })` from `src/lib/jobs/producer.ts`. JobType union + payload typing live in `lib/jobs/jobTypes.ts`. Unknown types fail at enqueue time. For dedup, include a `__dedupKey` property in the payload. Add a worker in `src/lib/jobs/workers/` + register it in `workers/index.ts`. |
| Add a recurring schedule | Append to `BUILT_IN_SCHEDULES` in `src/lib/jobs/scheduler.ts`. Cron is 5-field UTC (`* * * * *`); the parser supports `*`, `n`, `*/step`, `n,m` lists. |
| Add a product attribute used by /compare | One-line edit in `src/lib/compare/attributeGroups.ts` — add an `{ key, label, unit? }` entry to the right group. Keys not declared anywhere fall into the synthetic "Other specifications" group automatically. |
| Add an asset to a Brand / Category | Brand/Category admin forms (`src/app/admin/(app)/{brands,categories}/page.tsx`) already wire `<ImageUploadInput>` for every asset slot. To surface a new slot on a model: add the column via migration + extend the Zod body schema in the admin route + add the input to the form + (optional) surface in `/api/{brands,categories}` for storefront consumption. |
| Show recently uploaded assets / coverage | `/admin/assets` (Item 17 P2). Backing API: `GET /api/admin/assets?include=health&kind=&page=&pageSize=`. |
| Delete an asset safely | `DELETE /api/admin/assets/[id]`. Refuses with `409 ASSET_IN_USE` + a `references[]` list of every Brand / Category / store-config key pointing at the URL. Clear the references first, OR retry with `?force=1` (audited). |
| Build a public-form endpoint with bot protection | Pattern in `src/app/api/contact/route.ts` (Item 13): CSRF + rate limit + honeypot field (silent 200) + Zod schema. |
| Add a responsive table | `<ResponsiveTable ariaLabel="…">` from `src/components/ResponsiveTable.tsx` (or rely on the bare-`<table>` CSS safety-net) |
| Throw a typed error from a service | One of `ValidationError` / `AuthError` / `ForbiddenError` / `NotFoundError` / `ConflictError` / `RateLimitError` / `ExternalServiceError` / `InternalError` from `src/lib/errors.ts`. NEVER `throw new Error('...')` in `src/lib/**` (static audit `test:error-handling (A1)` enforces). Use `{ ok: false, reason }` tagged results for EXPECTED business failures instead. |
| Add a rate limit to a new route | (1) Add a policy entry to `src/lib/security/rateLimitPolicies.ts` with a `domain.action` name + key strategy. (2) Inside the route handler, after any `getCurrentUser` call, `await applyRateLimit('your.policy', req, { userId })`. Done — wrapper attaches `X-RateLimit-*` headers; 429 + `Retry-After` is automatic on exceed. NEVER call the legacy `rateLimit(key, max, sec)` — static audit `test:rate-limiting (A1)` blocks it. |
| Reset a rate limit bucket for a stuck user | Admin: `GET /api/admin/rate-limits` to find the key, then `DELETE /api/admin/rate-limits/[...key]`. Writes an `AuditLog` row tagged `RATE_LIMIT_RESET`. |
| Wrap an external-service call | `await wrapExternal('firebase', 'verifyIdToken', () => sdk.verify(token))` — auto-converts any thrown error into `ExternalServiceError` with `cause` chain + safe client message. |
| Write a route handler | `export const POST = withErrorHandling(async (req, ctx) => { ... });` from `src/lib/api.ts`. NEVER write `try { } catch (e) { return handleError(e); }` by hand — the wrapper does both that AND establishes the request-id ALS for logging. |
| Catch a client API error | `try { const data = await apiOrThrow<T>(url) } catch (e) { if (isClientApiError(e)) { if (e.status === 401) ... } }` — both from `src/lib/client/api.ts`. The legacy `api()` tagged-result form remains supported. |
| Catch a render error in a UI tree | Wrap the subtree in `<ErrorBoundary fallback={<MyFallback />}>` from `src/components/ErrorBoundary.tsx`. Storefront + admin layouts already wrap `{children}`. Async event-handler errors need their own try/catch. |
| Emit a log line | `log.info('domain.action', { ...context })` from `src/lib/log.ts`. `requestId` auto-attached inside an API route; PII keys (phone/email/token/otp/...) auto-redacted before serialisation. NEVER use `console.*` in `src/lib/**` or `src/app/api/**` (static audit in `test:logging` will fail). |
| Bind context to a logger | `log.child({ userId })` returns a logger whose every subsequent call carries the bindings. Does not mutate the parent. |
| Run a script / job with correlated logs | `import { runWithRequestContext } from '@/lib/log'; runWithRequestContext({ requestId: 'req_job_xyz' }, async () => { /* ... */ })` — every log inside the function (and across awaits) carries `requestId`. |
| Verify a Firebase phone token server-side | `verifyFirebasePhoneToken(idToken)` from `src/lib/auth/firebasePhone.ts` (the ONLY allowed caller of `verifyIdToken`). Returns `{uid, phone}` or `null`; throws `PhoneTokenVerificationError` on bad tokens. |
| Run the phone-verify flow end-to-end | Service: `verifyPhoneCredential(userId, idToken, submittedPhone)` from `src/lib/auth/phoneVerification.ts`. HTTP: `POST /api/auth/phone/verify`. UI: `<PhoneVerificationForm phone onSuccess />`. |
| Normalise / mask an Indian phone | `normalisePhone(raw)` returns `+91XXXXXXXXXX` or `null`; `maskPhone(phone)` returns `+91******1234`. Both from `src/lib/auth/phoneVerification.ts`. **Never log full phone numbers.** |
| Skip Firebase in dev / tests | Set `idToken: 'dev-bypass-token'` (or import `DEV_BYPASS_TOKEN` from `src/lib/auth/phoneConstants.ts`). Triple-guarded in production: route handler + service + preflight all independently reject. |
| Re-mint the access cookie after a status change | `reissueAccessTokenForCurrentRequest()` from `src/lib/auth/session.ts` — call inside the route AFTER the DB write. Updates the JWT `status` claim so middleware routing reflects the change immediately. |
| Mint an admin session in tests | Pattern in `scripts/test-admin-uploads.ts` `makeAdminJar()` |
| Capture OTPs across a child process | `process.env.SHOPCORE_TEST_OTP_FILE = '/tmp/...'`; pass it into the spawned child env |
| Run a single end-to-end test | `npx next build && npm run test:<name>` |
| Restart deps after a fresh session | `test -d node_modules || npm install --no-audit --no-fund` |

---

_Last updated: alongside **Item 20 — Product Gallery Interaction**._

**What's new at the top of the stack:**
- **Item 20** (Product Gallery Interaction): new `<InteractiveProductGallery>` client island layered on top of the Item 19 SSR shell. Click-to-swap thumbnails (`role="tab"` + `aria-selected` + `aria-current`), prev/next + counter overlay, ArrowLeft/Right/Home/End keyboard nav, touch swipe (40 px), hover/tap CSS zoom, focus-trapped fullscreen lightbox via native `<dialog>.showModal()`. `prefers-reduced-motion` always overrides the admin's `transitionMs`. **6 new** `products.gallery*` store-config keys (`InteractionsEnabled / ZoomEnabled / FullscreenEnabled / LoopEnabled / TransitionMs / ThumbnailPosition`); 4 new featureGate helpers. Static gallery preserved as the master-switch-off fallback.
- **Item 19** (Product Gallery foundation): extended `ProductImage` with `isActive` + timestamps + compound index. New `lib/cms/productGallery.ts` service (exactly-one-primary + auto-promotion + cap-from-config). 5 admin API endpoints under `/api/admin/products/[id]/images/*` (CRUD + reorder + set-primary). Drag-reorder admin manager UI. `<ProductGallery>` SSR component (LCP-eager primary + lazy thumbs). New `'product'` image kind. 3 store-config keys under a new `'products'` category. Backward-compat pass: every single-image projection across 12 files now filters `isActive: true`.
- **Item 18 Phase 2** (Homepage CMS visual editor): `/admin/homepage` admin app with tabbed Sections / Metrics / Branches shell; 13 per-kind config forms; drag-reorder; `POST /api/newsletter/subscribe` (CSRF + 5/hr/IP rate limit + honeypot + uniform-success anti-enumeration); admin-only storefront preview mode `/?preview=admin`.
- **Item 18 Phase 1** (Homepage CMS data layer): 3 new tables (`HomepageSection`, `HomepageMetric`, `HomepageBranch`); 13 section kinds with per-kind Zod configs; public `GET /api/homepage` (cached); 11 admin CRUD endpoints; first-boot seed; SSR storefront renderer; 4 feature flags; legacy hand-coded fallback page preserved.

**Stack tally:**

| Metric | Value |
|---|---|
| Test scripts                 | **44** (one .ts/.tsx per feature) |
| Dynamic assertions           | **~4,090+** |
| Static source-file audits    | **446** (via `test:no-native-dialogs`) |
| Prisma models                | **52** |
| Migrations                   | **16** |
| Rate-limit policies          | **30** (+ global) |
| Store-config entries         | **123+** across 12 categories |
| Admin-uploadable image kinds | **12** (logo, favicon, og_image, app_icon, brand, category, category_banner, category_icon, hero, promotion, product, misc) |

**Convention:** when a new feature lands, append to `BUILD_LOG.md` first (chronological authoritative record), then bring this `CONTEXT.md` into sync — bump the stack-tally numbers, add the feature row to §2, update the schema / routes / store-config / common-tasks sections that changed._
