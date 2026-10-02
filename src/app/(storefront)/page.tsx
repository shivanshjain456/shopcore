/**
 * Storefront homepage — Item 18 CMS-driven composition.
 *
 *   The visible structure is 100% admin-controlled. Every section
 *   comes from the HomepageSection table (seeded on first boot —
 *   see lib/cms/homepageDefaults.ts) and is rendered by the dispatch
 *   table in <HomepageRenderer>.
 *
 *   Feature-flag fallback:
 *     features.homepageRevampEnabled = false  →  legacy hand-coded
 *     layout in `_legacy-page.tsx`. The flag lets ops back out
 *     instantly if anything goes wrong.
 *
 *   Preview mode (Phase 2):
 *     `/?preview=admin` lets a signed-in ADMIN see EVERY section
 *     (including disabled / scheduled / future-dated rows) so they
 *     can sanity-check unpublished edits before flipping the toggle.
 *     The query param is ignored for anonymous + non-admin users.
 *
 *   First-paint is server-rendered. The composition + lookup-table
 *   reads happen inside one Promise.all in `getHomepageComposition`,
 *   so the page is at most ONE batched DB roundtrip plus per-section
 *   product fetches (which themselves batch where they can).
 *
 *   SEO: `generateMetadata` in the root layout already pulls store
 *   name + tagline from config and points OG at /opengraph-image.
 *   This page contributes ONE <h1> via the hero (existing behaviour),
 *   then well-structured <h2> per section so screen-readers can
 *   navigate landmarks.
 */
import {
  isHomepageRevampEnabled, isHomepageBrandsEnabled,
  isHomepageMetricsEnabled, isHomepageBranchesEnabled,
} from '@/lib/storeConfig/featureGate';
import { getHomepageComposition } from '@/lib/cms/homepage';
import { getCurrentUser } from '@/lib/auth/session';
import HomepageRenderer from '@/components/storefront/homepage/HomepageRenderer';
import LegacyHomePage from './_legacy-page';

export const dynamic = 'force-dynamic';

interface HomePageProps {
  searchParams?: { preview?: string };
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const enabled = await isHomepageRevampEnabled();
  if (!enabled) {
    // Ops kill-switch — preserves the pre-Item-18 page verbatim.
    return <LegacyHomePage />;
  }

  // Preview mode is admin-only — verify the role before passing through.
  const wantsPreview = searchParams?.preview === 'admin';
  const previewing = wantsPreview ? await isAdminViewer() : false;

  const [{ sections }, flags] = await Promise.all([
    getHomepageComposition({ preview: previewing }),
    readHomepageFlags(),
  ]);

  // Empty composition → fall back to the legacy layout so a fresh
  // install (before defaults are seeded by the runner) still shows
  // something useful.
  if (sections.length === 0) {
    return <LegacyHomePage />;
  }

  return (
    <main>
      {previewing && <PreviewBanner />}
      <HomepageRenderer sections={sections} flags={flags} />
    </main>
  );
}

async function isAdminViewer(): Promise<boolean> {
  const u = await getCurrentUser({ requireAdmin: true });
  return Boolean(u && u.role === 'ADMIN');
}

function PreviewBanner() {
  return (
    <div className="bg-amber-100 px-4 py-2 text-center text-xs font-semibold text-amber-900">
      Preview mode — showing every section, including disabled and scheduled rows.
    </div>
  );
}

/** Pull the granular homepage flags once at page-render time. We
 *  intentionally don't add a new client-flag plumbing for this; the
 *  three booleans flow as a prop into the renderer. */
async function readHomepageFlags() {
  const [brands, metrics, branches] = await Promise.all([
    isHomepageBrandsEnabled(),
    isHomepageMetricsEnabled(),
    isHomepageBranchesEnabled(),
  ]);
  return {
    homepageBrandsEnabled:   brands,
    homepageMetricsEnabled:  metrics,
    homepageBranchesEnabled: branches,
  };
}
