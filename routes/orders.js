'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { log } = require('../utils/logger');
const vendorApi = require('../utils/vendor-api');

const requireManager = requireRole('admin', 'location_manager', 'super_admin');
const requireAdmin   = requireRole('admin', 'super_admin');

router.use(requireAuth);
router.use(requireFeature('orders'));

function sessionUser(req) {
  return { id: req.session.userId, name: req.session.userName, role: req.session.userRole };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getOrderSettings(locationId) {
  return db.get(`SELECT * FROM order_settings WHERE location_id=?`, [locationId]);
}

async function getMinOrderValue(locationId, vendorId = null) {
  if (vendorId) {
    try {
      const v = await db.get(`SELECT min_order_value FROM vendors WHERE id=? AND location_id=?`, [vendorId, locationId]);
      if (v?.min_order_value !== null && v?.min_order_value !== undefined) return parseFloat(v.min_order_value);
    } catch (_) {}
  }
  const s = await getOrderSettings(locationId);
  return s ? parseFloat(s.min_order_value) : 0;
}

async function getVendorCreds(locationId) {
  const s = await getOrderSettings(locationId);
  const clientId = s?.vendor_client_id || process.env.VENDOR_CLIENT_ID || '';
  const apiKey   = s?.vendor_api_key   || process.env.VENDOR_API_KEY   || '';
  return { clientId, apiKey };
}

async function recalcOrderTotal(orderId) {
  const result = await db.get(
    `SELECT COALESCE(SUM(total_netto), 0) AS total FROM purchase_order_items WHERE order_id=?`,
    [orderId]
  );
  await db.run(`UPDATE purchase_orders SET total_netto=?, updated_at=NOW() WHERE id=?`,
    [result.total, orderId]);
  return parseFloat(result.total);
}

const LOW_STOCK_BASE_SQL = `
  JOIN (
    SELECT sre2.item_id, MAX(sr2.report_date) AS max_date
    FROM stock_report_entries sre2
    JOIN stock_reports sr2 ON sr2.id = sre2.report_id
    WHERE sr2.location_id = ?
    GROUP BY sre2.item_id
  ) latest ON latest.item_id = si.id
  JOIN stock_reports sr ON sr.location_id = ? AND sr.report_date = latest.max_date
  JOIN stock_report_entries sre ON sre.item_id = si.id AND sre.report_id = sr.id
  WHERE si.location_id = ? AND si.active = 1 AND si.min_qty IS NOT NULL
    AND si.report_type NOT IN ('products_shift','cakes_noon')
    AND sre.quantity IS NOT NULL AND sre.quantity NOT IN ('','—','-')
    AND CAST(sre.quantity AS DECIMAL(10,3)) < si.min_qty
  ORDER BY si.report_type, si.category, si.name`;

async function loadLowStockItems(locationId) {
  const params = [locationId, locationId, locationId];
  try {
    return await db.all(
      `SELECT si.id, si.name, si.category, si.report_type, si.unit, si.min_qty, si.vendor_product_key,
              si.vendor_id, v.name AS vendor_name, v.api_type AS vendor_api_type,
              CAST(sre.quantity AS DECIMAL(10,3)) AS last_qty, sr.report_date AS last_date
       FROM stock_items si LEFT JOIN vendors v ON v.id = si.vendor_id` + LOW_STOCK_BASE_SQL,
      params
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    // vendors table or vendor_id column not yet created — fall back without vendor columns
    return (await db.all(
      `SELECT si.id, si.name, si.category, si.report_type, si.unit, si.min_qty, si.vendor_product_key,
              NULL AS vendor_id, NULL AS vendor_name, NULL AS vendor_api_type,
              CAST(sre.quantity AS DECIMAL(10,3)) AS last_qty, sr.report_date AS last_date
       FROM stock_items si` + LOW_STOCK_BASE_SQL,
      params
    ));
  }
}

// ── Vendor management ──────────────────────────────────────────────────────

async function loadVendors(locationId) {
  try {
    return await db.all(`SELECT * FROM vendors WHERE location_id=? ORDER BY sort_order, name`, [locationId]);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

async function buildPriceMap(lowStock, locationId) {
  const priceMap = {};
  const allSkus = [...new Set(lowStock.map(i => i.vendor_product_key?.trim()).filter(Boolean))];
  if (allSkus.length === 0) return priceMap;

  console.log('[buildPriceMap] looking up', allSkus.length, 'SKUs:', allSkus);

  const allVendors = await loadVendors(locationId);
  const apiVendors = allVendors.filter(v => v.api_type === 'intermlecz' && v.client_id && v.api_key);

  console.log('[buildPriceMap] api vendors:', apiVendors.map(v => ({ id: v.id, name: v.name })));

  if (apiVendors.length === 0) {
    // Fall back to location-level credentials
    try {
      const creds = await getVendorCreds(locationId);
      const items = await vendorApi.getProductsBySku(allSkus, creds);
      for (const v of items) {
        priceMap[String(v.Sku).trim()] = { price: v.PriceAfterDiscountNet?.Value ?? null, unit: v.Unit, inStock: v.InStock, vendorName: v.Name || null };
      }
    } catch (e) {
      console.error('[buildPriceMap] location creds fallback failed:', e.message);
    }
    return priceMap;
  }

  // Try each API vendor — merge results (first match per SKU wins)
  for (const vendor of apiVendors) {
    try {
      const remaining = allSkus.filter(s => !(s in priceMap));
      if (remaining.length === 0) break;
      const items = await vendorApi.getProductsBySku(remaining, { clientId: vendor.client_id, apiKey: vendor.api_key });
      console.log('[buildPriceMap] vendor', vendor.name, 'returned', items.length, 'items');
      for (const v of items) {
        priceMap[String(v.Sku).trim()] = { price: v.PriceAfterDiscountNet?.Value ?? null, unit: v.Unit, inStock: v.InStock, vendorName: v.Name || null };
      }
    } catch (e) {
      console.error(`[buildPriceMap] vendor ${vendor.name} failed:`, e.message);
    }
  }

  console.log('[buildPriceMap] resolved', Object.keys(priceMap).length, 'of', allSkus.length, 'SKUs');
  return priceMap;
}

router.get('/vendors', requireManager, (req, res) => {
  const qs = req.query.edit ? `?edit=${req.query.edit}` : '';
  res.redirect('/orders/settings' + qs);
});

router.post('/vendors', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { name, client_id, api_key, website, min_order_value } = req.body;
    if (!name?.trim()) { req.flash('error', 'Nazwa jest wymagana.'); return res.redirect('/orders/settings'); }
    const slug = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 50) || `vendor-${Date.now()}`;
    const minVal = min_order_value !== '' && min_order_value !== undefined ? parseFloat(min_order_value) : null;
    const apiType = client_id?.trim() ? 'intermlecz' : 'manual';
    await db.run(
      `INSERT INTO vendors (location_id, name, slug, api_type, client_id, api_key, website, min_order_value) VALUES (?,?,?,?,?,?,?,?)`,
      [locationId, name.trim(), slug, apiType,
       client_id?.trim() || null, api_key?.trim() || null, website?.trim() || null, minVal]
    );
    await log(sessionUser(req), 'Dostawcy – dodano', name.trim());
    req.flash('success', `Dostawca "${name.trim()}" dodany.`);
    res.redirect('/orders/settings');
  } catch (e) {
    console.error(e);
    req.flash('error', e.code === 'ER_DUP_ENTRY' ? 'Dostawca o tym slugu już istnieje.' : 'Błąd zapisu.');
    res.redirect('/orders/settings');
  }
});

router.post('/vendors/:id', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { name, client_id, api_key, website, active, min_order_value } = req.body;
    const minVal = min_order_value !== '' && min_order_value !== undefined ? parseFloat(min_order_value) : null;
    const apiType = client_id?.trim() ? 'intermlecz' : 'manual';
    await db.run(
      `UPDATE vendors SET name=?, api_type=?, client_id=?, api_key=?, website=?, active=?, min_order_value=? WHERE id=? AND location_id=?`,
      [name?.trim(), apiType,
       client_id?.trim() || null, api_key?.trim() || null, website?.trim() || null,
       active === '1' ? 1 : 0, minVal, req.params.id, locationId]
    );
    await log(sessionUser(req), 'Dostawcy – zaktualizowano', name?.trim());
    req.flash('success', 'Dostawca zaktualizowany.');
    res.redirect('/orders/settings');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd aktualizacji.');
    res.redirect('/orders/settings');
  }
});

