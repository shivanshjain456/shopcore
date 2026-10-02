# ShopCore — Production deployment runbook

Target: a single Linux VPS in India (Hetzner Helsinki/Falkenstein routed via Cloudflare, or AWS/DigitalOcean/Hostinger Mumbai). Single Node process, single SQLite file. This setup comfortably handles your stated scale (≤500 users/month, 100+ concurrent, 1 admin).

---

## 0. Server prerequisites

```bash
# Ubuntu 24.04 LTS
sudo apt update && sudo apt install -y nodejs npm sqlite3 nginx certbot python3-certbot-nginx ufw
node -v   # must be >= 20

# Create a non-root user
sudo adduser --disabled-password --gecos '' shopcore
sudo usermod -aG www-data shopcore
```

Firewall:
```bash
sudo ufw allow ssh
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 1. App setup

```bash
sudo su - shopcore
git clone <your-repo> /home/shopcore/app
cd /home/shopcore/app/shopcore
npm ci

# Secrets
cp .env.example .env
nano .env   # see Environment section below

# DB
npm run db:migrate   # creates /home/shopcore/app/shopcore/data/store.db
npm run db:seed      # creates first admin from BOOTSTRAP_ADMIN_*
npm run db:seed:products  # optional: 22 demo products

# Preflight
npm run preflight    # MUST pass before going further

# Build
npm run build
```

---

## 2. Environment (`.env`)

| Var | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `APP_URL`  | yes | `https://yourdomain.in` |
| `DATABASE_URL` | yes | `file:../data/store.db` (relative to `prisma/`) |
| `SESSION_SECRET` | yes | `openssl rand -hex 32` |
| `CSRF_SECRET`    | yes | Different value — `openssl rand -hex 32` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` | yes | `smtp.gmail.com` / `465` / `true` |
| `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | yes | Gmail address + **App Password** (not normal password) |
| `OTP_LENGTH` `OTP_EXPIRY_MINUTES` `OTP_MAX_ATTEMPTS` `OTP_RESEND_COOLDOWN_SECONDS` | optional | defaults are fine |
| `BOOTSTRAP_ADMIN_*` | yes for first boot | seed creates one admin from these — change the password from `/admin` immediately |
| `PAYMENT_UPI_ID` `PAYMENT_DISPLAY_NAME` | yes | Shown to customers on checkout |
| `UPLOAD_DIR` | optional | default `./data/uploads`. Put on the same volume as the DB. |
| `MAX_UPLOAD_MB` | optional | default 5 |
| `RATE_LIMIT_*` | optional | sane defaults |
| `FIREBASE_*` | optional | if blank, Firebase mirror is disabled; auth still fully works |

After editing `.env` run `npm run preflight` again.

---

## 3. Systemd service

`/etc/systemd/system/shopcore.service`:

```ini
[Unit]
Description=ShopCore Next.js (production)
After=network.target

[Service]
Type=simple
User=shopcore
WorkingDirectory=/home/shopcore/app/shopcore
EnvironmentFile=/home/shopcore/app/shopcore/.env
Environment=NODE_ENV=production
ExecStartPre=/usr/bin/npm run preflight
ExecStart=/usr/bin/npx next start -p 3000
Restart=always
RestartSec=5
LimitNOFILE=65536

# Sandboxing
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=/home/shopcore/app/shopcore/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shopcore
sudo systemctl status shopcore
sudo journalctl -u shopcore -f   # structured JSON logs
```

---

## 4. Nginx reverse proxy + TLS

`/etc/nginx/sites-available/shopcore`:

