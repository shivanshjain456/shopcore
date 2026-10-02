import type { Config } from 'tailwindcss';

/**
 * Feature #14 — responsive overhaul.
 *
 * Breakpoint contract used across the codebase:
 *
 *   xs   380px   — small phones (between iPhone SE / iPhone 12 mini)
 *   sm   640px   — Tailwind default (large phones / phablets)
 *   md   768px   — tablets (iPad portrait)
 *   lg   1024px  — small laptops / iPad landscape
 *   xl   1280px  — desktops
 *   2xl  1536px  — large desktops
 *
 * The `xs` breakpoint is the only addition — every other one is Tailwind's
 * default. Avoid hard-coded widths in arbitrary brackets; prefer these.
 */
const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    screens: {
      xs:  '380px',
      sm:  '640px',
      md:  '768px',
      lg:  '1024px',
      xl:  '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        brand: {
          50:  '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          900: '#1e3a8a',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      /** Minimum 44×44 tap-target sizes, matching WCAG 2.5.5 / AA-Large. */
      minWidth:  { 'tap': '44px' },
      minHeight: { 'tap': '44px' },
      /** Fluid font-size scale powered by the CSS vars in `globals.css`. */
      fontSize: {
        fluid:    ['var(--text-base)', { lineHeight: '1.5' }],
        'fluid-xs':   ['var(--text-xs)',   { lineHeight: '1.4' }],
        'fluid-sm':   ['var(--text-sm)',   { lineHeight: '1.45' }],
        'fluid-base': ['var(--text-base)', { lineHeight: '1.55' }],
        'fluid-lg':   ['var(--text-lg)',   { lineHeight: '1.5' }],
        'fluid-xl':   ['var(--text-xl)',   { lineHeight: '1.4' }],
        'fluid-2xl':  ['var(--text-2xl)',  { lineHeight: '1.3' }],
        'fluid-3xl':  ['var(--text-3xl)',  { lineHeight: '1.2' }],
        'fluid-4xl':  ['var(--text-4xl)',  { lineHeight: '1.1' }],
        'fluid-5xl':  ['var(--text-5xl)',  { lineHeight: '1.05' }],
      },
    },
  },
  plugins: [
    /**
     * `.tap-target` — convenience utility for the WCAG-AA 44×44 minimum.
     * Use on small icon-only buttons. Pairs with `inline-flex items-center
     * justify-center` for centred glyphs.
     */
    function ({ addUtilities }: { addUtilities: (u: Record<string, Record<string, string>>) => void }) {
      addUtilities({
        '.tap-target': {
          'min-width':  '44px',
          'min-height': '44px',
        },
      });
    },
  ],
};

export default config;
