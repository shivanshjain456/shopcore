/**
 * Excel I/O for admin bulk workflows.
 *
 * Three shapes:
 *   - exportProductsXlsx() → full catalogue with a fixed column schema
 *   - exportUsersXlsx()    → every user with every field (for the one-click backup)
 *   - importProductsXlsx() → upsert by SKU; variants stored on a 2nd sheet
 *   - importInventoryXlsx()→ apply +/- deltas or absolute stock per SKU
 *
 * The column schemas are documented in the README headers — admins can edit a
 * downloaded file and re-upload without changing structure.
 */
import ExcelJS from 'exceljs';
import { prisma } from '@/lib/db/client';
import { ValidationError } from '@/lib/errors';

// ───────────────────────────────────────────────────── PRODUCTS — EXPORT

export async function exportProductsXlsx(): Promise<Buffer> {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: 'asc' },
    include: { category: true, brand: true, variants: true },
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ShopCore'; wb.created = new Date();

  const ws = wb.addWorksheet('products');
  ws.columns = [
    { header: 'sku',           key: 'sku',         width: 28 },
    { header: 'name',          key: 'name',        width: 40 },
    { header: 'slug',          key: 'slug',        width: 30 },
    { header: 'shortDesc',     key: 'shortDesc',   width: 50 },
    { header: 'description',   key: 'description', width: 80 },
    { header: 'category',      key: 'category',    width: 16 },
    { header: 'brand',         key: 'brand',       width: 16 },
    { header: 'mrp',           key: 'mrp',         width: 12 },
    { header: 'price',         key: 'price',       width: 12 },
    { header: 'b2bPrice',      key: 'b2bPrice',    width: 12 },
    { header: 'stock',         key: 'stock',       width: 8 },
    { header: 'lowStockAt',    key: 'lowStockAt',  width: 10 },
    { header: 'gstRate',       key: 'gstRate',     width: 8 },
    { header: 'hsnCode',       key: 'hsnCode',     width: 12 },
    { header: 'isActive',      key: 'isActive',    width: 10 },
    { header: 'isFeatured',    key: 'isFeatured',  width: 10 },
    { header: 'aiTags',        key: 'aiTags',      width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const p of products) {
    ws.addRow({
      sku: p.sku, name: p.name, slug: p.slug, shortDesc: p.shortDesc ?? '', description: p.description,
      category: p.category.slug, brand: p.brand?.slug ?? '',
      mrp: p.mrpPaise / 100, price: p.pricePaise / 100,
      b2bPrice: p.b2bPricePaise != null ? p.b2bPricePaise / 100 : '',
      stock: p.stock, lowStockAt: p.lowStockAt, gstRate: p.gstRate, hsnCode: p.hsnCode ?? '',
      isActive: p.isActive ? 'TRUE' : 'FALSE', isFeatured: p.isFeatured ? 'TRUE' : 'FALSE',
      aiTags: p.aiTags ?? '',
    });
  }

  const vs = wb.addWorksheet('variants');
  vs.columns = [
    { header: 'productSku', key: 'productSku', width: 28 },
    { header: 'variantSku', key: 'variantSku', width: 32 },
    { header: 'name',       key: 'name',       width: 40 },
    { header: 'attributes', key: 'attributes', width: 40 },
    { header: 'mrp',        key: 'mrp',        width: 12 },
    { header: 'price',      key: 'price',      width: 12 },
    { header: 'b2bPrice',   key: 'b2bPrice',   width: 12 },
    { header: 'stock',      key: 'stock',      width: 8 },
    { header: 'isActive',   key: 'isActive',   width: 10 },
  ];
  vs.getRow(1).font = { bold: true };
  for (const p of products) {
    for (const v of p.variants) {
      vs.addRow({
        productSku: p.sku, variantSku: v.sku, name: v.name, attributes: v.attributes,
        mrp: v.mrpPaise / 100, price: v.pricePaise / 100,
        b2bPrice: v.b2bPricePaise != null ? v.b2bPricePaise / 100 : '',
        stock: v.stock, isActive: v.isActive ? 'TRUE' : 'FALSE',
      });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// ───────────────────────────────────────────────────── PRODUCTS — IMPORT

export interface ImportRowResult { sku: string; ok: boolean; reason?: string; created?: boolean; }
export interface ImportSummary { products: ImportRowResult[]; variants: ImportRowResult[]; }

function asBool(v: unknown): boolean { return String(v ?? '').toLowerCase().match(/^(true|yes|1|y|t)$/) != null; }
function asNum(v: unknown): number   { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function asStr(v: unknown): string   { return v == null ? '' : String(v).trim(); }
function slugify(s: string): string  { return s.toLowerCase().trim().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

export async function importProductsXlsx(buf: Buffer): Promise<ImportSummary> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('products');
  if (!ws) throw new ValidationError('Workbook is missing the "products" sheet.', { code: 'EXCEL_MISSING_SHEET' });
  const vs = wb.getWorksheet('variants'); // optional

  // Build header → column index
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => asStr(v).toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase()) + 1; // 1-based

  const productResults: ImportRowResult[] = [];
  const categorySlugs = new Map<string, string>(); // slug → id
  const brandSlugs    = new Map<string, string>();

  // Pre-fetch categories and brands
  const cats = await prisma.category.findMany();
  for (const c of cats) categorySlugs.set(c.slug, c.id);
  const brs = await prisma.brand.findMany();
  for (const b of brs) brandSlugs.set(b.slug, b.id);

  const skuToProductId = new Map<string, string>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sku = asStr(row.getCell(col('sku')).value).toUpperCase();
    if (!sku) continue;
    try {
      const name = asStr(row.getCell(col('name')).value);
      if (!name) throw new ValidationError('Missing name', { code: 'EXCEL_ROW_MISSING_NAME' });
      const catSlug = slugify(asStr(row.getCell(col('category')).value));
      let categoryId = categorySlugs.get(catSlug);
      if (!categoryId) {
        // auto-create category from slug
        const c = await prisma.category.create({ data: { name: catSlug.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()), slug: catSlug } });
        categoryId = c.id; categorySlugs.set(catSlug, c.id);
      }
      const brandSlugRaw = asStr(row.getCell(col('brand')).value);
      let brandId: string | null = null;
      if (brandSlugRaw) {
        const brSlug = slugify(brandSlugRaw);
        brandId = brandSlugs.get(brSlug) ?? null;
        if (!brandId) {
          const b = await prisma.brand.create({ data: { name: brandSlugRaw, slug: brSlug } });
          brandId = b.id; brandSlugs.set(brSlug, b.id);
        }
      }

      const slugCell = asStr(row.getCell(col('slug')).value) || slugify(name);
      const data = {
        name,
        slug: slugCell,
        description: asStr(row.getCell(col('description')).value),
        shortDesc: asStr(row.getCell(col('shortdesc')).value) || null,
        categoryId,
        brandId,
        mrpPaise:   Math.round(asNum(row.getCell(col('mrp')).value)   * 100),
        pricePaise: Math.round(asNum(row.getCell(col('price')).value) * 100),
        b2bPricePaise: asStr(row.getCell(col('b2bprice')).value) === '' ? null : Math.round(asNum(row.getCell(col('b2bprice')).value) * 100),
        stock: Math.floor(asNum(row.getCell(col('stock')).value)),
        lowStockAt: Math.floor(asNum(row.getCell(col('lowstockat')).value)) || 5,
        gstRate: asNum(row.getCell(col('gstrate')).value) || 18,
        hsnCode: asStr(row.getCell(col('hsncode')).value) || null,
        isActive: asBool(row.getCell(col('isactive')).value),
        isFeatured: asBool(row.getCell(col('isfeatured')).value),
        aiTags: asStr(row.getCell(col('aitags')).value) || null,
      };

      const existing = await prisma.product.findUnique({ where: { sku } });
      const saved = existing
        ? await prisma.product.update({ where: { sku }, data })
        : await prisma.product.create({ data: { sku, ...data } });
      skuToProductId.set(sku, saved.id);
      productResults.push({ sku, ok: true, created: !existing });
    } catch (e) {
      productResults.push({ sku, ok: false, reason: (e as Error).message });
    }
  }

  // ── Variants
  const variantResults: ImportRowResult[] = [];
  if (vs && vs.rowCount > 1) {
    const vheader = (vs.getRow(1).values as unknown[]).slice(1).map((v) => asStr(v).toLowerCase());
    const vcol = (name: string) => vheader.indexOf(name.toLowerCase()) + 1;
    for (let r = 2; r <= vs.rowCount; r++) {
      const row = vs.getRow(r);
      const productSku = asStr(row.getCell(vcol('productsku')).value).toUpperCase();
      const variantSku = asStr(row.getCell(vcol('variantsku')).value).toUpperCase();
      if (!productSku || !variantSku) continue;
      try {
        const productId = skuToProductId.get(productSku) ?? (await prisma.product.findUnique({ where: { sku: productSku } }))?.id;
        if (!productId) throw new ValidationError(`Product SKU ${productSku} not found`, { code: 'EXCEL_UNKNOWN_SKU' });
        const data = {
          productId,
          name: asStr(row.getCell(vcol('name')).value) || variantSku,
          attributes: asStr(row.getCell(vcol('attributes')).value) || '{}',
          mrpPaise:   Math.round(asNum(row.getCell(vcol('mrp')).value)   * 100),
          pricePaise: Math.round(asNum(row.getCell(vcol('price')).value) * 100),
          b2bPricePaise: asStr(row.getCell(vcol('b2bprice')).value) === '' ? null : Math.round(asNum(row.getCell(vcol('b2bprice')).value) * 100),
          stock: Math.floor(asNum(row.getCell(vcol('stock')).value)),
          isActive: asBool(row.getCell(vcol('isactive')).value),
        };
        const existing = await prisma.variant.findUnique({ where: { sku: variantSku } });
        if (existing) await prisma.variant.update({ where: { sku: variantSku }, data });
        else          await prisma.variant.create({ data: { sku: variantSku, ...data } });
        variantResults.push({ sku: variantSku, ok: true, created: !existing });
      } catch (e) {
        variantResults.push({ sku: variantSku, ok: false, reason: (e as Error).message });
      }
    }
  }

  return { products: productResults, variants: variantResults };
}

// ───────────────────────────────────────────────────── INVENTORY — IMPORT

export interface InventoryImportRow { sku: string; ok: boolean; reason?: string; newStock?: number; delta?: number; }

export async function importInventoryXlsx(buf: Buffer, mode: 'absolute' | 'delta', performedBy: string): Promise<InventoryImportRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new ValidationError('Empty workbook.', { code: 'EXCEL_EMPTY_WORKBOOK' });
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => asStr(v).toLowerCase());
  const skuCol = header.indexOf('sku') + 1;
  const qtyCol = (header.indexOf('stock') + 1) || (header.indexOf('qty') + 1) || (header.indexOf('delta') + 1);
  if (!skuCol || !qtyCol) throw new ValidationError('Headers required: sku and stock|qty|delta', { code: 'EXCEL_MISSING_HEADERS' });

  const results: InventoryImportRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const sku = asStr(ws.getRow(r).getCell(skuCol).value).toUpperCase();
    const n   = asNum(ws.getRow(r).getCell(qtyCol).value);
    if (!sku) continue;
    try {
      // Variant first, then product
      const v = await prisma.variant.findUnique({ where: { sku } });
      if (v) {
        const newStock = mode === 'absolute' ? Math.max(0, Math.floor(n)) : Math.max(0, v.stock + Math.floor(n));
        const delta = newStock - v.stock;
        await prisma.variant.update({ where: { id: v.id }, data: { stock: newStock } });
        if (delta !== 0) {
          await prisma.inventoryLog.create({ data: { productId: v.productId, variantId: v.id, delta, reason: mode === 'absolute' ? 'MANUAL_ADJUST' : 'BULK_UPLOAD', performedBy } });
        }
        results.push({ sku, ok: true, newStock, delta });
        continue;
      }
      const p = await prisma.product.findUnique({ where: { sku } });
      if (p) {
        const newStock = mode === 'absolute' ? Math.max(0, Math.floor(n)) : Math.max(0, p.stock + Math.floor(n));
        const delta = newStock - p.stock;
        await prisma.product.update({ where: { id: p.id }, data: { stock: newStock } });
        if (delta !== 0) {
          await prisma.inventoryLog.create({ data: { productId: p.id, delta, reason: mode === 'absolute' ? 'MANUAL_ADJUST' : 'BULK_UPLOAD', performedBy } });
        }
        results.push({ sku, ok: true, newStock, delta });
        continue;
      }
      results.push({ sku, ok: false, reason: 'SKU not found' });
    } catch (e) {
      results.push({ sku, ok: false, reason: (e as Error).message });
    }
  }
  return results;
}