router.delete('/vendors/:id', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const inUse = await db.get(
      `SELECT COUNT(*) AS cnt FROM stock_items WHERE vendor_id=? AND location_id=?`,
      [req.params.id, locationId]
    );
    if (inUse && inUse.cnt > 0) {
      req.flash('error', `Nie można usunąć – ${inUse.cnt} produktów korzysta z tego dostawcy.`);
      return res.redirect('/orders/settings');
    }
    const v = await db.get(`SELECT name FROM vendors WHERE id=? AND location_id=?`, [req.params.id, locationId]);
    await db.run(`DELETE FROM vendors WHERE id=? AND location_id=?`, [req.params.id, locationId]);
    await log(sessionUser(req), 'Dostawcy – usunięto', v?.name);
    req.flash('success', 'Dostawca usunięty.');
    res.redirect('/orders/settings');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd usuwania.');
    res.redirect('/orders/settings');
  }
});

// ── AJAX: assign vendor SKU to a stock item ────────────────────────────────

router.post('/assign-sku', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const stockItemId = parseInt(req.body.stock_item_id, 10);
    const sku = req.body.vendor_product_key?.trim() || null;
    const vendorId = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) : null;
    if (!stockItemId) return res.status(400).json({ error: 'Brak ID produktu.' });
    const item = await db.get(`SELECT id, name FROM stock_items WHERE id=? AND location_id=?`, [stockItemId, locationId]);
    if (!item) return res.status(404).json({ error: 'Produkt nie istnieje.' });
    try {
      await db.run(`UPDATE stock_items SET vendor_product_key=?, vendor_id=? WHERE id=?`, [sku, vendorId || null, stockItemId]);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        await db.run(`UPDATE stock_items SET vendor_product_key=? WHERE id=?`, [sku, stockItemId]);
      } else throw e;
    }
    await log(sessionUser(req), 'Zamówienia – przypisano SKU', `${item.name} → ${sku || '(usunięto)'}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── AJAX: vendor product search ────────────────────────────────────────────

router.get('/vendor/search', requireManager, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [], total: 0 });
    const locationId = getLocationId(req);

    // Look up vendor by vendor_id if provided
    if (req.query.vendor_id) {
      const vendor = await db.get(
        `SELECT * FROM vendors WHERE id=? AND location_id=? AND active=1`,
        [req.query.vendor_id, locationId]
      );
      if (vendor) {
        if (vendor.api_type !== 'intermlecz') {
          return res.json({ items: [], total: 0, manual: true, vendorName: vendor.name });
        }
        const result = await vendorApi.searchProducts(q, 30, { clientId: vendor.client_id, apiKey: vendor.api_key });
        return res.json(result);
      }
    }

    // Fallback: use location-level credentials
    const creds = await getVendorCreds(locationId);
    const result = await vendorApi.searchProducts(q, 30, creds);
    res.json(result);
  } catch (e) {
    console.error('Vendor search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AJAX: debug SKU lookup (temp) ─────────────────────────────────────────

router.get('/vendor/debug-sku', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const allVendors = await loadVendors(locationId);
    const apiVendors = allVendors.filter(v => v.api_type === 'intermlecz' && v.client_id && v.api_key);
    const testSku = (req.query.sku || '').trim();
    const results = [];
    for (const vendor of apiVendors) {
      try {
        const items = testSku
          ? await vendorApi.getProductsBySku([testSku], { clientId: vendor.client_id, apiKey: vendor.api_key })
          : [];
        results.push({ vendor: vendor.name, vendorId: vendor.id, itemCount: items.length, items });
      } catch (e) {
        results.push({ vendor: vendor.name, vendorId: vendor.id, error: e.message });
      }
    }
    res.json({ apiVendors: apiVendors.map(v => ({ id: v.id, name: v.name, hasClientId: !!v.client_id, hasApiKey: !!v.api_key })), testSku, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get('/', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const minOrderValue = await getMinOrderValue(locationId);

    const lowStock = await loadLowStockItems(locationId);
    const vendors  = await loadVendors(locationId);
    const priceMap = await buildPriceMap(lowStock, locationId).catch(() => ({}));

    const orders = await db.all(
      `SELECT po.*, u.name AS created_by_name, a.name AS approved_by_name, v.name AS vendor_name
       FROM purchase_orders po
       JOIN users u ON u.id = po.created_by
       LEFT JOIN users a ON a.id = po.approved_by
       LEFT JOIN vendors v ON v.id = po.vendor_id
       WHERE po.location_id = ?
       ORDER BY po.updated_at DESC LIMIT 50`,
      [locationId]
    );

    res.render('orders/index', {
      title: 'Zamówienia', currentPath: '/orders',
      lowStock, orders, minOrderValue, vendors, priceMap,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Settings ───────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const vendors = await loadVendors(locationId);
    const editId = req.query.edit ? parseInt(req.query.edit) : null;
    const editVendor = editId ? vendors.find(v => v.id === editId) : null;
    res.render('orders/settings', {
      title: 'Ustawienia zamówień', currentPath: '/orders',
      vendors, editVendor,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});


// ── New order form ─────────────────────────────────────────────────────────

router.get('/new', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const lowStock = await loadLowStockItems(locationId);
    const minOrderValue = await getMinOrderValue(locationId);

    const priceMap = await buildPriceMap(lowStock, locationId).catch(e => {
      console.error('[/new] buildPriceMap threw:', e.message, e.stack);
      return {};
    });

    const vendors = await loadVendors(locationId);
    res.render('orders/new', {
      title: 'Nowe zamówienie', currentPath: '/orders',
      lowStock, priceMap, minOrderValue, vendors,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Create / save draft order ──────────────────────────────────────────────

router.post('/', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const userId = req.session.userId;
    const { notes, vendor_id } = req.body;

    // Parse items from flat form fields: item_stock_id[], item_name[], item_sku[], item_qty[], item_unit[], item_price[]
    const stockIds   = [].concat(req.body.item_stock_id  || []);
    const names      = [].concat(req.body.item_name      || []);
    const skus       = [].concat(req.body.item_sku       || []);
    const qtys       = [].concat(req.body.item_qty       || []);
    const units      = [].concat(req.body.item_unit      || []);
    const prices     = [].concat(req.body.item_price     || []);

    if (names.length === 0) {
      req.flash('error', 'Dodaj co najmniej jeden produkt do zamówienia.');
      return res.redirect('/orders/new');
    }

    const result = await db.run(
      `INSERT INTO purchase_orders (location_id, created_by, vendor_id, notes, status, total_netto) VALUES (?,?,?,?,'draft',0)`,
      [locationId, userId, parseInt(vendor_id) || null, notes?.trim() || null]
    );
    const orderId = result.insertId;

    for (let i = 0; i < names.length; i++) {
      const qty   = parseFloat(qtys[i]) || 0;
      const price = parseFloat(prices[i]) || null;
      const total = price !== null ? parseFloat((qty * price).toFixed(2)) : null;
      if (qty <= 0) continue;
      await db.run(
        `INSERT INTO purchase_order_items
           (order_id, stock_item_id, vendor_product_key, product_name, unit, quantity, unit_price_netto, total_netto)
         VALUES (?,?,?,?,?,?,?,?)`,
        [orderId, parseInt(stockIds[i]) || null, skus[i]?.trim() || null,
         names[i]?.trim(), units[i]?.trim() || null, qty, price, total]
      );
    }

    await recalcOrderTotal(orderId);
    await log(sessionUser(req), 'Zamówienia – nowe zamówienie', `ID: ${orderId}`);
    req.flash('success', 'Zamówienie zapisane jako szkic.');
    res.redirect(`/orders/${orderId}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd tworzenia zamówienia.');
    res.redirect('/orders/new');
  }
});

