/**
 * Receipt uploads — secure local-disk storage with sharp re-encoding.
 *
 * Layout:    data/uploads/receipts/<userId>/<random>.<ext>
 * Access:    /api/uploads/receipts/<userId>/<file>  → only the owner or an admin
 *
 * Re-encoding strategy:
 *  - image/jpeg, image/png, image/webp → sharp normalise → JPEG (cap 2000px)
 *  - application/pdf                   → passed through (size-capped)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { env } from '@/lib/config';

const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_PDF   = new Set(['application/pdf']);
const ALLOWED       = new Set([...ALLOWED_IMAGE, ...ALLOWED_PDF]);

export const MAX_RECEIPT_MB = env.MAX_UPLOAD_MB;

function ensureSafe(filename: string) {
  // strip any path separators a hostile filename might carry
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

export interface SavedReceipt {
  url: string;       // /api/uploads/receipts/<userId>/<file>
  diskPath: string;  // absolute path
  mime: string;
  bytes: number;
}

export async function saveReceiptUpload(params: {
  userId: string;
  file: File;
}): Promise<{ ok: true; data: SavedReceipt } | { ok: false; reason: string }> {
  const { userId, file } = params;
  if (!file || !file.size) return { ok: false, reason: 'No file uploaded.' };
  if (file.size > MAX_RECEIPT_MB * 1024 * 1024) return { ok: false, reason: `File too large (max ${MAX_RECEIPT_MB} MB).` };
  if (!ALLOWED.has(file.type)) return { ok: false, reason: 'Only JPG, PNG, WEBP or PDF receipts are accepted.' };

  const dir = path.resolve(env.UPLOAD_DIR, 'receipts', userId);
  await fs.mkdir(dir, { recursive: true });
  const stamp = Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');

  const buf = Buffer.from(await file.arrayBuffer());
  let outName: string;
  let outMime: string;
  let outBytes: number;

  if (ALLOWED_IMAGE.has(file.type)) {
    // Re-encode: this strips EXIF + any embedded payloads + caps size
    const jpg = await sharp(buf)
      .rotate()                    // honour EXIF orientation
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    outName = `${stamp}.jpg`;
    outMime = 'image/jpeg';
    outBytes = jpg.length;
    await fs.writeFile(path.join(dir, outName), jpg);
  } else {
    // PDF — magic-byte sniff to make sure
    if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
      return { ok: false, reason: 'Uploaded file is not a valid PDF.' };
    }
    outName = `${stamp}.pdf`;
    outMime = 'application/pdf';
    outBytes = buf.length;
    await fs.writeFile(path.join(dir, outName), buf);
  }

  // Public URL routed through our /api/uploads/[...path] guard:
  const url = `/api/uploads/receipts/${ensureSafe(userId)}/${outName}`;
  return { ok: true, data: { url, diskPath: path.join(dir, outName), mime: outMime, bytes: outBytes } };
}
