/**
 * Variant-price bug regression suite.
 *
 *   npm run test:variant-price
 *
 * Three layers, exactly as the bug-report asked for:
 *
 *   1. UNIT TESTS — pure selector `selectVariantPrice()`:
 *        (1) Default variant price displayed on initial render
 *        (2) Price updates when a different variant is selected
 *        (3) Price updates correctly across multiple sequential variant changes
 *        (4) Cart receives correct price for selected variant (server-side guard)
 *        (5) Variant with undefined price (defensive)
 *        (6) Product with only one variant
 *        (7) Product with no variants array
 *        (8) Variant not found in variants array (defensive)
 *        (9) Price is a float (e.g., Rs. 999.50)
 *
 *   2. INTEGRATION TESTS — real DB lifecycle:
 *        (i)   Selected variant's price flows into the cart line, NOT the
 *              product-level fallback (server re-validates).
 *        (ii)  Cart line total reflects the variant price × qty.
 *        (iii) Changing selection between two adds-to-cart produces two
 *              cart lines with two different prices.
 *        (iv)  Place-order persists the variant price as `unitPricePaise`
 *              on `OrderItem` (immune to later product-price edits).
 *
 *   3. REGRESSION — the original bug shape:
 *        Confirm that even if the SERVER computes the wrong base price,
 *        the cart endpoint corrects to the variant price (defence in depth).
 *
 * Exit 0 on full pass; non-zero with a clear failure on first mismatch.
 */
// Allow @shopcore.test email addresses for fixtures (Feature #10 policy bypass).
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';
import { prisma } from '../src/lib/db/client';
import {
  selectVariantPrice,
  discountPercentForResult,
  type PriceableProduct,
} from '../src/lib/catalog/variantPrice';
import { addToCart, getCartView } from '../src/lib/catalog/cart';
import { placeOrder } from '../src/lib/checkout/placeOrder';
import { priceCtxForUser } from '../src/lib/catalog/pricing';
import { hashPassword } from '../src/lib/auth/password';

let passed = 0; let failed = 0;
function ok(label: string) { passed++; console.log(`  ✔ ${label}`); }
function fail(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else fail(label, expected, actual);
}

// ────────────────────────────────────────────────────── 1. UNIT TESTS

