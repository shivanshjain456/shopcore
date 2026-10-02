/**
 * Validation utilities — atomic-validate-then-write for the PATCH handler
 * (spec §3.3). Pure functions; no DB access.
 */
import { CONFIG_SCHEMA, isConfigKey, type ConfigKey } from './schema';

export interface ValidatedPatchOk {
  ok:      true;
  /** The validated patch with each value coerced to its schema-produced
   *  shape (Zod may apply defaults / transforms). */
  values:  Partial<Record<ConfigKey, unknown>>;
}
export interface ValidatedPatchErr {
  ok:      false;
  errors:  Record<string, string>;
}
export type ValidatedPatch = ValidatedPatchOk | ValidatedPatchErr;

/**
 * Validate every key/value in `patch`. Returns a structured result —
 * NEVER throws. The handler decides how to surface errors (typically as
 * `400 CONFIG_VALIDATION_ERROR` with the error map in `issues`).
 *
 * Atomic: if ANY value fails, none should be written. The caller is
 * responsible for honouring that — this function just reports.
 */
export function validateConfigPatch(patch: Record<string, unknown>): ValidatedPatch {
  const errors: Record<string, string> = {};
  const values: Partial<Record<ConfigKey, unknown>> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!isConfigKey(key)) {
      errors[key] = 'Unknown config key.';
      continue;
    }
    const entry = CONFIG_SCHEMA[key];
    const result = entry.validation.safeParse(value);
    if (!result.success) {
      // Take the first issue — the admin UI shows it next to the field.
      errors[key] = result.error.issues[0]?.message ?? 'Invalid value.';
      continue;
    }
    values[key] = result.data;
  }

  // ── Cross-field rules ──────────────────────────────────────────────
  // payments.maxOrderPaise must be >= payments.minOrderPaise.
  const min = (values['payments.minOrderPaise'] ?? null) as number | null;
  const max = (values['payments.maxOrderPaise'] ?? null) as number | null;
  if (min !== null && max !== null && max < min) {
    errors['payments.maxOrderPaise'] = 'Must be ≥ payments.minOrderPaise.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, values };
}
