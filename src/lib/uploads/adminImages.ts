/**
 * Admin-uploaded public images — Feature #16, extended by Item 17.
 *
 *   Pipeline:
 *     1. Validate MIME against the allowlist (JPG / PNG / WEBP / HEIC / AVIF).
 *     2. Enforce a per-kind file-size cap (from `IMAGE_KIND_SPECS`).
 *     3. Re-encode via sharp:
 *          - rotate to honour EXIF orientation,
 *          - resize `fit: 'inside'` to the kind's max edge,
 *          - emit JPG (for photographic kinds: hero, category, og_image)
 *            OR PNG (for transparent kinds: logo, brand, favicon,
 *            app_icon, category_icon).
 *     4. Strip EXIF + arbitrary metadata as a side-effect of re-encoding.
 *     5. Filename: `<base36-time>_<6-byte-hex>.<ext>` — random so the
 *        public prefix doesn't leak admin uploads.
 *
 *   Returned URL is always app-relative
 *   (`/api/uploads/public-images/<kind>/<file>`). The CDN / Next.js
 *   `<Image>` can rewrite it without `next.config.mjs` changes
 *   because it's same-origin.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { env } from '@/lib/config';
import {
  ADMIN_IMAGE_KINDS, IMAGE_KIND_SPECS, isAdminImageKind,
  getImageKindSpec,
  type AdminImageKind, type ImageKindSpec,
} from './imageKinds';

export { ADMIN_IMAGE_KINDS, IMAGE_KIND_SPECS, isAdminImageKind, getImageKindSpec };
export type { AdminImageKind, ImageKindSpec };

const ALLOWED_IMAGE = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'image/avif',
]);

/** Back-compat constant — old callers (tests, legacy admin code) may
 *  still read `MAX_IMAGE_MB` as a global. The per-kind cap from
 *  `IMAGE_KIND_SPECS[kind].maxMb` is what `saveAdminImage` actually
 *  enforces. */
export const MAX_IMAGE_MB = env.MAX_UPLOAD_MB;

export interface SavedAdminImage {
  url:      string; // /api/uploads/public-images/<kind>/<file>
  diskPath: string; // absolute path on disk
  mime:     string; // image/jpeg | image/png
  bytes:    number;
  width:    number;
  height:   number;
}

export async function saveAdminImage(params: {
  kind: AdminImageKind;
  file: File;
}): Promise<{ ok: true; data: SavedAdminImage } | { ok: false; reason: string }> {
  const { kind, file } = params;
  if (!file || !file.size) return { ok: false, reason: 'No file uploaded.' };

  const spec = getImageKindSpec(kind);
  // Per-kind cap takes precedence; the env-wide MAX_UPLOAD_MB is the
  // absolute ceiling — neither side may exceed the other.
  const capMb = Math.min(spec.maxMb, env.MAX_UPLOAD_MB);
  if (file.size > capMb * 1024 * 1024) {
    return { ok: false, reason: `File too large (max ${capMb} MB for ${kind} uploads).` };
  }
  if (!ALLOWED_IMAGE.has(file.type)) {
    return {
      ok: false,
      reason: 'Only image files are accepted (JPG / PNG / WEBP / HEIC / AVIF).',
    };
  }

  const dir = path.resolve(env.UPLOAD_DIR, 'public-images', kind);
  await fs.mkdir(dir, { recursive: true });

  const buf = Buffer.from(await file.arrayBuffer());
  let outBuf: Buffer;
  let meta: { width?: number; height?: number };
  let outMime: 'image/jpeg' | 'image/png';
  let outExt:  'jpg' | 'png';
  try {
    const base = sharp(buf)
      .rotate()
      .resize({ width: spec.maxPx, height: spec.maxPx, fit: 'inside', withoutEnlargement: true });
    if (spec.outputFormat === 'png') {
      // Preserve alpha for logos / icons. PNG quality 1-100 controls
      // compression effort (1 = fastest / largest, 100 = best).
      outBuf  = await base.png({ quality: spec.quality, compressionLevel: 9 }).toBuffer();
      outMime = 'image/png';
      outExt  = 'png';
    } else {
      outBuf  = await base.jpeg({ quality: spec.quality, mozjpeg: true }).toBuffer();
      outMime = 'image/jpeg';
      outExt  = 'jpg';
    }
    meta = await sharp(outBuf).metadata();
  } catch {
    return { ok: false, reason: 'Could not decode the image. Please try a different file.' };
  }

  const stamp = Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
  const outName = `${stamp}.${outExt}`;
  const disk = path.join(dir, outName);
  await fs.writeFile(disk, outBuf);

  return {
    ok: true,
    data: {
      url: `/api/uploads/public-images/${kind}/${outName}`,
      diskPath: disk,
      mime: outMime,
      bytes: outBuf.length,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    },
  };
}
