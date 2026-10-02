'use client';
/**
 * ProductCollectionSectionForm — Item 18 Phase 2.
 *
 *   The workhorse: the source.mode discriminator picks among
 *   featured / newest / top_rated / trending / by_category / by_brand /
 *   manual. The mode dropdown swaps the secondary inputs in.
 *
 *   Used directly for `PRODUCT_COLLECTION` and indirectly (via the
 *   pre-locked-mode wrappers) for `MOST_RATED_PRODUCTS` and
 *   `TRENDING_PRODUCTS`.
 */
import React from 'react';
import type { SectionFormProps } from './types';
import {
  TextField, TextareaField, NumberField, SelectField, CtaPair, ThemePicker, ChipPicker,
  searchProducts, searchCategories, searchBrands,
  pickString, pickNumber, pickObject, asCta, asTheme,
} from './sharedInputs';

type CollectionMode = 'featured' | 'newest' | 'top_rated' | 'trending' | 'by_category' | 'by_brand' | 'manual';

const MODE_OPTIONS: Array<{ value: CollectionMode; label: string }> = [
  { value: 'featured',    label: 'Featured products' },
  { value: 'newest',      label: 'Newest arrivals' },
  { value: 'top_rated',   label: 'Top rated' },
  { value: 'trending',    label: 'Trending' },
  { value: 'by_category', label: 'By category' },
  { value: 'by_brand',    label: 'By brand' },
  { value: 'manual',      label: 'Hand-picked products' },
];

interface Props extends SectionFormProps {
  /** When set, locks the source.mode dropdown to a single mode. Used
   *  by MOST_RATED_PRODUCTS / TRENDING_PRODUCTS so the admin can't
   *  accidentally repurpose the alias kind. */
  lockedMode?: CollectionMode;
}

export default function ProductCollectionSectionForm({ config, onChange, lockedMode }: Props) {
  const heading    = pickString(config, 'heading', 'Featured');
  const subheading = pickString(config, 'subheading', '');
  const theme      = asTheme(config, 'theme');
  const cta        = asCta(config, 'cta');
  const maxItems   = pickNumber(config, 'maxItems', 8);

  const sourceObj  = pickObject(config, 'source');
  const rawMode    = pickString(sourceObj, 'mode', lockedMode ?? 'featured');
  const mode: CollectionMode = MODE_OPTIONS.some((m) => m.value === rawMode)
    ? (rawMode as CollectionMode) : 'featured';

  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }
  function patchSource(next: Record<string, unknown>) {
    patch({ source: { mode, ...next } });
  }
  function changeMode(next: CollectionMode) {
    // Reset secondary fields when the mode changes so we don't end up
    // with stale `categorySlug` keys etc.
    const seeded: Record<string, unknown> = { mode: next };
    if (next === 'top_rated') seeded.minReviews = pickNumber(sourceObj, 'minReviews', 1);
    if (next === 'by_category') seeded.categorySlug = pickString(sourceObj, 'categorySlug', '');
    if (next === 'by_brand')    seeded.brandSlug    = pickString(sourceObj, 'brandSlug', '');
    if (next === 'manual')      seeded.productIds   = Array.isArray(sourceObj['productIds']) ? sourceObj['productIds'] : [];
    patch({ source: seeded });
  }

  // ── Mode-specific renderers ───────────────────────────────────────────
  function ModeInputs() {
    if (mode === 'featured' || mode === 'newest' || mode === 'trending') {
      return (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          This mode requires no further setup.
        </p>
      );
    }
    if (mode === 'top_rated') {
      const minReviews = pickNumber(sourceObj, 'minReviews', 1);
      return (
        <NumberField label="Minimum reviews" min={0} max={10000} value={minReviews}
          hint="Only count products with at least this many reviews."
          onChange={(n) => patchSource({ minReviews: Math.max(0, Math.min(10000, n)) })} />
      );
    }
    if (mode === 'by_category') {
      const categorySlug = pickString(sourceObj, 'categorySlug', '');
      return (
        <TextField label="Category slug" value={categorySlug} maxLength={64} required
          hint="The URL slug of the source category (e.g. air-conditioners)."
          onChange={(v) => patchSource({ categorySlug: v.toLowerCase().trim() })} />
      );
    }
    if (mode === 'by_brand') {
      const brandSlug = pickString(sourceObj, 'brandSlug', '');
      return (
        <TextField label="Brand slug" value={brandSlug} maxLength={64} required
          hint="The URL slug of the source brand (e.g. apple)."
          onChange={(v) => patchSource({ brandSlug: v.toLowerCase().trim() })} />
      );
    }
    if (mode === 'manual') {
      const productIds = Array.isArray(sourceObj['productIds'])
        ? (sourceObj['productIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      return (
        <ChipPicker label="Products" value={productIds} max={40} fetchItems={searchProducts}
          onChange={(v) => patchSource({ productIds: v })} />
      );
    }
    return null;
  }

  // Helper picker (search-driven) for slug-based modes — surface
  // suggestions even though slug is the source of truth.
  function HelperLookup() {
    if (mode === 'by_category') {
      return <ChipHelper title="Browse categories" fetcher={searchCategories}
        onPick={(slug) => patchSource({ categorySlug: slug })} />;
    }
    if (mode === 'by_brand') {
      return <ChipHelper title="Browse brands" fetcher={searchBrands}
        onPick={(slug) => patchSource({ brandSlug: slug })} />;
    }
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Heading" value={heading} maxLength={120}
          onChange={(v) => patch({ heading: v })} />
        <SelectField<CollectionMode>
          label={lockedMode ? 'Source (locked)' : 'Source'}
          value={mode}
          options={lockedMode ? MODE_OPTIONS.filter((m) => m.value === lockedMode) : MODE_OPTIONS}
          onChange={(v) => { if (!lockedMode) changeMode(v); }}
        />
      </div>
      <TextareaField label="Sub-heading" value={subheading} maxLength={240}
        onChange={(v) => patch({ subheading: v })} />
      <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50/50 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Source options</h4>
        <ModeInputs />
        <HelperLookup />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumberField label="Max items" min={1} max={40} value={maxItems}
          onChange={(n) => patch({ maxItems: Math.max(1, Math.min(40, n)) })} />
        <ThemePicker value={theme} onChange={(v) => patch({ theme: v })} />
      </div>
      <CtaPair value={cta} onChange={(v) => patch({ cta: v })} />
    </div>
  );
}

// ── Mini helper: browse-and-pick assistant for slug fields ──────────────
function ChipHelper({
  title, fetcher, onPick,
}: { title: string; fetcher: (q: string) => Promise<Array<{ id: string; label: string; sub?: string }>>; onPick: (slug: string) => void }) {
  return (
    <details className="rounded-md border border-slate-200 bg-white p-2">
      <summary className="cursor-pointer text-xs font-semibold text-slate-700">{title}</summary>
      <div className="mt-2">
        <ChipPicker
          label="Pick to copy slug"
          value={[]}
          fetchItems={async (q) => {
            const items = await fetcher(q);
            return items.map((it) => ({ id: it.sub ?? it.id, label: it.label, sub: it.sub }));
          }}
          onChange={(v) => { if (v[0]) onPick(v[0]); }}
        />
      </div>
    </details>
  );
}
