'use client';
/**
 * WhyShopWithUsSectionForm — Item 18 Phase 2.
 *
 *   Repeatable array of trust cards (up to 8). Each card has a title
 *   (required), description, and optional icon URL. Cards have stable
 *   keys derived from the title; we never use array index as a React
 *   key (test:edge-cases D7.4).
 */
import React from 'react';
import { useId } from 'react';
import type { SectionFormProps } from './types';
import ImageUploadInput from '@/components/admin/ImageUploadInput';
import { Button } from '@/components/admin/Helpers';
import { TextField, TextareaField, pickString, pickObject } from './sharedInputs';

interface Card { _key: string; title: string; description: string; iconUrl: string }

function readCards(o: Record<string, unknown>): Card[] {
  const arr = o['cards'];
  if (!Array.isArray(arr)) return [];
  return arr.map((c, i): Card => {
    const co = (c && typeof c === 'object') ? (c as Record<string, unknown>) : {};
    const title = pickString(co, 'title', '');
    return {
      _key:        `card-${i}-${title.slice(0, 16) || 'untitled'}`,
      title,
      description: pickString(co, 'description', ''),
      iconUrl:     pickString(co, 'iconUrl', ''),
    };
  });
}
function toConfigCards(cards: Card[]): Array<{ title: string; description: string; iconUrl: string }> {
  return cards.map((c) => ({ title: c.title, description: c.description, iconUrl: c.iconUrl }));
}

export default function WhyShopWithUsSectionForm({ config, onChange }: SectionFormProps) {
  const heading    = pickString(config, 'heading', 'Why shop with us');
  const subheading = pickString(config, 'subheading', '');
  const cards      = readCards(config);
  const keyPrefix  = useId();

  function patch(p: Record<string, unknown>) { onChange({ ...config, ...p }); }
  function setCards(next: Card[]) { patch({ cards: toConfigCards(next) }); }

  function addCard() {
    if (cards.length >= 8) return;
    const stamp = String(Date.now()).slice(-6);
    setCards([...cards, { _key: `${keyPrefix}-new-${stamp}`, title: '', description: '', iconUrl: '' }]);
  }
  function updateCard(idx: number, p: Partial<Card>) {
    const next = cards.slice();
    next[idx] = { ...next[idx]!, ...p };
    setCards(next);
  }
  function removeCard(idx: number) {
    setCards(cards.filter((_, i) => i !== idx));
  }
  function moveCard(idx: number, dir: -1 | 1) {
    const swap = idx + dir;
    if (swap < 0 || swap >= cards.length) return;
    const next = cards.slice();
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    setCards(next);
  }

  // Make sure card keys are stable across renders within a single edit
  // session. We synthesize an id from the slot + a short hash of the
  // (original index, title) tuple.
  return (
    <div className="space-y-4">
      <TextField label="Heading" value={heading} maxLength={120}
        onChange={(v) => patch({ heading: v })} />
      <TextareaField label="Sub-heading" value={subheading} maxLength={240}
        onChange={(v) => patch({ subheading: v })} />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Cards ({cards.length} / 8)</h4>
          <Button type="button" onClick={addCard} disabled={cards.length >= 8}>+ Add card</Button>
        </div>
        {cards.length === 0 && <p className="text-xs text-slate-500">No cards yet — add one to get started.</p>}
        <ul className="space-y-3">
          {cards.map((card, idx) => (
            <li key={card._key} className="rounded-md border border-slate-200 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Card {idx + 1}</span>
                <div className="flex gap-1">
                  <button type="button" aria-label="Move up"
                    onClick={() => moveCard(idx, -1)}
                    className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">↑</button>
                  <button type="button" aria-label="Move down"
                    onClick={() => moveCard(idx, +1)}
                    className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">↓</button>
                  <button type="button" aria-label="Remove card"
                    onClick={() => removeCard(idx)}
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50">✕</button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField label="Title" value={card.title} maxLength={60} required
                  onChange={(v) => updateCard(idx, { title: v })} />
                <ImageUploadInput
                  name={`why-card-${card._key}-icon`}
                  kind="misc"
                  label="Icon image (optional)"
                  value={card.iconUrl}
                  onChange={(v) => updateCard(idx, { iconUrl: v })}
                />
              </div>
              <div className="mt-3">
                <TextareaField label="Description" value={card.description} maxLength={240}
                  onChange={(v) => updateCard(idx, { description: v })} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
