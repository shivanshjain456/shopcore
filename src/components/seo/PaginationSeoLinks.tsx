/**
 * <PaginationSeoLinks> — Item 12 Phase 2.
 *
 * Server component that renders `<link rel="canonical">` plus optional
 * `<link rel="prev">` / `<link rel="next">` plus `<meta
 * name="robots" content="noindex,follow">` when the SEO helper says
 * the page should be deindexed.
 *
 * React hoists `<link>` and `<meta>` tags out of the body into <head>
 * (React 18+ behaviour preserved by Next.js 14). Rendering this
 * component anywhere in the page tree is equivalent to extending
 * `generateMetadata` — and works for the dynamic, per-request
 * `prev`/`next` URLs that the static Metadata object cannot express.
 */
import type { PaginationSeoResult } from '@/lib/seo/paginationSeo';

export default function PaginationSeoLinks(props: PaginationSeoResult): JSX.Element {
  const { canonical, prevUrl, nextUrl, robotsNoindex } = props;
  return (
    <>
      <link rel="canonical" href={canonical} />
      {prevUrl && <link rel="prev" href={prevUrl} />}
      {nextUrl && <link rel="next" href={nextUrl} />}
      {robotsNoindex && <meta name="robots" content="noindex,follow" />}
    </>
  );
}
