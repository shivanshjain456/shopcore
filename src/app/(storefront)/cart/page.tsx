'use client';

import Link from 'next/link';
import { useCart } from '@/components/storefront/CartProvider';
import QuantityControl from '@/components/storefront/QuantityControl';
import { rupees } from '@/lib/catalog/pricing';

export default function CartPage() {
  const cart = useCart();

  if (!cart.loaded) {
    return <main className="mx-auto max-w-5xl px-4 py-16 text-center text-sm text-slate-500">Loading your cart…</main>;
  }

  if (cart.items.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Your cart is empty</h1>
        <p className="mt-2 text-slate-600">Browse our collection and add something you like.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">Continue shopping</Link>
          <Link href="/c/laptops" className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50">Shop laptops</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="text-2xl font-bold text-slate-900">Your cart</h1>
      <p className="text-sm text-slate-600">{cart.unitCount} item{cart.unitCount === 1 ? '' : 's'}</p>
      {!cart.authed && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          You&apos;re browsing as a guest. <Link href="/login?next=/cart" className="font-semibold underline">Sign in</Link> to save your cart and continue to checkout.
        </p>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Lines */}
        <div className="space-y-3">
          {cart.items.map((it) => (
            <div key={it.id} className="flex gap-4 rounded-xl border border-slate-200 bg-white p-3">
              <Link href={`/p/${it.slug}`} className="block h-24 w-32 shrink-0 overflow-hidden rounded-lg bg-slate-50">
                {it.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.imageUrl} alt={it.productName} className="h-full w-full object-cover" />
                )}
              </Link>
              <div className="flex flex-1 flex-col">
                <Link href={`/p/${it.slug}`} className="text-sm font-semibold text-slate-900 hover:text-brand-700">
                  {it.productName}
                </Link>
                {it.variantName && <p className="text-xs text-slate-500">{it.variantName}</p>}
                {!it.inStock && <p className="text-xs font-semibold text-red-600">No longer in stock</p>}
                <div className="mt-auto flex items-center justify-between gap-2">
                  <QuantityControl itemId={it.id} quantity={it.quantity} stock={it.stock} />
                  <button
                    type="button"
                    onClick={() => cart.remove(it.id)}
                    className="text-xs font-medium text-slate-500 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold text-slate-900">{rupees(it.lineTotalPaise)}</div>
                {it.quantity > 1 && <div className="text-xs text-slate-500">{rupees(it.unitPricePaise)} each</div>}
              </div>
            </div>
          ))}
        </div>

        {/* Summary */}
        <aside className="h-fit rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-bold uppercase text-slate-700">Order summary</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">Subtotal</dt>
              <dd className="font-semibold">{rupees(cart.subtotalPaise)}</dd>
            </div>
            {cart.savingsPaise > 0 && (
              <div className="flex justify-between text-emerald-700">
                <dt>You save</dt>
                <dd>− {rupees(cart.savingsPaise)}</dd>
              </div>
            )}
            <div className="flex justify-between text-slate-600">
              <dt>Shipping</dt>
              <dd>Calculated at checkout</dd>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold">
              <dt>Estimated total</dt>
              <dd>{rupees(cart.subtotalPaise)}</dd>
            </div>
          </dl>

          <Link
            href={cart.authed ? '/checkout' : '/login?next=/checkout'}
            className="mt-5 block rounded-lg bg-brand-600 px-4 py-3 text-center text-sm font-semibold text-white hover:bg-brand-700"
          >
            {cart.authed ? 'Proceed to checkout' : 'Sign in to checkout'}
          </Link>
          <Link href="/" className="mt-2 block text-center text-xs text-slate-500 hover:underline">Continue shopping</Link>
        </aside>
      </div>
    </main>
  );
}