```nginx
server {
  listen 80;
  server_name yourdomain.in www.yourdomain.in;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name yourdomain.in www.yourdomain.in;

  ssl_certificate     /etc/letsencrypt/live/yourdomain.in/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.in/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers on;

  client_max_body_size 10m;     # receipts + uploads (sharp re-encodes anyway)
  gzip on;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml;

  # Long-poll endpoints — let them sit up to 30 s
  proxy_read_timeout 35s;

  # ── Trust Nginx as the forwarding proxy for client IPs ────────────
  # CRITICAL for the rate-limit system: without these directives, every
  # request appears to come from 127.0.0.1 (Nginx itself), so a single
  # bucket holds ALL users' counters and IP-keyed limits become useless.
  #
  # `set_real_ip_from` should list every IP that runs Nginx. For a
  # single-VPS deployment, 127.0.0.1 (the loopback Nginx talks to Node
  # over) is sufficient. If you scale to multiple Nginx instances or
  # use Cloudflare in front, add their IP ranges here.
  real_ip_header X-Forwarded-For;
  set_real_ip_from 127.0.0.1;
  real_ip_recursive on;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id      $request_id;
  }

  # Health/ready bypass auth gates
  location = /api/health { proxy_pass http://127.0.0.1:3000; access_log off; }
  location = /api/ready  { proxy_pass http://127.0.0.1:3000; }

  # ── Background-job backup files (Item 7) ────────────────────────
  # The DB_BACKUP worker writes data/backups/auto_<ts>.db. These files
  # contain the FULL database — they MUST NOT be web-accessible. There
  # is no `location /data/...` block in this config, but make the
  # intent explicit with a deny:
  location ^~ /data/  { deny all; return 404; }
  location ^~ /backups/ { deny all; return 404; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/shopcore /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.in -d www.yourdomain.in
sudo systemctl reload nginx
```

---

## 5. Daily backup cron

The legacy `scripts/backup.ts` cron entry remains the **primary** backup
path. The background-jobs `DB_BACKUP` worker (Item 7, runs daily at
03:00 UTC) is a **second belt** — it writes to the same `data/backups/`
directory using the same `VACUUM INTO` pattern and the same integrity
check. Having two independent triggers means one failing (cron daemon
down, runner stopped) never silently leaves you without backups.

```bash
crontab -e -u shopcore
# add:
0 2 * * *  cd /home/shopcore/app/shopcore && /usr/bin/npx tsx scripts/backup.ts >> /home/shopcore/app/shopcore/data/backup.log 2>&1
```

Off-machine: copy `data/backups/*.db` to S3 / B2 / rsync.net nightly.
**Never** expose `data/backups/` over Nginx (already denied in section 4).

---

## 5b. Background Jobs System (Item 7)

The job runner + scheduler run **inside the Next.js process** — there
is no separate worker daemon. `src/lib/db/client.ts` dynamic-imports
`@/lib/jobs/startup` on first load (skipped when `NODE_ENV=test` or
`JOB_RUNNER_ENABLED=false`).

**Operator interfaces:**

- `/admin/jobs` — admin dashboard (queue stats, job list with filters,
  per-row Retry / Cancel, schedule on/off toggles)
- `npm run preflight` — fails startup if fewer than 5 active schedules
  exist; warns on stuck `PROCESSING` jobs > 1 h
- Structured logs via the standard logger (`grep msg=job.` in journalctl)

**Tunables** (all in `.env`, all optional — defaults are sensible):

| Var | Default | When to change |
|---|---|---|
| `JOB_RUNNER_ENABLED`             | `true`     | `false` on a read-only replica or during maintenance window |
| `JOB_RUNNER_POLL_INTERVAL_MS`    | `5000`     | Lower under high-throughput; raise to reduce idle DB hits |
| `JOB_RUNNER_BATCH_SIZE`          | `5`        | Higher for bursty queues |
| `JOB_RUNNER_MAX_CONCURRENT`      | `10`       | Cap on in-flight workers |
| `JOB_RUNNER_LOCK_TTL_MS`         | `300000`   | Raise if you have legitimately-long-running custom workers |
| `JOB_RUNNER_DRAIN_TIMEOUT_MS`    | `30000`    | SIGTERM drain budget — raise if jobs are slow |

