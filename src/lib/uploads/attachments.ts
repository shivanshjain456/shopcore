/**
 * Generic attachment uploads (returns, reviews, ticket replies, chat).
 * Same sharp-based hardening as receipts; lives under
 *   data/uploads/attachments/<userId>/<kind>/<random>.<ext>
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { env } from '@/lib/config';

const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_PDF   = new Set(['application/pdf']);
const ALLOWED       = new Set([...ALLOWED_IMAGE, ...ALLOWED_PDF]);

export type AttachmentKind = 'return' | 'review' | 'ticket' | 'chat';

export async function saveAttachment(params: { userId: string; kind: AttachmentKind; file: File }):
  Promise<{ ok: true; url: string; mime: string; bytes: number } | { ok: false; reason: string }> {
  const { userId, kind, file } = params;
  if (!file || !file.size) return { ok: false, reason: 'No file uploaded.' };
  if (file.size > env.MAX_UPLOAD_MB * 1024 * 1024) return { ok: false, reason: `File too large (max ${env.MAX_UPLOAD_MB} MB).` };
  if (!ALLOWED.has(file.type)) return { ok: false, reason: 'Only JPG, PNG, WEBP or PDF allowed.' };

  const dir = path.resolve(env.UPLOAD_DIR, 'attachments', userId, kind);
  await fs.mkdir(dir, { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());
  const stamp = Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');

  let outName: string, outMime: string, outBytes: number;
  if (ALLOWED_IMAGE.has(file.type)) {
    const jpg = await sharp(buf).rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    outName = `${stamp}.jpg`; outMime = 'image/jpeg'; outBytes = jpg.length;
    await fs.writeFile(path.join(dir, outName), jpg);
  } else {
    if (!(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
      return { ok: false, reason: 'Uploaded file is not a valid PDF.' };
    }
    outName = `${stamp}.pdf`; outMime = 'application/pdf'; outBytes = buf.length;
    await fs.writeFile(path.join(dir, outName), buf);
  }
  return { ok: true, url: `/api/uploads/attachments/${userId}/${kind}/${outName}`, mime: outMime, bytes: outBytes };
}
