'use client';
/** NewsletterSectionForm — Item 18 Phase 2. */
import React from 'react';
import type { SectionFormProps } from './types';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import { TextField, TextareaField, pickString } from './sharedInputs';

export default function NewsletterSectionForm({ config, onChange }: SectionFormProps) {
  const heading       = pickString(config, 'heading', 'Stay in the loop');
  const description   = pickString(config, 'description', '');
  const ctaLabel      = pickString(config, 'ctaLabel', 'Subscribe');
  const backgroundUrl = pickString(config, 'backgroundUrl', '');
  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }

  return (
    <div className="space-y-4">
      <TextField label="Heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <TextareaField label="Description" value={description} maxLength={400}
        onChange={(v) => patch({ description: v })} />
      <TextField label="Button label" value={ctaLabel} maxLength={60}
        onChange={(v) => patch({ ctaLabel: v })} />
      <ImageUploadInput
        name="newsletter-bg"
        kind="hero"
        label="Background image (optional)"
        value={backgroundUrl}
        onChange={(v) => patch({ backgroundUrl: v })}
      />
      <p className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-900">
        The subscribe form posts to <code>/api/newsletter/subscribe</code> — uniform-success
        response prevents enumeration of which addresses already have an account.
      </p>
    </div>
  );
}
