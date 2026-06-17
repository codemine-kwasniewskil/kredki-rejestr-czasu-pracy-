'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { log } = require('../utils/logger');
const vendorApi = require('../utils/vendor-api');
const vendorCatalog = require('../utils/vendor-catalog');

const requireManager = requireRole('admin', 'location_manager', 'super_admin');
const requireAdmin   = requireRole('admin', 'super_admin');

// Scheduled catalog refresh for all locations (Vercel cron). Registered BEFORE the
// auth middleware so it can run without a session. Guarded by CRON_SECRET — Vercel
// sends `Authorization: Bearer $CRON_SECRET`; a ?key= query is also accepted.
router.get('/cron/sync-catalog', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authed = secret && (
    req.headers.authorization === `Bearer ${secret}` || req.query.key === secret
  );
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await vendorCatalog.ensureSchema();
    const rows = await db.all(
      `SELECT DISTINCT location_id, xml_feed_url FROM vendors
         WHERE api_type='intermlecz' AND xml_feed_url IS NOT NULL AND xml_feed_url != ''`
    );
    const results = [];
    for (const r of rows) {
      try {
        const { count } = await vendorCatalog.syncCatalogOnce({ locationId: r.location_id, feedUrl: r.xml_feed_url });
        results.push({ locationId: r.location_id, count });
      } catch (e) {
        results.push({ locationId: r.location_id, error: e.message });
      }
    }
    res.json({ ok: true, synced: results });
  } catch (e) {
    console.error('[catalog] cron sync failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Lightweight availability refresh for all locations (Vercel cron). Same CRON_SECRET guard.
router.get('/cron/sync-availability', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authed = secret && (
    req.headers.authorization === `Bearer ${secret}` || req.query.key === secret
  );
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await vendorCatalog.ensureSchema();
    const rows = await db.all(
      `SELECT DISTINCT location_id, xml_feed_url FROM vendors
         WHERE api_type='intermlecz' AND xml_feed_url IS NOT NULL AND xml_feed_url != ''`
    );
    const results = [];
    for (const r of rows) {
      const availUrl = vendorCatalog.deriveAvailabilityUrl(r.xml_feed_url);
      if (!availUrl) { results.push({ locationId: r.location_id, error: 'no availability URL' }); continue; }
      try {
        const { matched } = await vendorCatalog.syncAvailabilityOnce({ locationId: r.location_id, availUrl });
        results.push({ locationId: r.location_id, matched });
      } catch (e) {
        results.push({ locationId: r.location_id, error: e.message });
      }
    }
    res.json({ ok: true, refreshed: results });
  } catch (e) {
    console.error('[catalog] cron availability failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

// Resolve the XML catalog feed URL for a location: first an intermlecz vendor's
// configured xml_feed_url, else the VENDOR_XML_FEED_URL env fallback.
async function getCatalogFeedUrl(locationId, vendors = null) {
  const list = vendors || await loadVendors(locationId);
  const withFeed = list.find(v => v.api_type === 'intermlecz' && v.xml_feed_url);
  return withFeed?.xml_feed_url || process.env.VENDOR_XML_FEED_URL || '';
}

// Make sure the catalog has data before reading. Triggers a one-time sync from the
// XML feed if the table is empty for this location and a feed URL is configured.
async function ensureCatalog(locationId, vendors = null) {
  try {
    const status = await vendorCatalog.catalogStatus(locationId);
    if (status.count > 0) return status;
    const feedUrl = await getCatalogFeedUrl(locationId, vendors);
    if (!feedUrl) return status;
    return await vendorCatalog.syncCatalogOnce({ locationId, feedUrl });
  } catch (e) {
    console.error('[catalog] ensureCatalog failed:', e.message);
    return { count: 0, syncedAt: null };
  }
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

function extractPriceEntry(v) {
  const priceNet = v.PriceAfterDiscountNet?.Value ?? null;
  const vat = v.Vat ?? null;
  const priceGross = priceNet !== null && vat !== null
    ? Math.round(priceNet * (1 + vat / 100) * 10000) / 10000
    : (v.RetailPriceGross?.Value ?? null);
  return {
    price: priceNet,
    priceGross,
    vat,
    retailPriceNet: v.RetailPriceNet?.Value ?? null,
    unit: v.Unit,
    inStock: v.InStock,
    vendorName: v.Name || null,
  };
}

async function buildPriceMap(lowStock, locationId) {
  const priceMap = {};
  const allSkus = [...new Set(lowStock.map(i => i.vendor_product_key?.trim()).filter(Boolean))];
  if (allSkus.length === 0) return priceMap;

  // Prices come from the local XML-feed catalog (one DB query, no /api3 calls).
  try {
    await ensureCatalog(locationId);
    const items = await vendorApi.getProductsBySku(allSkus, { locationId });
    for (const v of items) priceMap[String(v.Sku).trim()] = extractPriceEntry(v);
  } catch (e) {
    console.error('[buildPriceMap] catalog lookup failed:', e.message);
  }

  return priceMap;
}

router.get('/vendors', requireManager, (req, res) => {
  const qs = req.query.edit ? `?edit=${req.query.edit}` : '';
  res.redirect('/orders/settings' + qs);
});

router.post('/vendors', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { name, client_id, api_key, website, min_order_value, xml_feed_url } = req.body;
    if (!name?.trim()) { req.flash('error', 'Nazwa jest wymagana.'); return res.redirect('/orders/settings'); }
    const slug = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 50) || `vendor-${Date.now()}`;
    const minVal = min_order_value !== '' && min_order_value !== undefined ? parseFloat(min_order_value) : null;
    const apiType = client_id?.trim() ? 'intermlecz' : 'manual';
    await vendorCatalog.ensureSchema(); // make sure xml_feed_url column exists
    await db.run(
      `INSERT INTO vendors (location_id, name, slug, api_type, client_id, api_key, website, min_order_value, xml_feed_url) VALUES (?,?,?,?,?,?,?,?,?)`,
      [locationId, name.trim(), slug, apiType,
       client_id?.trim() || null, api_key?.trim() || null, website?.trim() || null, minVal,
       xml_feed_url?.trim() || null]
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
    const { name, client_id, api_key, website, active, min_order_value, xml_feed_url } = req.body;
    const minVal = min_order_value !== '' && min_order_value !== undefined ? parseFloat(min_order_value) : null;
    const apiType = client_id?.trim() ? 'intermlecz' : 'manual';
    await vendorCatalog.ensureSchema(); // make sure xml_feed_url column exists
    await db.run(
      `UPDATE vendors SET name=?, api_type=?, client_id=?, api_key=?, website=?, active=?, min_order_value=?, xml_feed_url=? WHERE id=? AND location_id=?`,
      [name?.trim(), apiType,
       client_id?.trim() || null, api_key?.trim() || null, website?.trim() || null,
       active === '1' ? 1 : 0, minVal, xml_feed_url?.trim() || null, req.params.id, locationId]
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

// ── AJAX: get delivery options from vendor API ────────────────────────────

router.get('/vendor/delivery-options', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const allVendors = await loadVendors(locationId);
    const apiVendor = allVendors.find(v => v.api_type === 'intermlecz' && v.client_id && v.api_key);
    if (!apiVendor) return res.json({ Items: [], error: 'Brak dostawcy API' });
    const orderSettings = await getOrderSettings(locationId) || {};
    const addressId = orderSettings.cafe_address_id || null;
    const items = await vendorApi.getDeliveryOptions({ clientId: apiVendor.client_id, apiKey: apiVendor.api_key }, addressId);
    res.json({ Items: items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AJAX: vendor product search ────────────────────────────────────────────

router.get('/vendor/search', requireManager, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [], total: 0 });
    const locationId = getLocationId(req);

    // A manual (non-intermlecz) vendor has no catalog — signal the UI to fall back.
    if (req.query.vendor_id) {
      const vendor = await db.get(
        `SELECT * FROM vendors WHERE id=? AND location_id=? AND active=1`,
        [req.query.vendor_id, locationId]
      );
      if (vendor && vendor.api_type !== 'intermlecz') {
        return res.json({ items: [], total: 0, manual: true, vendorName: vendor.name });
      }
    }

    // All intermlecz search reads the local XML-feed catalog (no /api3 calls).
    await ensureCatalog(locationId);
    const result = await vendorApi.searchProducts(q, 30, { locationId });
    res.json(result);
  } catch (e) {
    console.error('Vendor search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AJAX: search cafe stock items with a vendor SKU ───────────────────────

router.get('/stock-items', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const vendorId = req.query.vendor_id ? parseInt(req.query.vendor_id, 10) : null;
    const params = [`%${q}%`, locationId];
    let sql = `SELECT si.id, si.name, si.vendor_product_key AS sku, si.unit, si.vendor_id,
                      v.name AS vendor_name
               FROM stock_items si
               LEFT JOIN vendors v ON v.id = si.vendor_id
               WHERE si.name LIKE ? AND si.location_id = ? AND si.active = 1
                 AND si.vendor_product_key IS NOT NULL AND si.vendor_product_key != ''`;
    if (vendorId) { sql += ' AND si.vendor_id = ?'; params.push(vendorId); }
    sql += ' ORDER BY si.name LIMIT 30';
    res.json(await db.all(sql, params));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AJAX: live price + name for a single SKU ───────────────────────────────

router.get('/vendor/sku-info', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const sku = (req.query.sku || '').trim();
    if (!sku) return res.json(null);
    await ensureCatalog(locationId);
    const items = await vendorApi.getProductsBySku([sku], { locationId });
    const item = items[0] || null;
    if (!item) return res.json(null);
    res.json(extractPriceEntry(item));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Catalog sync (XML feed → vendor_products table) ────────────────────────

// Manual refresh from the settings page.
router.post('/vendor/sync-catalog', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const feedUrl = await getCatalogFeedUrl(locationId);
    if (!feedUrl) {
      req.flash('error', 'Brak adresu pliku XML. Dodaj go w danych dostawcy Inter-Mlecz lub ustaw VENDOR_XML_FEED_URL.');
      return res.redirect('/orders/settings');
    }
    const { count } = await vendorCatalog.syncCatalogOnce({ locationId, feedUrl });
    await log(sessionUser(req), 'Zamówienia – synchronizacja katalogu', `${count} produktów`);
    req.flash('success', `Katalog zsynchronizowany: ${count} produktów.`);
    res.redirect('/orders/settings');
  } catch (e) {
    console.error('[catalog] manual sync failed:', e.message);
    req.flash('error', `Błąd synchronizacji katalogu: ${e.message}`);
    res.redirect('/orders/settings');
  }
});

// Lightweight stock refresh from the availability feed (~2 MB) — no full re-download.
router.post('/vendor/refresh-availability', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const feedUrl = await getCatalogFeedUrl(locationId);
    const availUrl = vendorCatalog.deriveAvailabilityUrl(feedUrl);
    if (!availUrl) {
      req.flash('error', 'Brak adresu pliku dostępności. Ustaw adres pliku XML katalogu (format /xmlapi/1/3/…) lub VENDOR_XML_AVAILABILITY_URL.');
      return res.redirect('/orders/settings');
    }
    const { matched } = await vendorCatalog.syncAvailabilityOnce({ locationId, availUrl });
    await log(sessionUser(req), 'Zamówienia – odświeżenie dostępności', `${matched} produktów`);
    req.flash('success', `Dostępność odświeżona: ${matched} produktów zaktualizowanych.`);
    res.redirect('/orders/settings');
  } catch (e) {
    console.error('[catalog] availability refresh failed:', e.message);
    req.flash('error', `Błąd odświeżania dostępności: ${e.message}`);
    res.redirect('/orders/settings');
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
    const orderSettings = await getOrderSettings(locationId) || {};
    const catalogStatus = await vendorCatalog.catalogStatus(locationId).catch(() => ({ count: 0, syncedAt: null }));

    // Live payment options from the API vendor, so the dropdown offers exactly what the B2B
    // platform accepts (no fuzzy mapping). Empty list → the view falls back to a text input.
    const apiVendor = vendors.find(v => v.api_type === 'intermlecz' && v.client_id && v.api_key);
    let paymentOptions = [];
    if (apiVendor) {
      paymentOptions = await vendorApi.getPaymentOptions({ clientId: apiVendor.client_id, apiKey: apiVendor.api_key })
        .catch(e => { console.warn('Payment options fetch failed:', e.message); return []; });
    }

    // Payment is stored as a numeric platform Id, so preselect by Id (no name matching).
    const selectedPaymentId = orderSettings.cafe_payment_id != null ? parseInt(orderSettings.cafe_payment_id, 10) : null;
    const paymentMismatch = selectedPaymentId != null && !paymentOptions.some(p => Number(p.Id) === selectedPaymentId);

    res.render('orders/settings', {
      title: 'Ustawienia zamówień', currentPath: '/orders',
      vendors, editVendor, orderSettings, catalogStatus, paymentOptions,
      selectedPaymentId, paymentMismatch,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/settings/api-addresses', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const vendors = await loadVendors(locationId);
    const apiVendor = vendors.find(v => v.api_type === 'intermlecz' && v.client_id && v.api_key);
    if (!apiVendor) return res.json({ error: 'Brak dostawcy z API (Inter-Mlecz).' });
    const addresses = await vendorApi.getClientAddresses({ clientId: apiVendor.client_id, apiKey: apiVendor.api_key });
    if (addresses.length === 1) {
      const a = addresses[0];
      const existing = await getOrderSettings(locationId) || {};
      if (!existing.cafe_address_id) {
        await db.run(
          `INSERT INTO order_settings (location_id, cafe_address_id, cafe_name, cafe_street, cafe_house_number, cafe_postal_code, cafe_city, cafe_phone, cafe_email)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE cafe_address_id=VALUES(cafe_address_id), cafe_name=VALUES(cafe_name),
             cafe_street=VALUES(cafe_street), cafe_house_number=VALUES(cafe_house_number),
             cafe_postal_code=VALUES(cafe_postal_code), cafe_city=VALUES(cafe_city),
             cafe_phone=VALUES(cafe_phone), cafe_email=VALUES(cafe_email)`,
          [locationId, parseInt(a.Id), a.Name || null, a.Street || null, a.HouseNumber || null,
           a.PostalCode || null, a.City || null, a.Phone || null, a.Email || null]
        ).catch(() => {});
      }
    }
    res.json({ addresses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings/address', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { cafe_name, cafe_street, cafe_house_number, cafe_postal_code, cafe_city,
            cafe_phone, cafe_email, cafe_address_id, cafe_delivery_name, cafe_payment_id } = req.body;
    const cafeAddress = [cafe_street, cafe_house_number, cafe_postal_code, cafe_city]
      .filter(Boolean).join(' ').trim() || null;
    await db.run(
      `INSERT INTO order_settings
         (location_id, cafe_address, cafe_name, cafe_street, cafe_house_number, cafe_postal_code, cafe_city, cafe_phone, cafe_email, cafe_address_id, cafe_delivery_name, cafe_payment_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         cafe_address=VALUES(cafe_address), cafe_name=VALUES(cafe_name),
         cafe_street=VALUES(cafe_street), cafe_house_number=VALUES(cafe_house_number),
         cafe_postal_code=VALUES(cafe_postal_code), cafe_city=VALUES(cafe_city),
         cafe_phone=VALUES(cafe_phone), cafe_email=VALUES(cafe_email),
         cafe_address_id=VALUES(cafe_address_id),
         cafe_delivery_name=VALUES(cafe_delivery_name),
         cafe_payment_id=VALUES(cafe_payment_id)`,
      [locationId, cafeAddress,
       cafe_name?.trim() || null, cafe_street?.trim() || null,
       cafe_house_number?.trim() || null, cafe_postal_code?.trim() || null,
       cafe_city?.trim() || null, cafe_phone?.trim() || null,
       cafe_email?.trim() || null, cafe_address_id ? parseInt(cafe_address_id) : null,
       cafe_delivery_name?.trim() || null, cafe_payment_id ? parseInt(cafe_payment_id, 10) : null]
    );
    req.flash('success', 'Adres kawiarni zapisany.');
    res.redirect('/orders/settings');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd zapisu adresu.');
    res.redirect('/orders/settings');
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
    const orderSettings = await getOrderSettings(locationId) || {};
    const cafeAddress = orderSettings.cafe_address || '';
    res.render('orders/new', {
      title: 'Nowe zamówienie', currentPath: '/orders',
      lowStock, priceMap, minOrderValue, vendors, cafeAddress,
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
    const { notes, vendor_id, delivery_date, delivery_address, payment_method, own_order_number } = req.body;

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
      `INSERT INTO purchase_orders (location_id, created_by, vendor_id, notes, status, total_netto, delivery_date, delivery_address, payment_method, own_order_number) VALUES (?,?,?,?,'draft',0,?,?,?,?)`,
      [locationId, userId, parseInt(vendor_id) || null, notes?.trim() || null,
       delivery_date?.trim() || null, delivery_address?.trim() || null,
       payment_method?.trim() || null, own_order_number?.trim() || null]
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
    const isAdmin = ['admin', 'super_admin'].includes(req.session.userRole);
    // Admins can edit an open basket too — after editing, "Aktualizuj koszyk" re-syncs it.
    const editableStatuses = isAdmin ? ['draft', 'approved', 'basket_created'] : ['draft'];
    if (!editableStatuses.includes(order.status)) {
      req.flash('error', 'Nie można edytować zamówienia w tym statusie.');
      return res.redirect(`/orders/${order.id}`);
    }

    const items = await db.all(
      `SELECT * FROM purchase_order_items WHERE order_id = ? ORDER BY id`,
      [order.id]
    );
    const minOrderValue = await getMinOrderValue(locationId, order.vendor_id);
    const orderSettings = await getOrderSettings(locationId) || {};
    const cafeAddress = orderSettings.cafe_address || '';

    res.render('orders/edit', {
      title: `Edytuj zamówienie #${order.id}`, currentPath: '/orders',
      order, items, minOrderValue, cafeAddress,
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
    const isAdminPut = ['admin', 'super_admin'].includes(req.session.userRole);
    const editableStatusesPut = isAdminPut ? ['draft', 'approved', 'basket_created'] : ['draft'];
    if (!order || !editableStatusesPut.includes(order.status)) {
      req.flash('error', 'Nie można edytować zamówienia w tym statusie.');
      return res.redirect(`/orders/${req.params.id}`);
    }

    const { notes, delivery_date, own_order_number, payment_method, delivery_address } = req.body;
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

    await db.run(
      `UPDATE purchase_orders SET notes=?, delivery_date=?, own_order_number=?, payment_method=?, delivery_address=?, updated_at=NOW() WHERE id=?`,
      [notes?.trim() || null, delivery_date || null, own_order_number?.trim() || null, payment_method || null, delivery_address?.trim() || null, order.id]
    );

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

// ── Shared setup for basket routes ────────────────────────────────────────

async function _buildBasketParams(locationId, order) {
  const items = await db.all(`SELECT * FROM purchase_order_items WHERE order_id=?`, [order.id]);
  const itemsWithSku = items.filter(i => i.vendor_product_key);

  let creds = await getVendorCreds(locationId);
  if (order.vendor_id) {
    const v = await db.get(`SELECT * FROM vendors WHERE id=? AND location_id=?`, [order.vendor_id, locationId]);
    if (v?.client_id && v?.api_key) creds = { clientId: v.client_id, apiKey: v.api_key };
  }

  try {
    const skus = itemsWithSku.map(i => i.vendor_product_key);
    const vendorProducts = await vendorApi.getProductsBySku(skus, { locationId });
    const unitMap = new Map(vendorProducts.map(p => [String(p.Sku).trim(), p.Unit]));
    for (const item of itemsWithSku) {
      const vendorUnit = unitMap.get(String(item.vendor_product_key).trim());
      if (vendorUnit) item.unit = vendorUnit;
    }
  } catch (e) {
    console.error('[basket] unit re-fetch error:', e.message);
  }

  const settings = await getOrderSettings(locationId) || {};
  let address = null;
  let addressId = settings.cafe_address_id ? parseInt(settings.cafe_address_id, 10) : null;
  try {
    const addrs = await vendorApi.getClientAddresses(creds);
    if (addrs.length > 0) {
      const a = addrs[0];
      if (!addressId) addressId = parseInt(a.Id, 10);
      address = {
        Name:            a.Name            || settings.cafe_name  || '',
        Street:          a.Street          || settings.cafe_street || '',
        City:            a.City            || settings.cafe_city   || '',
        PostalCode:      a.PostalCode      || settings.cafe_postal_code || '',
        Phone:           a.Phone           || settings.cafe_phone  || '',
        CountryId:       a.CountryId       || settings.cafe_country_id || 1,
        RegionId:        a.RegionId        || 0,
        Email:           a.Email           || settings.cafe_email  || '',
        ApartmentNumber: a.ApartmentNumber || '',
        HouseNumber:     a.HouseNumber     || settings.cafe_house_number || '',
        TaxNumber:       a.TaxNumber       || '',
      };
    }
  } catch (e) {
    console.error('[basket] getClientAddresses error:', e.message);
  }
  if (!address && settings.cafe_street && settings.cafe_city) {
    address = {
      Name:            settings.cafe_name         || '',
      Street:          settings.cafe_street        || '',
      City:            settings.cafe_city          || '',
      PostalCode:      settings.cafe_postal_code   || '',
      Phone:           settings.cafe_phone         || '',
      CountryId:       settings.cafe_country_id   || 1,
      RegionId:        0,
      Email:           settings.cafe_email         || '',
      ApartmentNumber: '',
      HouseNumber:     settings.cafe_house_number  || '',
      TaxNumber:       '',
    };
  }

  // Own order number goes to the platform's dedicated nr_wlasny field (see prepareBasket),
  // NOT into the comment. The "|" char is rejected by the platform, so it's stripped from notes.
  const ownOrderNumber = order.own_order_number?.trim() || null;
  const comment = (order.notes?.trim() || `Zamówienie #${order.id} - Kredki`).replace(/\|/g, '/');
  // Payment is configured as a numeric platform Id (see settings dropdown), sent straight through.
  const paymentId = settings.cafe_payment_id != null ? parseInt(settings.cafe_payment_id, 10) : null;

  return { itemsWithSku, creds, address, addressId, comment, paymentId, ownOrderNumber };
}

// ── Step 1: Create basket (approved → basket_created) ─────────────────────

router.post('/:id/create-basket', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'approved') {
      req.flash('error', 'Tylko zatwierdzone zamówienia można wysłać do koszyka.');
      return res.redirect(`/orders/${req.params.id}`);
    }

    const { itemsWithSku, creds, address, addressId, comment, paymentId, ownOrderNumber } = await _buildBasketParams(locationId, order);
    if (itemsWithSku.length === 0) {
      req.flash('error', 'Żaden produkt nie ma przypisanego klucza SKU dostawcy.');
      return res.redirect(`/orders/${order.id}`);
    }

    const basketId = await vendorApi.prepareBasket({
      items: itemsWithSku,
      comment,
      paymentId,
      ownOrderNumber,
      address,
      addressId,
      deliveryDate: order.delivery_date || null,
      ...creds,
    });

    await db.run(
      `UPDATE purchase_orders SET status='basket_created', vendor_basket_id=?, updated_at=NOW() WHERE id=?`,
      [String(basketId), order.id]
    );
    await log(sessionUser(req), 'Zamówienia – koszyk utworzony', `ID: ${order.id} | BasketId: ${basketId}`);

    req.flash('success', `Koszyk utworzony u dostawcy (ID: ${basketId}). Sprawdź koszyk na platformie B2B, a następnie finalizuj zamówienie.`);
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error('Create basket error:', e);
    req.flash('error', e.message);
    res.redirect(`/orders/${req.params.id}`);
  }
});

// ── Step 1b: Update an existing basket in place (basket_created) ──────────
// Re-syncs the already-created basket with the current order (items, quantities, comment,
// payment, delivery date, nr_wlasny) without deleting it — the basket ID is preserved.

router.post('/:id/update-basket', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'basket_created') {
      req.flash('error', 'Tylko zamówienia z otwartym koszykiem można aktualizować.');
      return res.redirect(`/orders/${req.params.id}`);
    }
    if (!order.vendor_basket_id) {
      req.flash('error', 'Brak ID koszyka — nie można zaktualizować.');
      return res.redirect(`/orders/${order.id}`);
    }

    const { itemsWithSku, creds, address, addressId, comment, paymentId, ownOrderNumber } = await _buildBasketParams(locationId, order);
    if (itemsWithSku.length === 0) {
      req.flash('error', 'Żaden produkt nie ma przypisanego klucza SKU dostawcy.');
      return res.redirect(`/orders/${order.id}`);
    }

    await vendorApi.updateBasket({
      basketId: order.vendor_basket_id,
      items: itemsWithSku,
      comment,
      paymentId,
      ownOrderNumber,
      address,
      addressId,
      deliveryDate: order.delivery_date || null,
      ...creds,
    });

    await db.run(`UPDATE purchase_orders SET updated_at=NOW() WHERE id=?`, [order.id]);
    await log(sessionUser(req), 'Zamówienia – koszyk zaktualizowany', `ID: ${order.id} | BasketId: ${order.vendor_basket_id}`);

    req.flash('success', `Koszyk u dostawcy zaktualizowany (ID: ${order.vendor_basket_id}). Sprawdź koszyk na platformie B2B.`);
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error('Update basket error:', e);
    req.flash('error', e.message);
    res.redirect(`/orders/${req.params.id}`);
  }
});

// ── Step 2: Finalize basket (basket_created → placed) ─────────────────────

router.post('/:id/finalize-basket', requireAdmin, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const order = await db.get(
      `SELECT * FROM purchase_orders WHERE id=? AND location_id=?`, [req.params.id, locationId]
    );
    if (!order || order.status !== 'basket_created') {
      req.flash('error', 'Tylko zamówienia z otwartym koszykiem można finalizować.');
      return res.redirect(`/orders/${req.params.id}`);
    }
    if (!order.vendor_basket_id) {
      req.flash('error', 'Brak ID koszyka — nie można sfinalizować.');
      return res.redirect(`/orders/${order.id}`);
    }

    const { creds, address, addressId } = await _buildBasketParams(locationId, order);

    const settings = await getOrderSettings(locationId) || {};
    const deliveryName = settings.cafe_delivery_name?.trim() || null;

    const vendorResult = await vendorApi.finalizeBasket({
      basketId: order.vendor_basket_id, deliveryName, address, addressId, ...creds,
    });

    // The order create response's OrderId is the supplier's order number (integer; can be
    // negative for test orders). Use != null so 0/negatives aren't lost, and never fall back to
    // storing a raw JSON blob.
    const vendorOrderId = vendorResult?.OrderId != null ? String(vendorResult.OrderId)
      : (vendorResult?.Id != null ? String(vendorResult.Id) : null);
    if (vendorOrderId == null) {
      console.error('[basket] finalize succeeded but no OrderId in response:', JSON.stringify(vendorResult));
    }
    await db.run(
      `UPDATE purchase_orders SET status='placed', vendor_order_id=?, updated_at=NOW() WHERE id=?`,
      [vendorOrderId, order.id]
    );
    await log(sessionUser(req), 'Zamówienia – złożono u dostawcy', `ID: ${order.id} | Vendor: ${vendorOrderId ?? '(brak OrderId)'}`);

    const statements = [
      ...(vendorResult?.BasketStatements || []),
      ...(vendorResult?.BasketProductsStatements || []),
    ].map(s => s.Message).filter(Boolean);

    req.flash('success', `Zamówienie złożone u dostawcy${vendorOrderId ? ` (nr ${vendorOrderId})` : ''}.${statements.length ? ' ' + statements.join('; ') : ''}`);
    res.redirect(`/orders/${order.id}`);
  } catch (e) {
    console.error('Finalize basket error:', e);
    req.flash('error', e.message);
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
