const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole, getLocationId } = require('../middleware/auth');
const { log } = require('../utils/logger');

const requireManager = [requireAuth, requireRole('admin', 'location_manager', 'super_admin')];

// GET / — list or calendar view
router.get('/', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const view = req.query.view === 'calendar' ? 'calendar' : 'list';

    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);

    let deliveries = [];
    let calendarData = {};
    let calendarDays = [];

    if (view === 'calendar') {
      const firstDay = `${year}-${String(month).padStart(2, '0')}-01`;
      const daysInMonth = new Date(year, month, 0).getDate();
      const lastDay = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

      const rows = await db.all(`
        SELECT d.*, u.name as created_by_name
        FROM deliveries d
        LEFT JOIN users u ON u.id = d.created_by
        WHERE d.location_id = ? AND d.delivered_at BETWEEN ? AND ?
        ORDER BY d.delivered_at ASC, d.created_at ASC
      `, [locationId, firstDay, lastDay]);

      for (const row of rows) {
        const d = new Date(row.delivered_at);
        const day = d.getUTCDate();
        if (!calendarData[day]) calendarData[day] = [];
        calendarData[day].push(row);
      }

      // Build calendar grid (Mon-first)
      const startDow = new Date(year, month - 1, 1).getDay(); // 0=Sun
      const offset = startDow === 0 ? 6 : startDow - 1; // Mon=0 offset
      for (let i = 0; i < offset; i++) calendarDays.push(null);
      for (let d = 1; d <= daysInMonth; d++) calendarDays.push(d);
      deliveries = rows;
    } else {
      deliveries = await db.all(`
        SELECT d.*, u.name as created_by_name
        FROM deliveries d
        LEFT JOIN users u ON u.id = d.created_by
        WHERE d.location_id = ?
        ORDER BY d.delivered_at DESC, d.created_at DESC
        LIMIT 100
      `, [locationId]);
    }

    res.render('deliveries/index', {
      currentPath: '/deliveries',
      view,
      deliveries,
      calendarData,
      calendarDays,
      year,
      month,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd ładowania dostaw.' });
  }
});

// GET /new
router.get('/new', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.render('deliveries/new', {
    currentPath: '/deliveries',
    today,
  });
});