**Restart safety:** the runner registers `SIGTERM`/`SIGINT` handlers
that stop polling, then wait up to `DRAIN_TIMEOUT_MS` for in-flight
jobs to complete. Use `systemctl restart shopcore` for clean restarts.
A crashed process leaves jobs in `PROCESSING` — the next-startup
reclaimer (per-poll sweep on `lockExpiresAt < now`) recovers them.

**Audit trail:** retry/cancel actions and schedule edits write
`AuditLog` rows (`JOB_RETRY`, `JOB_CANCEL`, `JOB_SCHEDULE_UPDATE`) —
visible in `/admin/audit-log`.

---

## 5c. Store Config + Feature Toggles (Item 8)

The admin control plane for every operational switch in ShopCore.
Schema lives in `src/lib/storeConfig/schema.ts` — **123+ typed entries
across 12 categories** (`store`, `features`, `products` — added by Items
19+20, hosts the 9 gallery knobs; `payments`, `shipping`, `checkout`,
`loyalty`, `b2b`, `notifications`, `security`, `performance`,
`maintenance`). Admins edit them from `/admin/store-config`.

**Operator interfaces:**

- `/admin/store-config` — tabbed UI, one tab per category, schema-driven
  field rendering, per-field danger confirmations, export / import /
  reset (typed `RESET_ALL_CONFIG` confirmation).
- `npm run preflight` — passes when at least 5 active job schedules
  exist (the cron-driven control loops); store-config itself is
  validated on read by `getStoreConfig()`.

**Runtime files written by the system:**

| File | Purpose | Web-served? |
|---|---|---|
| `data/maintenance.json` | Mirror of `maintenance.*` flags. Written on every admin PATCH that touches a `maintenance.*` key. Used by ops scripts / cron / external probes — NOT by the storefront layout (which reads via `getStoreConfig` for consistency). | **NO** — Nginx already denies `/data/*` per section 4. Re-verify after every Nginx reload. |
| `data/backups/auto_*.db`  | DB_BACKUP worker output. | NO (same deny). |
| `data/audit-archive/*.jsonl` | AUDIT_LOG_ARCHIVE worker output (rotated audit log). | NO (same deny). |

**Operational toggles to know:**

| Toggle | Effect |
|---|---|
| `maintenance.maintenanceMode` | Redirects all non-admin storefront traffic to `/maintenance`. Admin panel + auth endpoints remain reachable. Use `maintenance.allowedMaintenanceIps` to let yourself in for smoke testing. |
| `maintenance.checkoutPaused`  | Soft-stop on new orders. Customers can still browse / log in / view past orders. Cart contents preserved. |
| `maintenance.registrationPaused` | Reject new signups without disabling the registration feature permanently. |
| `payments.upiEnabled`         | Master switch for the UPI payment method. OFF stops every new order. |
| `notifications.emailEnabled`  | Master switch for transactional email. OFF stops every outgoing email. |
| `features.b2bEnabled`         | Closes the entire B2B portal. |
| `features.emailAuthEnabled` / `features.phoneAuthEnabled` | Per-method sign-in toggles. Disabling both locks customers out — admin panel uses a separate auth path. |

**Restart safety:** the 30-second in-process cache means changes
propagate within ~30 s of save (faster — the cache is invalidated on
the same Node process that saved). Settings marked `requiresRestart`
in the schema (currently `store.timezone`, `security.sessionTimeoutMinutes`)
only take effect after `sudo systemctl restart shopcore`.

**Audit trail:** every PATCH / export / import / reset writes an
`AuditLog` row (`STORE_CONFIG_UPDATED`, `STORE_CONFIG_EXPORTED`,
`STORE_CONFIG_IMPORTED`, `STORE_CONFIG_RESET`) — visible in
`/admin/audit-log`.

---

## 5d. Real Brand Assets + Image Uploads (Item 17)

ShopCore's image pipeline is declarative. The canonical kind registry
lives at `src/lib/uploads/imageKinds.ts` — **12 kinds** (`logo`,
`favicon`, `og_image`, `app_icon`, `brand`, `category`,
`category_banner`, `category_icon`, `hero`, `promotion`, `product`
(Item 19), `misc`). Each kind declares its own max file size, max
re-encoded edge in px, output format (PNG for transparent kinds — logos
/ icons / favicon; JPG for photographic kinds — hero / category / OG /
product), and quality setting.

