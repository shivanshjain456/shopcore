/**
 * Loyalty bug-fix regression suite.
 *
 *   npm run test:loyalty
 *
 * Three layers:
 *
 *   1. UNIT TESTS        — pure-function `computeEarnedPoints()` math.
 *                          Exhaustive: every mode, every basis, every rounding,
 *                          disabled paths, cap clamp, min-order floor.
 *
 *   2. INTEGRATION TESTS — full DB lifecycle: place an order, then verify
 *                          payment, assert the credited points equal the
 *                          snapshot — across several admin-set formulas.
 *                          Also asserts IDEMPOTENCY: re-verifying the same
 *                          order does NOT double-credit.
 *
 *   3. REGRESSION TESTS  — the old buggy formula behaviour is impossible to
 *                          reproduce now: even with the worst-case config
 *                          (5% PERCENT, SUBTOTAL basis, CEIL), the credit
 *                          for a ₹51,990 order is at most ₹2,600 worth of
 *                          points, NEVER ₹51,990.
 *
 * Exit 0 on full pass; non-zero on first failure with a clear assertion.
 */
// Allow @shopcore.test email addresses for fixtures (Feature #10 policy bypass).
process.env.SHOPCORE_ALLOW_TEST_EMAILS = '1';
import { prisma } from '../src/lib/db/client';
import { computeEarnedPoints, toLoyaltyConfig, type LoyaltyConfig } from '../src/lib/account/loyaltyFormula';
import { placeOrder } from '../src/lib/checkout/placeOrder';
import { verifyPayment } from '../src/lib/admin/orders';
import { hashPassword } from '../src/lib/auth/password';
import { getStoreConfig } from '../src/lib/checkout/storeConfig';
import { invalidateConfigCache } from '../src/lib/storeConfig';
import { DEFAULT_STORE_CONFIG } from '../src/lib/config';

