'use client';
/**
 * Client-side cart state with localStorage persistence for guests + server sync
 * for signed-in users.
 *
 * Strategy:
 *  - On mount: GET /api/cart. If 200, we're signed-in → server cart is truth.
 *  - If 401, we're a guest → load from localStorage.
 *  - All mutations call /api/cart/* with optimistic UI; failures revert.
 *  - On sign-in (a separate flow), call /api/cart/merge with guest items.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { api } from '@/lib/client/api';

export interface CartLine {
  id: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  slug: string;
  imageUrl: string | null;
  unitPricePaise: number;
  mrpPaise: number;
  quantity: number;
  lineTotalPaise: number;
  stock: number;
  inStock: boolean;
}

export interface CartState {
  loaded: boolean;
  authed: boolean;
  items: CartLine[];
  unitCount: number;
  subtotalPaise: number;
  mrpTotalPaise: number;
  savingsPaise: number;
}

interface CartCtx extends CartState {
  add: (p: { productId: string; variantId?: string | null; quantity?: number }) => Promise<{ ok: boolean; error?: string }>;
  update: (itemId: string, qty: number) => Promise<{ ok: boolean; error?: string }>;
  remove: (itemId: string) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

const GUEST_KEY = 'sc_guest_cart_v1';

interface GuestItem { productId: string; variantId: string | null; quantity: number; }

function loadGuest(): GuestItem[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(GUEST_KEY) || '[]') as GuestItem[]; }
  catch { return []; }
}

function saveGuest(items: GuestItem[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(GUEST_KEY, JSON.stringify(items));
}

const Ctx = createContext<CartCtx | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CartState>({
    loaded: false, authed: false, items: [],
    unitCount: 0, subtotalPaise: 0, mrpTotalPaise: 0, savingsPaise: 0,
  });

  const refresh = useCallback(async () => {
    const r = await api<{ cart: CartState }>('/api/cart');
    if (r.ok && r.data) {
      setState({ ...r.data.cart, loaded: true, authed: true });
      return;
    }
    // Guest path: hydrate from localStorage, fetch lightweight price info
    const guest = loadGuest();
    if (guest.length === 0) {
      setState((s) => ({ ...s, loaded: true, authed: false, items: [], unitCount: 0, subtotalPaise: 0, mrpTotalPaise: 0, savingsPaise: 0 }));
      return;
    }
    const r2 = await api<{ cart: CartState }>('/api/cart/preview', { method: 'POST', body: { items: guest } });
    if (r2.ok && r2.data) {
      setState({ ...r2.data.cart, loaded: true, authed: false });
    } else {
      setState((s) => ({ ...s, loaded: true, authed: false }));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback<CartCtx['add']>(async ({ productId, variantId = null, quantity = 1 }) => {
    if (state.authed) {
      const r = await api<{ cart: CartState }>('/api/cart/add', { method: 'POST', body: { productId, variantId, quantity } });
      if (!r.ok) return { ok: false, error: r.error };
      if (r.data) setState({ ...r.data.cart, loaded: true, authed: true });
      return { ok: true };
    }
    // GUEST path: validate against the server BEFORE mutating localStorage.
    // The validator returns the authoritative stock count and rejects with a
    // specific message if anything is wrong (OOS, inactive, exceeds cap, etc.)
    const guest = loadGuest();
    const ix = guest.findIndex((g) => g.productId === productId && (g.variantId ?? null) === variantId);
    const alreadyInCart = ix >= 0 ? guest[ix].quantity : 0;
    const check = await api<{ available: number }>('/api/cart/validate', {
      method: 'POST',
      body: { productId, variantId, quantity, alreadyInCart },
    });
    if (!check.ok) return { ok: false, error: check.error ?? 'Could not add to cart.' };
    if (ix >= 0) guest[ix].quantity = alreadyInCart + quantity;
    else guest.push({ productId, variantId, quantity });
    saveGuest(guest);
    await refresh();
    return { ok: true };
  }, [state.authed, refresh]);

  const update = useCallback<CartCtx['update']>(async (itemId, qty) => {
    if (state.authed) {
      const r = await api<{ cart: CartState }>('/api/cart/update', { method: 'POST', body: { itemId, quantity: qty } });
      if (!r.ok) return { ok: false, error: r.error };
      if (r.data) setState({ ...r.data.cart, loaded: true, authed: true });
      return { ok: true };
    }
    // guest: itemId is the index into local list (we encode it that way for guests)
    const guest = loadGuest();
    const idx = Number(itemId);
    if (!Number.isFinite(idx) || idx < 0 || idx >= guest.length) return { ok: false, error: 'Item not found.' };
    if (qty <= 0) {
      guest.splice(idx, 1);
      saveGuest(guest);
      await refresh();
      return { ok: true };
    }
    // Real-time stock validation against server BEFORE persisting the change.
    // alreadyInCart=0 because qty is the FINAL desired quantity (not a delta).
    const g = guest[idx];
    const check = await api<{ available: number }>('/api/cart/validate', {
      method: 'POST',
      body: { productId: g.productId, variantId: g.variantId, quantity: qty, alreadyInCart: 0 },
    });
    if (!check.ok) return { ok: false, error: check.error ?? 'Could not update cart.' };
    guest[idx].quantity = qty;
    saveGuest(guest);
    await refresh();
    return { ok: true };
  }, [state.authed, refresh]);

  const remove = useCallback<CartCtx['remove']>(async (itemId) => update(itemId, 0), [update]);

  const value = useMemo<CartCtx>(() => ({
    ...state, add, update, remove, refresh,
  }), [state, add, update, remove, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCart must be inside CartProvider');
  return v;
}

export function getGuestCartForMerge(): GuestItem[] { return loadGuest(); }
export function clearGuestCart() { if (typeof window !== 'undefined') localStorage.removeItem(GUEST_KEY); }