**On-disk layout:**

```
data/uploads/
├── public-images/<kind>/<random>.<png|jpg>   # served publicly (long-cache, immutable)
├── receipts/<userId>/<random>.<ext>          # gated — owner-or-admin only
└── attachments/<userId>/<kind>/<random>.<ext>  # gated — owner-or-admin only
```

**Web exposure:** Only `public-images/` is web-accessible (via the gated
`/api/uploads/...` handler — public-images return `Cache-Control:
public, max-age=31536000, immutable`; receipts + attachments return
`private, no-store` and require ownership). All other `data/*`
sub-directories are explicitly denied by Nginx (see section 4).

**Operator interface:**

- `/admin/assets` (Item 17 P2) — asset health dashboard. Coverage cards
  for store identity (logo / favicon / OG / Apple icon), brands, and
  categories. Recent-uploads table with reference-checked delete.
- `GET /api/admin/assets?include=health&kind=&page=&pageSize=` — paginated
  registry. Returns coverage stats when `include=health` is set.
- `DELETE /api/admin/assets/[id]` — reference-checked. Returns
  `409 ASSET_IN_USE` with a `references[]` array listing every
  Brand / Category / store-config key still pointing at the URL.
  Admin must clear those first, OR retry with `?force=1` (audited as
  `ASSET_DELETED_FORCED`).

**Dynamic favicon / Apple touch icon / Open Graph card:**
`src/app/icon.tsx`, `apple-icon.tsx`, and `opengraph-image.tsx` all
read `getStoreConfig()` and either redirect to the admin-uploaded
asset (`store.faviconUrl`, `store.appIconUrl`, `store.ogImageUrl`) or
generate a designed PNG via `next/og` — store's first letter / name /
tagline on a brand-derived palette. **Customers never see a broken
icon.** ⚠️ `next/og` rejects `hsl()` inside `linear-gradient()` — use
hex colours only.

**Designed fallback components** (`<StoreLogo>`, `<BrandLogo>`,
`<CategoryImage>`): the storefront never renders a broken `<img>`. A
missing URL collapses into an inline-SVG wordmark / coloured initial
tile / branded gradient.

---

## 5e. Homepage CMS (Item 18)

The storefront homepage is **100% admin-composable**. Sections live in
the `HomepageSection` table; admins compose / order / disable /
schedule them via `/admin/homepage`.

**Admin interfaces:**

- `/admin/homepage` — tabbed shell:
  - **Sections** tab: drag-reorder list (HTML5 native DnD + ↑/↓
    keyboard fallback), per-row Edit / Disable / Delete, `+ Add section`
    kind-picker → per-kind config form, Preview button → `/?preview=admin`.
  - **Metrics** tab: trust-tile CRUD (`170+ brands`, `10M+ customers`).
  - **Branches** tab: physical-store-locations CRUD.
- 13 per-kind forms in `src/app/admin/(app)/homepage/forms/`; the
  registry is TS-enforced (adding a new kind in `homepageSchemas.ts`
  hits a compile error in `sectionFormRegistry.ts` until the form is
  wired). No developer intervention required for normal section edits.

**First-boot seed:** `seedDefaultsIfEmpty()` runs on first import of
`src/lib/db/client.ts` (skipped in `NODE_ENV=test` and when
`JOB_RUNNER_ENABLED=false`). Populates 7 default sections + 4 default
metrics so a fresh install renders immediately. Idempotent — re-running
after admin edits is a no-op.

**Ops kill-switch:** flip `features.homepageRevampEnabled = false` to
revert the storefront to the legacy hand-coded layout
(`src/app/(storefront)/_legacy-page.tsx`, preserved verbatim from
pre-Item-18 ShopCore). Use this if a custom section misbehaves while
admins fix the data.