function unitTests() {
  console.log('\n── UNIT TESTS (selectVariantPrice) ──');

  // Three-variant fixture (storage tiers)
  const product: PriceableProduct = {
    id: 'p1', pricePaise: 99_900, mrpPaise: 109_900, stock: 0,
    variants: [
      { id: 'v64',  name: '64GB',  pricePaise:  99_900, mrpPaise: 109_900, stock: 5, isActive: true },
      { id: 'v128', name: '128GB', pricePaise: 149_900, mrpPaise: 159_900, stock: 3, isActive: true },
      { id: 'v256', name: '256GB', pricePaise: 199_900, mrpPaise: 219_900, stock: 0, isActive: true },
    ],
  };

  // ── (1) Default variant price displayed on initial render
  // First paint passes `selectedId = null`. We expect the first variant.
  const init = selectVariantPrice(product, null);
  eq('(1) initial render uses first variant', 'v64', init.selectedVariantId);
  eq('(1) initial price = first variant price (₹999)', 99_900, init.pricePaise);
  eq('(1) initial reason', 'fallback-first', init.reason);

  // ── (2) Price updates when a different variant is selected
  const r128 = selectVariantPrice(product, 'v128');
  eq('(2) selecting 128GB switches price to ₹1,499', 149_900, r128.pricePaise);
  eq('(2) selecting 128GB returns name "128GB"', '128GB', r128.variantName);
  eq('(2) reason indicates a match', 'selected-found', r128.reason);

  // ── (3) Price updates correctly across multiple sequential variant changes
  const sequence: string[] = ['v64', 'v128', 'v256', 'v64', 'v128'];
  const expected: number[]  = [ 99_900, 149_900, 199_900, 99_900, 149_900 ];
  const got = sequence.map((id) => selectVariantPrice(product, id).pricePaise);
  eq('(3) sequential variant changes produce correct price each time', expected, got);

  // Also confirm out-of-stock (256GB) STILL surfaces its true price; the UI
  // disables the button, but the formula must not lie about the price.
  const oos = selectVariantPrice(product, 'v256');
  eq('(3b) OOS variant still reports its true price', 199_900, oos.pricePaise);
  eq('(3b) OOS variant reports inStock=false', false, oos.inStock);

  // ── (4) Cart receives correct price for selected variant
  // (Server-side check covered in integration; here we assert the SELECTOR
  // outputs the very `selectedVariantId` that the Add-to-Cart click will send.)
  const r = selectVariantPrice(product, 'v128');
  eq('(4) selector returns selectedVariantId for Add-to-Cart', 'v128', r.selectedVariantId);

  // ── (5) Variant with undefined price
  const productMissing: PriceableProduct = {
    id: 'p2', pricePaise: 50_000, mrpPaise: 60_000, stock: 0,
    variants: [
      { id: 'va', name: 'A', pricePaise: undefined as unknown as number, mrpPaise: 60_000, stock: 2, isActive: true },
      { id: 'vb', name: 'B', pricePaise: 70_000, mrpPaise: 80_000, stock: 2, isActive: true },
    ],
  };
  const missing = selectVariantPrice(productMissing, 'va');
  eq('(5) variant with undefined price falls back to product price', 50_000, missing.pricePaise);
  eq('(5) reason flags missing-price for UI warning', 'missing-price', missing.reason);
  // and switching to a healthy variant recovers
  const recover = selectVariantPrice(productMissing, 'vb');
  eq('(5b) switching to a healthy variant shows its real price', 70_000, recover.pricePaise);

  // ── (6) Product with only one variant
  const single: PriceableProduct = {
    id: 'p3', pricePaise: 25_000, mrpPaise: 25_000, stock: 0,
    variants: [{ id: 'only', name: 'Standard', pricePaise: 25_000, mrpPaise: 25_000, stock: 1, isActive: true }],
  };
  const onlyDefault = selectVariantPrice(single, null);
  eq('(6) single-variant default selects that variant', 'only', onlyDefault.selectedVariantId);
  eq('(6) single-variant default uses variant price', 25_000, onlyDefault.pricePaise);
  const onlyExplicit = selectVariantPrice(single, 'only');
  eq('(6b) explicit selection of the sole variant resolves to itself', 'only', onlyExplicit.selectedVariantId);

  // ── (7) Product with no variants array
  const noVariantsArr: PriceableProduct = { id: 'p4', pricePaise: 12_000, mrpPaise: 15_000, stock: 4 };
  const r7a = selectVariantPrice(noVariantsArr, null);
  eq('(7a) no variants field → product price', 12_000, r7a.pricePaise);
  eq('(7a) no variants field → selectedVariantId null', null, r7a.selectedVariantId);
  eq('(7a) no variants field → reason no-variants', 'no-variants', r7a.reason);

  const emptyVariants: PriceableProduct = { id: 'p5', pricePaise: 7_500, mrpPaise: 7_500, stock: 2, variants: [] };
  const r7b = selectVariantPrice(emptyVariants, 'anything');
  eq('(7b) empty variants array → product price (ignores selectedId)', 7_500, r7b.pricePaise);
  eq('(7b) empty variants array → reason no-variants', 'no-variants', r7b.reason);

  // null variants (legacy DB shape)
  const nullVariants = { id: 'p5b', pricePaise: 8_000, mrpPaise: 8_000, stock: 1, variants: null } as unknown as PriceableProduct;
  const r7c = selectVariantPrice(nullVariants, null);
  eq('(7c) null variants field → product price (no throw)', 8_000, r7c.pricePaise);

  // ── (8) Variant not found in variants array (defensive)
  const r8 = selectVariantPrice(product, 'ghost-variant-id');
  eq('(8) unknown selectedId falls back to first variant', 'v64', r8.selectedVariantId);
  eq('(8) unknown selectedId price = first variant price', 99_900, r8.pricePaise);
  eq('(8) unknown selectedId reason flags the fallback', 'selected-not-found', r8.reason);

  // ── (9) Price is a float (legacy data: e.g., Rs. 999.50)
  // Our stored model is integer paise; if a legacy row leaks 99950.5, we coerce.
  const floatRow: PriceableProduct = {
    id: 'p6', pricePaise: 99_950 as unknown as number, mrpPaise: 109_900, stock: 0,
    variants: [
      { id: 'vf', name: 'Float', pricePaise: 99_950.5 as unknown as number, mrpPaise: 109_900, stock: 2, isActive: true },
    ],
  };
  const rf = selectVariantPrice(floatRow, 'vf');
  eq('(9a) float pricePaise (99950.5) coerced to integer 99951', 99_951, rf.pricePaise);
  // string-shaped numerics also tolerated
  const strRow: PriceableProduct = {
    id: 'p7', pricePaise: 0, mrpPaise: 0, stock: 0,
    variants: [{ id: 'vs', name: 'StrNum', pricePaise: ('45000' as unknown as number), mrpPaise: ('50000' as unknown as number), stock: 1, isActive: true }],
  };
  const rs = selectVariantPrice(strRow, 'vs');
  eq('(9b) string-numeric pricePaise "45000" coerced to integer 45000', 45_000, rs.pricePaise);

  // Bonus: discount percent helper
  eq('(bonus) discountPercentForResult: 99_900 vs 109_900 mrp → 9%', 9, discountPercentForResult(init));
  eq('(bonus) discountPercentForResult: equal price/mrp → 0%', 0, discountPercentForResult(selectVariantPrice(single, null)));
}

