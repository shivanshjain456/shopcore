/**
 * POST /api/checkout/upload-receipt
 * multipart/form-data:  file=<binary>
 *
 * Returns { url } that the client then submits with the order.
 * Files are re-encoded and quarantined under data/uploads/receipts/<userId>/.
 */
import type { NextRequest } from 'next/server';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { saveReceiptUpload, MAX_RECEIPT_MB } from '@/lib/uploads/receipts';
import { applyRateLimit } from '@/lib/security/ratelimit';
import { clientIp } from '@/lib/security/ip';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);

  await applyRateLimit('checkout.upload_receipt', req, { userId: user.id });

  const form = await req.formData();
  const f = form.get('file');
  if (!(f instanceof File)) return jsonError('No file uploaded.', 400);

  const r = await saveReceiptUpload({ userId: user.id, file: f });
  if (!r.ok) return jsonError(r.reason, 400);

  return jsonOk({ url: r.data.url, mime: r.data.mime, bytes: r.data.bytes, maxMb: MAX_RECEIPT_MB });
});
