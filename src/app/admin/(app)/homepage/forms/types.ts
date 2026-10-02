/**
 * Section form contract — Item 18 Phase 2.
 *
 *   Every per-kind config form component conforms to `SectionFormProps`:
 *   it receives the current `config` blob (whatever Zod produced after
 *   parsing the DB row) plus an `onChange` callback. The parent owns
 *   the state; the form is purely controlled.
 *
 *   Each form is responsible for:
 *     1. Decoding the incoming config (defensively — never crash on a
 *        partial/older shape; fall back to per-field defaults).
 *     2. Emitting the next config blob through `onChange` on every
 *        edit so the parent can save / preview in real time.
 *     3. Surfacing the kind's specific UX (text inputs, multi-pickers,
 *        image uploads, etc) — NOT slug / order / scheduling, which
 *        are handled by `<SectionMetaForm>` one level above.
 */
import type { HomepageSectionKind } from '@/lib/cms/homepageSchemas';

export type SectionConfig = Record<string, unknown>;

export interface SectionFormProps {
  /** Current config blob. NEVER `null`/`undefined` — parent passes `{}`
   *  for a brand-new section. */
  config:   SectionConfig;
  /** Emit the full next config blob. The parent merges this into the
   *  saved row on submit. */
  onChange: (next: SectionConfig) => void;
}

/** Map kind → form component. Filled by `sectionFormRegistry.ts`. */
export type SectionFormRegistry = Record<HomepageSectionKind, (props: SectionFormProps) => JSX.Element>;
