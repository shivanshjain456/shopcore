/**
 * Security headers applied by middleware (in addition to those set in
 * next.config.mjs). Middleware-set values take effect at runtime; the
 * config-level ones cover static assets too.
 *
 * Cross-Origin-* values lean strict — we don't embed third-party iframes
 * or load cross-origin resources by design (inline SVG product tiles,
 * locally-stored uploads, no external CDN).
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'X-DNS-Prefetch-Control': 'off',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
