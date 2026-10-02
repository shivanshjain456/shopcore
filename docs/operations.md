# ShopCore — Operations & Deployment Runbook

This guide outlines runtime topology, operational procedures, observability, database management, and disaster recovery runbooks for ShopCore.

---

## 1. Production Topology & Requirements

ShopCore is intentionally architected to operate efficiently on lean, low-cost virtual private servers (VPS):

- **Host Specifications**: 1 to 2 vCPU, 2 GB RAM, 20 GB SSD storage.
- **Operating System**: Ubuntu 22.04 LTS or Debian 12.
- **Runtime Dependencies**: Node.js >= 20.x, SQLite 3, Nginx / Caddy reverse proxy.
- **Architecture**: Single Node.js process managing both the Next.js HTTP server and the in-process background job runner, fronted by a TLS-terminating reverse proxy.

---

## 2. Health Monitoring & Probes

ShopCore exposes dedicated endpoints for health and readiness probes (suitable for Docker, systemd, or external monitoring like Uptime Kuma):

### 2.1 Liveness Probe (`GET /api/health`)
- **Status**: Fast, lightweight verification that the Node.js event loop is responsive.
- **Expected Response**: HTTP 200 OK `{ "ok": true, "status": "UP", "timestamp": "..." }`

### 2.2 Readiness Probe (`GET /api/ready`)
- **Status**: Deep probe verifying:
  1. SQLite database connectivity and read/write availability.
  2. Database migration state (checks for unapplied migrations).
  3. Disk storage availability for image uploads.
- **Expected Response**: HTTP 200 OK `{ "ok": true, "status": "READY", "checks": { "db": "OK", "migrations": "OK" } }`

---

## 3. Database Maintenance & Backup Runbook

Because SQLite stores data in a single file (`data/store.db`), standard file copy (`cp`) while the database is actively being written to can produce corrupted snapshots. ShopCore uses SQLite's native atomic `VACUUM INTO` engine.

### 3.1 Creating an Online Database Backup
```bash
# Triggers an atomic backup to data/backups/store-YYYY-MM-DD-HHMM.db
npm run db:backup
```
- **Concurrency Safety**: Readers and writers continue uninterrupted. SQLite writes a clean, defragmented snapshot to the target path.
- **Automated Schedule**: The in-process background job scheduler runs `db_backup` nightly at 03:00 UTC and automatically rotates backups older than 30 days.

### 3.2 Restoring from a Backup
```bash
# 1. Stop the application service to release file locks
sudo systemctl stop shopcore

# 2. Execute the restore script
npm run db:restore -- data/backups/store-2026-10-02-1800.db

# 3. Verify integrity
npm run preflight

# 4. Restart the service
sudo systemctl start shopcore
```

---

## 4. Observability & Structured Logging

ShopCore emits single-line structured JSON logs to `stdout` and `stderr`:

```json
{
  "level": "info",
  "msg": "order.placed",
  "requestId": "9c8a14b3-d64e-4f21-8f81-678a3c9b1104",
  "userId": "cmurb8w...",
  "orderId": "ord_10482",
  "totalPaise": 5199000,
  "env": "production",
  "ts": "2026-10-02T18:42:37.478Z"
}
```

### Logging Rules
- **Request Tracing**: All log events emitted during an HTTP request automatically inherit the server-generated `requestId` via Node.js `AsyncLocalStorage`.
- **Automatic PII Redaction**: Passwords, OTP codes, credit card strings, authorization cookies, and JWTs are replaced with `••••••` by `src/lib/log.ts` before serialization.
- **Ingestion**: Standard log forwarders (e.g. Vector, Promtail, Fluent Bit) can scrape container or systemd journal logs directly without custom parsing filters.

---

## 5. Systemd Service Configuration

For bare-metal or VPS deployments, run ShopCore under systemd supervision:

```ini
# /etc/systemd/system/shopcore.service
[Unit]
Description=ShopCore Production Service
After=network.target

[Service]
Type=simple
User=shopcore
WorkingDirectory=/var/www/shopcore
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000

# Security Hardening
ProtectSystem=full
ProtectHome=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

---

## 6. Disaster Recovery & Emergency Maintenance

### Toggling Maintenance Mode
In the event of upstream outages or emergency data repair:
1. Navigate to `/admin/store-config` -> **Maintenance** tab.
2. Toggle `maintenance.mode = true` and provide a custom customer-facing notice.
3. The server immediately returns HTTP 503 with the maintenance view for all non-admin storefront traffic while allowing staff to access the administrative dashboard.
