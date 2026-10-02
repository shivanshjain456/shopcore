/**
 * Generates sample Excel template files into docs/excel-templates/:
 *   - products-template.xlsx  (with `products` + `variants` sheets pre-headered)
 *   - inventory-template.xlsx (header sku,stock — for absolute mode)
 *
 * Admins can download these from /admin/excel; this script writes them to disk
 * so they're versioned in the repo too.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const OUT = path.resolve('docs/excel-templates');
fs.mkdirSync(OUT, { recursive: true });

async function products() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ShopCore';
  const ws = wb.addWorksheet('products');
  ws.columns = [
    { header: 'sku',         key: 'sku',         width: 28 },
    { header: 'name',        key: 'name',        width: 40 },
    { header: 'slug',        key: 'slug',        width: 30 },
    { header: 'shortDesc',   key: 'shortDesc',   width: 50 },
    { header: 'description', key: 'description', width: 80 },
    { header: 'category',    key: 'category',    width: 16 },
    { header: 'brand',       key: 'brand',       width: 16 },
    { header: 'mrp',         key: 'mrp',         width: 12 },
    { header: 'price',       key: 'price',       width: 12 },
    { header: 'b2bPrice',    key: 'b2bPrice',    width: 12 },
    { header: 'stock',       key: 'stock',       width: 8  },
    { header: 'lowStockAt',  key: 'lowStockAt',  width: 10 },
    { header: 'gstRate',     key: 'gstRate',     width: 8  },
    { header: 'hsnCode',     key: 'hsnCode',     width: 12 },
    { header: 'isActive',    key: 'isActive',    width: 10 },
    { header: 'isFeatured',  key: 'isFeatured',  width: 10 },
    { header: 'aiTags',      key: 'aiTags',      width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({
    sku: 'LAP-EXAMPLE-001', name: 'Example Laptop 15', slug: 'example-laptop-15',
    shortDesc: '15.6" FHD · i5 · 8GB · 512GB SSD',
    description: 'Full marketing description here…',
    category: 'laptops', brand: 'dell',
    mrp: 62990, price: 51990, b2bPrice: 49490,
    stock: 10, lowStockAt: 3, gstRate: 18, hsnCode: '8471',
    isActive: 'TRUE', isFeatured: 'FALSE', aiTags: 'intel,i5,fhd',
  });

  const vs = wb.addWorksheet('variants');
  vs.columns = [
    { header: 'productSku', key: 'productSku', width: 28 },
    { header: 'variantSku', key: 'variantSku', width: 32 },
    { header: 'name',       key: 'name',       width: 40 },
    { header: 'attributes', key: 'attributes', width: 40 },
    { header: 'mrp',        key: 'mrp',        width: 12 },
    { header: 'price',      key: 'price',      width: 12 },
    { header: 'b2bPrice',   key: 'b2bPrice',   width: 12 },
    { header: 'stock',      key: 'stock',      width: 8  },
    { header: 'isActive',   key: 'isActive',   width: 10 },
  ];
  vs.getRow(1).font = { bold: true };
  vs.addRow({
    productSku: 'LAP-EXAMPLE-001', variantSku: 'LAP-EXAMPLE-001-V1',
    name: '8 GB / 512 GB SSD', attributes: '{"ram":"8GB","storage":"512GB SSD"}',
    mrp: 62990, price: 51990, b2bPrice: 49490, stock: 5, isActive: 'TRUE',
  });

  await wb.xlsx.writeFile(path.join(OUT, 'products-template.xlsx'));
}

async function inventory() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ShopCore';
  const ws = wb.addWorksheet('inventory');
  ws.columns = [
    { header: 'sku',   key: 'sku',   width: 32 },
    { header: 'stock', key: 'stock', width: 10 }, // use `delta` instead for delta-mode imports
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({ sku: 'LAP-EXAMPLE-001', stock: 25 });
  await wb.xlsx.writeFile(path.join(OUT, 'inventory-template.xlsx'));

  const wb2 = new ExcelJS.Workbook();
  wb2.creator = 'ShopCore';
  const ws2 = wb2.addWorksheet('inventory-delta');
  ws2.columns = [
    { header: 'sku',   key: 'sku',   width: 32 },
    { header: 'delta', key: 'delta', width: 10 },
  ];
  ws2.getRow(1).font = { bold: true };
  ws2.addRow({ sku: 'LAP-EXAMPLE-001', delta: 10 });
  ws2.addRow({ sku: 'ACC-EXAMPLE-002', delta: -3 });
  await wb2.xlsx.writeFile(path.join(OUT, 'inventory-delta-template.xlsx'));
}

async function main() {
  await products();
  await inventory();
  console.log('✔ Templates written to', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
