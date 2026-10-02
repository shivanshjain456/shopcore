'use client';
/** TopCategoriesSectionForm — Item 18 Phase 2. */
import React from 'react';
import type { SectionFormProps } from './types';
import {
  TextField, TextareaField, NumberField, SourcePicker, ChipPicker, SelectField,
  searchCategories, pickString, pickNumber, pickStringArray,
} from './sharedInputs';

export default function TopCategoriesSectionForm({ config, onChange }: SectionFormProps) {
  const source       = (pickString(config, 'source', 'auto') === 'manual') ? 'manual' : 'auto';
  const categoryIds  = pickStringArray(config, 'categoryIds');
  const maxItems     = pickNumber(config, 'maxItems', 10);
  const heading      = pickString(config, 'heading', 'Shop by category');
  const subheading   = pickString(config, 'subheading', '');
  const layoutRaw    = pickString(config, 'layout', 'tiles');
  const layout: 'tiles' | 'compact' = layoutRaw === 'compact' ? 'compact' : 'tiles';

  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <TextField label="Heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <TextareaField label="Sub-heading" value={subheading} maxLength={240}
        onChange={(v) => patch({ subheading: v })} />
      <SourcePicker value={source} onChange={(v) => patch({ source: v })}
        autoHint="Use the catalogue's sortOrder ranking."
        manualHint="Pick categories one by one." />
      {source === 'manual' && (
        <ChipPicker label="Categories" value={categoryIds} max={20} fetchItems={searchCategories}
          onChange={(v) => patch({ categoryIds: v })} />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumberField label="Max items" min={1} max={20} value={maxItems}
          onChange={(n) => patch({ maxItems: Math.max(1, Math.min(20, n)) })} />
        <SelectField<'tiles' | 'compact'>
          label="Layout"
          value={layout}
          options={[
            { value: 'tiles',   label: 'Tiles (large)' },
            { value: 'compact', label: 'Compact (chips)' },
          ]}
          onChange={(v) => patch({ layout: v })}
        />
      </div>
    </div>
  );
}
