/**
 * Shared response shape for `/api/cart` family of endpoints.
 * Keeps the wire format consistent across user-cart and guest-preview.
 */
import type { CartView } from './cart';

export function serializeCartForApi(view: CartView) {
  return {
    cart: {
      id: view.id,
      items: view.items,
      itemCount: view.itemCount,
      unitCount: view.unitCount,
      subtotalPaise: view.subtotalPaise,
      mrpTotalPaise: view.mrpTotalPaise,
      savingsPaise: view.savingsPaise,
    },
  };
}
