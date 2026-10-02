import { jsonError, jsonOk, withErrorHandling } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth/session';
import { getB2BProfile } from '@/lib/b2b/apply';
import { requireB2BEnabled } from '@/lib/storeConfig/featureGate';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  // Item 8: B2B portal disabled → 403 across the whole namespace.
  await requireB2BEnabled();
  const user = await getCurrentUser();
  if (!user) return jsonError('Please sign in.', 401);
  const profile = await getB2BProfile(user.id);
  return jsonOk({ profile });
});
