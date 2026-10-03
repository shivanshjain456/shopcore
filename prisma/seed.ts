/**
 * One-time seed script:
 *  - Bootstraps the first admin from env vars
 *  - Seeds default StoreConfig
 *  - Seeds default B2B tiers
 *  - Seeds a handful of categories + brands for the chosen vertical
 *
 * Re-running is safe: every operation is idempotent.
 *
 * Usage:  npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEFAULT_STORE_CONFIG } from '../src/lib/config';
import { seedJobSchedules } from '../src/lib/jobs/scheduler';

const prisma = new PrismaClient();

async function main() {
  // ── StoreConfig
  await prisma.storeConfig.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton', data: JSON.stringify(DEFAULT_STORE_CONFIG) },
  });
  console.log('✔ StoreConfig ready');

  // ── B2B tiers
  const tiers = [
    { name: 'Silver',   discountPercent: 5,  minOrderPaise: 0 },
    { name: 'Gold',     discountPercent: 10, minOrderPaise: 5000000 },
    { name: 'Platinum', discountPercent: 15, minOrderPaise: 25000000 },
  ];
  for (const t of tiers) {
    await prisma.b2BTier.upsert({
      where: { name: t.name },
      update: t,
      create: t,
    });
  }
  console.log('✔ B2B tiers ready');

  // ── Categories
  const cats = [
    { name: 'Laptops',     slug: 'laptops',     sortOrder: 1 },
    { name: 'Desktops',    slug: 'desktops',    sortOrder: 2 },
    { name: 'Computers',   slug: 'computers',   sortOrder: 3 },
    { name: 'Accessories', slug: 'accessories', sortOrder: 4 },
    { name: 'Electronics', slug: 'electronics', sortOrder: 5 },
  ];
  for (const c of cats) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      update: c,
      create: c,
    });
  }
  console.log('✔ Categories ready');

  // ── Brands (common ones; admin can edit/add)
  const brands = ['Dell', 'HP', 'Lenovo', 'Apple', 'Asus', 'Acer', 'MSI', 'Logitech', 'Samsung'];
  for (const name of brands) {
    const slug = name.toLowerCase();
    await prisma.brand.upsert({
      where: { slug },
      update: { name },
      create: { name, slug },
    });
  }
  console.log('✔ Brands ready');

  // ── Bootstrap admin
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@shopcore.internal';
  const pass = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'ShopCoreAdmin#2026';
  const phone = process.env.BOOTSTRAP_ADMIN_PHONE || '+910000000000';

  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email },
        { phone },
      ],
    },
  });

  if (!existing) {
    const hash = await bcrypt.hash(pass, 12);
    await prisma.user.create({
      data: {
        firstName:    process.env.BOOTSTRAP_ADMIN_FIRSTNAME ?? 'Store',
        lastName:     process.env.BOOTSTRAP_ADMIN_LASTNAME  ?? 'Admin',
        email,
        phone,
        passwordHash: hash,
        addressLine1: 'HQ',
        addressLine2: '-',
        city:         'Mumbai',
        state:        'Maharashtra',
        pinCode:      '400001',
        country:      'India',
        role:         'ADMIN',
        // STATE_MACHINE_BYPASS: seed-time bootstrap. The Account State
        // Machine governs runtime status TRANSITIONS; this insert sets
        // the initial state for a brand-new admin row, no prior state
        // exists.
        status:       'ACTIVE',
      },
    });
    console.log(`✔ Bootstrap admin created: ${email}`);
  } else {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    console.log(`✔ Admin ensured: ${existing.email}`);
  }

  // ── Background Job schedules (Item 7) ─────────────────────────────────
  // Idempotent upsert of all built-in JobSchedule rows.
  const sched = await seedJobSchedules();
  console.log(`✔ Job schedules ready (created=${sched.created} updated=${sched.updated} unchanged=${sched.unchanged})`);

  console.log('\n✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