**Granular family flags:** `features.homepageBrandsEnabled`,
`features.homepageMetricsEnabled`, `features.homepageBranchesEnabled`
let ops drop entire SECTION CATEGORIES (brand strips / metric tiles /
branch lists) without touching every row.

**Preview mode:** `/?preview=admin` bypasses the active + scheduling
filter so admins can sanity-check unpublished / scheduled / disabled
sections. Admin role is verified server-side via
`getCurrentUser({ requireAdmin: true })` — the query param is silently
ignored for anonymous + non-admin viewers (no error, no banner). When
active, an amber banner makes the mode unmistakable.

**Newsletter subscription endpoint** (Item 18 P2):
`POST /api/newsletter/subscribe`. CSRF + 5/hr/IP rate limit +
`website` honeypot field + **uniform-success response**
(`{ received: true }` regardless of whether the email matches an
existing account — prevents enumeration). Internally: if a `User`
with that email exists, flips `emailSubscribed=true` (idempotent);
otherwise enqueues a `SEND_EMAIL` job to `notifications.adminEmail`
so the operator can fold the lead into their CRM. **No new table** —
uses existing `User.emailSubscribed` + the Item-7 `SEND_EMAIL` worker.

**Audit trail:** every section / metric / branch mutation writes an
`AuditLog` row (`HOMEPAGE_SECTION_{CREATE,UPDATE,DELETE,REORDER} /
HOMEPAGE_METRIC_UPDATE / HOMEPAGE_BRANCH_UPDATE`).

---

## 5f. Product Gallery (Item 19 + 20)

Multi-image product gallery. Storefront shows a thumb rail + main image
on the PDP; admins curate per product via a drag-reorder manager
inline on the product edit page.

**Admin interfaces:**

- `/admin/products/[id]` — gallery manager is the second card on every
  product edit page. Drag-reorder (HTML5 DnD + ↑/↓), multi-file upload
  (file-picker + drag-and-drop zone), Set-primary, Disable/Enable,
  inline alt-text editor (blur-or-Enter saves), Remove with dialog
  confirm. Per-cap warning when `products.maxGalleryImages` is reached.
- 5 admin API endpoints under `/api/admin/products/[id]/images/*`
  (see `API.md` § Product Gallery). All CSRF-guarded, audit-wired
  (`PRODUCT_IMAGE_{UPLOAD,UPDATE,DELETE,REORDER,PRIMARY_CHANGED}`),
  rate-limited via the existing `admin.uploads` policy.

**Image kind:** `product` (added to `IMAGE_KIND_SPECS` by Item 19) —
JPG, q90, max 2400 px, max 5 MB. Routes through the same
`saveAdminImage` pipeline as every other admin upload (EXIF strip +
sharp re-encode). Multipart uploads also record a `StoreAsset` row so
the asset shows up in `/admin/assets`.

**Storefront knobs (`/admin/store-config` → `products` tab):**

| Key | Default | Effect |
|---|---|---|
| `products.galleryEnabled`               | `true`    | Master kill-switch. OFF → PDP renders only the primary image, no thumb rail. |
| `products.maxGalleryImages`             | `12`      | Per-product cap (1–40). Defended at the service layer + the admin UI. |
| `products.galleryLazyLoadEnabled`       | `true`    | Secondary thumbs use `loading="lazy"`. OFF for stores whose customers expect instant thumb cycling on slow networks. |
| `products.galleryInteractionsEnabled`   | `true`    | Item 20 — master switch for interactive layer. OFF reverts to Item-19 static markup (no JS-driven click-swap / swipe / zoom / fullscreen). |
| `products.galleryZoomEnabled`           | `true`    | Item 20 — hover-zoom (desktop) / tap-zoom (mobile) via pure-CSS `transform: scale(2)`. |
| `products.galleryFullscreenEnabled`     | `true`    | Item 20 — "View fullscreen" affordance + focus-trapped `<dialog>.showModal()` lightbox. |
| `products.galleryLoopEnabled`           | `false`   | Item 20 — Amazon-style stop-at-end by default; flip ON for Flipkart-style loop wrap. |
| `products.galleryTransitionMs`          | `150`     | Item 20 — fade duration on main-image swap (0–500 ms). **`prefers-reduced-motion` always overrides this to 0** regardless of admin setting. |
| `products.galleryThumbnailPosition`     | `bottom`  | Item 20 — `bottom` or `left`. `left` activates on `sm:` desktop only; mobile always uses `bottom` regardless. |

