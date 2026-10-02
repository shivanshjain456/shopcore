/**
 * Product URL + share-link service — Feature #35.
 *
 *   Single source of truth for:
 *     - Constructing canonical product URLs (`buildProductUrl`).
 *     - Stamping UTM parameters consistently across the codebase
 *       (`appendUtm`).
 *     - Building per-platform share URLs (`buildShareLinks`) for
 *       WhatsApp / Telegram / Facebook / Twitter-X / Email.
 *
 *   Why a service instead of inlining?
 *     - Every share point (PDP, future cart-share, future affiliate
 *       links, future QR codes) must produce identical URLs. Having
 *       URL construction scattered across components is how URL
 *       contracts silently drift.
 *     - Future hooks (referral codes, short URLs, A/B-test bucketing)
 *       slot in HERE without touching call sites.
 *
 *   Conventions:
 *     - All URLs are ABSOLUTE (start with `https://...` or `http://...`)
 *       because share targets need fully-qualified URLs.
 *     - Slugs are URL-encoded defensively so a malformed slug (cyrillic,
 *       emoji, slash) never breaks the link.
 *     - UTM params follow the standard Google taxonomy
 *       (utm_source / utm_medium / utm_campaign / utm_content / utm_term).
 *     - All builders are PURE functions — no I/O, no DOM access — so
 *       they're safe to call from both server and client code AND
 *       trivial to unit-test without mocking.
 */

/** Defaults used when the caller omits UTM medium. Tweakable centrally. */
export const SHARE_DEFAULTS = {
  utmSource:   'shopcore',
  utmMedium:   'share',
  utmCampaign: 'product_share',
} as const;

export interface UtmParams {
  utm_source?:   string;
  utm_medium?:   string;
  utm_campaign?: string;
  utm_content?:  string;
  utm_term?:     string;
}

export interface BuildProductUrlOptions {
  /** Override the app base URL — useful for SSR contexts where the
   *  request origin differs from `APP_URL`. Defaults to APP_URL. */
  baseUrl?: string;
  /** UTM parameters to stamp. When `medium` is one of our known
   *  channels (`whatsapp`, `telegram`, `facebook`, `twitter`, `email`,
   *  `copy_link`, `native`), it's passed through verbatim. */
  utm?: UtmParams;
  /** Optional path prefix override (default `/p`). */
  productPathPrefix?: string;
}

