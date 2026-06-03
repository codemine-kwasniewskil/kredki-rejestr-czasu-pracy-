'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

const requireManager = requireRole('admin', 'location_manager');

router.use(requireAuth);

function sessionUser(req) {
  return { id: req.session.userId, name: req.session.userName, role: req.session.userRole };
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadMeta() {
  const rows = await db.all(`SELECT * FROM stock_report_types ORDER BY sort_order, id`);
  const REPORT_META = {};
  for (const r of rows) {
    REPORT_META[r.id] = {
      label: r.label, icon: r.icon,
      desc: r.description || '', freq: r.freq || '',
      isShift: !!r.is_shift_type, active: !!r.active,
    };
  }
  return { reportTypes: rows, REPORT_META };
}

function groupByCategory(items) {
  const grouped = [];
  let lastCat = undefined;
  for (const item of items) {
    if (item.category !== lastCat) {
      grouped.push({ category: item.category, items: [] });
      lastCat = item.category;
    }
    grouped[grouped.length - 1].items.push(item);
  }
  return grouped;
}

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { REPORT_META } = await loadMeta();
    const reportDate = req.query.date || today();

    const reports = await db.all(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id
       WHERE sr.report_date = ? ORDER BY sr.report_type`,
      [reportDate]
    );
    const reportsByType = {};
    for (const r of reports) reportsByType[r.report_type] = r;

    const history = await db.all(
      `SELECT sr.report_date, sr.report_type, u.name AS submitted_by_name, sr.id
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id
       WHERE sr.report_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       ORDER BY sr.report_date DESC, sr.report_type`
    );

    res.render('stock/index', {
      title: 'Raport Stanów', currentPath: '/stock',
      reportDate, reportsByType, history, REPORT_META,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Form ───────────────────────────────────────────────────────────────────

router.get('/form/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { REPORT_META } = await loadMeta();
    const meta = REPORT_META[type];
    if (!meta) return res.redirect('/stock');

    const reportDate = req.query.date || today();

    const items = await db.all(
      `SELECT * FROM stock_items WHERE report_type = ? AND active = 1 ORDER BY sort_order, id`,
      [type]
    );
    const existing = await db.get(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id
       WHERE sr.report_date = ? AND sr.report_type = ?`,
      [reportDate, type]
    );
    const entries = {};
    if (existing) {
      const rows = await db.all(`SELECT * FROM stock_report_entries WHERE report_id = ?`, [existing.id]);
      for (const e of rows) entries[e.item_id] = e;
    }

    const minQtyMap = {};
    for (const item of items) {
      if (item.min_qty !== null && item.min_qty !== undefined) minQtyMap[item.id] = Number(item.min_qty);
    }

    // Last reported value per item (most recent report of this type)
    const lastRows = await db.all(
      `SELECT sre.item_id, sre.quantity, sre.stan_zamkniecie
       FROM stock_report_entries sre
       INNER JOIN (
         SELECT sre2.item_id, MAX(sr2.report_date) AS max_date
         FROM stock_report_entries sre2
         JOIN stock_reports sr2 ON sr2.id = sre2.report_id
         WHERE sr2.report_type = ?
         GROUP BY sre2.item_id
       ) latest ON latest.item_id = sre.item_id
       JOIN stock_reports sr ON sr.id = sre.report_id AND sr.report_date = latest.max_date
       WHERE sr.report_type = ?`,
      [type, type]
    );
    const lastValues = {};
    for (const row of lastRows) lastValues[row.item_id] = row;

    res.render('stock/form', {
      title: meta.label, currentPath: '/stock',
      type, meta, reportDate, existing,
      grouped: groupByCategory(items), entries, REPORT_META, minQtyMap, lastValues,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Save ───────────────────────────────────────────────────────────────────

router.post('/save', async (req, res) => {
  try {
    const { report_type, report_date, notes } = req.body;
    const { REPORT_META } = await loadMeta();
    const meta = REPORT_META[report_type];
    if (!meta) return res.redirect('/stock');

    const userId = req.session.userId;

    let report = await db.get(
      `SELECT id FROM stock_reports WHERE report_date = ? AND report_type = ?`,
      [report_date, report_type]
    );
    const wasNew = !report;
    if (report) {
      await db.run(
        `UPDATE stock_reports SET submitted_by=?, notes=?, updated_at=NOW() WHERE id=?`,
        [userId, notes || null, report.id]
      );
    } else {
      const result = await db.run(
        `INSERT INTO stock_reports (report_date, report_type, submitted_by, notes) VALUES (?,?,?,?)`,
        [report_date, report_type, userId, notes || null]
      );
      report = { id: result.insertId };
    }

    const items = await db.all(
      `SELECT id FROM stock_items WHERE report_type = ? AND active = 1`, [report_type]
    );
    // If dual-layout sent duplicate fields, pick the first non-empty value; enforce integer
    const pick = (v) => {
      const raw = (Array.isArray(v) ? v.find(x => x && x.trim()) || '' : v || '').trim();
      if (!raw || raw === '—' || raw === '-') return null;
      const n = parseInt(raw.replace(',', '.'), 10);
      return isNaN(n) ? null : String(n);
    };

    for (const item of items) {
      const id = item.id;
      if (meta.isShift) {
        const s_o = pick(req.body[`stan_otwarcie_${id}`]);
        const d   = pick(req.body[`dostawa_${id}`]);
        const s16 = pick(req.body[`stan_16_${id}`]);
        const s_z = pick(req.body[`stan_zamkniecie_${id}`]);
        const usz = pick(req.body[`uszkodzone_${id}`]);
        await db.run(
          `INSERT INTO stock_report_entries (report_id,item_id,stan_otwarcie,dostawa,stan_16,stan_zamkniecie,uszkodzone)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE stan_otwarcie=VALUES(stan_otwarcie),dostawa=VALUES(dostawa),
             stan_16=VALUES(stan_16),stan_zamkniecie=VALUES(stan_zamkniecie),uszkodzone=VALUES(uszkodzone)`,
          [report.id, id, s_o, d, s16, s_z, usz]
        );
      } else {
        const qty = pick(req.body[`qty_${id}`]);
        const n   = (req.body[`notes_${id}`] || '').trim() || null;
        await db.run(
          `INSERT INTO stock_report_entries (report_id,item_id,quantity,notes)
           VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE quantity=VALUES(quantity),notes=VALUES(notes)`,
          [report.id, id, qty, n]
        );
      }
    }

    const action = wasNew ? 'Raport Stanów – nowy raport' : 'Raport Stanów – aktualizacja raportu';
    await log(sessionUser(req), action, `Typ: ${meta.label} | Data: ${report_date}`);
    req.flash('success', 'Raport zapisany.');
    res.redirect(`/stock/view/${report.id}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy zapisie raportu.');
    res.redirect('/stock');
  }
});

// ── View ───────────────────────────────────────────────────────────────────

router.get('/view/:id', async (req, res) => {
  try {
    const { REPORT_META } = await loadMeta();
    const report = await db.get(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id WHERE sr.id = ?`,
      [req.params.id]
    );
    if (!report) return res.status(404).render('error', { message: 'Raport nie istnieje.' });

    const meta = REPORT_META[report.report_type] || { label: report.report_type, icon: '📋', isShift: false };

    const items = await db.all(
      `SELECT si.*, sre.quantity, sre.stan_otwarcie, sre.dostawa, sre.stan_16, sre.stan_zamkniecie, sre.uszkodzone
       FROM stock_items si
       LEFT JOIN stock_report_entries sre ON sre.item_id=si.id AND sre.report_id=?
       WHERE si.report_type=? AND si.active=1 ORDER BY si.sort_order, si.id`,
      [report.id, report.report_type]
    );

    res.render('stock/view', {
      title: meta.label, currentPath: '/stock',
      report, grouped: groupByCategory(items), meta, REPORT_META,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Admin panel ────────────────────────────────────────────────────────────

router.get('/admin', requireManager, async (req, res) => {
  try {
    const { reportTypes, REPORT_META } = await loadMeta();
    const tab = req.query.tab || 'items';
    const activeType = req.query.type || (reportTypes[0]?.id || 'daily_morning');
    const editId = req.query.edit ? parseInt(req.query.edit) : null;

    const items = await db.all(
      `SELECT si.*, COUNT(sre.id) AS entry_count
       FROM stock_items si
       LEFT JOIN stock_report_entries sre ON sre.item_id = si.id
       WHERE si.report_type = ?
       GROUP BY si.id
       ORDER BY si.sort_order, si.id`,
      [activeType]
    );
    const editItem = editId ? await db.get(`SELECT * FROM stock_items WHERE id=?`, [editId]) : null;

    // Categories for dropdown: merge stock_categories table + distinct from items
    const categoryRows = await db.all(
      `SELECT DISTINCT name AS category FROM (
         SELECT name FROM stock_categories WHERE report_type=?
         UNION
         SELECT category FROM stock_items WHERE report_type=? AND category IS NOT NULL
       ) c ORDER BY category`,
      [activeType, activeType]
    );
    const categories = categoryRows.map(r => r.category);

    // Units for dropdown: merge stock_units table + distinct from items
    const unitRows = await db.all(
      `SELECT DISTINCT name AS unit FROM (
         SELECT name FROM stock_units
         UNION
         SELECT unit FROM stock_items WHERE unit IS NOT NULL AND unit != '' AND unit != '-'
       ) u ORDER BY unit`
    );
    const units = unitRows.map(r => r.unit);

    // Category stats for management panel (catalog + item counts)
    const categoryStats = await db.all(
      `SELECT c.name AS category, COALESCE(ic.cnt, 0) AS cnt
       FROM (
         SELECT name FROM stock_categories WHERE report_type=?
         UNION
         SELECT DISTINCT category FROM stock_items WHERE report_type=? AND category IS NOT NULL
       ) c
       LEFT JOIN (
         SELECT category, COUNT(*) AS cnt FROM stock_items WHERE report_type=? AND category IS NOT NULL GROUP BY category
       ) ic ON ic.category = c.name
       ORDER BY c.name`,
      [activeType, activeType, activeType]
    );

    // Unit stats for management panel (catalog + item counts for this type)
    const unitStats = await db.all(
      `SELECT u.name AS unit, COALESCE(ic.cnt, 0) AS cnt
       FROM (
         SELECT name FROM stock_units
         UNION
         SELECT DISTINCT unit FROM stock_items WHERE unit IS NOT NULL AND unit != '' AND unit != '-'
       ) u
       LEFT JOIN (
         SELECT unit, COUNT(*) AS cnt FROM stock_items WHERE report_type=? AND unit IS NOT NULL GROUP BY unit
       ) ic ON ic.unit = u.name
       ORDER BY u.name`,
      [activeType]
    );

    const history = await db.all(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by=u.id
       ORDER BY sr.report_date DESC, sr.report_type LIMIT 100`
    );

    res.render('stock/admin', {
      title: 'Zarządzaj – Raport Stanów', currentPath: '/stock',
      tab, activeType, items, editItem, categories, units,
      categoryStats, unitStats,
      history, reportTypes, REPORT_META,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// Add item
router.post('/admin/items', requireManager, async (req, res) => {
  try {
    const { report_type, category, name, unit, target_qty, sort_order, min_qty } = req.body;
    if (!name || !report_type) {
      req.flash('error', 'Nazwa i typ raportu są wymagane.');
      return res.redirect(`/stock/admin?type=${report_type || ''}`);
    }
    const minQtyVal = min_qty && min_qty.trim() !== '' ? parseFloat(min_qty) : null;
    await db.run(
      `INSERT INTO stock_items (report_type, category, name, unit, target_qty, sort_order, min_qty) VALUES (?,?,?,?,?,?,?)`,
      [report_type, category?.trim() || null, name.trim(), unit?.trim() || null,
       target_qty?.trim() || null, parseInt(sort_order) || 0, minQtyVal]
    );
    await log(sessionUser(req), 'Raport Stanów – dodano produkt', `${name.trim()} | Typ: ${report_type}${category ? ' | Kat: ' + category.trim() : ''}`);
    req.flash('success', 'Produkt dodany.');
    res.redirect(`/stock/admin?type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu.');
    res.redirect('/stock/admin');
  }
});

// Update item
router.post('/admin/items/:id', requireManager, async (req, res) => {
  try {
    const { report_type, category, name, unit, target_qty, sort_order, active, min_qty } = req.body;
    const minQtyVal = min_qty && min_qty.trim() !== '' ? parseFloat(min_qty) : null;
    await db.run(
      `UPDATE stock_items SET report_type=?,category=?,name=?,unit=?,target_qty=?,sort_order=?,active=?,min_qty=? WHERE id=?`,
      [report_type, category?.trim() || null, name?.trim(), unit?.trim() || null,
       target_qty?.trim() || null, parseInt(sort_order) || 0, active === '1' ? 1 : 0, minQtyVal, req.params.id]
    );
    await log(sessionUser(req), 'Raport Stanów – zaktualizowano produkt', `ID: ${req.params.id} | ${name?.trim()} | Typ: ${report_type}`);
    req.flash('success', 'Produkt zaktualizowany.');
    res.redirect(`/stock/admin?type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy aktualizacji.');
    res.redirect('/stock/admin');
  }
});

// Toggle item active
router.post('/admin/items/:id/toggle', requireManager, async (req, res) => {
  try {
    const item = await db.get(`SELECT * FROM stock_items WHERE id=?`, [req.params.id]);
    if (item) {
      await db.run(`UPDATE stock_items SET active=? WHERE id=?`, [item.active ? 0 : 1, item.id]);
      await log(sessionUser(req), `Raport Stanów – produkt ${item.active ? 'ukryty' : 'aktywowany'}`, `${item.name} | Typ: ${item.report_type}`);
    }
    res.redirect(`/stock/admin?type=${req.body.report_type || ''}`);
  } catch (e) {
    console.error(e);
    res.redirect('/stock/admin');
  }
});

// Delete item (only if unused in any report)
router.delete('/admin/items/:id', requireManager, async (req, res) => {
  try {
    const usage = await db.get(`SELECT COUNT(*) AS cnt FROM stock_report_entries WHERE item_id=?`, [req.params.id]);
    if (usage && usage.cnt > 0) {
      req.flash('error', 'Nie można usunąć – produkt ma historię w raportach. Użyj „Ukryj" aby go dezaktywować.');
      return res.redirect(`/stock/admin?tab=items&type=${req.body.report_type || ''}`);
    }
    const toDelete = await db.get(`SELECT name, report_type FROM stock_items WHERE id=?`, [req.params.id]);
    await db.run(`DELETE FROM stock_items WHERE id=?`, [req.params.id]);
    await log(sessionUser(req), 'Raport Stanów – usunięto produkt', `${toDelete?.name} | Typ: ${toDelete?.report_type}`);
    req.flash('success', 'Produkt usunięty.');
    res.redirect(`/stock/admin?tab=items&type=${req.body.report_type || ''}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu.');
    res.redirect('/stock/admin');
  }
});

// Add category to catalog
router.post('/admin/categories/add', requireManager, async (req, res) => {
  try {
    const { report_type, name } = req.body;
    if (!name?.trim()) {
      req.flash('error', 'Podaj nazwę kategorii.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    await db.run(`INSERT IGNORE INTO stock_categories (report_type, name) VALUES (?,?)`, [report_type, name.trim()]);
    await log(sessionUser(req), 'Raport Stanów – dodano kategorię', `${name.trim()} | Typ: ${report_type}`);
    req.flash('success', `Kategoria „${name.trim()}" dodana.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu kategorii.');
    res.redirect('/stock/admin');
  }
});

// Add unit to catalog
router.post('/admin/units/add', requireManager, async (req, res) => {
  try {
    const { report_type, name } = req.body;
    if (!name?.trim()) {
      req.flash('error', 'Podaj nazwę jednostki.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    await db.run(`INSERT IGNORE INTO stock_units (name) VALUES (?)`, [name.trim()]);
    await log(sessionUser(req), 'Raport Stanów – dodano jednostkę', name.trim());
    req.flash('success', `Jednostka „${name.trim()}" dodana.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu jednostki.');
    res.redirect('/stock/admin');
  }
});

// Rename category across items + catalog
router.post('/admin/categories/rename', requireManager, async (req, res) => {
  try {
    const { report_type, old_category, new_category } = req.body;
    if (!old_category || !new_category?.trim()) {
      req.flash('error', 'Podaj nową nazwę kategorii.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    const n = new_category.trim();
    await db.run(`UPDATE stock_items SET category=? WHERE report_type=? AND category=?`, [n, report_type, old_category]);
    await db.run(`UPDATE stock_categories SET name=? WHERE report_type=? AND name=?`, [n, report_type, old_category]);
    await log(sessionUser(req), 'Raport Stanów – zmieniono nazwę kategorii', `${old_category} → ${n} | Typ: ${report_type}`);
    req.flash('success', `Kategoria „${old_category}" → „${n}".`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy zmianie nazwy.');
    res.redirect('/stock/admin');
  }
});

// Delete category from items + catalog
router.post('/admin/categories/delete', requireManager, async (req, res) => {
  try {
    const { report_type, category } = req.body;
    await db.run(`UPDATE stock_items SET category=NULL WHERE report_type=? AND category=?`, [report_type, category]);
    await db.run(`DELETE FROM stock_categories WHERE report_type=? AND name=?`, [report_type, category]);
    await log(sessionUser(req), 'Raport Stanów – usunięto kategorię', `${category} | Typ: ${report_type}`);
    req.flash('success', `Kategoria „${category}" usunięta.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu kategorii.');
    res.redirect('/stock/admin');
  }
});

// Rename unit across items + catalog
router.post('/admin/units/rename', requireManager, async (req, res) => {
  try {
    const { report_type, old_unit, new_unit } = req.body;
    if (!old_unit || !new_unit?.trim()) {
      req.flash('error', 'Podaj nową nazwę jednostki.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    const n = new_unit.trim();
    await db.run(`UPDATE stock_items SET unit=? WHERE unit=?`, [n, old_unit]);
    await db.run(`UPDATE stock_units SET name=? WHERE name=?`, [n, old_unit]);
    await log(sessionUser(req), 'Raport Stanów – zmieniono nazwę jednostki', `${old_unit} → ${n}`);
    req.flash('success', `Jednostka „${old_unit}" → „${n}".`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy zmianie jednostki.');
    res.redirect('/stock/admin');
  }
});

// Delete unit from items + catalog
router.post('/admin/units/delete', requireManager, async (req, res) => {
  try {
    const { report_type, unit } = req.body;
    await db.run(`UPDATE stock_items SET unit=NULL WHERE unit=?`, [unit]);
    await db.run(`DELETE FROM stock_units WHERE name=?`, [unit]);
    await log(sessionUser(req), 'Raport Stanów – usunięto jednostkę', unit);
    req.flash('success', `Jednostka „${unit}" usunięta.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu jednostki.');
    res.redirect('/stock/admin');
  }
});

// Add report type
router.post('/admin/types', requireManager, async (req, res) => {
  try {
    const { id, label, icon, description, freq, is_shift_type, sort_order } = req.body;
    if (!id || !label) {
      req.flash('error', 'ID i nazwa są wymagane.');
      return res.redirect('/stock/admin?tab=types');
    }
    const slug = id.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    await db.run(
      `INSERT INTO stock_report_types (id,label,icon,description,freq,is_shift_type,sort_order) VALUES (?,?,?,?,?,?,?)`,
      [slug, label.trim(), icon?.trim() || '📋', description?.trim() || null,
       freq?.trim() || null, is_shift_type === '1' ? 1 : 0, parseInt(sort_order) || 50]
    );
    await log(sessionUser(req), 'Raport Stanów – dodano typ raportu', `${slug} | ${label.trim()}`);
    req.flash('success', `Typ raportu "${label}" dodany.`);
    res.redirect('/stock/admin?tab=types');
  } catch (e) {
    console.error(e);
    req.flash('error', e.code === 'ER_DUP_ENTRY' ? 'ID już istnieje – wybierz inne.' : 'Błąd przy dodawaniu.');
    res.redirect('/stock/admin?tab=types');
  }
});

// Update report type
router.post('/admin/types/:id', requireManager, async (req, res) => {
  try {
    const { label, icon, description, freq, is_shift_type, sort_order } = req.body;
    await db.run(
      `UPDATE stock_report_types SET label=?,icon=?,description=?,freq=?,is_shift_type=?,sort_order=? WHERE id=?`,
      [label?.trim(), icon?.trim() || '📋', description?.trim() || null,
       freq?.trim() || null, is_shift_type === '1' ? 1 : 0, parseInt(sort_order) || 0, req.params.id]
    );
    req.flash('success', 'Typ zaktualizowany.');
    res.redirect('/stock/admin?tab=types');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy aktualizacji.');
    res.redirect('/stock/admin?tab=types');
  }
});

// Toggle report type active
router.post('/admin/types/:id/toggle', requireManager, async (req, res) => {
  try {
    const t = await db.get(`SELECT * FROM stock_report_types WHERE id=?`, [req.params.id]);
    if (t) await db.run(`UPDATE stock_report_types SET active=? WHERE id=?`, [t.active ? 0 : 1, t.id]);
    res.redirect('/stock/admin?tab=types');
  } catch (e) {
    console.error(e);
    res.redirect('/stock/admin?tab=types');
  }
});

// Delete report
router.delete('/admin/reports/:id', requireManager, async (req, res) => {
  try {
    const toDelReport = await db.get(`SELECT report_date, report_type FROM stock_reports WHERE id=?`, [req.params.id]);
    await db.run(`DELETE FROM stock_reports WHERE id=?`, [req.params.id]);
    await log(sessionUser(req), 'Raport Stanów – usunięto raport', `Typ: ${toDelReport?.report_type} | Data: ${toDelReport?.report_date}`);
    req.flash('success', 'Raport usunięty.');
    res.redirect('/stock/admin?tab=history');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu.');
    res.redirect('/stock/admin?tab=history');
  }
});

module.exports = router;
