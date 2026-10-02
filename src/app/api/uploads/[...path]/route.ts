/**
 * GET /api/uploads/<...>  — gated file server for receipts (and future uploads).
 *
 * Access rules:
 *  - /api/uploads/receipts/<userId>/<file>          → only that userId or an admin
 *  - /api/uploads/attachments/<userId>/<kind>/<file>→ only that userId or an admin
 *  - /api/uploads/public-images/<kind>/<file>       → PUBLIC (cache-friendly)
 *                                                      — used by admin-uploaded
 *                                                        hero banners, promotion
 *                                                        artwork, brand logos
 *                                                        (Feature #16)
 *  - any other prefix                               → 403
 *
 * The disk is NEVER exposed directly; nothing under /data/ is served as static.
 */
import fs from 'node:fs/promises';
import { withErrorHandling } from '@/lib/api';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getCurrentUser, getSession } from '@/lib/auth/session';
import { env } from '@/lib/config';
import { isAdminImageKind } from '@/lib/uploads/adminImages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.pdf': 'application/pdf',
};

export const GET = withErrorHandling(async (_: Request, { params }: { params: { path: string[] } }) => {
  const segs = params.path ?? [];

  // ── PUBLIC: admin-uploaded images for hero banners / promotions / logos ─
  //
  // Shape: /api/uploads/public-images/<kind>/<file>
  // Authorization: none — these are public marketing assets.
  // Cache: 1 year immutable (filenames are random; admins replace by
  //        uploading a NEW file + updating the model).
  if (segs[0] === 'public-images' && segs.length >= 3) {
    const kind = segs[1];
    if (!isAdminImageKind(kind)) {
      return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
    }
    const root = path.resolve(env.UPLOAD_DIR);
    const target = path.resolve(root, segs[0], ...segs.slice(1));
    // Path-traversal guard: refuse anything that resolves outside UPLOAD_DIR.
    if (!target.startsWith(root + path.sep)) {
      return NextResponse.json({ ok: false, error: 'Bad path.' }, { status: 400 });
    }
    try {
      const buf = await fs.readFile(target);
      const ext = path.extname(target).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      return new NextResponse(buf, {
        headers: {
          'Content-Type': mime,
          // Filenames are random + immutable; safe to cache aggressively.
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
    }
  }

  // ── PRIVATE: receipts / attachments — owner-or-admin only ──────────────
  let userIdFromUrl: string;
  let rest: string[];
  if (segs[0] === 'receipts' && segs.length >= 3) {
    userIdFromUrl = segs[1]; rest = segs.slice(2);
  } else if (segs[0] === 'attachments' && segs.length >= 4) {
    userIdFromUrl = segs[1]; rest = segs.slice(2); // kind + filename
  } else {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  // Auth
  const session = await getSession();
  const adminSession = await getSession({ requireAdmin: true });
  if (!session && !adminSession) {
    return NextResponse.json({ ok: false, error: 'Not authenticated.' }, { status: 401 });
  }

  // Only the owner or an admin may read
  const me = await getCurrentUser();
  const meAdmin = await getCurrentUser({ requireAdmin: true });
  if (!meAdmin && me?.id !== userIdFromUrl) {
    return NextResponse.json({ ok: false, error: 'Forbidden.' }, { status: 403 });
  }

  // Resolve safe path inside upload dir
  const root = path.resolve(env.UPLOAD_DIR);
  const target = path.resolve(root, segs[0], userIdFromUrl, ...rest);
  if (!target.startsWith(root + path.sep)) {
    return NextResponse.json({ ok: false, error: 'Bad path.' }, { status: 400 });
  }
  try {
    const buf = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return new NextResponse(buf, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `inline; filename="${path.basename(target)}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  }
});
