/**
 * Server-side analytics. Computed live (no caching layer needed at our scale).
 */
import { prisma } from '@/lib/db/client';

export interface Kpis {
  revenue30Paise: number;
  ordersCount30: number;
  averageOrderValuePaise: number;
  conversionRate: number;       // ordering users / active users in last 30d
  customerLifetimeValuePaise: number; // mean lifetime spend across customers with ≥1 verified order
  topProducts: { id: string; name: string; sku: string; unitsSold: number; revenuePaise: number }[];
  revenueByDay: { date: string; revenuePaise: number; orders: number }[];
  inventoryForecast: { sku: string; name: string; stock: number; weeklyVelocity: number; daysOfStock: number }[];
}

export async function computeKpis(): Promise<Kpis> {
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * 86400_000);

  const verifiedRecent = await prisma.order.findMany({
    where: { paymentStatus: 'VERIFIED', createdAt: { gte: since30 } },
    include: { items: { include: { product: { select: { id: true, name: true, sku: true } } } } },
  });

  const revenue30 = verifiedRecent.reduce((s, o) => s + o.totalPaise, 0);
  const ordersCount30 = verifiedRecent.length;
  const aov = ordersCount30 > 0 ? Math.round(revenue30 / ordersCount30) : 0;

  // Conversion rate: distinct ordering users (verified) / users who had any activity in 30d
  const orderingUsers = new Set(verifiedRecent.map((o) => o.userId)).size;
  const activeUsers = await prisma.user.count({
    where: { lastLoginAt: { gte: since30 } },
  });
  const conversionRate = activeUsers > 0 ? orderingUsers / activeUsers : 0;

  // CLV = total verified spend / number of customers with ≥1 verified order
  const allVerified = await prisma.order.groupBy({
    by: ['userId'], where: { paymentStatus: 'VERIFIED' }, _sum: { totalPaise: true },
  });
  const totalLifetime = allVerified.reduce((s, r) => s + (r._sum.totalPaise ?? 0), 0);
  const lifetimeCustomers = allVerified.length;
  const clv = lifetimeCustomers > 0 ? Math.round(totalLifetime / lifetimeCustomers) : 0;

  // Top products by units in last 30 days
  const productAgg = new Map<string, { id: string; name: string; sku: string; units: number; revenue: number }>();
  for (const o of verifiedRecent) {
    for (const it of o.items) {
      const e = productAgg.get(it.productId) ?? { id: it.product.id, name: it.product.name, sku: it.product.sku, units: 0, revenue: 0 };
      e.units += it.quantity; e.revenue += it.lineTotalPaise;
      productAgg.set(it.productId, e);
    }
  }
  const topProducts = Array.from(productAgg.values())
    .sort((a, b) => b.units - a.units).slice(0, 10)
    .map((e) => ({ id: e.id, name: e.name, sku: e.sku, unitsSold: e.units, revenuePaise: e.revenue }));

  // Revenue by day (last 30 days)
  const byDay = new Map<string, { rev: number; orders: number }>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    byDay.set(d.toISOString().slice(0, 10), { rev: 0, orders: 0 });
  }
  for (const o of verifiedRecent) {
    const k = o.createdAt.toISOString().slice(0, 10);
    const slot = byDay.get(k);
    if (slot) { slot.rev += o.totalPaise; slot.orders += 1; }
  }
  const revenueByDay = Array.from(byDay.entries()).map(([date, v]) => ({ date, revenuePaise: v.rev, orders: v.orders }));

  // Inventory forecast: 30-day units / 4.28 = weekly velocity → days-of-stock = stock / (vel/7)
  const products = await prisma.product.findMany({ where: { isActive: true } });
  const inventoryForecast = products.map((p) => {
    const last30 = productAgg.get(p.id)?.units ?? 0;
    const weekly = last30 / 4.286;
    const daily = weekly / 7;
    const daysOfStock = daily > 0 ? Math.round(p.stock / daily) : 9999;
    return { sku: p.sku, name: p.name, stock: p.stock, weeklyVelocity: Math.round(weekly * 10) / 10, daysOfStock };
  }).filter((x) => x.weeklyVelocity > 0 || x.stock <= 5).sort((a, b) => a.daysOfStock - b.daysOfStock).slice(0, 20);

  return {
    revenue30Paise: revenue30, ordersCount30, averageOrderValuePaise: aov,
    conversionRate: Math.round(conversionRate * 1000) / 10,  // percent with 1 decimal
    customerLifetimeValuePaise: clv,
    topProducts, revenueByDay, inventoryForecast,
  };
}
