'use client';
/** StoreMetricsSectionForm — Item 18 Phase 2. */
import React from 'react';
import type { SectionFormProps } from './types';
import { TextField, TextareaField, ThemePicker, pickString, asTheme } from './sharedInputs';

export default function StoreMetricsSectionForm({ config, onChange }: SectionFormProps) {
  const heading    = pickString(config, 'heading', '');
  const subheading = pickString(config, 'subheading', '');
  const theme      = asTheme(config, 'theme');
  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <TextField label="Heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <TextareaField label="Sub-heading" value={subheading} maxLength={240}
        onChange={(v) => patch({ subheading: v })} />
      <ThemePicker value={theme} onChange={(v) => patch({ theme: v })} />
      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
        The actual metric values (e.g. <em>170+ brands</em>) live in the <strong>Metrics</strong> tab above.
      </p>
    </div>
  );
}
