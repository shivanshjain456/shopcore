'use client';
/** FeaturedBrandsSectionForm — Item 18 Phase 2. */
import React from 'react';
import type { SectionFormProps } from './types';
import {
  TextField, TextareaField, NumberField, SourcePicker, ChipPicker,
  searchBrands, pickString, pickNumber, pickStringArray,
} from './sharedInputs';

export default function FeaturedBrandsSectionForm({ config, onChange }: SectionFormProps) {
  const source     = (pickString(config, 'source', 'auto') === 'manual') ? 'manual' : 'auto';
  const brandIds   = pickStringArray(config, 'brandIds');
  const maxItems   = pickNumber(config, 'maxItems', 12);
  const heading    = pickString(config, 'heading', 'Shop by brand');
  const subheading = pickString(config, 'subheading', '');

  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <TextField label="Heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <TextareaField label="Sub-heading" value={subheading} maxLength={240}
        onChange={(v) => patch({ subheading: v })} />
      <SourcePicker
        value={source}
        onChange={(v) => patch({ source: v })}
        autoHint="Pick the most-active brands automatically."
        manualHint="Choose exactly which brands appear."
      />
      {source === 'manual' && (
        <ChipPicker label="Brands" value={brandIds} max={24} fetchItems={searchBrands}
          onChange={(v) => patch({ brandIds: v })} />
      )}
      <NumberField label="Max items" min={1} max={24} value={maxItems}
        onChange={(n) => patch({ maxItems: Math.max(1, Math.min(24, n)) })} />
    </div>
  );
}