// ── View order ─────────────────────────────────────────────────────────────

router.get('/:id(\\d+)', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT po.*, u.name AS created_by_name, a.name AS approved_by_name,
              v.name AS vendor_name, v.api_type AS vendor_api_type
       FROM purchase_orders po
       JOIN users u ON u.id = po.created_by
       LEFT JOIN users a ON a.id = po.approved_by
       LEFT JOIN vendors v ON v.id = po.vendor_id
       WHERE po.id = ? AND po.location_id = ?`,
      [req.params.id, locationId]
    );
    if (!order) return res.status(404).render('error', { message: 'Zamówienie nie istnieje.' });

    const items = await db.all(
      `SELECT * FROM purchase_order_items WHERE order_id = ? ORDER BY id`,
      [order.id]
    );

    const minOrderValue = await getMinOrderValue(locationId, order.vendor_id);
    const isAdmin = ['admin', 'super_admin'].includes(req.session.userRole);

    res.render('orders/view', {
      title: `Zamówienie #${order.id}`, currentPath: '/orders',
      order, items, minOrderValue, isAdmin,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Edit order form ────────────────────────────────────────────────────────

router.get('/:id(\\d+)/edit', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT po.*, u.name AS created_by_name,
              v.name AS vendor_name, v.api_type AS vendor_api_type
       FROM purchase_orders po
       JOIN users u ON u.id = po.created_by
       LEFT JOIN vendors v ON v.id = po.vendor_id
       WHERE po.id = ? AND po.location_id = ?`,
      [req.params.id, locationId]
    );
    if (!order) return res.status(404).render('error', { message: 'Zamówienie nie istnieje.' });
    if (order.status !== 'draft') {
      req.flash('error', 'Edytować można tylko zamówienia w statusie Szkic.');
      return res.redirect(`/orders/${order.id}`);
    }

    const items = await db.all(
      `SELECT * FROM purchase_order_items WHERE order_id = ? ORDER BY id`,
      [order.id]
    );
    const minOrderValue = await getMinOrderValue(locationId, order.vendor_id);

    res.render('orders/edit', {
      title: `Edytuj zamówienie #${order.id}`, currentPath: '/orders',
      order, items, minOrderValue,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Update order (draft only) ──────────────────────────────────────────────

router.put('/:id(\\d+)', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'draft') {
      req.flash('error', 'Edytować można tylko zamówienia w statusie Szkic.');
      return res.redirect(`/orders/${req.params.id}`);
    }

    const { notes } = req.body;
    const stockIds = [].concat(req.body.item_stock_id || []);
    const names    = [].concat(req.body.item_name     || []);
    const skus     = [].concat(req.body.item_sku      || []);
    const qtys     = [].concat(req.body.item_qty      || []);
    const units    = [].concat(req.body.item_unit     || []);
    const prices   = [].concat(req.body.item_price    || []);

    if (names.length === 0) {
      req.flash('error', 'Dodaj co najmniej jeden produkt do zamówienia.');
      return res.redirect(`/orders/${order.id}/edit`);
    }

    await db.run(`UPDATE purchase_orders SET notes=?, updated_at=NOW() WHERE id=?`,
      [notes?.trim() || null, order.id]);

    await db.run(`DELETE FROM purchase_order_items WHERE order_id=?`, [order.id]);

    for (let i = 0; i < names.length; i++) {
      const qty   = parseFloat(qtys[i]) || 0;
      const price = parseFloat(prices[i]) || null;
      const total = price !== null ? parseFloat((qty * price).toFixed(2)) : null;
      if (qty <= 0) continue;
      await db.run(
        `INSERT INTO purchase_order_items
           (order_id, stock_item_id, vendor_product_key, product_name, unit, quantity, unit_price_netto, total_netto)
         VALUES (?,?,?,?,?,?,?,?)`,
        [order.id, parseInt(stockIds[i]) || null, skus[i]?.trim() || null,
         names[i]?.trim(), units[i]?.trim() || null, qty, price, total]
      );
    }

    await recalcOrderTotal(order.id);
    await log(sessionUser(req), 'Zamówienia – edytowano zamówienie', `ID: ${order.id}`);
    req.flash('success', 'Zamówienie zaktualizowane.');
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd zapisu zmian.');
    res.redirect(`/orders/${req.params.id}/edit`);
  }
});

