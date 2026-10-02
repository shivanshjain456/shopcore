'use client';
/** BrandShowcaseSectionForm — Item 18 Phase 2. */
import React from 'react';
import type { SectionFormProps } from './types';
import {
  TextField, TextareaField, NumberField, SourcePicker, ChipPicker, SelectField,
  searchBrands, pickString, pickNumber, pickStringArray,
} from './sharedInputs';

export default function BrandShowcaseSectionForm({ config, onChange }: SectionFormProps) {
  const heading      = pickString(config, 'heading', 'Discover leading brands');
  const subheading   = pickString(config, 'subheading', '');
  const source       = (pickString(config, 'source', 'auto') === 'manual') ? 'manual' : 'auto';
  const brandIds     = pickStringArray(config, 'brandIds');
  const maxItems     = pickNumber(config, 'maxItems', 12);
  const scrollRaw    = pickString(config, 'scrollMode', 'static');
  const scrollMode: 'scroll' | 'static' = scrollRaw === 'scroll' ? 'scroll' : 'static';

  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <TextField label="Heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <TextareaField label="Sub-heading" value={subheading} maxLength={240}
        onChange={(v) => patch({ subheading: v })} />
      <SourcePicker value={source} onChange={(v) => patch({ source: v })} />
      {source === 'manual' && (
        <ChipPicker label="Brands" value={brandIds} max={48} fetchItems={searchBrands}
          onChange={(v) => patch({ brandIds: v })} />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumberField label="Max items" min={3} max={48} value={maxItems}
          onChange={(n) => patch({ maxItems: Math.max(3, Math.min(48, n)) })} />
        <SelectField<'scroll' | 'static'>
          label="Display"
          value={scrollMode}
          options={[
            { value: 'static', label: 'Static grid' },
            { value: 'scroll', label: 'Auto-scrolling marquee' },
          ]}
          onChange={(v) => patch({ scrollMode: v })}
        />
      </div>
    </div>
  );
}
