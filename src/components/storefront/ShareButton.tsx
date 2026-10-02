'use client';
/**
 * ShareButton + ShareDialog — Feature #35.
 *
 *   A single button that, when clicked:
 *     - On devices with `navigator.share` (most mobile + recent macOS Safari),
 *       directly opens the OS share sheet for the most native experience.
 *     - On devices WITHOUT `navigator.share`, opens our in-app fallback
 *       dialog with: Copy Link · WhatsApp · Telegram · Facebook · X · Email.
 *
 *   The fallback dialog is always available as a manual "More options"
 *   route — even on devices that DO have native share — by clicking the
 *   small caret next to the button. This gives keyboard / power users a
 *   deterministic path that doesn't depend on OS UI.
 *
 *   Accessibility:
 *     - The button + caret + every share-channel button is keyboard-
 *       activatable and has an aria-label.
 *     - The modal traps focus (the project's AppDialog uses a native
 *       <dialog> via the AppDialog component, but our share dialog uses
 *       a custom popover so it can host icon buttons inline). We
 *       implement Escape-to-close + focus trap + click-outside-to-close
 *       in this component.
 *     - The copy-link success message is announced via a `role="status"`
 *       live region.
 *
 *   This file is intentionally self-contained — it does NOT depend on
 *   the global DialogProvider, because the share dialog has a richer
 *   layout (a grid of icon buttons) than the alert/confirm/prompt
 *   primitives the global provider supports.
 */