// POST / — create
router.post('/', requireAuth, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { delivered_at, supplier, description, quantity, notes } = req.body;

    if (!delivered_at || !description || !description.trim()) {
      req.flash('error', 'Data i opis dostawy są wymagane.');
      return res.redirect('/deliveries/new');
    }

    await db.run(`
      INSERT INTO deliveries (location_id, delivered_at, supplier, description, quantity, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      locationId,
      delivered_at,
      supplier || null,
      description.trim(),
      quantity || null,
      notes || null,
      req.session.userId,
    ]);

    await log(
      { id: req.session.userId, name: req.session.userName, role: req.session.userRole },
      'delivery_create',
      `Dodano dostawę: ${description.trim()}`
    );

    req.flash('success', 'Dostawa została zapisana.');
    res.redirect('/deliveries');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Błąd podczas zapisywania dostawy.');
    res.redirect('/deliveries/new');
  }
});

// GET /report — admin table report with filters
router.get('/report', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const now = new Date();
    const fromDefault = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const toDefault = now.toISOString().split('T')[0];

    const from = req.query.from || fromDefault;
    const to = req.query.to || toDefault;
    const supplierFilter = req.query.supplier || '';

    const whereClauses = ['d.location_id = ?', 'd.delivered_at BETWEEN ? AND ?'];
    const params = [locationId, from, to];

    if (supplierFilter) {
      whereClauses.push('d.supplier LIKE ?');
      params.push(`%${supplierFilter}%`);
    }

    const deliveries = await db.all(`
      SELECT d.*, u.name as created_by_name
      FROM deliveries d
      LEFT JOIN users u ON u.id = d.created_by
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY d.delivered_at DESC, d.created_at DESC
    `, params);

    const supplierRows = await db.all(`
      SELECT DISTINCT supplier FROM deliveries
      WHERE location_id = ? AND supplier IS NOT NULL AND supplier != ''
      ORDER BY supplier
    `, [locationId]);

    res.render('deliveries/report', {
      currentPath: '/deliveries',
      deliveries,
      supplierRows,
      from,
      to,
      supplierFilter,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd ładowania raportu dostaw.' });
  }
});

// GET /summary — monthly aggregated summary: products + quantities, grouped by supplier
const MONTHS_PL = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];

// Parse a free-text quantity ("10", "10 szt", "5,5 kg") into a numeric value + unit hint.
function parseQuantity(raw) {
  if (!raw) return { num: null, unit: '' };
  const str = String(raw).trim();
  const m = str.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return { num: null, unit: str };
  const num = parseFloat(m[0].replace(',', '.'));
  const unit = str.replace(m[0], '').trim();
  return { num: isNaN(num) ? null : num, unit };
}

function fmtNum(n) {
  if (n == null) return '—';
  return (Number.isInteger(n) ? n.toString() : n.toFixed(2)).replace('.', ',');
}

router.get('/summary', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = (req.query.month || defaultMonth).substring(0, 7);

    const rows = await db.all(`
      SELECT supplier, description, quantity
      FROM deliveries
      WHERE location_id = ? AND DATE_FORMAT(delivered_at, '%Y-%m') = ?
      ORDER BY supplier, description
    `, [locationId, month]);

    // Group by supplier → product, summing numeric quantities.
    const suppliersMap = new Map();
    for (const r of rows) {
      const supplierKey = (r.supplier && r.supplier.trim()) || 'Bez dostawcy';
      if (!suppliersMap.has(supplierKey)) suppliersMap.set(supplierKey, new Map());
      const productsMap = suppliersMap.get(supplierKey);

      const name = (r.description || '').trim();
      const key = name.toLowerCase();
      const { num, unit } = parseQuantity(r.quantity);
      if (!productsMap.has(key)) {
        productsMap.set(key, { name, total: 0, hasNumeric: false, unit: '', deliveries: 0 });
      }
      const p = productsMap.get(key);
      p.deliveries += 1;
      if (num != null) { p.total += num; p.hasNumeric = true; if (!p.unit && unit) p.unit = unit; }
    }

    const suppliers = [...suppliersMap.entries()]
      .map(([name, productsMap]) => ({
        name,
        products: [...productsMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl')),
        deliveriesCount: [...productsMap.values()].reduce((s, p) => s + p.deliveries, 0),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pl'));

    const monthOptions = [];
    const base = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    for (let i = 0; i < 18; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthOptions.push({ val, label: MONTHS_PL[d.getMonth()] + ' ' + d.getFullYear() });
    }
    const [mYear, mMonth] = month.split('-').map(Number);
    const monthLabel = MONTHS_PL[mMonth - 1] + ' ' + mYear;

    res.render('deliveries/summary', {
      currentPath: '/deliveries',
      suppliers,
      month,
      monthLabel,
      monthOptions,
      totalDeliveries: rows.length,
      fmtNum,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd ładowania podsumowania dostaw.' });
  }
});

// GET /:id/edit
router.get('/:id/edit', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const delivery = await db.get(
      `SELECT * FROM deliveries WHERE id = ? AND location_id = ?`,
      [req.params.id, locationId]
    );
    if (!delivery) {
      req.flash('error', 'Dostawa nie znaleziona.');
      return res.redirect('/deliveries');
    }
    const deliveredAt = delivery.delivered_at
      ? new Date(delivery.delivered_at).toISOString().split('T')[0]
      : '';
    res.render('deliveries/edit', {
      currentPath: '/deliveries',
      delivery: { ...delivery, delivered_at: deliveredAt },
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd ładowania dostawy.' });
  }
});

// PUT /:id
router.put('/:id', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { delivered_at, supplier, description, quantity, notes } = req.body;

    await db.run(`
      UPDATE deliveries
      SET delivered_at=?, supplier=?, description=?, quantity=?, notes=?, updated_at=NOW()
      WHERE id=? AND location_id=?
    `, [
      delivered_at,
      supplier || null,
      description,
      quantity || null,
      notes || null,
      req.params.id,
      locationId,
    ]);

    await log(
      { id: req.session.userId, name: req.session.userName, role: req.session.userRole },
      'delivery_update',
      `Edytowano dostawę ID ${req.params.id}`
    );

    req.flash('success', 'Dostawa zaktualizowana.');
    res.redirect('/deliveries');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Błąd podczas aktualizacji dostawy.');
    res.redirect('/deliveries');
  }
});

// DELETE /:id
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    await db.run(`DELETE FROM deliveries WHERE id=? AND location_id=?`, [req.params.id, locationId]);
    await log(
      { id: req.session.userId, name: req.session.userName, role: req.session.userRole },
      'delivery_delete',
      `Usunięto dostawę ID ${req.params.id}`
    );
    req.flash('success', 'Dostawa usunięta.');
    res.redirect('/deliveries');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Błąd podczas usuwania dostawy.');
    res.redirect('/deliveries');
  }
});

module.exports = router;
