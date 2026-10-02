/**
 * Job Type Registry — the single source of truth for every background job
 * the system knows about. Spec §2.3.
 *
 * Discipline:
 *   - No job type string may appear outside this file. Any handler / producer
 *     call site imports the constant from JOB_TYPES.
 *   - Every JobType MUST have a matching entry in `JobPayloadMap` below,
 *     otherwise `enqueueJob<T>(...)` will fail to compile at the call site.
 *   - Every JobType MUST have a registered handler in
 *     `src/lib/jobs/workers/index.ts` — the runner asserts this at boot
 *     (and `enqueueJob()` rejects unknown handlers eagerly — fail fast).
 *
 * Adding a new job type is a 3-step change:
 *   1) add `JOB_TYPES.MY_THING`
 *   2) add `JobPayloadMap` entry (the typed payload shape)
 *   3) register a handler (real or stub) in `workers/index.ts`
 */

export const JOB_TYPES = {
  // Email
  SEND_EMAIL:                    'send_email',
  // Auth
  CLEANUP_EXPIRED_OTPS:          'cleanup_expired_otps',
  CLEANUP_EXPIRED_SESSIONS:      'cleanup_expired_sessions',
  CLEANUP_EXPIRED_RESET_TOKENS:  'cleanup_expired_reset_tokens',
  // Account
  ACCOUNT_DELETION_CLEANUP:      'account_deletion_cleanup',
  // Inventory
  LOW_STOCK_ALERT:               'low_stock_alert',
  RESTOCK_NOTIFICATION:          'restock_notification',
  // Checkout
  ABANDONED_CART_REMINDER:       'abandoned_cart_reminder',
  CLEANUP_STUCK_IDEMPOTENCY:     'cleanup_stuck_idempotency',
  // Orders
  ORDER_STATUS_NOTIFICATION:     'order_status_notification',
  // B2B
  B2B_QUOTE_EXPIRY:              'b2b_quote_expiry',
  // Promotions (future — registered now so handler-not-implemented warnings
  // are emitted rather than runner crashes when these are first scheduled).
  PROMOTION_ACTIVATION:          'promotion_activation',
  PROMOTION_EXPIRY:              'promotion_expiry',
  // SEO (future)
  SITEMAP_GENERATION:            'sitemap_generation',
  // Analytics (future)
  ANALYTICS_DAILY_ROLLUP:        'analytics_daily_rollup',
  // Maintenance
  DB_VACUUM:                     'db_vacuum',
  DB_BACKUP:                     'db_backup',
  AUDIT_LOG_ARCHIVE:             'audit_log_archive',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

// ─── Payload types ─────────────────────────────────────────────────────────
//
// One typed interface per JobType. Workers re-validate their payload with
// Zod before use (spec §3.10) — these TS types are the compile-time contract
// for *producers* (call sites of `enqueueJob`).

export interface SendEmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface AbandonedCartReminderPayload {
  /** Optional cart-id scope. When omitted, the worker scans every stale
   *  cart in the eligibility window (the recurring schedule uses this). */
  cartId?: string;
}

export interface OrderStatusNotificationPayload {
  orderId: string;
  newStatus: string;
}

export interface LowStockAlertPayload {
  /** Optional product-id scope. When omitted (recurring), worker scans
   *  every product whose stock dipped to / below its lowStockAt threshold. */
  productId?: string;
}

export interface RestockNotificationPayload {
  productId: string;
  variantId?: string;
}

export interface AccountDeletionCleanupPayload {
  userId: string;
}

export interface B2BQuoteExpiryPayload {
  /** Optional quote-id scope. When omitted (recurring), worker scans
   *  every PENDING quote past its 7-day window. */
  quoteId?: string;
}

export interface PromotionPayload {
  promotionId: string;
}

export interface SitemapGenerationPayload {
  /** Optional reason tag for audit. */
  reason?: string;
}

export interface AnalyticsDailyRollupPayload {
  /** ISO date `YYYY-MM-DD` the rollup is computed for; defaults to "yesterday". */
  date?: string;
}

export interface DbVacuumPayload {
  /** No fields today — kept as an object so future flags can be added
   *  additively without changing every call site. */
  _placeholder?: never;
}

export interface DbBackupPayload {
  _placeholder?: never;
}

export interface AuditLogArchivePayload {
  /** Override the default 90-day cutoff (in days). */
  retentionDays?: number;
}

export interface EmptyPayload {
  _placeholder?: never;
}

/**
 * Mapping JobType → payload TS shape. Every JobType is covered; missing keys
 * surface as a compile error in `enqueueJob` and in the worker registry.
 */
export interface JobPayloadMap {
  [JOB_TYPES.SEND_EMAIL]:                    SendEmailPayload;
  [JOB_TYPES.CLEANUP_EXPIRED_OTPS]:          EmptyPayload;
  [JOB_TYPES.CLEANUP_EXPIRED_SESSIONS]:      EmptyPayload;
  [JOB_TYPES.CLEANUP_EXPIRED_RESET_TOKENS]:  EmptyPayload;
  [JOB_TYPES.ACCOUNT_DELETION_CLEANUP]:      AccountDeletionCleanupPayload;
  [JOB_TYPES.LOW_STOCK_ALERT]:               LowStockAlertPayload;
  [JOB_TYPES.RESTOCK_NOTIFICATION]:          RestockNotificationPayload;
  [JOB_TYPES.ABANDONED_CART_REMINDER]:       AbandonedCartReminderPayload;
  [JOB_TYPES.CLEANUP_STUCK_IDEMPOTENCY]:     EmptyPayload;
  [JOB_TYPES.ORDER_STATUS_NOTIFICATION]:     OrderStatusNotificationPayload;
  [JOB_TYPES.B2B_QUOTE_EXPIRY]:              B2BQuoteExpiryPayload;
  [JOB_TYPES.PROMOTION_ACTIVATION]:          PromotionPayload;
  [JOB_TYPES.PROMOTION_EXPIRY]:              PromotionPayload;
  [JOB_TYPES.SITEMAP_GENERATION]:            SitemapGenerationPayload;
  [JOB_TYPES.ANALYTICS_DAILY_ROLLUP]:        AnalyticsDailyRollupPayload;
  [JOB_TYPES.DB_VACUUM]:                     DbVacuumPayload;
  [JOB_TYPES.DB_BACKUP]:                     DbBackupPayload;
  [JOB_TYPES.AUDIT_LOG_ARCHIVE]:             AuditLogArchivePayload;
}

export type JobPayload<T extends JobType> = JobPayloadMap[T];

/** Set of every legal job type string (cheap O(1) membership check). */
export const ALL_JOB_TYPES: ReadonlySet<JobType> = new Set(Object.values(JOB_TYPES));

export function isJobType(s: string): s is JobType {
  return ALL_JOB_TYPES.has(s as JobType);
}
