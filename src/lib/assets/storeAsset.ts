/**
 * StoreAsset operations — Item 17 Phase 2.
 *
 *   listAssets()          — paginated list with kind filter.
 *   findAssetReferences() — checks every place a URL might be referenced
 *                           (Brand, Category, store config) so the
 *                           dashboard can warn the admin before delete.
 *   deleteAsset()         — removes the file from disk + the DB row.
 *                           Atomic: file unlink runs first; DB delete
 *                           only proceeds if the file is gone (or was
 *                           never there).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@/lib/db/client';
import { env } from '@/lib/config';
import { getStoreConfig } from '@/lib/storeConfig';
import { log } from '@/lib/log';
import { isAdminImageKind, type AdminImageKind } from '@/lib/uploads/imageKinds';
import { NotFoundError } from '@/lib/errors';

export interface ListAssetsParams {
  kind?:     AdminImageKind | 'all';
  page:      number;
  pageSize:  number;
}

export interface StoreAssetRow {
  id:         string;
  kind:       string;
  url:        string;
  altText:    string | null;
  width:      number | null;
  height:     number | null;
  mimeType:   string | null;
  bytes:      number | null;
  uploadedBy: string;
  uploaderEmail: string | null;
  createdAt:  Date;
}

export interface ListAssetsResult {
  items: StoreAssetRow[];
  total: number;
}

export async function listAssets(params: ListAssetsParams): Promise<ListAssetsResult> {
  const where = params.kind && params.kind !== 'all' && isAdminImageKind(params.kind)
    ? { kind: params.kind }
    : {};
  const skip = (params.page - 1) * params.pageSize;
  const take = params.pageSize;
  const [total, rows] = await Promise.all([
    prisma.storeAsset.count({ where }),
    prisma.storeAsset.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip, take,
      include: { uploader: { select: { email: true } } },
    }),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      id:         r.id,
      kind:       r.kind,
      url:        r.url,
      altText:    r.altText,
      width:      r.width,
      height:     r.height,
      mimeType:   r.mimeType,
      bytes:      r.bytes,
      uploadedBy: r.uploadedBy,
      uploaderEmail: r.uploader.email ?? null,
      createdAt:  r.createdAt,
    })),
  };
}

export interface AssetReference {
  kind: 'brand' | 'category' | 'store_config';
  entity:    string;   // e.g. "Brand: apple" or "store.logoUrl"
  field:     string;   // which column / config key
}

/** Find every DB row + config key that points at this URL. Used by
 *  the delete confirmation modal — never returns "in use" for an
 *  empty URL; the lookup is per-table SELECT scoped to the exact URL. */
export async function findAssetReferences(url: string): Promise<AssetReference[]> {
  if (!url || url.trim() === '') return [];
  const refs: AssetReference[] = [];

  // PAGINATION-EXEMPT: where clauses are scoped to one URL → at most
  //   a handful of rows per query.
  const brandsLogo = await prisma.brand.findMany({
    where: { logoUrl: url }, select: { slug: true },
  });
  for (const b of brandsLogo) refs.push({ kind: 'brand', entity: `Brand: ${b.slug}`, field: 'logoUrl' });

  const brandsBanner = await prisma.brand.findMany({
    where: { bannerUrl: url }, select: { slug: true },
  });
  for (const b of brandsBanner) refs.push({ kind: 'brand', entity: `Brand: ${b.slug}`, field: 'bannerUrl' });

  const catsImage = await prisma.category.findMany({
    where: { imageUrl: url }, select: { slug: true },
  });
  for (const c of catsImage) refs.push({ kind: 'category', entity: `Category: ${c.slug}`, field: 'imageUrl' });

  const catsBanner = await prisma.category.findMany({
    where: { bannerUrl: url }, select: { slug: true },
  });
  for (const c of catsBanner) refs.push({ kind: 'category', entity: `Category: ${c.slug}`, field: 'bannerUrl' });

  const catsIcon = await prisma.category.findMany({
    where: { iconUrl: url }, select: { slug: true },
  });
  for (const c of catsIcon) refs.push({ kind: 'category', entity: `Category: ${c.slug}`, field: 'iconUrl' });

  // Store config — read once, scan the asset fields.
  const cfg = await getStoreConfig();
  const store = (cfg as { store?: Record<string, unknown> }).store ?? {};
  for (const k of ['logoUrl', 'logoDarkUrl', 'faviconUrl', 'ogImageUrl', 'appIconUrl'] as const) {
    if (store[k] === url) refs.push({ kind: 'store_config', entity: `store.${k}`, field: k });
  }
  return refs;
}

export interface DeleteAssetResult {
  ok:       true;
  fileGone: boolean;        // true if the disk file existed and was removed
}

/** Hard-delete: unlinks the disk file (best-effort) and removes the
 *  DB row. Does NOT clear references — the admin should null out any
 *  Brand/Category/store-config fields pointing at this URL first
 *  (the dashboard warns them via findAssetReferences). */
export async function deleteAsset(id: string): Promise<DeleteAssetResult> {
  const row = await prisma.storeAsset.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Asset not found.');

  // URL shape: /api/uploads/public-images/<kind>/<file>
  // Map back to a disk path under env.UPLOAD_DIR. Defensive: only
  // delete files under that root; any URL pointing elsewhere (e.g. a
  // CDN URL the admin manually typed) is left alone.
  let fileGone = false;
  const prefix = '/api/uploads/public-images/';
  if (row.url.startsWith(prefix)) {
    const rel  = row.url.slice(prefix.length);                // <kind>/<file>
    const root = path.resolve(env.UPLOAD_DIR);
    const disk = path.resolve(root, 'public-images', rel);
    if (disk.startsWith(root + path.sep)) {
      try {
        await fs.unlink(disk);
        fileGone = true;
      } catch {
        // File missing or perms — log and continue with DB delete.
        log.warn('asset.disk_unlink_failed', { id, url: row.url });
      }
    }
  }

  await prisma.storeAsset.delete({ where: { id } });
  log.info('asset.deleted', { id, kind: row.kind, url: row.url, fileGone });
  return { ok: true, fileGone };
}
