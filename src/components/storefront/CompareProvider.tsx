'use client';
/**
 * <CompareProvider> — Item 14.
 *
 * Compare list state for the whole storefront. Mounted in the storefront
 * layout once; descendant components (the `<CompareButton>` on PDP /
 * product cards, the `<CompareTray>` floating UI, etc.) read state and
 * dispatch actions via `useCompare()`.
 *
 * Backends:
 *   - Authenticated users: server-side `CompareItem` rows. The provider
 *     calls `/api/compare` for every mutation.
 *   - Anonymous users: the same `/api/compare` endpoint, which writes
 *     to the `sc_compare_v1` cookie. The cookie is `httpOnly: false`
 *     so the provider can read it on first paint without a round trip.
 *
 * The list shape is intentionally narrow — only product IDs — because
 * the full product data only matters on the /compare page itself,
 * where the server-rendered page does its own fetch. Everywhere else
 * (PDP "In compare" indicator, tray thumbnails) only needs the IDs
 * + lightweight metadata.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { api } from '@/lib/client/api';
import { useFeatureFlags } from './FeatureFlagProvider';

export interface CompareEntry {
  productId: string;
  addedAt:   string;
}

export interface CompareState {
  items:    CompareEntry[];
  maxItems: number;
  loading:  boolean;
}

interface CompareCtx extends CompareState {
  has:    (productId: string) => boolean;
  add:    (productId: string) => Promise<AddResult>;
  remove: (productId: string) => Promise<void>;
  clear:  () => Promise<void>;
  /** Force a re-fetch from the server. Use after login. */
  refresh: () => Promise<void>;
}

export type AddResult =
  | { ok: true;  alreadyIn?: boolean }
  | { ok: false; code: string; message: string };

const Ctx = createContext<CompareCtx | null>(null);

const COOKIE_NAME = 'sc_compare_v1';

/** Read the productId list from the `sc_compare_v1` cookie for
 *  first-paint hydration. Returns [] for any failure mode. */
function readCookieIds(): string[] {
  if (typeof document === 'undefined') return [];
  const raw = document.cookie ? document.cookie.split(';') : [];
  for (const part of raw) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    try {
      const decoded = decodeURIComponent(part.slice(eq + 1).trim());
      const arr = JSON.parse(decoded) as unknown;
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    } catch { /* */ }
  }
  return [];
}

export function CompareProvider({ children }: { children: ReactNode }) {
  const flags = useFeatureFlags();
  // First-paint state: hydrate from the cookie (anonymous-friendly) so
  // the tray + "In compare" indicators don't flash. When the feature is
  // disabled at the server, start with an empty list to avoid an
  // initial fetch that would 403.
  const [state, setState] = useState<CompareState>(() => {
    if (!flags.compareEnabled) return { items: [], maxItems: 4, loading: false };
    const ids = readCookieIds();
    return {
      items: ids.map((productId) => ({ productId, addedAt: new Date().toISOString() })),
      maxItems: 4,
      loading: true,
    };
  });

  /** Single source of truth for an authoritative refresh — calls
   *  /api/compare and replaces local state. */
  const refresh = useCallback(async (): Promise<void> => {
    if (!flags.compareEnabled) return;
    setState((s) => ({ ...s, loading: true }));
    const r = await api<{
      items: Array<{ product?: { id: string }; productId?: string; addedAt: string }>;
      maxItems: number;
    }>('/api/compare');
    if (r.ok && r.data) {
      // The full GET returns `{ product, addedAt }` items; the mutation
      // endpoints return `{ productId, addedAt }`. Normalise.
      const items: CompareEntry[] = r.data.items.map((it) => ({
        productId: it.productId ?? it.product?.id ?? '',
        addedAt:   it.addedAt,
      })).filter((it) => it.productId.length > 0);
      setState({ items, maxItems: r.data.maxItems ?? 4, loading: false });
    } else {
      // Feature disabled / network error: clear so the tray hides.
      setState({ items: [], maxItems: 4, loading: false });
    }
  }, [flags.compareEnabled]);

  useEffect(() => { if (flags.compareEnabled) void refresh(); }, [refresh, flags.compareEnabled]);

  const has = useCallback((productId: string): boolean => {
    return state.items.some((e) => e.productId === productId);
  }, [state.items]);

  const add = useCallback(async (productId: string): Promise<AddResult> => {
    if (!flags.compareEnabled) return { ok: false, code: 'FEATURE_DISABLED', message: 'Compare is disabled.' };
    if (state.items.some((e) => e.productId === productId)) {
      return { ok: true, alreadyIn: true };
    }
    const r = await api<{ items: Array<{ productId: string; addedAt: string }>; maxItems: number }>(
      '/api/compare', { method: 'POST', body: { productId } },
    );
    if (r.ok && r.data) {
      setState({ items: r.data.items, maxItems: r.data.maxItems, loading: false });
      return { ok: true };
    }
    return {
      ok: false,
      code:    r.code ?? 'COMPARE_ADD_FAILED',
      message: r.error ?? 'Could not add to compare.',
    };
  }, [state.items, flags.compareEnabled]);

  const remove = useCallback(async (productId: string): Promise<void> => {
    const r = await api<{ items: Array<{ productId: string; addedAt: string }> }>(
      `/api/compare/${encodeURIComponent(productId)}`, { method: 'DELETE' },
    );
    if (r.ok && r.data) {
      setState((s) => ({ ...s, items: r.data!.items }));
    }
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    await api('/api/compare', { method: 'DELETE' });
    setState((s) => ({ ...s, items: [] }));
  }, []);

  const value = useMemo<CompareCtx>(() => ({
    ...state, has, add, remove, clear, refresh,
  }), [state, has, add, remove, clear, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCompare(): CompareCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCompare must be used inside <CompareProvider>.');
  return v;
}
