import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonOk, withErrorHandling } from '@/lib/api';
import { assertCsrf } from '@/lib/security/csrf';
import { requireAdminUser, AdminGuardError } from '@/lib/admin/guards';
import { suggestTags } from '@/lib/ai/tagger';

export const dynamic = 'force-dynamic';

const Body = z.object({ text: z.string().trim().min(1).max(20_000) });

export const POST = withErrorHandling(async (req: NextRequest) => {
  assertCsrf();
  await requireAdminUser();
  const { text } = Body.parse(await req.json());
  return jsonOk({ tags: suggestTags(text) });
});
