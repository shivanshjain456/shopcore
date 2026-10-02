/**
 * GET /support — Item 13.
 *
 * Public self-service support hub. Sections (top → bottom):
 *
 *   1. Hero with placeholder search.
 *   2. Quick-action cards (Track Order / Returns / Contact / My
 *      Tickets) — anonymous users get login-redirect hrefs.
 *   3. FAQ accordion — items assembled SERVER-SIDE so we can branch on
 *      config (e.g. drop the B2B item when features.b2bEnabled is off,
 *      tailor the payment-methods answer to payments.upiEnabled).
 *   4. Support tickets — server fetches the user's recent 5; client
 *      list embeds the inline new-ticket form. Gated by
 *      features.supportTickets — section ABSENT from DOM when off
 *      (spec: NOT hidden with CSS).
 *   5. Live chat card — gated by features.liveChat — same absent-when-off
 *      rule.
 *
 * generateMetadata uses the configured store name — cached via
 * getStoreConfig's 30s window so this is one Prisma read per render.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth/session';
import { getStoreConfig } from '@/lib/storeConfig';
import { prisma } from '@/lib/db/client';
import { log } from '@/lib/log';
import FaqAccordion, { type FaqItem } from '@/components/storefront/FaqAccordion';
import SupportTicketList, { type TicketRow } from '@/components/storefront/SupportTicketList';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await getStoreConfig();
  return {
    title:       `Support | ${cfg.store.name}`,
    description: `Get help with your orders, returns, and account. Browse FAQs or contact our support team.`,
  };
}

/** Build the FAQ item list server-side, branching on config so we can
 *  tailor copy to the store's actual capabilities. The client
 *  component never sees the config — it just renders the items. */
function buildFaqItems(cfg: {
  features: { b2bEnabled: boolean };
  payments: { upiEnabled: boolean };
}): FaqItem[] {
  const items: FaqItem[] = [
    {
      question: 'How do I track my order?',
      answer: (
        <p>
          Once you&apos;re signed in, every order and its current status
          lives at <Link href="/account/orders" className="font-semibold text-brand-700 underline">My orders</Link>.
          You&apos;ll get an email at every status change too.
        </p>
      ),
    },
    {
      question: 'What is your return policy?',
      answer: (
        <p>
          Most items are eligible for return within the policy window from
          the date of delivery. Open a return from your order page and pick
          a reason — we&apos;ll review and respond.
          Full details live on each order&apos;s detail page.
        </p>
      ),
    },
    {
      question: 'How do I verify my payment?',
      answer: (
        <p>
          UPI orders ask for the <strong>UTR number</strong> from your bank
          app right after you scan the QR. Enter the 12-character UTR
          plus an optional receipt screenshot. We verify it against your
          order within a few minutes during business hours.
        </p>
      ),
    },
    {
      question: 'Can I change my delivery address after placing an order?',
      answer: (
        <p>
          Yes — as long as the order hasn&apos;t been packed for dispatch yet.
          Open the order page and use the &ldquo;Edit address&rdquo; option.
          Once the order is in <em>Packed</em> or later, contact us via{' '}
          <Link href="/contact" className="font-semibold text-brand-700 underline">the contact form</Link>{' '}
          so we can coordinate with the courier.
        </p>
      ),
    },
    {
      question: 'How do I cancel an order?',
      answer: (
        <p>
          Open the order from{' '}
          <Link href="/account/orders" className="font-semibold text-brand-700 underline">My orders</Link>{' '}
          and use the &ldquo;Cancel order&rdquo; button. Cancellation is
          allowed within the policy window and only before the order
          reaches the dispatched stage.
        </p>
      ),
    },
    {
      question: 'What payment methods do you accept?',
      answer: (
        <p>
          {cfg.payments.upiEnabled
            ? 'We currently accept UPI payments via QR scan. Pay with any UPI-enabled app (PhonePe, Google Pay, Paytm, BHIM, etc.), capture the UTR shown in your bank app, and paste it on the checkout page to confirm.'
            : 'Payment options are temporarily limited. Please check back shortly.'}
        </p>
      ),
    },
  ];
  if (cfg.features.b2bEnabled) {
    items.push({
      question: 'How do I apply for a B2B account?',
      answer: (
        <p>
          Head to <Link href="/b2b/apply" className="font-semibold text-brand-700 underline">B2B apply</Link>,
          fill in your GSTIN and PAN, and we&apos;ll review the application —
          usually within one business day. Approved accounts get tier
          pricing across the catalogue and a separate B2B dashboard.
        </p>
      ),
    });
  }
  items.push({
    question: 'How do I contact support?',
    answer: (
      <p>
        Use{' '}
        <Link href="/contact" className="font-semibold text-brand-700 underline">our contact form</Link>{' '}
        — we respond within 1–2 business days. Signed-in users can also
        open a support ticket below to track the conversation.
      </p>
    ),
  });
  return items;
}

/** Quick-action card. Anchor href is direction-aware: signed-out users
 *  get a `/login?next=…` URL so they're returned here after auth. */