**Restart safety:** changes propagate within ~30 s of save (store config
cache). The PDP reads settings once per render on the server; no client
poll. The interactive client island reads its prop on every mount.

**Backward-compat pass:** Item 19 migrated every existing single-image
projection (12 files: queries.ts, homepage.ts, compareData.ts, cart.ts,
account/reviews.ts, b2b/quotes.ts, checkout/express.ts, wishlist /
orders / account-reviews / account-subscriptions / cart-preview routes)
to `{ where: { isActive: true }, take: 1, orderBy: [{ isPrimary:
'desc' }, { sortOrder: 'asc' }] }`. **Soft-disabling an image hides it
from cards, wishlist, search, cart, orders, compare, and OG previews
all at once** — no per-surface admin work required.

**Audit trail:** every gallery mutation writes an `AuditLog` row. The
`PRODUCT_IMAGE_PRIMARY_CHANGED` entry carries both the previous and
the new primary image ids in the `before`/`after` JSON columns.

---

## 6. Day-2 operations

| Task | Command |
|---|---|
| Reload after code update | `git pull && npm install --no-audit --no-fund && npm run build && sudo systemctl restart shopcore` |
| Tail logs | `sudo journalctl -u shopcore -f` |
| Filter logs by feature | `sudo journalctl -u shopcore -f \| grep '"msg":"job.'` (jobs), `... grep '"msg":"homepage.'` (Item 18), `... grep '"msg":"product.image.'` (Item 19) |
| Manual backup | `npm run db:backup` |
| Restore | `sudo systemctl stop shopcore && npm run db:restore -- data/backups/store-…db && sudo systemctl start shopcore` |
| Regenerate Excel templates | `npm run excel:templates` |
| Add an admin | Insert via Prisma Studio or seed second admin email/password and re-run `db:seed` |
| Rotate session secrets | Change `SESSION_SECRET`, restart — all sessions invalidated |
| Flip a feature flag | `/admin/store-config` → relevant tab → toggle → Save. Cache invalidates atomically on the saving Node process (other processes pick it up within 30 s). |
| Pause checkout temporarily | `/admin/store-config` → Maintenance → `maintenance.checkoutPaused = true`. Existing carts preserved; new orders refused with `503 CHECKOUT_PAUSED`. |
| Enter full maintenance mode | `/admin/store-config` → Maintenance → `maintenance.maintenanceMode = true` + add your IP to `maintenance.allowedMaintenanceIps`. Non-admin traffic redirects to `/maintenance`; admin panel + auth endpoints remain reachable. |
| Disable the new homepage CMS | `/admin/store-config` → Features → `features.homepageRevampEnabled = false`. Storefront immediately falls back to the legacy hand-coded layout (`_legacy-page.tsx`). |
| Disable the interactive product gallery | `/admin/store-config` → Products → `products.galleryInteractionsEnabled = false`. PDP reverts to Item-19 static markup (no click-swap / zoom / lightbox). |
| Run a single test suite | `npm run test:<name>` (44 suites total — see `package.json`). **Never run them in parallel** — they share an in-memory rate-limit store and a single SQLite file. |
| Full regression sweep | Touch a feature → run its suite + `test:edge-cases test:error-handling test:logging test:rate-limiting test:no-native-dialogs test:store-config` |

---

## 7. Health monitoring

