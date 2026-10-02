'use client';
/**
 * SectionEditor — Item 18 Phase 2.
 *
 *   Modal-style editor pane: <SectionMetaForm> + the per-kind config
 *   form picked from the registry. Owns local draft state; bubbles up
 *   a Save → POST/PATCH to the parent.
 */
import React from 'react';
import { useState } from 'react';
import { Button } from '@/components/admin/Helpers';
import SectionMetaForm, { type SectionMeta } from './forms/SectionMetaForm';
import { SECTION_FORM_COMPONENTS, SECTION_KIND_LABELS, SECTION_KIND_DESCRIPTIONS } from './forms/sectionFormRegistry';
import type { HomepageSectionKind } from '@/lib/cms/homepageSchemas';
import type { SectionConfig } from './forms/types';

export interface SectionDraft {
  id?:    string;
  kind:   HomepageSectionKind;
  meta:   SectionMeta;
  config: SectionConfig;
}

interface Props {
  draft: SectionDraft;
  busy:  boolean;
  error: string | null;
  onCancel: () => void;
  onSave:   (next: SectionDraft) => void;
}

export default function SectionEditor({ draft, busy, error, onCancel, onSave }: Props) {
  const [meta,   setMeta]   = useState<SectionMeta>(draft.meta);
  const [config, setConfig] = useState<SectionConfig>(draft.config);
  const Form = SECTION_FORM_COMPONENTS[draft.kind];

  function submit() {
    onSave({ ...draft, meta, config });
  }

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <header className="space-y-1 border-b border-slate-100 pb-3">
        <h2 className="text-lg font-bold text-slate-900">
          {draft.id ? 'Edit section' : 'New section'}
          <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
            {SECTION_KIND_LABELS[draft.kind]}
          </span>
        </h2>
        <p className="text-xs text-slate-500">{SECTION_KIND_DESCRIPTIONS[draft.kind]}</p>
      </header>

      <SectionMetaForm
        value={meta}
        onChange={setMeta}
        slugLocked={Boolean(draft.id)}
        kindLabel={draft.kind}
      />

      <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50/50 p-3">
        <h3 className="text-sm font-semibold text-slate-800">Section configuration</h3>
        <Form config={config} onChange={setConfig} />
      </div>

      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
        <Button tone="ghost" onClick={onCancel} disabled={busy} type="button">Cancel</Button>
        <Button onClick={submit} disabled={busy} type="button">
          {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Create section'}
        </Button>
      </div>
    </div>
  );
}
