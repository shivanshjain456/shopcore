/**
 * ProductGallery — Item 19 (foundation) + Item 20 (interaction switcher).
 *
 *   Server-rendered entry point. Two render branches, picked from
 *   admin store-config:
 *
 *     • interactionSettings.interactionsEnabled === false
 *       → STATIC mode (Item 19 markup verbatim — no client JS,
 *         no swipe, no zoom, no fullscreen). The thumb rail still
 *         renders so customers see every photo; they just can't
 *         click them to swap the main image.
 *
 *     • interactionSettings.interactionsEnabled === true
 *       → INTERACTIVE mode — delegates to <InteractiveProductGallery>,
 *         a client island that adds click-to-swap thumbnails,
 *         prev/next buttons, keyboard navigation (Arrow / Home / End),
 *         touch swipe, hover/tap zoom, and a focus-trapped fullscreen
 *         lightbox. Every interaction is admin-configurable via
 *         `products.gallery*` keys in store config.
 *
 *   The static branch retains the original stable `data-*` hooks so
 *   any external test / scraper / hand-off from Item 19 keeps working.
 */
import type { ProductImageRow, GalleryInteractionSettings } from '@/lib/cms/productGallery';
import InteractiveProductGallery from './InteractiveProductGallery';

interface GalleryProps {
  productName: string;
  images:      ProductImageRow[];
  /** When false, only the primary image renders (no thumb rail). Driven
   *  by `products.galleryEnabled` store config. */
  galleryEnabled: boolean;
  /** When true, secondary images use `loading="lazy"`. Driven by
   *  `products.galleryLazyLoadEnabled` store config. */
  lazyLoadEnabled: boolean;
  /** Item 20 — interaction-layer settings. Optional so existing
   *  callers stay compatible; defaults to the Item-19 static behaviour
   *  (no interactions). */
  interactionSettings?: GalleryInteractionSettings;
}

const DEFAULT_INTERACTION_SETTINGS: GalleryInteractionSettings = {
  interactionsEnabled: false,
  zoomEnabled:         false,
  fullscreenEnabled:   false,
  loopEnabled:         false,
  transitionMs:        0,
  thumbnailPosition:   'bottom',
};

export default function ProductGallery({
  productName, images, galleryEnabled, lazyLoadEnabled,
  interactionSettings = DEFAULT_INTERACTION_SETTINGS,
}: GalleryProps) {
  // Item 20 — interactive branch.
  if (interactionSettings.interactionsEnabled && galleryEnabled && images.length > 0) {
    return (
      <InteractiveProductGallery
        productName={productName}
        images={images}
        lazyLoadEnabled={lazyLoadEnabled}
        settings={interactionSettings}
      />
    );
  }
  // Item 19 — static branch (preserved unchanged below).
  return staticGallery({ productName, images, galleryEnabled, lazyLoadEnabled });
}

function staticGallery({
  productName, images, galleryEnabled, lazyLoadEnabled,
}: {
  productName: string;
  images:      ProductImageRow[];
  galleryEnabled:  boolean;
  lazyLoadEnabled: boolean;
}) {
  // ── Empty state ────────────────────────────────────────────────────
  if (images.length === 0) {
    return (
      <div
        className="space-y-3"
        data-testid="product-gallery"
        data-product-image-count="0"
      >
        <div className="grid aspect-square w-full place-items-center rounded-xl border border-slate-200 bg-slate-50 text-slate-400">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-wider">No image</p>
            <p className="mt-1 text-[11px]">{productName}</p>
          </div>
        </div>
      </div>
    );
  }

  // Primary is enforced by the service layer (`registerImage`,
  // `setPrimary`, `ensurePrimary`). Defensive fallback: pick the first
  // active image if for any reason no row is flagged primary.
  const primary = images.find((i) => i.isPrimary) ?? images[0]!;
  const thumbs  = images;
  // The lazy flag applies to NON-primary thumbnails. The primary image
  // is always eager because it's the LCP candidate (Phase-4 perf rule).
  const secondaryLoading: 'eager' | 'lazy' = lazyLoadEnabled ? 'lazy' : 'eager';

  return (
    <section
      className="space-y-3"
      aria-label={`${productName} — image gallery`}
      data-testid="product-gallery"
      data-product-image-count={String(images.length)}
    >
      {/* ── Main image ────────────────────────────────────────────── */}
      <figure
        className="overflow-hidden rounded-xl border border-slate-200 bg-white"
        data-product-image-id={primary.id}
        data-product-image-primary="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={primary.url}
          alt={primary.alt ?? productName}
          className="aspect-square w-full object-contain sm:aspect-[3/2]"
          loading="eager"
          decoding="async"
          // `fetchpriority` is a real HTML attribute (browsers honour it
          // for the LCP element) but React's typings haven't caught up;
          // routing through a Record<string, string> keeps the prop on
          // the DOM without a `@ts-ignore`.
          {...({ fetchpriority: 'high' } as Record<string, string>)}
        />
        <figcaption className="sr-only">
          {primary.alt ?? `Primary image of ${productName}`}
        </figcaption>
      </figure>

      {/* ── Thumb rail ────────────────────────────────────────────────
          Hidden entirely when the admin turns the gallery off via
          store config, OR when there's only one image so the rail
          would be pointless. */}
      {galleryEnabled && thumbs.length > 1 && (
        <ul
          role="list"
          aria-label={`All images of ${productName}`}
          className="grid grid-cols-4 gap-2 sm:grid-cols-5 lg:grid-cols-6"
          data-testid="product-gallery-thumbs"
        >
          {thumbs.map((image) => (
            <li
              key={image.id}
              data-product-image-id={image.id}
              data-product-image-primary={String(image.isPrimary)}
            >
              <figure
                className={
                  'overflow-hidden rounded-md border bg-white ' +
                  (image.isPrimary
                    ? 'border-brand-500 ring-2 ring-brand-200'
                    : 'border-slate-200')
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt={image.alt ?? productName}
                  className="aspect-square w-full object-cover"
                  loading={image.isPrimary ? 'eager' : secondaryLoading}
                  decoding="async"
                />
                <figcaption className="sr-only">
                  {image.alt ?? `Image of ${productName}`}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