// ── Submit for approval ────────────────────────────────────────────────────

router.post('/:id/submit', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'draft') {
      req.flash('error', 'Nieprawidłowy status zamówienia.');
      return res.redirect(`/orders/${req.params.id}`);
    }
    await db.run(
      `UPDATE purchase_orders SET status='pending_approval', updated_at=NOW() WHERE id=?`, [order.id]
    );
    await log(sessionUser(req), 'Zamówienia – wysłano do akceptacji', `ID: ${order.id}`);
    req.flash('success', 'Zamówienie wysłane do akceptacji.');
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd zmiany statusu.');
    res.redirect(`/orders/${req.params.id}`);
  }
});

// ── Approve ────────────────────────────────────────────────────────────────

router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'pending_approval') {
      req.flash('error', 'Zamówienie nie oczekuje na akceptację.');
      return res.redirect(`/orders/${req.params.id}`);
    }
    await db.run(
      `UPDATE purchase_orders SET status='approved', approved_by=?, updated_at=NOW() WHERE id=?`,
      [req.session.userId, order.id]
    );
    await log(sessionUser(req), 'Zamówienia – zatwierdzone', `ID: ${order.id}`);
    req.flash('success', 'Zamówienie zatwierdzone.');
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd zatwierdzania.');
    res.redirect(`/orders/${req.params.id}`);
  }
});

