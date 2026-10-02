/**
 * /admin/homepage — Item 18 Phase 2.
 *
 *   Server component shell. Layout-level admin guard is already
 *   enforced by `src/app/admin/(app)/layout.tsx`; we only render the
 *   client app here.
 */
import HomepageAdminApp from './HomepageAdminApp';

export const dynamic = 'force-dynamic';

export default function AdminHomepagePage() {
  return <HomepageAdminApp />;
}
