/**
 * GET /contact — Item 13.
 *
 * Public-facing contact page. Two-column on desktop (info | form),
 * stacked on mobile. The form is a client component; the surrounding
 * shell is a server component so it can read getStoreConfig() +
 * getCurrentUser() and pre-fill / pin the form values.
 *
 * Inside the (storefront) route group, so it inherits the header /
 * footer / announcement banner / maintenance gate from the storefront
 * layout.
 *
 * Metadata is dynamic via generateMetadata so the page title carries
 * the configured store name. Both metadata + page hit getStoreConfig()
 * — the 30-second in-process cache means this is a single Prisma read
 * per render (Item 8 caching guarantee).
 */
import type { Metadata } from 'next';
import { getCurrentUser } from '@/lib/auth/session';
import { getStoreConfig } from '@/lib/storeConfig';
import { formatPhone } from '@/lib/utils/phone';
import ContactForm from '@/components/storefront/ContactForm';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await getStoreConfig();
  return {
    title:       `Contact Us | ${cfg.store.name}`,
    description: `Get in touch with ${cfg.store.name}. We're here to help with your orders, returns, and account questions.`,
  };
}

export default async function ContactPage(): Promise<JSX.Element> {
  const [cfg, user] = await Promise.all([getStoreConfig(), getCurrentUser()]);
  const s = cfg.store;

  const hasEmail   = s.supportEmail.trim().length > 0;
  const hasPhone   = s.supportPhone.trim().length > 0;
  const hasAddress = s.address.trim().length > 0;
  const hasAnyContact = hasEmail || hasPhone || hasAddress;

  const mapsHref = hasAddress
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}`
    : null;

  const defaultName = user
    ? `${user.firstName} ${user.lastName}`.trim()
    : '';

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <header className="mb-6 sm:mb-10">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">
          {s.name}{s.tagline ? ` · ${s.tagline}` : ''}
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">Contact us</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Have a question about an order, a return, or anything else?
          We&apos;re happy to help — fill in the form or reach out using the details below.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
        {/* ── LEFT — contact info ─────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <h2 className="text-base font-semibold text-slate-900">Get in touch</h2>

            {!hasAnyContact ? (
              <p className="mt-3 text-sm text-slate-500">
                Contact information coming soon.
              </p>
            ) : (
              <dl className="mt-4 space-y-4 text-sm">
                {hasEmail && (
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">Email</dt>
                    <dd className="mt-1">
                      <a
                        href={`mailto:${s.supportEmail}`}
                        className="tap-target font-medium text-brand-700 hover:underline"
                      >
                        {s.supportEmail}
                      </a>
                    </dd>
                  </div>
                )}
                {hasPhone && (
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">Phone</dt>
                    <dd className="mt-1">
                      <a
                        href={`tel:${s.supportPhone}`}
                        className="tap-target font-medium text-brand-700 hover:underline"
                      >
                        {/* Item 9 — display via formatPhone for consistent spacing. */}
                        {formatPhone(s.supportPhone)}
                      </a>
                    </dd>
                  </div>
                )}
                {hasAddress && (
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">Address</dt>
                    <dd className="mt-1 whitespace-pre-line text-slate-700">{s.address}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">Hours</dt>
                  {/* TODO: move to store config (e.g. store.businessHours) once
                      we add a structured-string field for it. For now this is
                      the agreed default per the brief. */}
                  <dd className="mt-1 text-slate-700">Monday – Saturday, 10:00 AM – 6:00 PM IST</dd>
                </div>
              </dl>
            )}
          </div>

          {/* Map placeholder — no API key available, so we render a
              styled card with a "View on Google Maps" link instead of
              an iframe embed. Spec §2.1. */}
          {hasAddress && mapsHref && (
            <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-slate-100 p-5 sm:p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Location</p>
              <p className="mt-2 text-sm text-slate-700">{s.address}</p>
              <a
                href={mapsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="tap-target mt-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline"
              >
                View on Google Maps
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          )}

          {/* TODO: social links — add when store.socialLinks (or similar
              structured config key) lands. Intentionally rendered as an
              empty placeholder per the brief. */}
        </aside>

        {/* ── RIGHT — contact form ────────────────────────────────── */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">Send us a message</h2>
          <p className="mt-1 text-sm text-slate-600">
            We typically respond within 1–2 business days.
          </p>
          <div className="mt-5">
            <ContactForm
              defaultName={defaultName}
              defaultEmail={user?.email ?? ''}
              isAuthenticated={!!user}
            />
          </div>
        </section>
      </div>
    </main>
  );
}