// ── Reject ─────────────────────────────────────────────────────────────────

router.post('/:id/reject', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'pending_approval') {
      req.flash('error', 'Zamówienie nie oczekuje na akceptację.');
      return res.redirect(`/orders/${req.params.id}`);
    }
    const reason = req.body.reject_reason?.trim() || null;
    await db.run(
      `UPDATE purchase_orders SET status='rejected', reject_reason=?, updated_at=NOW() WHERE id=?`,
      [reason, order.id]
    );
    await log(sessionUser(req), 'Zamówienia – odrzucone', `ID: ${order.id} | Powód: ${reason || '—'}`);
    req.flash('success', 'Zamówienie odrzucone.');
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd odrzucania.');
    res.redirect(`/orders/${req.params.id}`);
  }
});

// ── Reopen rejected → draft ────────────────────────────────────────────────

router.post('/:id/reopen', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'rejected') {
      req.flash('error', 'Tylko odrzucone zamówienia można przywrócić.');
      return res.redirect(`/orders/${req.params.id}`);
    }
    await db.run(
      `UPDATE purchase_orders SET status='draft', reject_reason=NULL, updated_at=NOW() WHERE id=?`, [order.id]
    );
    await log(sessionUser(req), 'Zamówienia – przywrócono do szkicu', `ID: ${order.id}`);
    req.flash('success', 'Zamówienie przywrócone do szkicu.');
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przywracania.');
    res.redirect(`/orders/${req.params.id}`);
  }
});