- Cloudflare → set up "Health Check" hitting `https://yourdomain.in/api/ready` every 5 min, alert on 503.
- Or UptimeRobot / BetterStack free tier on `/api/health`.
- `/api/health` — always 200 if the Node process is up (does NOT touch the DB; suitable for liveness probes).
- `/api/ready` — 200 only when the DB + StoreConfig + boot safety checks are all green; 503 otherwise (suitable for readiness probes / canary cut-overs).

**Log line of interest** (`journalctl -u shopcore`):

| `msg` | Meaning |
|---|---|
| `job.runner.started` / `job.scheduler.started`            | Item 7 — runner + scheduler came up cleanly |
| `homepage.unknown_section_kind` / `homepage.invalid_section_config` | Item 18 — one bad section row was logged + dropped; page still rendered. Open `/admin/homepage` to fix. |
| `product.image.primary_promoted`                          | Item 19 — primary auto-promotion fired after the previous primary was disabled / deleted |
| `newsletter.subscribe.user_opted_in` / `newsletter.subscribe.lead_notified` | Item 18 P2 — newsletter subscribe paths |
| `rate.limit` (level=warn)                                  | A request was rate-limited. `key` field is hashed — never a raw IP. |
| `client.error_report`                                      | A storefront error boundary fired; client beaconed details. |

The structured logger auto-redacts PII (`email` → `**ja***@example.com`,
`phone` → `+91******1234`) and fully redacts secrets (`token`, `otp`,
`utr`, `password*`, `cookie`, `secret`). Never grep raw logs for those
fields — they will not be there.

---

## 8. Security review checklist (cut-over)

### Secrets + auth

- [ ] `.env` has all `*_SECRET` set to fresh `openssl rand -hex 32` values
- [ ] `BOOTSTRAP_ADMIN_PASSWORD` rotated; admin password changed from the UI
- [ ] SMTP App Password (not personal Gmail password) configured
- [ ] Firebase Phone Auth `NEXT_PUBLIC_FIREBASE_*` + `FIREBASE_SERVICE_ACCOUNT_*` set (preflight refuses production startup otherwise — see §9)

### Network + TLS

- [ ] HTTPS enforced; HSTS preload header present (`curl -I` to verify)
- [ ] Nginx has `set_real_ip_from 127.0.0.1` + `real_ip_header X-Forwarded-For` (see §4) so the rate limiter sees real client IPs, not `127.0.0.1`
- [ ] If fronted by Cloudflare, ALSO add the Cloudflare IP ranges to `set_real_ip_from`

### Routes + access

- [ ] `/api/admin/*` returns 401 anonymously (probe in browser DevTools)
- [ ] `/api/ready` returns 200; `/api/health` returns 200
- [ ] `/admin/*` (HTML) returns 307 to `/admin/login` anonymously
- [ ] Receipt URLs require auth (`curl -i https://…/api/uploads/receipts/…/…` → 401)
- [ ] Public images cache correctly (`curl -I https://…/api/uploads/public-images/brand/…` → `Cache-Control: public, max-age=31536000, immutable`)
- [ ] `/data/*` paths return 404 from Nginx (DB + backups never web-accessible)

### Backups + data

- [ ] Daily backup cron running and producing files in `data/backups/`
- [ ] DB_BACKUP job schedule (Item 7) shows up in `/admin/jobs` as ACTIVE
- [ ] Off-site backup copy verified (rsync / S3 / B2)
- [ ] Replace `/public/payment/qr.png` with the real UPI QR PNG of your account
- [ ] `PAYMENT_UPI_ID` and `PAYMENT_DISPLAY_NAME` match your live UPI handle

### Admin posture

- [ ] `/admin/store-config` audited — no flag accidentally OFF in prod (`features.b2bEnabled`, `payments.upiEnabled`, `notifications.emailEnabled`, `products.galleryEnabled`)
- [ ] `/admin/homepage` (Item 18) seeded with 7 default sections OR composed deliberately by the operator (use Preview mode `/?preview=admin` to dry-run)
- [ ] Brand + category coverage on `/admin/assets` (Item 17 P2) — ideally 100% before launch so the storefront never shows a designed fallback in front of customers
- [ ] At least one image uploaded per active product (Item 19); the gallery cap `products.maxGalleryImages` is set sensibly (default 12)
- [ ] Spot-check 3 active products' PDPs with `/?preview=admin` to confirm the interactive gallery (Item 20) loads + swipe / zoom / fullscreen all work