// ───────────────────────────────────────────────────── USERS — EXPORT

export async function exportUsersXlsx(): Promise<Buffer> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: { b2bTier: true, _count: { select: { orders: true, reviews: true } } },
  });
  const wb = new ExcelJS.Workbook(); wb.created = new Date();
  const ws = wb.addWorksheet('users');
  ws.columns = [
    { header: 'id', key: 'id', width: 28 },
    { header: 'firstName', key: 'firstName', width: 16 },
    { header: 'lastName', key: 'lastName', width: 16 },
    { header: 'email', key: 'email', width: 32 },
    { header: 'phone', key: 'phone', width: 16 },
    { header: 'role', key: 'role', width: 10 },
    { header: 'status', key: 'status', width: 14 },
    { header: 'addressLine1', key: 'addressLine1', width: 30 },
    { header: 'addressLine2', key: 'addressLine2', width: 30 },
    { header: 'city', key: 'city', width: 16 },
    { header: 'state', key: 'state', width: 20 },
    { header: 'pinCode', key: 'pinCode', width: 10 },
    { header: 'country', key: 'country', width: 12 },
    { header: 'companyName', key: 'companyName', width: 30 },
    { header: 'gstin', key: 'gstin', width: 18 },
    { header: 'pan', key: 'pan', width: 14 },
    { header: 'b2bApprovedAt', key: 'b2bApprovedAt', width: 22 },
    { header: 'b2bTier', key: 'b2bTier', width: 12 },
    { header: 'loyaltyPoints', key: 'loyaltyPoints', width: 10 },
    { header: 'referralCode', key: 'referralCode', width: 28 },
    { header: 'referredById', key: 'referredById', width: 28 },
    { header: 'ordersCount', key: 'ordersCount', width: 10 },
    { header: 'reviewsCount', key: 'reviewsCount', width: 10 },
    { header: 'lastLoginAt', key: 'lastLoginAt', width: 22 },
    { header: 'createdAt', key: 'createdAt', width: 22 },
    { header: 'updatedAt', key: 'updatedAt', width: 22 },
    { header: 'firebaseUid', key: 'firebaseUid', width: 28 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const u of users) {
    ws.addRow({
      id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, phone: u.phone,
      role: u.role, status: u.status,
      addressLine1: u.addressLine1, addressLine2: u.addressLine2, city: u.city, state: u.state, pinCode: u.pinCode, country: u.country,
      companyName: u.companyName ?? '', gstin: u.gstin ?? '', pan: u.pan ?? '',
      b2bApprovedAt: u.b2bApprovedAt?.toISOString() ?? '',
      b2bTier: u.b2bTier?.name ?? '',
      loyaltyPoints: u.loyaltyPoints, referralCode: u.referralCode,
      referredById: u.referredById ?? '',
      ordersCount: u._count.orders, reviewsCount: u._count.reviews,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? '',
      createdAt: u.createdAt.toISOString(), updatedAt: u.updatedAt.toISOString(),
      firebaseUid: u.firebaseUid ?? '',
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

export async function exportUsersCsv(): Promise<string> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    include: { b2bTier: true, _count: { select: { orders: true, reviews: true } } },
  });
  const cols = [
    'id','firstName','lastName','email','phone','role','status',
    'addressLine1','addressLine2','city','state','pinCode','country',
    'companyName','gstin','pan','b2bApprovedAt','b2bTier',
    'loyaltyPoints','referralCode','referredById',
    'ordersCount','reviewsCount','lastLoginAt','createdAt','updatedAt','firebaseUid',
  ];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const u of users) {
    lines.push(cols.map((k) => {
      switch (k) {
        case 'b2bTier':       return esc(u.b2bTier?.name ?? '');
        case 'b2bApprovedAt': return esc(u.b2bApprovedAt?.toISOString() ?? '');
        case 'lastLoginAt':   return esc(u.lastLoginAt?.toISOString() ?? '');
        case 'createdAt':     return esc(u.createdAt.toISOString());
        case 'updatedAt':     return esc(u.updatedAt.toISOString());
        case 'ordersCount':   return esc(u._count.orders);
        case 'reviewsCount':  return esc(u._count.reviews);
        default:              return esc((u as unknown as Record<string, unknown>)[k] ?? '');
      }
    }).join(','));
  }
  return lines.join('\n');
}