// ── Place order with vendor ────────────────────────────────────────────────

router.post('/:id/place', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'approved') {
      req.flash('error', 'Tylko zatwierdzone zamówienia można złożyć.');
      return res.redirect(`/orders/${req.params.id}`);
    }

    const minOrderValue = await getMinOrderValue(locationId, order.vendor_id);
    if (minOrderValue > 0 && parseFloat(order.total_netto) < minOrderValue) {
      req.flash('error', `Wartość zamówienia (${parseFloat(order.total_netto).toFixed(2)} PLN) jest poniżej minimum (${minOrderValue} PLN).`);
      return res.redirect(`/orders/${order.id}`);
    }

    const items = await db.all(
      `SELECT * FROM purchase_order_items WHERE order_id=?`, [order.id]
    );
    const itemsWithSku = items.filter(i => i.vendor_product_key);
    if (itemsWithSku.length === 0) {
      req.flash('error', 'Żaden produkt nie ma przypisanego klucza SKU dostawcy.');
      return res.redirect(`/orders/${order.id}`);
    }

    let creds = await getVendorCreds(locationId);
    if (order.vendor_id) {
      const v = await db.get(`SELECT * FROM vendors WHERE id=? AND location_id=?`, [order.vendor_id, locationId]);
      if (v?.client_id && v?.api_key) creds = { clientId: v.client_id, apiKey: v.api_key };
    }
    const vendorResult = await vendorApi.placeOrder({
      items: itemsWithSku,
      comment: order.notes || `Zamówienie #${order.id} – Kredki`,
      ...creds,
    });

    const vendorOrderId = vendorResult?.OrderId || vendorResult?.Id || JSON.stringify(vendorResult);
    await db.run(
      `UPDATE purchase_orders SET status='placed', vendor_order_id=?, updated_at=NOW() WHERE id=?`,
      [String(vendorOrderId), order.id]
    );
    await log(sessionUser(req), 'Zamówienia – złożono u dostawcy', `ID: ${order.id} | Vendor: ${vendorOrderId}`);
    req.flash('success', `Zamówienie złożone! Numer u dostawcy: ${vendorOrderId}`);
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error('Place order error:', e);
    req.flash('error', `Błąd składania zamówienia: ${e.message}`);
    res.redirect(`/orders/${req.params.id}`);
  }
});

// ── Delete draft ───────────────────────────────────────────────────────────

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || !['draft', 'rejected'].includes(order.status)) {
      req.flash('error', 'Można usunąć tylko szkice i odrzucone zamówienia.');
      return res.redirect(`/orders/${req.params.id}`);
    }
    await db.run(`DELETE FROM purchase_orders WHERE id=?`, [order.id]);
    await log(sessionUser(req), 'Zamówienia – usunięto zamówienie', `ID: ${order.id}`);
    req.flash('success', 'Zamówienie usunięte.');
    res.redirect('/orders');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd usuwania.');
    res.redirect('/orders');
  }
});

module.exports = router;
