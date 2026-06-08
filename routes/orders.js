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

async function getMinOrderValue(locationId) {
  const s = await getOrderSettings(locationId);
  return s ? parseFloat(s.min_order_value) : 500;
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

async function loadLowStockItems(locationId) {
  return db.all(
    `SELECT si.id, si.name, si.category, si.report_type, si.unit, si.min_qty, si.vendor_product_key,
            CAST(sre.quantity AS DECIMAL(10,3)) AS last_qty, sr.report_date AS last_date
     FROM stock_items si
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
     ORDER BY si.report_type, si.category, si.name`,
    [locationId, locationId, locationId]
  );
}

// ── AJAX: vendor product search ────────────────────────────────────────────

router.get('/vendor/search', requireManager, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [], total: 0 });
    const creds = await getVendorCreds(getLocationId(req));
    const result = await vendorApi.searchProducts(q, 30, creds);
    res.json(result);
  } catch (e) {
    console.error('Vendor search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get('/', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const minOrderValue = await getMinOrderValue(locationId);

    const lowStock = await loadLowStockItems(locationId);

    const orders = await db.all(
      `SELECT po.*, u.name AS created_by_name, a.name AS approved_by_name
       FROM purchase_orders po
       JOIN users u ON u.id = po.created_by
       LEFT JOIN users a ON a.id = po.approved_by
       WHERE po.location_id = ?
       ORDER BY po.updated_at DESC LIMIT 50`,
      [locationId]
    );

    res.render('orders/index', {
      title: 'Zamówienia', currentPath: '/orders',
      lowStock, orders, minOrderValue,
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
    const settings = await getOrderSettings(locationId);
    res.render('orders/settings', {
      title: 'Ustawienia zamówień', currentPath: '/orders',
      minOrderValue: settings ? parseFloat(settings.min_order_value) : 500,
      vendorClientId: settings?.vendor_client_id || process.env.VENDOR_CLIENT_ID || '',
      vendorApiKey:   settings?.vendor_api_key   || process.env.VENDOR_API_KEY   || '',
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/settings', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const val       = parseFloat(req.body.min_order_value) || 500;
    const clientId  = req.body.vendor_client_id?.trim() || null;
    const apiKey    = req.body.vendor_api_key?.trim()   || null;
    await db.run(
      `INSERT INTO order_settings (location_id, min_order_value, vendor_client_id, vendor_api_key)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE
         min_order_value=VALUES(min_order_value),
         vendor_client_id=VALUES(vendor_client_id),
         vendor_api_key=VALUES(vendor_api_key)`,
      [locationId, val, clientId, apiKey]
    );
    await log(sessionUser(req), 'Zamówienia – ustawienia', `Min: ${val} PLN | ClientId: ${clientId}`);
    req.flash('success', 'Ustawienia zapisane.');
    res.redirect('/orders/settings');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd zapisu ustawień.');
    res.redirect('/orders/settings');
  }
});

// ── New order form ─────────────────────────────────────────────────────────

router.get('/new', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const lowStock = await loadLowStockItems(locationId);
    const minOrderValue = await getMinOrderValue(locationId);

    // Enrich with current vendor prices for items that have a vendor_product_key
    const skus = lowStock.filter(i => i.vendor_product_key).map(i => i.vendor_product_key);
    const priceMap = {};
    if (skus.length > 0) {
      try {
        const creds = await getVendorCreds(locationId);
        const vendorItems = await vendorApi.getProductsBySku(skus, creds);
        for (const v of vendorItems) {
          priceMap[v.Sku] = {
            price: v.PriceAfterDiscountNet?.Value ?? null,
            unit: v.Unit,
            inStock: v.InStock,
          };
        }
      } catch (e) {
        console.error('Price fetch failed (continuing):', e.message);
      }
    }

    res.render('orders/new', {
      title: 'Nowe zamówienie', currentPath: '/orders',
      lowStock, priceMap, minOrderValue,
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
    const { notes } = req.body;

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
      `INSERT INTO purchase_orders (location_id, created_by, notes, status, total_netto) VALUES (?,?,?,'draft',0)`,
      [locationId, userId, notes?.trim() || null]
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
      `SELECT po.*, u.name AS created_by_name, a.name AS approved_by_name
       FROM purchase_orders po
       JOIN users u ON u.id = po.created_by
       LEFT JOIN users a ON a.id = po.approved_by
       WHERE po.id = ? AND po.location_id = ?`,
      [req.params.id, locationId]
    );
    if (!order) return res.status(404).render('error', { message: 'Zamówienie nie istnieje.' });

    const items = await db.all(
      `SELECT * FROM purchase_order_items WHERE order_id = ? ORDER BY id`,
      [order.id]
    );

    const minOrderValue = await getMinOrderValue(locationId);
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

    const minOrderValue = await getMinOrderValue(locationId);
    if (parseFloat(order.total_netto) < minOrderValue) {
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

    const creds = await getVendorCreds(locationId);
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
