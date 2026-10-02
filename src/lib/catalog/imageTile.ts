/**
 * Generate a clean SVG product tile as a data URI.
 *
 * Used as the default product image until admin uploads real photos in Phase 7.
 * Respects our CSP (img-src 'self' data:) — no external network calls.
 *
 * The same function runs at seed time AND at runtime, so we always produce
 * the same visual for a given (kind, accent, label) triple.
 */
type Kind = 'laptop' | 'desktop' | 'monitor' | 'keyboard' | 'mouse' | 'headset' | 'storage' | 'router' | 'box';

const PALETTE = ['#0ea5e9', '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#14b8a6', '#ef4444'];

export function accentFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function shape(kind: Kind, accent: string): string {
  // Each shape draws inside a 600x400 viewBox, centred around (300,200)
  switch (kind) {
    case 'laptop':
      return `
        <rect x="120" y="110" width="360" height="200" rx="14" fill="#0f172a"/>
        <rect x="140" y="130" width="320" height="160" rx="6" fill="${accent}" opacity="0.95"/>
        <rect x="170" y="160" width="120" height="14" rx="3" fill="white" opacity="0.85"/>
        <rect x="170" y="184" width="200" height="10" rx="3" fill="white" opacity="0.6"/>
        <rect x="170" y="204" width="160" height="10" rx="3" fill="white" opacity="0.45"/>
        <rect x="90"  y="312" width="420" height="14" rx="6" fill="#1e293b"/>
        <rect x="260" y="312" width="80"  height="14" rx="6" fill="#334155"/>`;
    case 'desktop':
      return `
        <rect x="200" y="80"  width="200" height="220" rx="14" fill="#0f172a"/>
        <rect x="218" y="100" width="164" height="180" rx="6"  fill="${accent}" opacity="0.85"/>
        <circle cx="300" cy="120" r="6" fill="#22d3ee"/>
        <rect x="230" y="160" width="140" height="10" rx="3" fill="white" opacity="0.8"/>
        <rect x="230" y="180" width="100" height="10" rx="3" fill="white" opacity="0.55"/>
        <rect x="230" y="200" width="120" height="10" rx="3" fill="white" opacity="0.45"/>
        <rect x="180" y="312" width="240" height="12" rx="4" fill="#334155"/>`;
    case 'monitor':
      return `
        <rect x="90"  y="80"  width="420" height="240" rx="14" fill="#0f172a"/>
        <rect x="106" y="96"  width="388" height="208" rx="6"  fill="${accent}" opacity="0.9"/>
        <rect x="140" y="130" width="160" height="14" rx="3" fill="white" opacity="0.85"/>
        <rect x="140" y="154" width="240" height="10" rx="3" fill="white" opacity="0.55"/>
        <rect x="270" y="324" width="60"  height="12" rx="3" fill="#1e293b"/>
        <rect x="220" y="336" width="160" height="14" rx="4" fill="#334155"/>`;
    case 'keyboard':
      return `
        <rect x="80"  y="160" width="440" height="120" rx="14" fill="#0f172a"/>
        ${Array.from({ length: 4 }).map((_, r) =>
          Array.from({ length: 12 }).map((_, c) =>
            `<rect x="${100 + c * 34}" y="${178 + r * 22}" width="26" height="16" rx="3" fill="${c === 5 && r === 1 ? accent : '#334155'}"/>`,
          ).join(''),
        ).join('')}`;
    case 'mouse':
      return `
        <ellipse cx="300" cy="220" rx="90" ry="120" fill="#0f172a"/>
        <path d="M300 100 Q310 100 310 130 L310 200 L290 200 L290 130 Q290 100 300 100" fill="${accent}"/>
        <circle cx="300" cy="170" r="6" fill="${accent}" opacity="0.6"/>`;
    case 'headset':
      return `
        <path d="M150 220 Q150 100 300 100 Q450 100 450 220" stroke="#0f172a" stroke-width="22" fill="none" stroke-linecap="round"/>
        <rect x="120" y="200" width="70" height="110" rx="20" fill="${accent}"/>
        <rect x="410" y="200" width="70" height="110" rx="20" fill="${accent}"/>`;
    case 'storage':
      return `
        <rect x="170" y="120" width="260" height="160" rx="10" fill="#0f172a"/>
        <rect x="186" y="138" width="228" height="36"  rx="4" fill="${accent}"/>
        <circle cx="200" cy="220" r="8" fill="${accent}"/>
        <rect x="220" y="214" width="190" height="12" rx="3" fill="#334155"/>
        <rect x="220" y="240" width="120" height="10" rx="3" fill="#334155"/>`;
    case 'router':
      return `
        <rect x="160" y="180" width="280" height="80" rx="10" fill="#0f172a"/>
        <circle cx="200" cy="220" r="5" fill="${accent}"/>
        <circle cx="220" cy="220" r="5" fill="${accent}" opacity="0.6"/>
        <circle cx="240" cy="220" r="5" fill="${accent}" opacity="0.3"/>
        <path d="M220 170 q 80 -90 160 0" stroke="${accent}" stroke-width="4" fill="none" opacity="0.5"/>
        <path d="M240 170 q 60 -60 120 0" stroke="${accent}" stroke-width="4" fill="none" opacity="0.7"/>`;
    case 'box':
    default:
      return `
        <rect x="180" y="120" width="240" height="180" rx="10" fill="#0f172a"/>
        <rect x="180" y="120" width="240" height="40"  fill="${accent}"/>`;
  }
}

export function productTileSvg(opts: { kind: Kind; accent?: string; label?: string; sub?: string }) {
  const accent = opts.accent ?? '#6366f1';
  const label = (opts.label ?? '').slice(0, 40);
  const sub = (opts.sub ?? '').slice(0, 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" width="600" height="400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>
  <rect width="600" height="400" fill="url(#bg)"/>
  ${shape(opts.kind, accent)}
  ${label ? `<text x="30" y="372" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="14" fill="#0f172a" font-weight="700">${escapeXml(label)}</text>` : ''}
  ${sub ? `<text x="30" y="390" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="11" fill="#64748b">${escapeXml(sub)}</text>` : ''}
</svg>`;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

export function productTileDataUri(opts: { kind: Kind; accent?: string; label?: string; sub?: string }) {
  const svg = productTileSvg(opts);
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/** Best-guess "kind" from a product name. */
export function kindFromName(name: string): Kind {
  const n = name.toLowerCase();
  if (n.includes('laptop') || n.includes('notebook') || n.includes('macbook') || n.includes('thinkpad') || n.includes('ideapad') || n.includes('inspiron') || n.includes('vivobook') || n.includes('pavilion')) return 'laptop';
  if (n.includes('desktop') || n.includes('tower') || n.includes('pc')) return 'desktop';
  if (n.includes('monitor') || n.includes('display')) return 'monitor';
  if (n.includes('keyboard')) return 'keyboard';
  if (n.includes('mouse')) return 'mouse';
  if (n.includes('headset') || n.includes('headphone') || n.includes('earbud')) return 'headset';
  if (n.includes('ssd') || n.includes('hdd') || n.includes('drive') || n.includes('storage')) return 'storage';
  if (n.includes('router') || n.includes('wifi') || n.includes('access point')) return 'router';
  return 'box';
}
