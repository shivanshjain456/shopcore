'use client';
/** WidePromoBannerSectionForm — Item 18 Phase 2. */
import React from 'react';
import type { SectionFormProps } from './types';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import {
  TextField, TextareaField, CtaPair, ThemePicker,
  pickString, asCta, asTheme,
} from './sharedInputs';

export default function WidePromoBannerSectionForm({ config, onChange }: SectionFormProps) {
  const imageDesktopUrl = pickString(config, 'imageDesktopUrl', '');
  const imageMobileUrl  = pickString(config, 'imageMobileUrl', '');
  const imageAlt        = pickString(config, 'imageAlt', '');
  const headline        = pickString(config, 'headline', '');
  const subheadline     = pickString(config, 'subheadline', '');
  const theme           = asTheme(config, 'theme');
  const cta             = asCta(config, 'cta');

  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ImageUploadInput
          name="wide-promo-desktop"
          kind="hero"
          label="Desktop image"
          value={imageDesktopUrl}
          onChange={(v) => patch({ imageDesktopUrl: v })}
        />
        <ImageUploadInput
          name="wide-promo-mobile"
          kind="hero"
          label="Mobile image"
          value={imageMobileUrl}
          onChange={(v) => patch({ imageMobileUrl: v })}
        />
      </div>
      <TextField label="Image alt text" value={imageAlt} maxLength={200} required
        hint="Describes the banner for screen readers."
        onChange={(v) => patch({ imageAlt: v })} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Headline" value={headline} maxLength={120}
          onChange={(v) => patch({ headline: v })} />
        <ThemePicker value={theme} onChange={(v) => patch({ theme: v })} />
      </div>
      <TextareaField label="Sub-headline" value={subheadline} maxLength={240}
        onChange={(v) => patch({ subheadline: v })} />
      <CtaPair value={cta} onChange={(v) => patch({ cta: v })} />
    </div>
  );
}
