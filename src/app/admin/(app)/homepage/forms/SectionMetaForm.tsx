'use client';
/**
 * SectionMetaForm — Item 18 Phase 2.
 *
 *   Shared meta-field strip rendered above every per-kind config form:
 *   slug · title · displayOrder · isActive · startsAt / endsAt
 *   scheduling window.
 *
 *   Stateless / controlled: parent owns the values + the onChange.
 *   The component never reads from or writes to a DB; it only renders.
 */
import React from 'react';
import { ChangeEvent } from 'react';

export interface SectionMeta {
  slug:         string;
  title:        string;
  displayOrder: number;
  isActive:     boolean;
  startsAt:     string;   // ISO datetime-local OR ''
  endsAt:       string;
}

interface Props {
  value:    SectionMeta;
  onChange: (next: SectionMeta) => void;
  /** If true, the slug input is read-only (slug is the stable PK). */
  slugLocked?: boolean;
  /** Surface the kind for read-only display. */
  kindLabel:  string;
}

export default function SectionMetaForm({ value, onChange, slugLocked, kindLabel }: Props) {
  function patch(p: Partial<SectionMeta>) { onChange({ ...value, ...p }); }
  function onText(field: keyof SectionMeta) {
    return (e: ChangeEvent<HTMLInputElement>) => patch({ [field]: e.target.value } as Partial<SectionMeta>);
  }

  return (
    <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <legend className="sr-only">Section metadata</legend>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600">Kind</label>
        <p className="mt-1 rounded-md bg-slate-100 px-2.5 py-1.5 text-sm font-mono text-slate-700">{kindLabel}</p>
      </div>

      <div>
        <label htmlFor="hp-meta-slug" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
          Slug <span className="text-red-600" aria-hidden="true">*</span>
        </label>
        <input
          id="hp-meta-slug"
          type="text"
          name="slug"
          required
          readOnly={slugLocked}
          maxLength={64}
          pattern="[a-z0-9-]+"
          value={value.slug}
          onChange={onText('slug')}
          placeholder="featured-products"
          className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm read-only:bg-slate-100"
        />
        <p className="mt-1 text-[11px] text-slate-500">Lowercase letters, digits, and hyphens only.</p>
      </div>

      <div className="sm:col-span-2">
        <label htmlFor="hp-meta-title" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">Admin title</label>
        <input
          id="hp-meta-title"
          type="text"
          maxLength={120}
          value={value.title}
          onChange={onText('title')}
          placeholder="Internal label (admin only)"
          className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
        />
      </div>

      <div>
        <label htmlFor="hp-meta-order" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">Display order</label>
        <input
          id="hp-meta-order"
          type="number"
          min={0}
          step={10}
          value={value.displayOrder}
          onChange={(e) => patch({ displayOrder: Math.max(0, Number(e.target.value || 0)) })}
          className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
        />
      </div>

      <div className="flex items-end gap-2">
        <label className="inline-flex select-none items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm">
          <input
            type="checkbox"
            checked={value.isActive}
            onChange={(e) => patch({ isActive: e.target.checked })}
            className="h-4 w-4"
          />
          Active (visible on storefront)
        </label>
      </div>

      <div>
        <label htmlFor="hp-meta-starts" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
          Starts at <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <input
          id="hp-meta-starts"
          type="datetime-local"
          value={value.startsAt}
          onChange={onText('startsAt')}
          className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
        />
      </div>
      <div>
        <label htmlFor="hp-meta-ends" className="block text-xs font-semibold uppercase tracking-wide text-slate-600">
          Ends at <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <input
          id="hp-meta-ends"
          type="datetime-local"
          value={value.endsAt}
          onChange={onText('endsAt')}
          className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
        />
      </div>
    </fieldset>
  );
}