// ────────────────────────────────────────────────────── 2. INTEGRATION TESTS

function freshPhone() {
  return '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
}

async function setupUser(suffix: string) {
  const email = `vp_${Date.now()}_${suffix}@shopcore.test`;
  const passwordHash = await hashPassword('TestPass#9k2');
  const phone = freshPhone();
  const user = await prisma.user.create({
    data: {
      firstName: 'VP', lastName: 'Test', email, phone, passwordHash,
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      // STATE_MACHINE_BYPASS: test-fixture seeding (initial-row insert).
      pinCode: '400001', country: 'India', role: 'CUSTOMER', status: 'ACTIVE',
    },
  });
  const addr = await prisma.address.create({
    data: { userId: user.id, fullName: 'VP Test', phone,
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India', isDefault: true },
  });
  return { user: await prisma.user.findUniqueOrThrow({ where: { id: user.id } }), addressId: addr.id };
}

async function integrationTests() {
  console.log('\n── INTEGRATION TESTS (real DB cart + order) ──');

  // Pick a multi-variant product with healthy stock
  const product = await prisma.product.findFirst({
    where: { isActive: true, variants: { some: { stock: { gte: 1 }, isActive: true } } },
    include: { variants: { where: { isActive: true, stock: { gte: 1 } }, orderBy: { pricePaise: 'asc' } } },
  });
  if (!product || product.variants.length < 2) {
    throw new Error('Need a seeded product with ≥2 active in-stock variants (e.g. Dell Inspiron 15). Run `npm run db:seed:products`.');
  }
  const cheap = product.variants[0];
  const dear  = product.variants[product.variants.length - 1];
  if (cheap.pricePaise === dear.pricePaise) {
    throw new Error('Need two variants with DIFFERENT prices for a meaningful test.');
  }
  console.log(`   using ${product.sku} · cheap=${cheap.name} ₹${cheap.pricePaise/100} · dear=${dear.name} ₹${dear.pricePaise/100}`);

  // (i) selecting the DEAR variant and adding to cart must charge the dear price
  const a = await setupUser('A');
  const addRes = await addToCart({ userId: a.user.id, productId: product.id, variantId: dear.id, quantity: 1 });
  if (!addRes.ok) throw new Error('addToCart failed: ' + addRes.reason);

  const cartA = await getCartView(a.user.id, priceCtxForUser(a.user, null));
  eq('(i) cart line uses variant price (not product fallback)',
     dear.pricePaise, cartA.items[0]?.unitPricePaise);
  eq('(i) cart line uses correct variantId',
     dear.id, cartA.items[0]?.variantId);

  // (ii) line total = variant price × qty
  await addToCart({ userId: a.user.id, productId: product.id, variantId: dear.id, quantity: 2 });
  const cartA2 = await getCartView(a.user.id, priceCtxForUser(a.user, null));
  // addToCart accumulates same variant, so quantity is 3 (1 + 2 capped to MAX/stock)
  const expected3 = (cartA2.items[0]?.unitPricePaise ?? 0) * (cartA2.items[0]?.quantity ?? 0);
  eq('(ii) cart line total = unit × qty', expected3, cartA2.items[0]?.lineTotalPaise);

  // (iii) two ADDS of two DIFFERENT variants of same product → two lines, two prices
  const b = await setupUser('B');
  await addToCart({ userId: b.user.id, productId: product.id, variantId: cheap.id, quantity: 1 });
  await addToCart({ userId: b.user.id, productId: product.id, variantId: dear.id,  quantity: 1 });
  const cartB = await getCartView(b.user.id, priceCtxForUser(b.user, null));
  eq('(iii) two different variants of same product → two cart lines', 2, cartB.items.length);
  const prices = cartB.items.map((i) => i.unitPricePaise).sort((x, y) => x - y);
  eq('(iii) two prices match the two variant prices',
     [cheap.pricePaise, dear.pricePaise].sort((x, y) => x - y), prices);

  // (iv) Place-order persists variant price as OrderItem.unitPricePaise
  const c = await setupUser('C');
  await addToCart({ userId: c.user.id, productId: product.id, variantId: dear.id, quantity: 1 });
  const utr12 = `4${Math.floor(Math.random() * 9 + 1)}${Date.now().toString().slice(-10)}`.slice(0, 12).padStart(12, '7');
  const placed = await placeOrder({
    user: c.user, shippingAddressId: c.addressId,
    paymentMethod: 'UPI',
    utrNumber: utr12, receiptUrl: '/api/uploads/receipts/test/dummy.jpg',
  });
  if (!placed.ok) throw new Error('placeOrder failed: ' + placed.reason);
  const oi = await prisma.orderItem.findFirstOrThrow({ where: { orderId: placed.orderId } });
  eq('(iv) OrderItem.unitPricePaise = variant price', dear.pricePaise, oi.unitPricePaise);
  eq('(iv) OrderItem.variantId = chosen variant', dear.id, oi.variantId);

  // After this order, dear variant's stock dropped by 1 — note it for cleanup
  // (cleanup at the bottom restores stocks)

  // CLEANUP test users
  for (const u of [a, b, c]) {
    await prisma.utrSubmission.deleteMany({ where: { userId: u.user.id } });
    await prisma.inventoryLog.deleteMany({ where: { performedBy: u.user.id } });
    await prisma.orderItem.deleteMany({ where: { order: { userId: u.user.id } } });
    await prisma.orderStatusHistory.deleteMany({ where: { order: { userId: u.user.id } } });
    await prisma.loyaltyLedger.deleteMany({ where: { userId: u.user.id } });
    await prisma.order.deleteMany({ where: { userId: u.user.id } });
    await prisma.cartItem.deleteMany({ where: { cart: { userId: u.user.id } } });
    await prisma.cart.deleteMany({ where: { userId: u.user.id } });
    await prisma.userActivity.deleteMany({ where: { userId: u.user.id } });
    await prisma.address.deleteMany({ where: { userId: u.user.id } });
    await prisma.user.delete({ where: { id: u.user.id } });
  }
  // Restore the dear-variant stock consumed by the placed order in (iv)
  await prisma.variant.update({ where: { id: dear.id }, data: { stock: { increment: 1 } } });
}

// ────────────────────────────────────────────────────── 3. REGRESSION TESTS

async function regressionTests() {
  console.log('\n── REGRESSION ──');

  // The original bug: PDP showed product.pricePaise even after the user
  // chose a higher-priced variant. The fix has TWO defences:
  //
  //   - DISPLAY: `selectVariantPrice()` returns the variant price when one is
  //              selected — proved by unit test (2).
  //   - SERVER:  even if a buggy/malicious client sent ONLY a productId (no
  //              variantId), the server-side cart-add now REJECTS the call
  //              for products that have variants ("Please choose a variant.")
  //              — preventing the wrong-price-at-checkout class of bug.
  //
  // Below we assert that server defence:

  const product = await prisma.product.findFirst({
    where: { isActive: true, variants: { some: { isActive: true, stock: { gte: 1 } } } },
    include: { variants: true },
  });
  if (!product) throw new Error('No multi-variant product for regression test.');

  const ru = await prisma.user.create({
    data: {
      firstName: 'R', lastName: 'Test', email: `vp_r_${Date.now()}@shopcore.test`,
      phone: freshPhone(), passwordHash: await hashPassword('TestPass#9k2'),
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      // STATE_MACHINE_BYPASS: test-fixture seeding (initial-row insert).
      pinCode: '400001', country: 'India', role: 'CUSTOMER', status: 'ACTIVE',
    },
  });

  // Attempt #1: client sends productId only, NO variantId — server must refuse
  const bad = await addToCart({ userId: ru.id, productId: product.id, variantId: null, quantity: 1 });
  if (bad.ok) fail('regression: cart-add WITHOUT variantId should be rejected for products with variants', 'reject', 'accepted');
  ok(`regression: cart-add without variantId rejected: "${bad.reason}"`);

  // Attempt #2: client sends a fabricated variantId — server must refuse
  const bad2 = await addToCart({ userId: ru.id, productId: product.id, variantId: 'forged-' + Date.now(), quantity: 1 });
  if (bad2.ok) fail('regression: cart-add with fake variantId should be rejected', 'reject', 'accepted');
  ok(`regression: cart-add with fake variantId rejected: "${bad2.reason}"`);

  // Attempt #3: client sends the cheap variantId — server uses CHEAP price, not whichever was first
  const cheap = [...product.variants].filter((v) => v.isActive && v.stock > 0).sort((a, b) => a.pricePaise - b.pricePaise)[0];
  const good = await addToCart({ userId: ru.id, productId: product.id, variantId: cheap.id, quantity: 1 });
  if (!good.ok) fail('regression: legitimate cart-add should succeed', 'ok', good.reason);
  const cart = await getCartView(ru.id, priceCtxForUser(ru, null));
  eq('regression: legitimate cart-add uses the EXACT variant price submitted',
     cheap.pricePaise, cart.items[0]?.unitPricePaise);

  // CLEANUP
  await prisma.cartItem.deleteMany({ where: { cart: { userId: ru.id } } });
  await prisma.cart.deleteMany({ where: { userId: ru.id } });
  await prisma.userActivity.deleteMany({ where: { userId: ru.id } });
  await prisma.user.delete({ where: { id: ru.id } });
}

async function main() {
  unitTests();
  await integrationTests();
  await regressionTests();
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────\n`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
