/** GET /api/auth/csrf  → ensures cookie + returns token (so client can echo in header). */
import { jsonOk, withErrorHandling } from '@/lib/api';
import { ensureCsrfCookie } from '@/lib/security/csrf';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async () => {
  const token = ensureCsrfCookie();
  return jsonOk({ csrfToken: token });
});
