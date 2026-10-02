/** POST /api/account/upload?kind=return|review|ticket|chat   form-data file */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { saveAttachment, type AttachmentKind } from '@/lib/uploads/attachments';
import { applyRateLimit } from '@/lib/security/ratelimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const kindRaw = req.nextUrl.searchParams.get('kind') ?? 'ticket';
  if (!['return', 'review', 'ticket', 'chat'].includes(kindRaw)) return jsonError('Bad kind.', 400);
  await applyRateLimit('account.upload', req, { userId: user.id });

  const form = await req.formData();
  const f = form.get('file');
  if (!(f instanceof File)) return jsonError('No file.', 400);
  const r = await saveAttachment({ userId: user.id, kind: kindRaw as AttachmentKind, file: f });
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ url: r.url, mime: r.mime, bytes: r.bytes });
});
