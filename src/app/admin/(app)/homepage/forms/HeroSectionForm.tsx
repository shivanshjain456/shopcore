'use client';
/**
 * HeroSectionForm — Item 18 Phase 2.
 *
 *   The HERO section has no configurable fields of its own; it renders
 *   whatever is currently active in /admin/hero-banners. This form is
 *   a pointer + explainer so admins understand WHY there are no knobs.
 */
import React from 'react';
import Link from 'next/link';
import type { SectionFormProps } from './types';

export default function HeroSectionForm(_props: SectionFormProps) {
  // No fields — the section reads directly from the live hero-carousel
  // CMS so admins manage it in one place. We deliberately accept the
  // SectionFormProps so the registry signature stays uniform.
  void _props;
  return (
    <div className="rounded-md border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
      <p className="font-semibold">No additional configuration.</p>
      <p className="mt-1">
        The hero section renders whatever is currently active in the{' '}
        <Link href="/admin/hero-banners" className="font-semibold underline">Hero carousel</Link>{' '}
        admin. Edit your banners there; they appear here automatically.
      </p>
    </div>
  );
}