---

## 9. Firebase Phone Authentication (Phone Verification feature)

The phone-verification flow uses **Firebase Phone Authentication** for SMS-OTP delivery. Two
SDK halves are involved — set both up before going to production.

### 9.1 Firebase Console — one-time setup

1. **Enable Phone Auth**
   Firebase Console → Authentication → Sign-in method → **Phone** → toggle **Enable**.
2. **Authorized Domains**
   Firebase Console → Authentication → Settings → **Authorized domains** → add your
   production domain (e.g. `shop.example.in`) and any preview domains. `localhost` is
   pre-authorized for development.
3. **Test phone numbers (optional, dev/staging only)**
   Firebase Console → Authentication → Sign-in method → Phone → **Phone numbers for testing**
   — add e.g. `+919999900001` with fixed OTP `000000`. Firebase short-circuits SMS for these.
4. **reCAPTCHA**
   Firebase auto-provisions reCAPTCHA for every authorised domain — nothing extra to
   configure. The client uses an *invisible* widget; users do not see a challenge unless
   Firebase risk-scores the request high.

### 9.2 SMS Quota — Spark (free) plan

Firebase Spark plan includes **10,000 SMS verifications / month for India**. Beyond that,
upgrade to Blaze (pay-as-you-go). Monitor at:
Firebase Console → Authentication → **Usage**.

### 9.3 Required environment variables (production)

| Variable | Required | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY`     | Yes | Project Settings → General → "Your apps" → Web app → Config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes | Same as above (e.g. `your-project.firebaseapp.com`) |
| `NEXT_PUBLIC_FIREBASE_APP_ID`      | Yes | Same as above (e.g. `1:1234567890:web:abcdef...`) |
| `FIREBASE_PROJECT_ID`              | Yes | Same as above |
| `FIREBASE_SERVICE_ACCOUNT_JSON` OR `FIREBASE_SERVICE_ACCOUNT_PATH` | Yes | Project Settings → **Service Accounts** → Generate new private key |

`NEXT_PUBLIC_*` vars are **embedded at build time** by Next.js — you MUST rebuild
(`npm run build`) after changing them. `npm run preflight` will refuse to start production
if any of the five is missing.

### 9.4 Dev / staging without Firebase

If the three `NEXT_PUBLIC_FIREBASE_*` vars are absent, the `/verify-phone` UI renders a
**dev-bypass mode** that accepts the literal OTP `000000` and submits the token
`'dev-bypass-token'` to the server. The server triple-guards this:

  1. Route handler refuses the literal under `NODE_ENV === 'production'` (HTTP 400 `DEV_BYPASS_REJECTED`)
  2. Service module re-checks the same condition before any DB write
  3. `npm run preflight` aborts production startup if the vars are missing

There is no code path that allows `'dev-bypass-token'` to authenticate anyone in production.

### 9.5 Rollback procedure

The phone-verification migration adds three columns + one partial unique index to `User`:

```
"phoneVerified"      BOOLEAN NOT NULL DEFAULT 0
"phoneVerifiedAt"    DATETIME
"firebasePhoneUid"   TEXT
+ partial UNIQUE INDEX "User_firebasePhoneUid_key"
```

SQLite cannot `DROP COLUMN` or `DROP INDEX` cleanly without a table rebuild. To roll back:

```bash
npm run db:backup                   # capture current state first
# Then restore from the backup taken IMMEDIATELY BEFORE this migration ran:
npm run db:restore -- <pre-migration-snapshot>.db
```

If the snapshot is unavailable, the columns are forward-compatible (default 0 / NULL) and
can be left in place — they don't break any pre-feature code paths.
