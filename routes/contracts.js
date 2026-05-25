const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

router.get('/', requireRole('admin'), (req, res) => {
  const workers = db.prepare(`SELECT * FROM users WHERE role IN ('worker','location_manager') AND active=1 ORDER BY name`).all();
  const contracts = db.prepare(`
    SELECT c.*, u.name as user_name
    FROM contracts c
    JOIN users u ON u.id=c.user_id
    ORDER BY c.active DESC, u.name, c.start_date DESC
  `).all();
  res.render('contracts/index', { workers, contracts });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { user_id, min_hours_per_month, hourly_rate, start_date, end_date, notes } = req.body;
  if (!user_id || !min_hours_per_month || !start_date) {
    req.flash('error', 'Pracownik, godziny i data rozpoczęcia są wymagane.');
    return res.redirect('/contracts');
  }
  db.prepare(`UPDATE contracts SET active=0 WHERE user_id=?`).run(user_id);
  db.prepare(`INSERT INTO contracts (user_id, min_hours_per_month, hourly_rate, start_date, end_date, notes) VALUES (?,?,?,?,?,?)`).run(
    user_id, parseFloat(min_hours_per_month), hourly_rate ? parseFloat(hourly_rate) : null, start_date, end_date || null, notes || null
  );
  const _cw = db.prepare('SELECT name FROM users WHERE id=?').get(user_id);
  log(res.locals.user, 'Dodanie umowy', `${_cw ? _cw.name : user_id} | ${min_hours_per_month}h/mies.${hourly_rate ? ' | ' + parseFloat(hourly_rate).toFixed(2) + ' zł/h' : ''}`);
  req.flash('success', 'Umowa dodana.');
  res.redirect('/contracts');
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { min_hours_per_month, hourly_rate, start_date, end_date, notes, active } = req.body;
  const _cu = db.prepare('SELECT u.name FROM contracts c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(req.params.id);
  db.prepare(`UPDATE contracts SET min_hours_per_month=?,hourly_rate=?,start_date=?,end_date=?,notes=?,active=? WHERE id=?`).run(
    parseFloat(min_hours_per_month), hourly_rate ? parseFloat(hourly_rate) : null, start_date, end_date || null, notes || null, active ? 1 : 0, req.params.id
  );
  log(res.locals.user, 'Edycja umowy', _cu ? _cu.name : `ID: ${req.params.id}`);
  req.flash('success', 'Umowa zaktualizowana.');
  res.redirect('/contracts');
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const _cd = db.prepare('SELECT u.name FROM contracts c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(req.params.id);
  db.prepare(`DELETE FROM contracts WHERE id=?`).run(req.params.id);
  log(res.locals.user, 'Usunięcie umowy', _cd ? _cd.name : `ID: ${req.params.id}`);
  req.flash('success', 'Umowa usunięta.');
  res.redirect('/contracts');
});

module.exports = router;