let passed = 0; let failed = 0;
function ok(label: string)  { passed++; console.log(`  ✔ ${label}`); }
function fail(label: string, expected: unknown, actual: unknown): never {
  failed++;
  console.error(`  ✘ ${label}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
  process.exit(1);
}
function eq<T>(label: string, expected: T, actual: T) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) ok(label);
  else fail(label, expected, actual);
}

// ────────────────────────────────────────────────────────── 1. UNIT TESTS

function unitTests() {
  console.log('\n── UNIT TESTS ──');

  const base: LoyaltyConfig = toLoyaltyConfig({
    enabled: true, mode: 'PER_AMOUNT',
    pointsPerAmount: 1, amountUnitPaise: 10_000, percentBps: 0,
    eligibleBasis: 'SUBTOTAL_MINUS_DISCOUNT', rounding: 'FLOOR',
    minOrderPaise: 0, maxPointsPerOrder: null,
    redeemValuePaise: 100, signupBonus: 0, referrerBonus: 0, refereeBonus: 0,
  });

  // ── A. Disabled paths
  eq('disabled flag → 0',
     0, computeEarnedPoints({ ...base, enabled: false }, { subtotalPaise: 51_99000, discountPaise: 0 }).points);
  eq('mode DISABLED → 0',
     0, computeEarnedPoints({ ...base, mode: 'DISABLED' }, { subtotalPaise: 51_99000, discountPaise: 0 }).points);

  // ── B. PER_AMOUNT — the canonical "1 pt per ₹100 spent"
  eq('PER_AMOUNT: ₹51,990 → 519 pts (1 pt/₹100, FLOOR)',
     519, computeEarnedPoints(base, { subtotalPaise: 51_99000, discountPaise: 0 }).points);

  // 1 pt per ₹10 spent → ₹51,990 → 5,199 pts
  eq('PER_AMOUNT: 1 pt per ₹10 → 5,199',
     5_199, computeEarnedPoints({ ...base, amountUnitPaise: 1_000 }, { subtotalPaise: 51_99000, discountPaise: 0 }).points);

  // 2 pts per ₹100 → 1,038
  eq('PER_AMOUNT: 2 pts per ₹100 → 1,038',
     1_038, computeEarnedPoints({ ...base, pointsPerAmount: 2 }, { subtotalPaise: 51_99000, discountPaise: 0 }).points);

  // Basis: SUBTOTAL vs SUBTOTAL_MINUS_DISCOUNT
  eq('basis MINUS_DISCOUNT: ₹51,990 sub - ₹4,990 disc → 470',
     470, computeEarnedPoints(base,
       { subtotalPaise: 51_99000, discountPaise: 49_9000 }).points);
  eq('basis SUBTOTAL: ignores discount → 519',
     519, computeEarnedPoints({ ...base, eligibleBasis: 'SUBTOTAL' },
       { subtotalPaise: 51_99000, discountPaise: 49_9000 }).points);

  // ── C. PERCENT — 5% cashback (1 pt = ₹1)
  // 5% of ₹51,990 = ₹2,599.50 cashback ÷ ₹1 per point = 2,599 pts (FLOOR)
  eq('PERCENT: 5% of ₹51,990 → 2,599 pts (1 pt = ₹1)',
     2_599, computeEarnedPoints({ ...base, mode: 'PERCENT', percentBps: 500 },
       { subtotalPaise: 51_99000, discountPaise: 0 }).points);
  // Same 5% but with 1 pt = ₹0.10 → 25,995 pts
  eq('PERCENT: 5% of ₹51,990, 1 pt = ₹0.10 → 25,995 pts',
     25_995, computeEarnedPoints({ ...base, mode: 'PERCENT', percentBps: 500, redeemValuePaise: 10 },
       { subtotalPaise: 51_99000, discountPaise: 0 }).points);

  // ── D. Rounding
  // 1.5% of ₹100 = ₹1.50 cashback ÷ ₹1 per point = 1 pt (FLOOR/ROUND), 2 (CEIL)
  eq('PERCENT 1.5% of ₹100 FLOOR → 1', 1, computeEarnedPoints({ ...base, mode: 'PERCENT', percentBps: 150, rounding: 'FLOOR' }, { subtotalPaise: 10_000, discountPaise: 0 }).points);
  eq('PERCENT 1.5% of ₹100 ROUND → 2', 2, computeEarnedPoints({ ...base, mode: 'PERCENT', percentBps: 150, rounding: 'ROUND' }, { subtotalPaise: 10_000, discountPaise: 0 }).points);
  eq('PERCENT 1.5% of ₹100 CEIL → 2',  2, computeEarnedPoints({ ...base, mode: 'PERCENT', percentBps: 150, rounding: 'CEIL'  }, { subtotalPaise: 10_000, discountPaise: 0 }).points);

  // ── E. Caps + floors
  eq('minOrder ₹500 — order ₹400 → 0',
     0, computeEarnedPoints({ ...base, minOrderPaise: 50_000 },
       { subtotalPaise: 40_000, discountPaise: 0 }).points);
  eq('maxPointsPerOrder 100 — 519 capped to 100',
     100, computeEarnedPoints({ ...base, maxPointsPerOrder: 100 },
       { subtotalPaise: 51_99000, discountPaise: 0 }).points);

  // ── F. Defensive: garbage inputs collapse to 0
  eq('NaN pointsPerAmount → 0',
     0, computeEarnedPoints({ ...base, pointsPerAmount: NaN as unknown as number }, { subtotalPaise: 10_000, discountPaise: 0 }).points);
  eq('Negative subtotal → 0',
     0, computeEarnedPoints(base, { subtotalPaise: -100, discountPaise: 0 }).points);

  // ── G. THE BUG: assert the old behaviour cannot happen again.
  // The bug: (subtotal_paise / 100) * earnRate=1  ⇒ 51,990 points on a ₹51,990 order
  //          which redeems for ₹51,990 — 100% of order value, given away as cashback.
  // The fix expresses everything in POINTS-OF-MONETARY-VALUE; with sane defaults a
  // ₹51,990 order earns 519 pts (= ₹519 redeemable). 5% cashback (PERCENT mode) yields
  // 2,599 pts (= ₹2,599 redeemable). Either is dramatically below 100%.
  const order = { subtotalPaise: 51_99000, discountPaise: 0 };
  const defaultPts = computeEarnedPoints(toLoyaltyConfig({
    enabled: true, mode: 'PER_AMOUNT', pointsPerAmount: 1, amountUnitPaise: 10_000,
  }), order).points;
  eq('REGRESSION: default formula on ₹51,990 → 519 pts (was 51,990)', 519, defaultPts);

  const fivePct = computeEarnedPoints(toLoyaltyConfig({
    enabled: true, mode: 'PERCENT', percentBps: 500, rounding: 'FLOOR',
  }), order).points;
  eq('REGRESSION: 5% cashback on ₹51,990 → 2,599 pts (= ₹2,599 redeemable)', 2_599, fivePct);

  // Even 10% — the most generous realistic admin choice — is still 10% of order,
  // never the full order amount.
  const tenPct = computeEarnedPoints(toLoyaltyConfig({
    enabled: true, mode: 'PERCENT', percentBps: 1000, rounding: 'CEIL',
  }), order).points;
  if (tenPct > order.subtotalPaise / 10) {
    fail('REGRESSION: 10% mode should not exceed 10% of order value', `≤ ${order.subtotalPaise / 10}`, tenPct);
  }
  ok(`REGRESSION: 10% cashback on ₹51,990 → ${tenPct} pts (= ₹${tenPct} redeemable, bounded by admin %)`);
}

// ────────────────────────────────────────────────────── 2. INTEGRATION TESTS

async function setConfig(loyalty: Partial<LoyaltyConfig>) {
  const current = await getStoreConfig();
  const merged = { ...current, loyalty: { ...current.loyalty, ...loyalty } };
  await prisma.storeConfig.upsert({
    where: { id: 'singleton' },
    update: { data: JSON.stringify(merged) },
    create: { id: 'singleton', data: JSON.stringify(merged) },
  });
  invalidateConfigCache();
}

function freshPhone() {
  return '+91' + '9' + String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
}

async function setupUser(suffix: string) {
  const email = `loyalty_${Date.now()}_${suffix}@shopcore.test`;
  const passwordHash = await hashPassword('TestPass#9k2');
  const phone = freshPhone();
  const user = await prisma.user.create({
    data: {
      firstName: 'Loy', lastName: 'Test', email, phone, passwordHash,
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      // STATE_MACHINE_BYPASS: test-fixture seeding (initial-row insert).
      pinCode: '400001', country: 'India', role: 'CUSTOMER', status: 'ACTIVE',
    },
  });
  const addr = await prisma.address.create({
    data: { userId: user.id, fullName: 'Loy Test', phone,
      addressLine1: 'X', addressLine2: 'Y', city: 'Mumbai', state: 'Maharashtra',
      pinCode: '400001', country: 'India', isDefault: true },
  });
  return { user: await prisma.user.findUniqueOrThrow({ where: { id: user.id } }), addressId: addr.id };
}

async function placeAndVerify(productSku: string, qty: number, suffix: string) {
  const { user, addressId } = await setupUser(suffix);
  const product = await prisma.product.findUniqueOrThrow({ where: { sku: productSku } });
  // Put into cart directly (faster than going through API)
  const cart = await prisma.cart.create({ data: { userId: user.id } });
  await prisma.cartItem.create({ data: { cartId: cart.id, productId: product.id, variantId: null, quantity: qty } });

  // Generate a UTR that PASSES our format + fraud-pattern filters per call:
  //   - 12 digits (UPI shape)
  //   - leading "4" (never all-zero / all-repeated)
  //   - rest is random-with-time-seed so each test run is unique
  const utr12 = `4${Math.floor(Math.random() * 9 + 1)}${Date.now().toString().slice(-10)}`.slice(0, 12).padStart(12, '7');
  const placed = await placeOrder({
    user, shippingAddressId: addressId,
    paymentMethod: 'UPI',
    utrNumber: utr12,
    receiptUrl: '/api/uploads/receipts/test/dummy.jpg',
  });
  if (!placed.ok) throw new Error('placeOrder failed: ' + placed.reason);

  // Read the snapshot
  const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
  const beforeBal = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).loyaltyPoints;

  // Verify payment as admin
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
  const v1 = await verifyPayment(admin.id, placed.orderId, null, { amountMatches: true });
  if (!v1.ok) throw new Error('verifyPayment failed: ' + v1.reason);

  const afterBal = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).loyaltyPoints;
  const credit = afterBal - beforeBal;

  // Idempotency: re-verify — should not change balance
  const v2 = await verifyPayment(admin.id, placed.orderId, null, { amountMatches: true });
  const afterBal2 = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).loyaltyPoints;
  const idempotent = afterBal === afterBal2 && !v2.ok;

  return {
    user, orderId: placed.orderId, subtotalPaise: order.subtotalPaise,
    snapshotPoints: order.loyaltyPointsEarned, snapshotJson: order.loyaltyFormulaSnapshot,
    credited: credit, idempotent,
  };
}

async function integrationTests() {
  console.log('\n── INTEGRATION TESTS ──');

  // Pick a real seeded product with healthy stock
  const product = await prisma.product.findFirst({ where: { isActive: true, stock: { gte: 5 } } });
  if (!product) throw new Error('No product with stock to test against. Run npm run db:seed:products.');

  // Case A: 1 point per ₹100 (default-ish)
  await setConfig({ enabled: true, mode: 'PER_AMOUNT', pointsPerAmount: 1, amountUnitPaise: 10_000,
                    eligibleBasis: 'SUBTOTAL_MINUS_DISCOUNT', rounding: 'FLOOR',
                    minOrderPaise: 0, maxPointsPerOrder: null });
  const r1 = await placeAndVerify(product.sku, 1, 'A');
  const expected1 = Math.floor(r1.subtotalPaise / 10_000);
  eq(`A) PER_AMOUNT 1/₹100 credits ${expected1} pts`, expected1, r1.credited);
  eq('A) snapshot matches credit', r1.snapshotPoints, r1.credited);
  eq('A) idempotent on re-verify', true, r1.idempotent);

  // Case B: 1 point per ₹10
  await setConfig({ enabled: true, mode: 'PER_AMOUNT', pointsPerAmount: 1, amountUnitPaise: 1_000 });
  const r2 = await placeAndVerify(product.sku, 1, 'B');
  const expected2 = Math.floor(r2.subtotalPaise / 1_000);
  eq(`B) PER_AMOUNT 1/₹10 credits ${expected2} pts`, expected2, r2.credited);

  // Case C: 5% PERCENT (cashback ÷ redeemValuePaise=100 default)
  await setConfig({ enabled: true, mode: 'PERCENT', percentBps: 500, redeemValuePaise: 100 });
  const r3 = await placeAndVerify(product.sku, 1, 'C');
  const expected3 = Math.floor(r3.subtotalPaise * 500 / 10_000 / 100);
  eq(`C) PERCENT 5% credits ${expected3} pts (5% cashback at 1pt=₹1)`, expected3, r3.credited);

  // Case D: DISABLED mode
  await setConfig({ enabled: true, mode: 'DISABLED' });
  const r4 = await placeAndVerify(product.sku, 1, 'D');
  eq('D) DISABLED mode credits 0', 0, r4.credited);

  // Case E: enabled=false
  await setConfig({ enabled: false, mode: 'PER_AMOUNT', pointsPerAmount: 100, amountUnitPaise: 100 });
  const r5 = await placeAndVerify(product.sku, 1, 'E');
  eq('E) enabled=false credits 0 regardless of mode', 0, r5.credited);

  // Case F: cap clamp
  await setConfig({ enabled: true, mode: 'PER_AMOUNT', pointsPerAmount: 1, amountUnitPaise: 1_000, maxPointsPerOrder: 50 });
  const r6 = await placeAndVerify(product.sku, 1, 'F');
  eq('F) maxPointsPerOrder=50 caps the credit', 50, r6.credited);

  // Case G: minOrder floor
  await setConfig({ enabled: true, mode: 'PER_AMOUNT', pointsPerAmount: 1, amountUnitPaise: 10_000, minOrderPaise: 99_99_99999, maxPointsPerOrder: null });
  const r7 = await placeAndVerify(product.sku, 1, 'G');
  eq('G) minOrderPaise above order value → 0', 0, r7.credited);

  // Cleanup test users + orders
  for (const r of [r1, r2, r3, r4, r5, r6, r7]) {
    await prisma.utrSubmission.deleteMany({ where: { userId: r.user.id } });
    await prisma.inventoryLog.deleteMany({ where: { performedBy: r.user.id } });
    await prisma.orderItem.deleteMany({ where: { order: { userId: r.user.id } } });
    await prisma.orderStatusHistory.deleteMany({ where: { order: { userId: r.user.id } } });
    await prisma.loyaltyLedger.deleteMany({ where: { userId: r.user.id } });
    await prisma.order.deleteMany({ where: { userId: r.user.id } });
    await prisma.cartItem.deleteMany({ where: { cart: { userId: r.user.id } } });
    await prisma.cart.deleteMany({ where: { userId: r.user.id } });
    await prisma.userActivity.deleteMany({ where: { userId: r.user.id } });
    await prisma.address.deleteMany({ where: { userId: r.user.id } });
    await prisma.user.delete({ where: { id: r.user.id } });
  }

  // Restore default loyalty config
  await setConfig(DEFAULT_STORE_CONFIG.loyalty as Partial<LoyaltyConfig>);

  // Restore stock that the 7 test orders consumed
  await prisma.product.update({ where: { id: product.id }, data: { stock: { increment: 7 } } });
}

// ────────────────────────────────────────────────────── 3. REGRESSION

async function regressionTests() {
  console.log('\n── REGRESSION ──');

  // 3a. The bug shape ('earnRate' field on its own) doesn't even compile any more
  //     because computeEarnedPoints() requires mode + pointsPerAmount/percentBps.
  //     Demonstrate that an OLD config blob (only enabled + earnRate) is treated
  //     as DISABLED via toLoyaltyConfig() defaults — fail-safe, NOT over-credit.
  const legacyShape = { enabled: true, earnRate: 1 } as unknown as Record<string, unknown>;
  const conf = toLoyaltyConfig(legacyShape);
  eq('legacy {enabled, earnRate:1} blob defaults to mode=DISABLED (fail-safe)', 'DISABLED', conf.mode);
  eq('legacy blob → 0 points (fail-safe, NOT 51,990)',
     0, computeEarnedPoints(conf, { subtotalPaise: 51_99000, discountPaise: 0 }).points);

  // 3b. The CORRECT 1pt/₹100 default credits 519 pts on a ₹51,990 order, NOT 51,990.
  const correct = computeEarnedPoints(
    toLoyaltyConfig({ enabled: true, mode: 'PER_AMOUNT', pointsPerAmount: 1, amountUnitPaise: 10_000,
                      eligibleBasis: 'SUBTOTAL_MINUS_DISCOUNT', rounding: 'FLOOR' }),
    { subtotalPaise: 51_99000, discountPaise: 0 },
  ).points;
  eq('default formula on ₹51,990 → 519 pts (was 51,990 in the bug)', 519, correct);

  // 3c. 100% PERCENT is the only way to "fully refund" via points, and it must
  //     be an explicit admin choice (`percentBps: 10000`) — never accidental.
  const fullCashback = computeEarnedPoints(
    toLoyaltyConfig({ enabled: true, mode: 'PERCENT', percentBps: 10_000, redeemValuePaise: 100 }),
    { subtotalPaise: 51_99000, discountPaise: 0 },
  ).points;
  eq('100% PERCENT cashback equals exactly order value in pts (admin-explicit)', 51_990, fullCashback);
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
