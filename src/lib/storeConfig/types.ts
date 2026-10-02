/**
 * Derived types — `StoreConfigValues` is built FROM the schema, not
 * defined separately. This guarantees the schema and the type cannot
 * drift apart (spec §3.2).
 *
 * The interesting bit is the dot-key → nested-object transformation:
 *
 *     'features.b2bEnabled'       boolean
 *     'features.wishlistEnabled'  boolean   ──►  { features: { b2bEnabled: boolean; wishlistEnabled: boolean } }
 *     'store.name'                string         { store:    { name: string } }
 *
 * We do this with two TS utility types: `ExtractType` pulls the payload
 * type out of a `ConfigEntry<T>`, and `Nestify` walks the dot-separated
 * keys to build the nested object shape.
 */
import type { CONFIG_SCHEMA, ConfigEntry, ConfigKey } from './schema';

// ── Pull the typed default out of an entry ────────────────────────────────
type ExtractType<E> = E extends ConfigEntry<infer T> ? T : never;

// Flat map of dot-key → value-type (intermediate form).
type FlatConfigValues = {
  [K in ConfigKey]: ExtractType<(typeof CONFIG_SCHEMA)[K]>;
};

// ── Dot-key → nested-object transformation ────────────────────────────────
//
// The implementation walks one path segment at a time:
//   - If the path has no dot, set the leaf type.
//   - Otherwise peel off the head, recurse on the tail.
// Multiple dot-keys sharing a common prefix are merged via intersection.
type Split<S extends string, D extends string> =
  S extends `${infer Head}${D}${infer Tail}` ? [Head, ...Split<Tail, D>] : [S];

type NestifyPath<Path extends readonly string[], V> =
  Path extends readonly [infer Head extends string, ...infer Rest extends string[]]
    ? Rest extends readonly []
      ? { [K in Head]: V }
      : { [K in Head]: NestifyPath<Rest, V> }
    : never;

type UnionToIntersection<U> =
  (U extends unknown ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type Nestify<Flat extends Record<string, unknown>> = UnionToIntersection<{
  [K in keyof Flat & string]: NestifyPath<Split<K, '.'>, Flat[K]>;
}[keyof Flat & string]>;

// ── The public type ──────────────────────────────────────────────────────

/**
 * Full, nested, type-safe view of the entire store config. Returned by
 * `getStoreConfig()`. Reading a value:
 *
 *     const cfg = await getStoreConfig();
 *     if (cfg.features.b2bEnabled) { ... }
 *     if (cfg.maintenance.maintenanceMode) { ... }
 *
 * Adding a new key to `CONFIG_SCHEMA` automatically widens this type —
 * no separate edit needed.
 */
export type StoreConfigValues = Nestify<FlatConfigValues>;

/** Partial flat patch — what the admin PATCH endpoint accepts. */
export type StoreConfigPatch = Partial<FlatConfigValues>;
