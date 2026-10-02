import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { getCurrentUser } from '@/lib/auth/session';
import { applyForB2B } from '@/lib/b2b/apply';
import {
  requireB2BEnabled,
  requireB2BRegistrationOpen,
} from '@/lib/storeConfig/featureGate';

export const dynamic = 'force-dynamic';

const Body = z.object({
  companyName: z.string().trim().min(2).max(200),
  gstin:       z.string().trim().min(15).max(15),
  pan:         z.string().trim().min(10).max(10),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  // Item 8: portal must be enabled AND applications open.
  await requireB2BEnabled();
  await requireB2BRegistrationOpen();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const body = Body.parse(await req.json());
  const r = await applyForB2B({ userId: user.id, ...body });
  if (!r.ok) return jsonError(r.reason, 400);
  return jsonOk({ status: r.status });
});
