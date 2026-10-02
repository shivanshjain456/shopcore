/**
 * POST /api/admin/uploads?kind=<see ADMIN_IMAGE_KINDS>
 *   multipart/form-data: file=<binary>
 *
 *   Admin-only direct-from-computer image upload. The response carries the
 *   re-encoded, hardened public URL that the admin UI then writes into the
 *   relevant model's image field (HeroBanner.imageDesktopUrl,
 *   Promotion.bannerUrl, etc.).
 *
 *   Pipeline:
 *     - Admin auth via requireAdminUser()
 *     - CSRF token via assertCsrf()
 *     - Per-admin rate limit (40 uploads / 10 min)
 *     - Hard MIME allowlist + sharp re-encode (lib/uploads/adminImages.ts)
 *     - Audit log row tagged ADMIN_IMAGE_UPLOAD
 *
 *   Returns: { url, mime, bytes, width, height, maxMb }
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError, audit } from '@/lib/admin/guards';
import { applyRateLimit } from '@/lib/security/ratelimit';
import {
  saveAdminImage, isAdminImageKind, MAX_IMAGE_MB,
} from '@/lib/uploads/adminImages';
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const admin = await requireAdminUser();

  await applyRateLimit('admin.uploads', req, { userId: admin.id });

  const kindRaw = req.nextUrl.searchParams.get('kind') ?? 'misc';
  if (!isAdminImageKind(kindRaw)) {
    return jsonError(
      'Invalid upload kind.',
      400,
    );
  }

  const form = await req.formData();
  const f = form.get('file');
  if (!(f instanceof File)) return jsonError('No file uploaded.', 400);

  const r = await saveAdminImage({ kind: kindRaw, file: f });
  if (!r.ok) return jsonError(r.reason, 400);

  // Audit — we tag the admin who uploaded, the kind, and the produced URL.
  // The original filename is intentionally NOT logged (admins occasionally
  // upload files named e.g. "Confidential-Q3-Plan.psd" while testing).
  await audit({
    actorId: admin.id,
    action: 'ADMIN_IMAGE_UPLOAD',
    entity: 'AdminImage',
    entityId: r.data.url,
    after: {
      url: r.data.url,
      kind: kindRaw,
      mime: r.data.mime,
      bytes: r.data.bytes,
      width: r.data.width,
      height: r.data.height,
    },
  });

  // Item 17 — record every successful upload in the StoreAsset
  //   registry. Powers the asset health dashboard (Phase 2) and the
  //   admin asset browser. Failures here are NOT fatal — the file
  //   itself is already on disk and the admin needs the URL back.
  try {
    await prisma.storeAsset.create({
      data: {
        kind:       kindRaw,
        url:        r.data.url,
        width:      r.data.width,
        height:     r.data.height,
        mimeType:   r.data.mime,
        bytes:      r.data.bytes,
        uploadedBy: admin.id,
      },
    });
    log.info('asset.uploaded', {
      kind: kindRaw, url: r.data.url,
      width: r.data.width, height: r.data.height, bytes: r.data.bytes,
      adminId: admin.id,
    });
  } catch (e) {
    log.warn('asset.registry_insert_failed', {
      kind: kindRaw, url: r.data.url,
      err: (e as Error).message,
    });
  }

  return jsonOk({
    url: r.data.url,
    mime: r.data.mime,
    bytes: r.data.bytes,
    width: r.data.width,
    height: r.data.height,
    maxMb: MAX_IMAGE_MB,
  });
});
