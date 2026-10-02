/**
 * Seed real-looking products so the storefront has something to render
 * immediately. Idempotent — re-runnable. In Phase 7 the admin replaces all
 * of this via Excel upload.
 *
 * Usage:   npm run db:seed:products
 */
import { PrismaClient } from '@prisma/client';
import { kindFromName, productTileDataUri, accentFor } from '../src/lib/catalog/imageTile';

const prisma = new PrismaClient();

interface Seed {
  sku: string;
  name: string;
  shortDesc: string;
  description: string;
  category: 'laptops' | 'desktops' | 'computers' | 'accessories' | 'electronics';
  brand: string;
  mrp: number;        // ₹
  price: number;      // ₹
  b2bPrice?: number;  // ₹
  stock: number;
  featured?: boolean;
  hsn?: string;
  gst?: number;
  aiTags: string[];
  variants?: Array<{ name: string; attrs: Record<string, string>; mrp: number; price: number; b2bPrice?: number; stock: number }>;
}

const products: Seed[] = [
  // ── Laptops
  {
    sku: 'LAP-DELL-INSP15-001',
    name: 'Dell Inspiron 15 3520',
    shortDesc: '15.6" FHD · Intel Core i5-1235U · 8 GB RAM · 512 GB SSD',
    description: 'A reliable everyday laptop for work and study. 15.6-inch Full HD anti-glare display, 12th-gen Intel Core i5, 8 GB DDR4 (expandable), 512 GB NVMe SSD, Windows 11 Home. Backlit keyboard. 1-year onsite warranty.',
    category: 'laptops', brand: 'Dell',
    mrp: 62990, price: 51990, b2bPrice: 49490, stock: 18, featured: true,
    hsn: '8471', gst: 18,
    aiTags: ['intel', 'i5', 'fhd', 'student', 'office', 'home', 'budget'],
    variants: [
      { name: '8 GB / 512 GB SSD',  attrs: { ram: '8GB',  storage: '512GB SSD' }, mrp: 62990, price: 51990, b2bPrice: 49490, stock: 12 },
      { name: '16 GB / 512 GB SSD', attrs: { ram: '16GB', storage: '512GB SSD' }, mrp: 69990, price: 57990, b2bPrice: 55490, stock: 6 },
      { name: '16 GB / 1 TB SSD',   attrs: { ram: '16GB', storage: '1TB SSD' },   mrp: 76990, price: 63990, b2bPrice: 61490, stock: 4 },
    ],
  },
  {
    sku: 'LAP-HP-PAV14-002',
    name: 'HP Pavilion 14',
    shortDesc: '14" FHD IPS · Ryzen 5 7530U · 16 GB RAM · 512 GB SSD',
    description: 'Lightweight 14-inch laptop with AMD Ryzen 5 7530U, 16 GB DDR4, 512 GB NVMe SSD, FHD IPS micro-edge display, Windows 11 Home. Audio by B&O.',
    category: 'laptops', brand: 'HP',
    mrp: 74990, price: 64990, b2bPrice: 62490, stock: 9, featured: true,
    hsn: '8471', gst: 18,
    aiTags: ['ryzen', 'amd', 'portable', 'ips', 'thin', 'light'],
  },
  {
    sku: 'LAP-LEN-IDP3-003',
    name: 'Lenovo IdeaPad Slim 3',
    shortDesc: '15.6" FHD · Core i3-1215U · 8 GB · 256 GB SSD',
    description: 'Entry-level Lenovo IdeaPad Slim 3 with 12th-gen Intel Core i3, 8 GB DDR4, 256 GB SSD, FHD 250-nits anti-glare. Great budget pick for college and home use.',
    category: 'laptops', brand: 'Lenovo',
    mrp: 44990, price: 36990, b2bPrice: 35490, stock: 22,
    hsn: '8471', gst: 18,
    aiTags: ['i3', 'budget', 'college', 'home', 'slim'],
  },
  {
    sku: 'LAP-APPLE-MBA13-004',
    name: 'Apple MacBook Air 13 (M3)',
    shortDesc: '13.6" Liquid Retina · Apple M3 · 8 GB · 256 GB SSD',
    description: 'Apple MacBook Air with M3 chip — 8-core CPU, 8-core GPU, 8 GB unified memory, 256 GB SSD, 13.6-inch Liquid Retina display. Up to 18 hours of battery life. macOS Sonoma.',
    category: 'laptops', brand: 'Apple',
    mrp: 114900, price: 99990, b2bPrice: 96490, stock: 6, featured: true,
    hsn: '8471', gst: 18,
    aiTags: ['apple', 'm3', 'silicon', 'macos', 'retina', 'premium'],
    variants: [
      { name: '8 GB / 256 GB · Midnight',     attrs: { ram: '8GB',  storage: '256GB', color: 'Midnight' },     mrp: 114900, price: 99990,  b2bPrice: 96490,  stock: 3 },
      { name: '8 GB / 512 GB · Starlight',    attrs: { ram: '8GB',  storage: '512GB', color: 'Starlight' },    mrp: 134900, price: 119990, b2bPrice: 116490, stock: 2 },
      { name: '16 GB / 512 GB · Space Grey',  attrs: { ram: '16GB', storage: '512GB', color: 'Space Grey' },   mrp: 154900, price: 139990, b2bPrice: 136490, stock: 1 },
    ],
  },
  {
    sku: 'LAP-ASUS-VB15-005',
    name: 'Asus Vivobook 15',
    shortDesc: '15.6" FHD · Core i5-12500H · 16 GB · 512 GB SSD',
    description: 'Asus Vivobook 15 with 12th-gen Intel H-series CPU, 16 GB DDR4, 512 GB SSD, full-HD display, backlit keyboard, ErgoSense touchpad. Windows 11 Home.',
    category: 'laptops', brand: 'Asus',
    mrp: 72990, price: 59990, b2bPrice: 57490, stock: 11,
    hsn: '8471', gst: 18,
    aiTags: ['vivobook', 'h-series', 'student', 'creator'],
  },
  {
    sku: 'LAP-LEN-TP-E14-006',
    name: 'Lenovo ThinkPad E14 Gen 5',
    shortDesc: '14" WUXGA · Core i5-1335U · 16 GB · 512 GB SSD',
    description: 'Business-grade ThinkPad E14 with 13th-gen Intel Core i5, 16 GB DDR4, 512 GB SSD, 14-inch WUXGA IPS display, MIL-SPEC durability, fingerprint reader, dTPM 2.0, Windows 11 Pro.',
    category: 'laptops', brand: 'Lenovo',
    mrp: 92990, price: 79990, b2bPrice: 76490, stock: 8, featured: true,
    hsn: '8471', gst: 18,
    aiTags: ['thinkpad', 'business', 'pro', 'fingerprint', 'durable'],
  },
  {
    sku: 'LAP-MSI-GF63-007',
    name: 'MSI GF63 Thin',
    shortDesc: 'Gaming · 15.6" FHD 144Hz · i5-12450H · RTX 2050 · 16 GB · 512 GB SSD',
    description: 'MSI GF63 Thin gaming laptop with 12th-gen Intel Core i5, NVIDIA RTX 2050 4 GB GDDR6, 16 GB DDR4, 512 GB NVMe SSD, 15.6-inch FHD 144Hz IPS-level panel, red backlit keyboard.',
    category: 'laptops', brand: 'MSI',
    mrp: 79990, price: 69990, b2bPrice: 67490, stock: 5,
    hsn: '8471', gst: 18,
    aiTags: ['gaming', 'rtx', '144hz', 'msi'],
  },
  {
    sku: 'LAP-ACER-A515-008',
    name: 'Acer Aspire 5',
    shortDesc: '15.6" FHD · Core i5-1235U · 8 GB · 512 GB SSD',
    description: 'Acer Aspire 5 thin-and-light with 12th-gen Intel Core i5, 8 GB DDR4, 512 GB NVMe SSD, full-HD IPS display, Wi-Fi 6, backlit keyboard, Windows 11 Home.',
    category: 'laptops', brand: 'Acer',
    mrp: 56990, price: 47990, b2bPrice: 45990, stock: 14,
    hsn: '8471', gst: 18,
    aiTags: ['aspire', 'thin', 'value'],
  },

  // ── Desktops
  {
    sku: 'DSK-DELL-OPT3000-101',
    name: 'Dell OptiPlex 3000 Micro',
    shortDesc: 'Compact · Core i5-12500T · 16 GB · 512 GB SSD',
    description: 'Dell OptiPlex 3000 Micro form factor with 12th-gen Intel Core i5 (T-series), 16 GB DDR4, 512 GB NVMe SSD, Wi-Fi, Windows 11 Pro. Ideal for offices.',
    category: 'desktops', brand: 'Dell',
    mrp: 68990, price: 58990, b2bPrice: 55990, stock: 10, featured: true,
    hsn: '8471', gst: 18,
    aiTags: ['office', 'micro', 'compact', 'pro'],
  },
  {
    sku: 'DSK-HP-PRODESK-102',
    name: 'HP ProDesk 400 G9 SFF',
    shortDesc: 'SFF · Core i5-12500 · 8 GB · 1 TB HDD',
    description: 'HP ProDesk 400 G9 Small Form Factor with 12th-gen Intel Core i5, 8 GB DDR4, 1 TB SATA HDD, DVD writer, Windows 11 Pro. 3-year onsite warranty.',
    category: 'desktops', brand: 'HP',
    mrp: 54990, price: 46990, b2bPrice: 44490, stock: 7,
    hsn: '8471', gst: 18,
    aiTags: ['sff', 'office', 'enterprise'],
  },
  {
    sku: 'DSK-LEN-M70Q-103',
    name: 'Lenovo ThinkCentre M70q Tiny',
    shortDesc: 'Tiny · Core i7-12700T · 16 GB · 512 GB SSD',
    description: 'Lenovo ThinkCentre M70q Gen 3 Tiny — palm-size desktop with 12th-gen Intel Core i7, 16 GB DDR4, 512 GB NVMe SSD, dual-display support, Windows 11 Pro.',
    category: 'desktops', brand: 'Lenovo',
    mrp: 84990, price: 72990, b2bPrice: 69990, stock: 6,
    hsn: '8471', gst: 18,
    aiTags: ['tiny', 'thinkcentre', 'i7'],
  },

  // ── Computers (workstations / AIO)
  {
    sku: 'CMP-HP-AIO24-201',
    name: 'HP All-in-One 24',
    shortDesc: '23.8" FHD · Core i3-1215U · 8 GB · 512 GB SSD',
    description: 'HP 24-inch All-in-One desktop with FHD IPS display, 12th-gen Intel Core i3, 8 GB DDR4, 512 GB SSD, wireless keyboard + mouse, Windows 11 Home.',
    category: 'computers', brand: 'HP',
    mrp: 51990, price: 44990, b2bPrice: 42990, stock: 8, featured: true,
    hsn: '8471', gst: 18,
    aiTags: ['aio', 'all-in-one', 'home', 'family'],
  },
  {
    sku: 'CMP-LEN-AIO3-202',
    name: 'Lenovo IdeaCentre AIO 3',
    shortDesc: '23.8" FHD · Ryzen 5 5500U · 8 GB · 256 GB SSD + 1 TB HDD',
    description: 'Lenovo IdeaCentre All-in-One 3 with AMD Ryzen 5 5500U, 8 GB DDR4, 256 GB SSD + 1 TB HDD, 23.8-inch FHD IPS, wireless KB+mouse, Windows 11 Home.',
    category: 'computers', brand: 'Lenovo',
    mrp: 49990, price: 42990, b2bPrice: 40990, stock: 5,
    hsn: '8471', gst: 18,
    aiTags: ['aio', 'ryzen', 'home'],
  },

  // ── Accessories
  {
    sku: 'ACC-LOG-MX3S-301',
    name: 'Logitech MX Master 3S',
    shortDesc: 'Wireless mouse · 8000 DPI · USB-C · Multi-device',
    description: 'Logitech MX Master 3S advanced wireless mouse — 8000 DPI dark-field tracking, MagSpeed scroll, USB-C fast charging, multi-device Easy-Switch, quiet clicks.',
    category: 'accessories', brand: 'Logitech',
    mrp: 11995, price: 8999, b2bPrice: 8499, stock: 40, featured: true,
    hsn: '8471', gst: 18,
    aiTags: ['mouse', 'wireless', 'productivity', 'mx'],
  },
  {
    sku: 'ACC-LOG-MX-KEYS-302',
    name: 'Logitech MX Keys S',
    shortDesc: 'Wireless keyboard · Backlit · USB-C · Multi-OS',
    description: 'Logitech MX Keys S full-size wireless keyboard with backlit keys, USB-C charging, Easy-Switch between three devices, Logi Bolt + Bluetooth.',
    category: 'accessories', brand: 'Logitech',
    mrp: 13495, price: 10999, b2bPrice: 10499, stock: 25,
    hsn: '8471', gst: 18,
    aiTags: ['keyboard', 'wireless', 'backlit', 'mx'],
  },
  {
    sku: 'ACC-DELL-SE2422H-303',
    name: 'Dell SE2422H 24" Monitor',
    shortDesc: '23.8" FHD · 75 Hz · VA · HDMI + VGA',
    description: 'Dell SE2422H 23.8-inch full-HD monitor with VA panel, 75 Hz refresh, 5 ms response, HDMI + VGA, tilt-adjust, 3-year exchange warranty.',
    category: 'accessories', brand: 'Dell',
    mrp: 11500, price: 8990, b2bPrice: 8490, stock: 16,
    hsn: '8528', gst: 18,
    aiTags: ['monitor', '24', 'fhd', 'display'],
  },
  {
    sku: 'ACC-SAM-S24F350-304',
    name: 'Samsung 24" FHD Monitor',
    shortDesc: '23.5" FHD · PLS · HDMI + VGA · AMD FreeSync',
    description: 'Samsung 24-inch FHD monitor with PLS panel, AMD FreeSync, Eye Saver Mode, HDMI + VGA inputs, slim bezel.',
    category: 'accessories', brand: 'Samsung',
    mrp: 12999, price: 9499, b2bPrice: 8999, stock: 10,
    hsn: '8528', gst: 18,
    aiTags: ['monitor', 'samsung', 'pls'],
  },
  {
    sku: 'ACC-LOG-H390-305',
    name: 'Logitech H390 USB Headset',
    shortDesc: 'USB · Noise-cancelling mic · In-line controls',
    description: 'Logitech H390 wired USB headset with noise-cancelling boom mic, in-line audio controls, padded ear cups. Plug-and-play.',
    category: 'accessories', brand: 'Logitech',
    mrp: 2995, price: 2199, b2bPrice: 1999, stock: 50,
    hsn: '8518', gst: 18,
    aiTags: ['headset', 'usb', 'work', 'meeting'],
  },
  {
    sku: 'ACC-SAM-T7-1TB-306',
    name: 'Samsung T7 1 TB Portable SSD',
    shortDesc: 'USB 3.2 Gen 2 · 1050 MB/s · Type-C',
    description: 'Samsung T7 portable SSD — 1 TB capacity, USB 3.2 Gen 2, read up to 1050 MB/s, write up to 1000 MB/s, AES-256 hardware encryption, shock-resistant.',
    category: 'accessories', brand: 'Samsung',
    mrp: 10999, price: 7999, b2bPrice: 7499, stock: 22,
    hsn: '8523', gst: 18,
    aiTags: ['ssd', 'storage', 'portable', 'usb-c'],
  },
  {
    sku: 'ACC-LOG-C920-307',
    name: 'Logitech C920 HD Pro Webcam',
    shortDesc: '1080p · Auto-focus · Stereo mic',
    description: 'Logitech C920 HD Pro webcam — full-HD 1080p video, auto-focus, dual stereo mics, universal clip, Plug-and-Play USB.',
    category: 'accessories', brand: 'Logitech',
    mrp: 8995, price: 6499, b2bPrice: 5999, stock: 14,
    hsn: '8525', gst: 18,
    aiTags: ['webcam', 'video', 'meeting', 'streaming'],
  },

  // ── Electronics (broader)
  {
    sku: 'ELE-TPLINK-AX1800-401',
    name: 'TP-Link Archer AX23 Wi-Fi 6 Router',
    shortDesc: 'Dual-band · AX1800 · OneMesh',
    description: 'TP-Link Archer AX23 dual-band AX1800 Wi-Fi 6 router with 4 high-gain antennas, OneMesh support, OFDMA, MU-MIMO.',
    category: 'electronics', brand: 'HP',  // brand placeholder; admin will fix in Phase 7
    mrp: 5499, price: 3999, b2bPrice: 3699, stock: 30,
    hsn: '8517', gst: 18,
    aiTags: ['router', 'wifi6', 'network'],
  },
  {
    sku: 'ELE-SAM-EAR2-402',
    name: 'Samsung Galaxy Buds2',
    shortDesc: 'TWS · ANC · 20 h battery',
    description: 'Samsung Galaxy Buds2 true-wireless earbuds with Active Noise Cancellation, ambient sound, up to 20 hours total battery with case, IPX2.',
    category: 'electronics', brand: 'Samsung',
    mrp: 11999, price: 7990, b2bPrice: 7490, stock: 18,
    hsn: '8518', gst: 18,
    aiTags: ['earbuds', 'tws', 'anc', 'samsung'],
  },
];

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  // Map slug → categoryId
  const cats = await prisma.category.findMany();
  const catBySlug = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
  const brands = await prisma.brand.findMany();
  const brandByName = Object.fromEntries(brands.map((b) => [b.name, b.id]));

  let created = 0, updated = 0;
  for (const p of products) {
    const catId = catBySlug[p.category];
    if (!catId) { console.warn(`skip ${p.sku}: no category ${p.category}`); continue; }
    let brandId = brandByName[p.brand];
    if (!brandId) {
      const b = await prisma.brand.create({ data: { name: p.brand, slug: slugify(p.brand) } });
      brandByName[p.brand] = b.id;
      brandId = b.id;
    }

    const slug = slugify(p.name);
    const accent = accentFor(p.sku);
    const kind = kindFromName(p.name);
    const imageUrl = productTileDataUri({
      kind, accent, label: p.brand + ' · ' + p.category, sub: p.shortDesc,
    });

    const existing = await prisma.product.findUnique({ where: { sku: p.sku } });
    const baseData = {
      name: p.name, slug, description: p.description, shortDesc: p.shortDesc,
      categoryId: catId, brandId,
      mrpPaise: p.mrp * 100, pricePaise: p.price * 100,
      b2bPricePaise: p.b2bPrice ? p.b2bPrice * 100 : null,
      gstRate: p.gst ?? 18, hsnCode: p.hsn,
      stock: p.stock, isActive: true, isFeatured: !!p.featured,
      aiTags: p.aiTags.join(','),
    };

    let productId: string;
    if (existing) {
      const upd = await prisma.product.update({ where: { id: existing.id }, data: baseData });
      productId = upd.id;
      updated++;
    } else {
      const cre = await prisma.product.create({ data: { sku: p.sku, ...baseData } });
      productId = cre.id;
      created++;
    }

    // Image: only one primary tile; keep idempotent by deleting then inserting
    await prisma.productImage.deleteMany({ where: { productId } });
    await prisma.productImage.create({
      data: { productId, url: imageUrl, alt: p.name, isPrimary: true, sortOrder: 0 },
    });

    // Variants
    if (p.variants && p.variants.length > 0) {
      const existingVars = await prisma.variant.findMany({ where: { productId } });
      const wantNames = new Set(p.variants.map((v) => v.name));
      for (const ev of existingVars) {
        if (!wantNames.has(ev.name)) await prisma.variant.delete({ where: { id: ev.id } });
      }
      for (let i = 0; i < p.variants.length; i++) {
        const v = p.variants[i];
        const vsku = `${p.sku}-V${i + 1}`;
        await prisma.variant.upsert({
          where: { sku: vsku },
          create: {
            sku: vsku, productId, name: v.name, attributes: JSON.stringify(v.attrs),
            mrpPaise: v.mrp * 100, pricePaise: v.price * 100,
            b2bPricePaise: v.b2bPrice ? v.b2bPrice * 100 : null,
            stock: v.stock, isActive: true,
          },
          update: {
            name: v.name, attributes: JSON.stringify(v.attrs),
            mrpPaise: v.mrp * 100, pricePaise: v.price * 100,
            b2bPricePaise: v.b2bPrice ? v.b2bPrice * 100 : null,
            stock: v.stock, isActive: true,
          },
        });
      }
    }
  }

  console.log(`\n✔ Seed-products done. Created ${created}, updated ${updated}.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
