const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole, getLocationId, requireFeature } = require('../middleware/auth');

router.get('/', requireRole('admin', 'location_manager'), requireFeature('shifts'), async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const templates = await db.all(
      `SELECT * FROM shift_templates WHERE active=1 AND location_id=? ORDER BY sort_order, start_time`,
      [locationId]
    );
    res.render('shifts/index', { templates });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const { name, start_time, end_time, color } = req.body;
    if (!name || !start_time || !end_time) {
      req.flash('error', 'Nazwa, czas rozpoczęcia i zakończenia są wymagane.');
      return res.redirect('/shifts');
    }
    const locationId = getLocationId(req);
    const maxOrder = await db.get(
      'SELECT COALESCE(MAX(sort_order),0)+1 as next FROM shift_templates WHERE location_id=?',
      [locationId]
    );
    await db.run(
      `INSERT INTO shift_templates (name, start_time, end_time, color, sort_order, location_id) VALUES (?,?,?,?,?,?)`,
      [name, start_time, end_time, color || '#3B82F6', maxOrder.next, locationId]
    );
    req.flash('success', 'Szablon zmiany dodany.');
    res.redirect('/shifts');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.put('/reorder', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'Nieprawidłowe dane.' });
    for (let i = 0; i < ids.length; i++) {
      await db.run('UPDATE shift_templates SET sort_order=? WHERE id=?', [i, ids[i]]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

router.put('/:id', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const { name, start_time, end_time, color } = req.body;
    await db.run(
      `UPDATE shift_templates SET name=?,start_time=?,end_time=?,color=? WHERE id=?`,
      [name, start_time, end_time, color || '#3B82F6', req.params.id]
    );
    req.flash('success', 'Szablon zaktualizowany.');
    res.redirect('/shifts');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.delete('/:id', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    await db.run(`UPDATE shift_templates SET active=0 WHERE id=?`, [req.params.id]);
    req.flash('success', 'Szablon usunięty.');
    res.redirect('/shifts');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

module.exports = router;
