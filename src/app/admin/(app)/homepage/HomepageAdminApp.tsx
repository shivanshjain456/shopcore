'use client';
/**
 * HomepageAdminApp — Item 18 Phase 2.
 *
 *   Top-level tabbed shell for the homepage CMS:
 *     - Sections (drag-reorder list)
 *     - Metrics  (HomepageMetric CRUD)
 *     - Branches (HomepageBranch CRUD)
 *
 *   The tab state lives in a query param so admins can deep-link.
 */
import React from 'react';
import { useState } from 'react';
import { PageHeader } from '@/components/admin/Helpers';
import SectionsTab from './SectionsTab';
import MetricsTab from './MetricsTab';
import BranchesTab from './BranchesTab';

type Tab = 'sections' | 'metrics' | 'branches';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'sections', label: 'Sections' },
  { id: 'metrics',  label: 'Metrics' },
  { id: 'branches', label: 'Branches' },
];

export default function HomepageAdminApp() {
  const [tab, setTab] = useState<Tab>('sections');
  return (
    <div className="space-y-4">
      <PageHeader
        title="Homepage CMS"
        subtitle="Admin is the sole authority over storefront homepage content."
      />
      <div role="tablist" aria-label="Homepage sub-sections" className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              aria-controls={`hp-tab-${t.id}`}
              id={`hp-tab-${t.id}-trigger`}
              type="button"
              onClick={() => setTab(t.id)}
              className={`-mb-px rounded-t-md px-4 py-2 text-sm font-semibold transition ${
                active
                  ? 'border-x border-t border-slate-200 bg-white text-brand-700'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >{t.label}</button>
          );
        })}
      </div>
      <div role="tabpanel" id={`hp-tab-${tab}`} aria-labelledby={`hp-tab-${tab}-trigger`}>
        {tab === 'sections' && <SectionsTab />}
        {tab === 'metrics'  && <MetricsTab />}
        {tab === 'branches' && <BranchesTab />}
      </div>
    </div>
  );
}