function QuickAction({
  title, description, href, icon,
}: {
  title: string; description: string; href: string; icon: string;
}): JSX.Element {
  return (
    <Link
      href={href}
      className="tap-target group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-brand-300 hover:bg-brand-50/30"
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-brand-50 text-base"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900 group-hover:text-brand-700">{title}</p>
        <p className="mt-0.5 text-xs text-slate-600">{description}</p>
      </div>
    </Link>
  );
}

export default async function SupportPage(): Promise<JSX.Element> {
  const [cfg, user] = await Promise.all([getStoreConfig(), getCurrentUser()]);
  const ticketsEnabled = cfg.features.supportTickets;
  const liveChatEnabled = cfg.features.liveChat;

  // Fetch the user's 5 most recent tickets server-side when permitted.
  // Spec §3.9 — DON'T block the page render on a fetch failure; log and
  // fall back to an empty list.
  let recentTickets: TicketRow[] = [];
  if (user && ticketsEnabled) {
    try {
      const rows = await prisma.supportTicket.findMany({
        where:   { userId: user.id },
        orderBy: { updatedAt: 'desc' },
        take:    5,
        select:  { id: true, subject: true, status: true, updatedAt: true },
      });
      recentTickets = rows.map((r) => ({
        id:        r.id,
        subject:   r.subject,
        status:    r.status,
        updatedAt: r.updatedAt.toISOString(),
      }));
    } catch (e) {
      log.warn('support.page.ticket_fetch_failed', { userId: user.id, error: (e as Error).message });
    }
  }

  const faqItems = buildFaqItems(cfg);

  // Link targets — anonymous variants pre-load `next=…` to round-trip
  // the user back here after sign-in.
  const trackOrderHref  = user ? '/account/orders'          : '/login?next=%2Faccount%2Forders';
  const returnsHref     = user ? '/account/returns'         : '/login?next=%2Faccount%2Freturns';
  const myTicketsHref   = user ? '#my-tickets'              : '/login?next=%2Fsupport%23my-tickets';
  const liveChatHref    = user ? '/account/chat'            : '/login?next=%2Faccount%2Fchat';

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      {/* ── Hero ───────────────────────────────────────────────── */}
      <header className="text-center sm:py-6">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">How can we help?</h1>
        <p className="mt-2 text-sm text-slate-600">
          Find answers, track your support requests, or get in touch.
        </p>
        {/* TODO: Item 24 — wire up to autocomplete search. For now this
            is a disabled "Coming soon" placeholder; because the page is
            a server component we render plain HTML (no onSubmit) — the
            disabled attribute prevents any submission attempt. */}
        <div
          role="search"
          aria-label="Search help topics"
          className="mx-auto mt-5 flex max-w-xl items-center gap-2"
        >
          <input
            type="search"
            placeholder="Search help topics…"
            disabled
            className="block w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm shadow-sm"
            aria-describedby="search-status"
          />
          <span id="search-status" className="text-xs text-slate-500">Coming soon</span>
        </div>
      </header>

      {/* ── Quick actions ───────────────────────────────────────── */}
      <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QuickAction icon="📦" title="Track my order"
          description="See order status and history."
          href={trackOrderHref} />
        <QuickAction icon="↩"  title="Return & refund"
          description="Open a return or check refund status."
          href={returnsHref} />
        <QuickAction icon="✉"  title="Contact us"
          description="Send us a message and we'll get back to you."
          href="/contact" />
        <QuickAction icon="🎫" title="My tickets"
          description={ticketsEnabled ? 'Track your support tickets.' : 'Ticket system is currently disabled.'}
          href={ticketsEnabled ? myTicketsHref : '/contact'} />
      </section>

      {/* ── FAQ ─────────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="text-xl font-bold text-slate-900">Frequently asked questions</h2>
        <p className="mt-1 text-sm text-slate-600">
          Quick answers to the questions we get most often.
        </p>
        <div className="mt-4">
          <FaqAccordion items={faqItems} />
        </div>
      </section>

      {/* ── Support tickets ─────────────────────────────────────── */}
      {ticketsEnabled && (
        <section id="my-tickets" className="mt-10 scroll-mt-20">
          {user ? (
            <>
              <h2 className="text-xl font-bold text-slate-900">My support tickets</h2>
              <p className="mt-1 text-sm text-slate-600">
                Your latest conversations with our support team.
              </p>
              <div className="mt-4">
                <SupportTicketList initialTickets={recentTickets} />
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <h2 className="text-lg font-bold text-slate-900">Track your support tickets</h2>
              <p className="mt-1 text-sm text-slate-600">
                Sign in to view and manage your support tickets.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Link
                  href="/login?next=%2Fsupport%23my-tickets"
                  className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="tap-target rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Create account
                </Link>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Live chat — only rendered when the flag is on ──────── */}
      {liveChatEnabled && (
        <section className="mt-10">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Chat with us</h2>
              <p className="mt-1 text-sm text-slate-600">
                Available Monday – Saturday, 10 AM – 6 PM IST.
              </p>
            </div>
            <Link
              href={liveChatHref}
              className="tap-target rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Start chat
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}