/** Trim trailing slashes — composing `${base}/${path}` shouldn't double up. */
function trimRightSlashes(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * Encode a slug for safe inclusion in a URL path segment. We don't use
 * `encodeURIComponent` directly because Next.js routes have their own
 * decoder — encoding a `/` here breaks the route lookup. We DO encode
 * everything else (spaces, query chars, fragments) so a slug like
 * `summer sale 2026?` stays intact.
 *
 * Slashes inside a slug are stripped (a slug should never contain `/`;
 * if it does that's a data bug and we don't want it to escape the
 * intended path).
 */
export function encodeSlugForUrl(slug: string): string {
  if (typeof slug !== 'string') return '';
  const trimmed = slug.trim().replace(/\/+/g, '');
  // encodeURIComponent over-encodes some chars that are valid in URL
  // paths (~, !, *, '), so we keep those literal. The result is what a
  // human reader would expect to see in the address bar.
  return encodeURIComponent(trimmed)
    .replace(/%7E/gi, '~')
    .replace(/%21/g,  '!')
    .replace(/%2A/g,  '*')
    .replace(/%27/g,  "'");
}

/** Append (or merge) UTM params onto a URL. Idempotent + order-stable. */
export function appendUtm(url: string, utm?: UtmParams): string {
  if (!utm) return url;
  // We parse using URL so an existing `?coupon=DIWALI` survives intact.
  // SSR-safe — Node has a built-in URL global.
  let u: URL;
  try { u = new URL(url); }
  catch { return url; /* malformed URL — return verbatim */ }
  for (const [k, v] of Object.entries(utm)) {
    if (v == null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Build the canonical, absolute URL for a product. The shape is:
 *
 *   `<base>/p/<encoded-slug>`
 *
 * (We already serve PDPs at `/p/[slug]`; keeping the existing route is
 * the right call — switching to `/products/...` would break every
 * already-shared link in the wild.)
 *
 * Test invariant: `new URL(buildProductUrl(...))` always succeeds.
 */
export function buildProductUrl(slug: string, opts: BuildProductUrlOptions = {}): string {
  const base   = trimRightSlashes(opts.baseUrl ?? process.env.APP_URL ?? 'http://localhost:3000');
  const prefix = opts.productPathPrefix ?? '/p';
  const url    = `${base}${prefix.startsWith('/') ? '' : '/'}${prefix}/${encodeSlugForUrl(slug)}`;
  return appendUtm(url, opts.utm);
}

// ── Share-link builders ────────────────────────────────────────────────────
//
// Each builder takes the SAME pre-built canonical URL + a title +
// (optional) description, and emits a `https://...` URL that, when
// opened, hands the share off to the named app/platform.
//
// We DON'T encode the URL into the title — most platforms re-render
// rich previews from the URL itself via Open Graph crawl.
//

export interface BuildShareLinksInput {
  /** Absolute, canonical product URL (already UTM-stamped). */
  url: string;
  /** Product name / title. */
  title: string;
  /** Optional one-line description. */
  description?: string;
}

export interface ShareLinks {
  whatsapp: string;
  telegram: string;
  facebook: string;
  twitter:  string;
  email:    string;
}

export function buildShareLinks({ url, title, description }: BuildShareLinksInput): ShareLinks {
  const t  = title.trim();
  const d  = (description ?? '').trim();
  const u  = url.trim();
  const enc = encodeURIComponent;
  // Compose share text for chat-style targets: title + url + optional desc.
  const chatText  = d ? `${t}\n\n${d}\n${u}` : `${t}\n${u}`;
  const tweetText = d ? `${t} — ${d}` : t;
  return {
    // WhatsApp accepts both `wa.me` (which we use — works on web + mobile)
    // and `whatsapp://send`. wa.me handles the platform redirect for us.
    whatsapp: `https://wa.me/?text=${enc(chatText)}`,
    telegram: `https://t.me/share/url?url=${enc(u)}&text=${enc(t)}${d ? `%0A${enc(d)}` : ''}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(u)}`,
    // X/Twitter intent — passes URL separately so the platform can render
    // the OG preview rather than treating the URL as part of the body.
    twitter:  `https://twitter.com/intent/tweet?text=${enc(tweetText)}&url=${enc(u)}`,
    email:    `mailto:?subject=${enc(t)}&body=${enc(chatText)}`,
  };
}

/** Known share-channel identifiers. Used to stamp utm_medium values. */
export type ShareChannel =
  | 'whatsapp' | 'telegram' | 'facebook' | 'twitter' | 'email'
  | 'copy_link' | 'native' | 'qr';

/**
 * Convenience: build a URL stamped with the channel as utm_medium.
 * Centralised so every channel always uses the same UTM scheme.
 */
export function buildProductUrlForChannel(
  slug: string, channel: ShareChannel, opts: Omit<BuildProductUrlOptions, 'utm'> = {},
): string {
  return buildProductUrl(slug, {
    ...opts,
    utm: {
      utm_source:   SHARE_DEFAULTS.utmSource,
      utm_medium:   channel,
      utm_campaign: SHARE_DEFAULTS.utmCampaign,
    },
  });
}

/**
 * Defensive helper used by tests + UI to label a channel for display.
 * Future locales just add cases here without touching every component.
 */
export function channelLabel(channel: ShareChannel): string {
  switch (channel) {
    case 'whatsapp':  return 'WhatsApp';
    case 'telegram':  return 'Telegram';
    case 'facebook':  return 'Facebook';
    case 'twitter':   return 'X (Twitter)';
    case 'email':     return 'Email';
    case 'copy_link': return 'Copy link';
    case 'native':    return 'More…';
    case 'qr':        return 'QR code';
  }
}
