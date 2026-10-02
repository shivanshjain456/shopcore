'use client';
/** DualPromoCardsSectionForm — Item 18 Phase 2. Two side-by-side cards. */
import React from 'react';
import type { SectionFormProps } from './types';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import {
  TextField, TextareaField, CtaPair, ThemePicker,
  pickString, pickObject, asCta, asTheme,
} from './sharedInputs';

interface CardValue {
  imageUrl: string; imageAlt: string;
  headline: string; subheadline: string;
  cta: { label: string; href: string };
  theme: ReturnType<typeof asTheme>;
}
function readCard(o: Record<string, unknown>): CardValue {
  return {
    imageUrl:    pickString(o, 'imageUrl', ''),
    imageAlt:    pickString(o, 'imageAlt', ''),
    headline:    pickString(o, 'headline', ''),
    subheadline: pickString(o, 'subheadline', ''),
    cta:         asCta(o, 'cta'),
    theme:       asTheme(o, 'theme'),
  };
}

function CardEditor({
  label, slot, value, onChange,
}: { label: string; slot: 'left' | 'right'; value: CardValue; onChange: (v: CardValue) => void }) {
  return (
    <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</legend>
      <ImageUploadInput
        name={`dual-promo-${slot}-image`}
        kind="promotion"
        label="Card image"
        value={value.imageUrl}
        onChange={(v) => onChange({ ...value, imageUrl: v })}
      />
      <TextField label="Image alt text" value={value.imageAlt} maxLength={200} required
        onChange={(v) => onChange({ ...value, imageAlt: v })} />
      <TextField label="Headline" value={value.headline} maxLength={120}
        onChange={(v) => onChange({ ...value, headline: v })} />
      <TextareaField label="Sub-headline" value={value.subheadline} maxLength={240}
        onChange={(v) => onChange({ ...value, subheadline: v })} />
      <ThemePicker value={value.theme} onChange={(v) => onChange({ ...value, theme: v })} />
      <CtaPair value={value.cta} onChange={(v) => onChange({ ...value, cta: v })} />
    </fieldset>
  );
}

export default function DualPromoCardsSectionForm({ config, onChange }: SectionFormProps) {
  const heading = pickString(config, 'heading', '');
  const left    = readCard(pickObject(config, 'left'));
  const right   = readCard(pickObject(config, 'right'));

  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <TextField label="Section heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <CardEditor label="Left card"  slot="left"  value={left}  onChange={(v) => patch({ left: v })} />
        <CardEditor label="Right card" slot="right" value={right} onChange={(v) => patch({ right: v })} />
      </div>
    </div>
  );
}
