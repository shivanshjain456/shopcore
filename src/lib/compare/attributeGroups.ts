/**
 * Compare attribute groups — Item 14.
 *
 * Declarative map of category-slug → attribute groups → attribute keys.
 * Drives the row-group sections on the /compare page. Adding a new
 * key for a category is a one-line edit here — no code changes needed
 * elsewhere.
 *
 * Naming convention:
 *
 *   - GROUP IDs are short, lowercase, semantic (`display`, `performance`).
 *   - ATTRIBUTE keys are snake_case to match the `Product.attributes`
 *     JSON shape (e.g. `display_size`, `display_resolution`).
 *   - LABELS are human-readable, sentence-case (the on-screen text).
 *
 * Every product gets the universal groups (`overview`, `pricing`,
 * `availability`, `actions`) regardless of category. Category-specific
 * groups are appended via `CATEGORY_GROUPS`.
 *
 * Pure module — no Prisma / Next imports. Safe to import from both
 * server and client code.
 */

export interface AttributeDescriptor {
  /** Key in `Product.attributes` JSON. */
  key:   string;
  /** Human label shown to the user. */
  label: string;
  /** Optional unit suffix appended to numeric values
   *  (e.g. "GHz", "mm", "g"). */
  unit?: string;
}

export interface AttributeGroup {
  /** Stable group id (used as React key + URL hash, if we ever add deep
   *  links to a specific group). */
  id:         string;
  /** Label shown in the left-axis cell of the compare table. */
  label:      string;
  /** Render variant. `attributes` lists rows for the unioned attributes
   *  map; `intrinsic` lists rows that read directly from columns on the
   *  Product row itself (price, brand, stock, etc.). */
  kind:       'attributes' | 'intrinsic';
  /** For `kind: 'attributes'`, the keys to display in order. The compare
   *  table also surfaces any extra keys present in `Product.attributes`
   *  that aren't listed here, under a synthetic "Other" group. */
  attributes: AttributeDescriptor[];
}

// ── Universal groups — always present, all categories ────────────────────

export const UNIVERSAL_GROUPS: AttributeGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    kind: 'intrinsic',
    attributes: [
      { key: 'brand',            label: 'Brand' },
      { key: 'category',         label: 'Category' },
      { key: 'sku',              label: 'SKU' },
    ],
  },
  {
    id: 'pricing',
    label: 'Pricing',
    kind: 'intrinsic',
    attributes: [
      { key: 'mrp',              label: 'MRP' },
      { key: 'price',            label: 'Selling price' },
      { key: 'discount_percent', label: 'Discount %' },
      { key: 'gst_rate',         label: 'GST rate' },
      { key: 'hsn_code',         label: 'HSN code' },
    ],
  },
  {
    id: 'ratings',
    label: 'Ratings & Reviews',
    kind: 'intrinsic',
    attributes: [
      { key: 'avg_rating',       label: 'Average rating' },
      { key: 'review_count',     label: 'Reviews' },
    ],
  },
  {
    id: 'availability',
    label: 'Availability',
    kind: 'intrinsic',
    attributes: [
      { key: 'stock_status',     label: 'Stock' },
    ],
  },
];

// ── Category-specific spec groups ────────────────────────────────────────
//
// Keys here must match the `Product.attributes` JSON keys the admin
// (or seed) sets. Anything in the JSON that isn't covered by any group
// falls into a synthetic "Other specifications" group at render time.

