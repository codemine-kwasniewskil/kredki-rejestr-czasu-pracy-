const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');

router.get('/', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const templates = await db.all(`SELECT * FROM shift_templates ORDER BY start_time`);
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
    await db.run(`INSERT INTO shift_templates (name, start_time, end_time, color) VALUES (?,?,?,?)`,
      [name, start_time, end_time, color || '#3B82F6']);
    req.flash('success', 'Szablon zmiany dodany.');
    res.redirect('/shifts');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.put('/:id', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const { name, start_time, end_time, color } = req.body;
    await db.run(`UPDATE shift_templates SET name=?,start_time=?,end_time=?,color=? WHERE id=?`,
      [name, start_time, end_time, color || '#3B82F6', req.params.id]);
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
