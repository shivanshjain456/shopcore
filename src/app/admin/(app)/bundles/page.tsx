import { prisma } from '@/lib/db/client';
import { PageHeader, Card } from '@/components/admin/Helpers';

export const dynamic = 'force-dynamic';

export default async function BundlesAdmin() {
  const bundles = await prisma.bundle.findMany({ include: { items: { include: { product: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' } });
  return (
    <>
      <PageHeader title="Bundles" subtitle="Curated multi-product packs at a discount. Add via Excel import (sheet: bundles) in a future update; manual UI for now." />
      <Card>
        {bundles.length === 0 ? <p className="text-sm text-slate-500">No bundles yet.</p>
          : <ul className="divide-y divide-slate-100">
              {bundles.map((b) => (
                <li key={b.id} className="py-2 text-sm">
                  <p className="font-semibold">{b.name}</p>
                  <p className="text-xs text-slate-500">{b.items.map((i) => `${i.quantity}× ${i.product.name}`).join(' + ')} · ₹{b.pricePaise / 100}</p>
                </li>
              ))}
            </ul>}
      </Card>
    </>
  );
}