export const CATEGORY_GROUPS: Record<string, AttributeGroup[]> = {
  // Laptops / desktops (electronics with full spec sheets).
  laptops: [
    {
      id: 'display', label: 'Display', kind: 'attributes',
      attributes: [
        { key: 'display_size',         label: 'Screen size',    unit: 'in' },
        { key: 'display_resolution',   label: 'Resolution' },
        { key: 'display_panel',        label: 'Panel type' },
        { key: 'display_refresh_rate', label: 'Refresh rate',   unit: 'Hz' },
      ],
    },
    {
      id: 'performance', label: 'Performance', kind: 'attributes',
      attributes: [
        { key: 'processor',            label: 'Processor' },
        { key: 'ram',                  label: 'RAM' },
        { key: 'storage',              label: 'Storage' },
        { key: 'graphics',             label: 'Graphics' },
      ],
    },
    {
      id: 'connectivity', label: 'Connectivity', kind: 'attributes',
      attributes: [
        { key: 'wifi',                 label: 'Wi-Fi' },
        { key: 'bluetooth',            label: 'Bluetooth' },
        { key: 'ports',                label: 'Ports' },
      ],
    },
    {
      id: 'physical', label: 'Physical', kind: 'attributes',
      attributes: [
        { key: 'weight',               label: 'Weight' },
        { key: 'dimensions',           label: 'Dimensions' },
        { key: 'color',                label: 'Colour' },
        { key: 'battery_life',         label: 'Battery life' },
        { key: 'operating_system',     label: 'Operating system' },
      ],
    },
  ],

  // Processors / CPUs — modelled on the reference image.
  processors: [
    {
      id: 'physical_properties', label: 'Physical properties', kind: 'attributes',
      attributes: [
        { key: 'socket',               label: 'Socket' },
        { key: 'process_size',         label: 'Process size' },
        { key: 'transistors',          label: 'Transistors' },
        { key: 'die_size',             label: 'Die size' },
        { key: 'package',              label: 'Package' },
      ],
    },
    {
      id: 'performance', label: 'Performance', kind: 'attributes',
      attributes: [
        { key: 'frequency',            label: 'Frequency' },
        { key: 'turbo_clock',          label: 'Turbo clock' },
        { key: 'base_clock',           label: 'Base clock' },
        { key: 'multiplier',           label: 'Multiplier' },
        { key: 'multiplier_unlocked',  label: 'Multiplier unlocked' },
        { key: 'tdp',                  label: 'TDP' },
      ],
    },
    {
      id: 'architecture', label: 'Architecture', kind: 'attributes',
      attributes: [
        { key: 'codename',             label: 'Codename' },
        { key: 'generation',           label: 'Generation' },
        { key: 'part_number',          label: 'Part #' },
        { key: 'memory_support',       label: 'Memory support' },
        { key: 'ecc_memory',           label: 'ECC memory' },
        { key: 'pci_express',          label: 'PCI-Express' },
      ],
    },
    {
      id: 'cores', label: 'Cores & cache', kind: 'attributes',
      attributes: [
        { key: 'cores',                label: 'Cores' },
        { key: 'threads',              label: 'Threads' },
        { key: 'integrated_graphics',  label: 'Integrated graphics' },
        { key: 'cache_l1',             label: 'L1 cache' },
        { key: 'cache_l2',             label: 'L2 cache' },
        { key: 'cache_l3',             label: 'L3 cache' },
      ],
    },
  ],

  // Accessories (peripherals, cables, mounts).
  accessories: [
    {
      id: 'compatibility', label: 'Compatibility', kind: 'attributes',
      attributes: [
        { key: 'compatible_with',      label: 'Compatible with' },
        { key: 'interface',            label: 'Interface' },
      ],
    },
    {
      id: 'physical', label: 'Physical', kind: 'attributes',
      attributes: [
        { key: 'weight',               label: 'Weight' },
        { key: 'dimensions',           label: 'Dimensions' },
        { key: 'color',                label: 'Colour' },
        { key: 'material',             label: 'Material' },
      ],
    },
  ],
};

/**
 * Return the full group list for a product category. Always prefixes
 * the universal groups; appends category-specific groups when the slug
 * is known. Unknown slugs return only the universal groups (the
 * "Other specifications" synthetic group at render time handles any
 * extra keys in `Product.attributes`).
 */
export function getAttributeGroupsForCategory(categorySlug: string | null | undefined): AttributeGroup[] {
  const universal = UNIVERSAL_GROUPS;
  if (!categorySlug) return universal;
  const specific = CATEGORY_GROUPS[categorySlug.toLowerCase()] ?? [];
  return [...universal, ...specific];
}

/**
 * When multiple compared products span DIFFERENT categories, return
 * the union of their groups (de-duplicated by id). The universal
 * groups always appear first; category-specific groups appear in the
 * order their first-seen category dictates.
 */
export function getAttributeGroupsForCategories(categorySlugs: Array<string | null | undefined>): AttributeGroup[] {
  const seen = new Set<string>();
  const out: AttributeGroup[] = [];
  for (const g of UNIVERSAL_GROUPS) { seen.add(g.id); out.push(g); }
  for (const slug of categorySlugs) {
    const specific = slug ? (CATEGORY_GROUPS[slug.toLowerCase()] ?? []) : [];
    for (const g of specific) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push(g);
    }
  }
  return out;
}
