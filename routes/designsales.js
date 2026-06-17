const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { log } = require('../utils/logger');

// designsales feature is enabled only for Kredki (gated via location_features)
router.use(requireAuth, requireFeature('designsales'));

const requireManager = requireRole('admin', 'location_manager', 'super_admin');

// GET / — single page: add form + list of recent sales
router.get('/', async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const sales = await db.all(`
      SELECT s.*, u.name AS created_by_name
      FROM design_sales s
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.location_id = ?
      ORDER BY s.sold_at DESC, s.created_at DESC
      LIMIT 200
    `, [locationId]);

    res.render('designsales/index', {
      currentPath: '/design-sales',
      sales,
      today: new Date().toISOString().split('T')[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd ładowania sprzedaży designu.' });
  }
});

// POST / — create
router.post('/', async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { sold_at, brand, color, quantity, notes } = req.body;

    if (!sold_at) {
      req.flash('error', 'Data sprzedaży jest wymagana.');
      return res.redirect('/design-sales');
    }

    const qty = quantity && String(quantity).trim() !== '' ? parseInt(quantity, 10) : null;

    await db.run(`
      INSERT INTO design_sales (location_id, sold_at, brand, color, quantity, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      locationId,
      sold_at,
      brand?.trim() || null,
      color?.trim() || null,
      Number.isNaN(qty) ? null : qty,
      notes?.trim() || null,
      req.session.userId,
    ]);

    await log(
      { id: req.session.userId, name: req.session.userName, role: req.session.userRole },
      'design_sale_create',
      `Sprzedaż designu: ${[brand, color].filter(Boolean).join(' ') || '—'}`
    );

    req.flash('success', 'Sprzedaż zapisana.');
    res.redirect('/design-sales');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Błąd podczas zapisywania sprzedaży.');
    res.redirect('/design-sales');
  }
});

// DELETE /:id (manager+)
router.delete('/:id', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    await db.run(`DELETE FROM design_sales WHERE id=? AND location_id=?`, [req.params.id, locationId]);
    await log(
      { id: req.session.userId, name: req.session.userName, role: req.session.userRole },
      'design_sale_delete',
      `Usunięto sprzedaż designu ID ${req.params.id}`
    );
    req.flash('success', 'Wpis usunięty.');
    res.redirect('/design-sales');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Błąd podczas usuwania wpisu.');
    res.redirect('/design-sales');
  }
});

module.exports = router;