import React, {
  KeyboardEvent, MouseEvent, useCallback, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import {
  buildProductUrl, buildProductUrlForChannel, buildShareLinks,
  channelLabel, type ShareChannel,
} from '@/lib/share/productUrl';

export interface ShareButtonProps {
  /** Canonical product slug. */
  slug: string;
  /** Product display name (used in the modal heading + share payload title). */
  productName: string;
  /** Short description used as fallback when a product has no shortDesc. */
  description?: string;
  /** Optional thumbnail URL for the modal preview. */
  imageUrl?: string | null;
  /** Optional price line for the modal preview. */
  priceText?: string;
  /** Override the absolute base URL — defaults to window.location.origin
   *  on the client (falls back to APP_URL on the server). */
  baseUrl?: string;
  /** Test hook. */
  'data-testid'?: string;
}

export default function ShareButton({
  slug, productName, description, imageUrl, priceText, baseUrl,
  'data-testid': testId = 'share-button',
}: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [hasNative, setHasNative] = useState(false);

  // Detect native share support exactly once after mount — `navigator`
  // doesn't exist on the server.
  useEffect(() => {
    setHasNative(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  // Build absolute URL. We prefer `window.location.origin` on the client
  // because the user may be on a non-prod host (preview, ngrok) where
  // process.env.APP_URL is wrong.
  const effectiveBase = useMemo(() => {
    if (baseUrl) return baseUrl;
    if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
    return undefined; // service falls back to process.env.APP_URL
  }, [baseUrl]);

  const canonicalUrl = useMemo(
    () => buildProductUrl(slug, { baseUrl: effectiveBase }),
    [slug, effectiveBase],
  );

  // The primary click attempts native share on devices that support it;
  // otherwise it falls back to opening the modal. Either way, the caret
  // button is always present so users can opt-in to the modal.
  const onPrimaryClick = useCallback(async () => {
    if (hasNative && typeof navigator.share === 'function') {
      const url = buildProductUrlForChannel(slug, 'native', { baseUrl: effectiveBase });
      try {
        await navigator.share({ title: productName, text: description, url });
        return;
      } catch (err) {
        // User dismissed the share sheet → ignore (DOMException name = 'AbortError').
        // Any other failure → fall back to the modal so the user has a path.
        if ((err as Error).name !== 'AbortError') {
          setOpen(true);
        }
      }
      return;
    }
    setOpen(true);
  }, [hasNative, slug, productName, description, effectiveBase]);

  return (
    <>
      <div className="inline-flex items-stretch overflow-hidden rounded-lg border border-slate-300 bg-white">
        <button
          type="button"
          onClick={onPrimaryClick}
          data-testid={testId}
          aria-label={hasNative ? `Share ${productName}` : `Share ${productName} — open options`}
          className="tap-target inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <ShareIcon className="h-4 w-4" aria-hidden="true" />
          <span>Share</span>
        </button>
        <button
          type="button"
          aria-label="Show all share options"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-more`}
          className="tap-target inline-flex items-center border-l border-slate-300 px-2 text-slate-500 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {open && (
        <ShareDialog
          open={open}
          onClose={() => setOpen(false)}
          slug={slug}
          productName={productName}
          description={description}
          imageUrl={imageUrl}
          priceText={priceText}
          canonicalUrl={canonicalUrl}
          effectiveBase={effectiveBase}
          hasNative={hasNative}
          testId={`${testId}-dialog`}
        />
      )}
    </>
  );
}

function ShareIcon({ className, ...rest }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}
    >
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M16 6l-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  );
}

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  productName: string;
  description?: string;
  imageUrl?: string | null;
  priceText?: string;
  canonicalUrl: string;
  effectiveBase?: string;
  hasNative: boolean;
  testId: string;
}

function ShareDialog({
  open, onClose, slug, productName, description, imageUrl, priceText,
  canonicalUrl, effectiveBase, hasNative, testId,
}: ShareDialogProps) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  // Per-channel URL with the right utm_medium stamped.
  const links = useMemo(() => {
    const channels: ShareChannel[] = ['whatsapp', 'telegram', 'facebook', 'twitter', 'email'];
    const out: Record<ShareChannel, string> = {} as Record<ShareChannel, string>;
    for (const c of channels) {
      const channelUrl = buildProductUrlForChannel(slug, c, { baseUrl: effectiveBase });
      const sl = buildShareLinks({ url: channelUrl, title: productName, description });
      out[c] = sl[c as keyof typeof sl];
    }
    // Copy-link version (UTM medium = copy_link).
    out['copy_link'] = buildProductUrlForChannel(slug, 'copy_link', { baseUrl: effectiveBase });
    return out;
  }, [slug, effectiveBase, productName, description]);

  // ── focus + escape + click-outside ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    lastFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    // Focus the first focusable element inside the dialog.
    const first = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    return () => {
      // Restore focus on close.
      lastFocusRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Tab') {
        // simple focus trap
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last  = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onBackdropClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  // ── copy-link ───────────────────────────────────────────────────────────
  //
  // Two-step strategy:
  //   1. Try the modern `navigator.clipboard.writeText` API. This is the
  //      preferred path because it works without DOM mutation and respects
  //      the new permissions model.
  //   2. If the modern API isn't available, OR if it throws (some browsers
  //      reject it inside an iframe / non-secure context even when it
  //      exists), fall through to a hidden `<textarea>` + `execCommand`
  //      so users on older / restricted browsers still get the link.
  //
  // Only if BOTH paths fail do we show an error.
  const onCopy = useCallback(async () => {
    setCopyError(null);
    const url = links['copy_link'];

    // Attempt the modern path. We swallow the rejection here so the legacy
    // path can have a turn.
    let modernSucceeded = false;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        modernSucceeded = true;
      } catch {
        // fall through to the legacy attempt below
      }
    }

    // Legacy `<textarea> + execCommand('copy')` fallback. We try this both
    // when the modern API is absent AND when it threw — covers iframes,
    // non-secure contexts, and ancient browsers.
    let legacySucceeded = false;
    if (!modernSucceeded) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.setAttribute('readonly', '');
        ta.style.position = 'absolute'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { legacySucceeded = document.execCommand('copy'); }
        finally { document.body.removeChild(ta); }
      } catch {
        legacySucceeded = false;
      }
    }

    if (modernSucceeded || legacySucceeded) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } else {
      setCopyError('Could not copy the link automatically — select and copy it manually.');
    }
  }, [links]);

  const onNativeShare = useCallback(async () => {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({
        title: productName, text: description ?? productName,
        url: buildProductUrlForChannel(slug, 'native', { baseUrl: effectiveBase }),
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setCopyError('Sharing was cancelled or failed.');
      }
    }
  }, [productName, description, slug, effectiveBase]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={onBackdropClick}
      data-testid={`${testId}-backdrop`}
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        data-testid={testId}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl animate-[fadeUp_180ms_ease-out_both] motion-reduce:animate-none"
      >
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 id={headingId} className="text-base font-bold text-slate-900">Share</h2>
          <button
            type="button"
            aria-label="Close share dialog"
            onClick={onClose}
            data-testid={`${testId}-close`}
            className="tap-target inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {/* Product preview */}
        <div className="flex items-start gap-3 px-4 pt-4">
          <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-xl text-slate-300" aria-hidden="true">📦</div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-semibold text-slate-900">{productName}</p>
            {priceText && <p className="text-sm text-brand-700">{priceText}</p>}
            <p
              data-testid={`${testId}-url`}
              className="mt-1 truncate text-xs text-slate-500"
              title={canonicalUrl}
            >
              {canonicalUrl}
            </p>
          </div>
        </div>

        {/* Channel grid */}
        <div
          role="group"
          aria-label="Share to a platform"
          className="grid grid-cols-3 gap-2 px-4 py-4 sm:grid-cols-6"
          data-testid={`${testId}-channels`}
        >
          {hasNative && (
            <ChannelButton
              testId={`${testId}-channel-native`}
              icon={<ShareIcon className="h-5 w-5" aria-hidden="true" />}
              label={channelLabel('native')}
              onClick={onNativeShare}
              tint="slate"
            />
          )}
          <ChannelLink
            testId={`${testId}-channel-whatsapp`}
            href={links.whatsapp}
            label={channelLabel('whatsapp')}
            icon={<WhatsAppIcon className="h-5 w-5" aria-hidden="true" />}
            tint="emerald"
          />
          <ChannelLink
            testId={`${testId}-channel-telegram`}
            href={links.telegram}
            label={channelLabel('telegram')}
            icon={<TelegramIcon className="h-5 w-5" aria-hidden="true" />}
            tint="sky"
          />
          <ChannelLink
            testId={`${testId}-channel-facebook`}
            href={links.facebook}
            label={channelLabel('facebook')}
            icon={<FacebookIcon className="h-5 w-5" aria-hidden="true" />}
            tint="blue"
          />
          <ChannelLink
            testId={`${testId}-channel-twitter`}
            href={links.twitter}
            label={channelLabel('twitter')}
            icon={<XIcon className="h-5 w-5" aria-hidden="true" />}
            tint="slate"
          />
          <ChannelLink
            testId={`${testId}-channel-email`}
            href={links.email}
            label={channelLabel('email')}
            icon={<EmailIcon className="h-5 w-5" aria-hidden="true" />}
            // mailto: should not open in a new tab
            newTab={false}
            tint="amber"
          />
        </div>

        {/* Copy-link row */}
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
          <label className="block text-xs font-semibold text-slate-700">Or copy the link</label>
          <div className="mt-1 flex items-stretch gap-2">
            <input
              data-testid={`${testId}-copy-input`}
              type="text"
              readOnly
              value={links['copy_link']}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 truncate rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono text-slate-700 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              aria-label="Shareable product link"
            />
            <button
              type="button"
              onClick={onCopy}
              data-testid={`${testId}-copy-button`}
              aria-label={copied ? 'Link copied' : 'Copy link to clipboard'}
              className={[
                'tap-target inline-flex items-center justify-center gap-1 rounded-md px-3 text-xs font-semibold transition',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600',
                copied
                  ? 'bg-emerald-600 text-white'
                  : 'bg-brand-600 text-white hover:bg-brand-700',
              ].join(' ')}
            >
              {copied
                ? (<><CheckIcon className="h-4 w-4" aria-hidden="true" /><span>Copied</span></>)
                : (<><CopyIcon className="h-4 w-4" aria-hidden="true" /><span>Copy</span></>)}
            </button>
          </div>
          <p
            role="status"
            aria-live="polite"
            data-testid={`${testId}-status`}
            className={[
              'min-h-[1rem] text-[11px]',
              copied ? 'text-emerald-700' : copyError ? 'text-red-700' : 'text-slate-500',
            ].join(' ')}
          >
            {copied ? '✓ Link copied to your clipboard'
              : copyError ? copyError
              : 'Tip: paste into WhatsApp, iMessage, email — the link unfurls into a rich preview.'}
          </p>
        </div>

        <style jsx>{`
          @keyframes fadeUp {
            from { opacity: 0; transform: translateY(6px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0)    scale(1); }
          }
        `}</style>
      </div>
    </div>
  );
}

// ── Channel buttons ────────────────────────────────────────────────────────
type Tint = 'emerald' | 'sky' | 'blue' | 'slate' | 'amber';

const TINT_CLASSES: Record<Tint, string> = {
  emerald: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-100',
  sky:     'bg-sky-50     text-sky-700     hover:bg-sky-100     border-sky-100',
  blue:    'bg-blue-50    text-blue-700    hover:bg-blue-100    border-blue-100',
  slate:   'bg-slate-50   text-slate-700   hover:bg-slate-100   border-slate-200',
  amber:   'bg-amber-50   text-amber-700   hover:bg-amber-100   border-amber-100',
};

function ChannelButton({
  testId, icon, label, onClick, tint = 'slate',
}: { testId: string; icon: React.ReactNode; label: string; onClick: () => void; tint?: Tint }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-label={`Share via ${label}`}
      className={[
        'tap-target inline-flex flex-col items-center justify-center gap-1 rounded-lg border px-2 py-3 text-[11px] font-semibold',
        'transition-transform duration-150 ease-out motion-reduce:transition-none',
        'hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600',
        TINT_CLASSES[tint],
      ].join(' ')}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ChannelLink({
  testId, href, label, icon, tint = 'slate', newTab = true,
}: { testId: string; href: string; label: string; icon: React.ReactNode; tint?: Tint; newTab?: boolean }) {
  return (
    <a
      href={href}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noopener noreferrer' : undefined}
      data-testid={testId}
      aria-label={`Share via ${label}`}
      className={[
        'tap-target inline-flex flex-col items-center justify-center gap-1 rounded-lg border px-2 py-3 text-[11px] font-semibold',
        'transition-transform duration-150 ease-out motion-reduce:transition-none',
        'hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600',
        TINT_CLASSES[tint],
      ].join(' ')}
    >
      {icon}
      <span>{label}</span>
    </a>
  );
}

// ── icons (inline, no external dep) ────────────────────────────────────────
function CopyIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <path d="M5 15V5a2 2 0 0 1 2-2h10" strokeLinecap="round"/>
    </svg>
  );
}
function CheckIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" {...p}>
      <path d="M5 13l4 4 10-10" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function WhatsAppIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M20.5 3.5A11 11 0 0 0 3.7 17.7L2 22l4.5-1.6A11 11 0 1 0 20.5 3.5zM12 20a8 8 0 0 1-4.1-1.1l-.3-.2-2.7.95.9-2.6-.2-.3A8 8 0 1 1 12 20zm4.4-5.6c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1-.2.2-.6.7-.7.8-.1.2-.3.2-.5.1-.7-.4-1.5-.8-2.2-1.7-.6-.8-1-1.7-1.1-2 0-.2 0-.3.1-.4l.4-.5c.1-.2.2-.3.3-.5 0-.2 0-.4 0-.5-.1-.2-.5-1.3-.7-1.8-.2-.4-.4-.4-.5-.4h-.4c-.2 0-.5 0-.7.3-.2.2-.9.9-.9 2.2 0 1.3.9 2.6 1.1 2.8.1.2 1.9 2.9 4.6 4 .6.3 1.2.4 1.6.5.7.1 1.3.1 1.8 0 .6-.1 1.4-.6 1.6-1.1.2-.5.2-1 .1-1.1-.1-.1-.3-.2-.5-.3z"/>
    </svg>
  );
}
function TelegramIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M21.5 4.4 18.5 19c-.2 1-.8 1.2-1.6.8l-4.5-3.3-2.2 2.1c-.2.2-.4.4-.9.4l.3-4.6 8.3-7.5c.4-.3-.1-.5-.6-.2L7.2 12.3l-4.4-1.4c-1-.3-1-1 .2-1.5l17-6.5c.8-.3 1.5.2 1.5 1.5z"/>
    </svg>
  );
}
function FacebookIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M22 12a10 10 0 1 0-11.5 9.9v-7H8v-3h2.5V9.5c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12H17l-.5 3h-2.6v7A10 10 0 0 0 22 12z"/>
    </svg>
  );
}
function XIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M18.244 2H21l-6.523 7.456L22 22h-6.788l-4.78-6.227L4.8 22H2.04l6.987-7.985L2 2h6.93l4.318 5.71L18.244 2zm-1.198 18h1.834L7.058 4H5.13l11.916 16z"/>
    </svg>
  );
}
function EmailIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2"/>
      <path d="M3 7l9 6 9-6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// silence unused-type warnings used only in JSX
void (null as unknown as KeyboardEvent | MouseEvent);
