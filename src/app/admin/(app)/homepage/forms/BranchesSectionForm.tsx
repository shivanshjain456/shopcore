'use client';
/** BranchesSectionForm — Item 18 Phase 2. */
import React from 'react';
import type { SectionFormProps } from './types';
import { TextField, TextareaField, NumberField, pickString, pickNumber } from './sharedInputs';

export default function BranchesSectionForm({ config, onChange }: SectionFormProps) {
  const heading    = pickString(config, 'heading', 'Visit our stores');
  const subheading = pickString(config, 'subheading', '');
  const maxItems   = pickNumber(config, 'maxItems', 6);
  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <TextField label="Heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <TextareaField label="Sub-heading" value={subheading} maxLength={240}
        onChange={(v) => patch({ subheading: v })} />
      <NumberField label="Max items" min={1} max={24} value={maxItems}
        onChange={(n) => patch({ maxItems: Math.max(1, Math.min(24, n)) })} />
      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
        The actual branch list lives in the <strong>Branches</strong> tab above.
      </p>
    </div>
  );
}
