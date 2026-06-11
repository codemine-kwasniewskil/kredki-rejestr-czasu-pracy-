'use strict';
// Product catalog backed by Inter-Mlecz XML feed (/xmlapi/...) instead of the
// rate-limited /api3 endpoints (100 req/hour). The full catalog is fetched in a
// single HTTP request, parsed, and cached in the `vendor_products` MySQL table.
// Search / SKU lookup / price reads hit the table — zero /api3 calls.
const https = require('https');
const zlib = require('zlib');
const db = require('../database/db');

let schemaReady = false;
const inFlight = new Map(); // locationId -> Promise — dedupe concurrent syncs

// ── Feed fetch ───────────────────────────────────────────────────────────────

function fetchXml(feedUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(feedUrl); } catch { return reject(new Error('Nieprawidłowy adres pliku XML.')); }
    if (!u.searchParams.has('stream')) u.searchParams.set('stream', 'true');
    const req = https.get(u, { headers: { 'Accept-Encoding': 'gzip', 'Accept': 'application/xml' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Plik XML: HTTP ${res.statusCode}`)); }
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Przekroczono czas pobierania pliku XML.')));
  });
}

// ── Parsing ──────────────────────────────────────────────────────────────────
// Feed quirks: CDATA-wrapped text, Polish decimal commas (3,99), True/False bools.

const unwrapCdata = s => { const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/); return m ? m[1].trim() : s.trim(); };

function tagText(block, name) {
  const m = block.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1] : '';
}

function plNum(s) {
  s = (s || '').trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseProducts(xml) {
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1); // strip BOM
  const out = [];
  const blocks = xml.split('<product ');
  for (let i = 1; i < blocks.length; i++) {
    const end = blocks[i].indexOf('</product>');
    if (end === -1) continue;
    const b = blocks[i].slice(0, end);
    const sku = unwrapCdata(tagText(b, 'sku'));
    if (!sku) continue;
    out.push({
      sku,
      ean: unwrapCdata(tagText(b, 'ean')) || null,
      productId: parseInt(tagText(b, 'id').trim(), 10) || null,
      name: unwrapCdata(tagText(b, 'name')).slice(0, 512),
      unit: unwrapCdata(tagText(b, 'unit')) || null,
      priceNet: plNum(tagText(b, 'priceAfterDiscountNet')),
      vat: plNum(tagText(b, 'vat')),
      gross: plNum(tagText(b, 'retailPriceGross')),
      inStock: tagText(b, 'inStock').trim() === 'True' ? 1 : 0,
      qty: plNum(tagText(b, 'qty')),
      availability: unwrapCdata(tagText(b, 'availability')) || null,
    });
  }
  return out;
}

// ── Schema ───────────────────────────────────────────────────────────────────

async function ensureSchema() {
  if (schemaReady) return;
  await db.run(`CREATE TABLE IF NOT EXISTS vendor_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    location_id INT NOT NULL,
    sku VARCHAR(64) NOT NULL,
    ean VARCHAR(32) NULL,
    product_id BIGINT NULL,
    name VARCHAR(512) NOT NULL,
    unit VARCHAR(32) NULL,
    price_net DECIMAL(12,4) NULL,
    vat DECIMAL(5,2) NULL,
    retail_gross DECIMAL(12,4) NULL,
    in_stock TINYINT(1) NOT NULL DEFAULT 0,
    qty DECIMAL(12,3) NULL,
    availability VARCHAR(64) NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_loc_sku (location_id, sku),
    KEY idx_loc_name (location_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Per-vendor feed URL — guarded ALTER (MySQL has no ADD COLUMN IF NOT EXISTS pre-8.0.something).
  try {
    await db.run(`ALTER TABLE vendors ADD COLUMN xml_feed_url VARCHAR(512) NULL`);
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  schemaReady = true;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

async function syncCatalog({ locationId, feedUrl }) {
  if (!locationId) throw new Error('Brak ID lokalizacji.');
  if (!feedUrl) throw new Error('Brak adresu pliku XML (feed) dla katalogu.');
  const xml = await fetchXml(feedUrl);
  const products = parseProducts(xml);
  if (products.length === 0) throw new Error('Plik XML nie zawiera produktów (sprawdź adres/token).');

  await ensureSchema();
  await db.run('DELETE FROM vendor_products WHERE location_id=?', [locationId]);

  const COLS = '(location_id, sku, ean, product_id, name, unit, price_net, vat, retail_gross, in_stock, qty, availability)';
  const CHUNK = 500;
  for (let i = 0; i < products.length; i += CHUNK) {
    const slice = products.slice(i, i + CHUNK);
    const values = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = [];
    for (const p of slice) {
      params.push(locationId, p.sku, p.ean, p.productId, p.name, p.unit,
        p.priceNet, p.vat, p.gross, p.inStock, p.qty, p.availability);
    }
    await db.run(`INSERT INTO vendor_products ${COLS} VALUES ${values}`, params);
  }
  return { count: products.length, syncedAt: new Date() };
}

// Dedupe concurrent syncs for the same location (e.g. cron + lazy-sync racing).
function syncCatalogOnce(opts) {
  const key = String(opts.locationId);
  if (inFlight.has(key)) return inFlight.get(key);
  const p = syncCatalog(opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ── Read (API-compatible shape) ──────────────────────────────────────────────
// Returns objects matching the old /api3/product/findProduct response so callers
// (extractPriceEntry, the search views) keep working unchanged.

function rowToApiProduct(r) {
  const net = r.price_net != null ? Number(r.price_net) : null;
  const vat = r.vat != null ? Number(r.vat) : null;
  const gross = r.retail_gross != null ? Number(r.retail_gross) : null;
  const retailNet = gross != null && vat != null
    ? Math.round((gross / (1 + vat / 100)) * 10000) / 10000
    : null;
  return {
    Id: r.product_id,
    Sku: r.sku,
    Name: r.name,
    Unit: r.unit,
    PriceAfterDiscountNet: net != null ? { Value: net } : null,
    RetailPriceGross: gross != null ? { Value: gross } : null,
    RetailPriceNet: retailNet != null ? { Value: retailNet } : null,
    Vat: vat,
    Qty: r.qty != null ? Number(r.qty) : null,
    InStock: !!r.in_stock,
  };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

async function searchCatalog({ locationId, phrase, limit = 30 }) {
  await ensureSchema();
  const q = (phrase || '').trim();
  const like = '%' + escapeLike(q) + '%';
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const rows = await db.all(
    `SELECT * FROM vendor_products
       WHERE location_id=? AND (name LIKE ? OR sku LIKE ?)
       ORDER BY in_stock DESC, name LIMIT ${lim}`,
    [locationId, like, like]
  );
  const c = await db.get(
    `SELECT COUNT(*) AS c FROM vendor_products WHERE location_id=? AND (name LIKE ? OR sku LIKE ?)`,
    [locationId, like, like]
  );
  return { items: rows.map(rowToApiProduct), total: c?.c ?? rows.length };
}

async function getCatalogBySku({ locationId, skus }) {
  if (!skus || skus.length === 0) return [];
  await ensureSchema();
  const clean = [...new Set(skus.map(s => String(s).trim()).filter(Boolean))];
  if (clean.length === 0) return [];
  const placeholders = clean.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT * FROM vendor_products WHERE location_id=? AND sku IN (${placeholders})`,
    [locationId, ...clean]
  );
  return rows.map(rowToApiProduct);
}

async function catalogStatus(locationId) {
  await ensureSchema();
  const r = await db.get(
    `SELECT COUNT(*) AS count, MAX(updated_at) AS syncedAt FROM vendor_products WHERE location_id=?`,
    [locationId]
  );
  return { count: r?.count ?? 0, syncedAt: r?.syncedAt ?? null };
}

module.exports = {
  ensureSchema,
  parseProducts,
  syncCatalog,
  syncCatalogOnce,
  searchCatalog,
  getCatalogBySku,
  catalogStatus,
};
