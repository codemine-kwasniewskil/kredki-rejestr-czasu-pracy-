const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');

router.get('/', requireRole('admin', 'location_manager'), (req, res) => {
  const templates = db.prepare(`SELECT * FROM shift_templates ORDER BY start_time`).all();
  res.render('shifts/index', { templates });
});

router.post('/', requireRole('admin', 'location_manager'), (req, res) => {
  const { name, start_time, end_time, color } = req.body;
  if (!name || !start_time || !end_time) {
    req.flash('error', 'Nazwa, czas rozpoczęcia i zakończenia są wymagane.');
    return res.redirect('/shifts');
  }
  db.prepare(`INSERT INTO shift_templates (name, start_time, end_time, color) VALUES (?,?,?,?)`).run(
    name, start_time, end_time, color || '#3B82F6'
  );
  req.flash('success', 'Szablon zmiany dodany.');
  res.redirect('/shifts');
});

router.put('/:id', requireRole('admin', 'location_manager'), (req, res) => {
  const { name, start_time, end_time, color } = req.body;
  db.prepare(`UPDATE shift_templates SET name=?,start_time=?,end_time=?,color=? WHERE id=?`)
    .run(name, start_time, end_time, color || '#3B82F6', req.params.id);
  req.flash('success', 'Szablon zaktualizowany.');
  res.redirect('/shifts');
});

router.delete('/:id', requireRole('admin', 'location_manager'), (req, res) => {
  db.prepare(`UPDATE shift_templates SET active=0 WHERE id=?`).run(req.params.id);
  req.flash('success', 'Szablon usunięty.');
  res.redirect('/shifts');
});

module.exports = router;
