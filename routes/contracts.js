const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const workers = await db.all(`SELECT * FROM users WHERE role IN ('worker','location_manager') AND active=1 ORDER BY name`);
    const contracts = await db.all(`
      SELECT c.*, u.name as user_name
      FROM contracts c
      JOIN users u ON u.id=c.user_id
      ORDER BY c.active DESC, u.name, c.start_date DESC
    `);
    res.render('contracts/index', { workers, contracts });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { user_id, min_hours_per_month, hourly_rate, start_date, end_date, notes } = req.body;
    if (!user_id || !min_hours_per_month || !start_date) {
      req.flash('error', 'Pracownik, godziny i data rozpoczęcia są wymagane.');
      return res.redirect('/contracts');
    }
    await db.run(`UPDATE contracts SET active=0 WHERE user_id=?`, [user_id]);
    await db.run(
      `INSERT INTO contracts (user_id, min_hours_per_month, hourly_rate, start_date, end_date, notes) VALUES (?,?,?,?,?,?)`,
      [user_id, parseFloat(min_hours_per_month), hourly_rate ? parseFloat(hourly_rate) : null, start_date, end_date || null, notes || null]
    );
    const _cw = await db.get('SELECT name FROM users WHERE id=?', [user_id]);
    log(res.locals.user, 'Dodanie umowy', `${_cw ? _cw.name : user_id} | ${min_hours_per_month}h/mies.${hourly_rate ? ' | ' + parseFloat(hourly_rate).toFixed(2) + ' zł/h' : ''}`);
    req.flash('success', 'Umowa dodana.');
    res.redirect('/contracts');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { min_hours_per_month, hourly_rate, start_date, end_date, notes, active } = req.body;
    const _cu = await db.get('SELECT u.name FROM contracts c JOIN users u ON u.id=c.user_id WHERE c.id=?', [req.params.id]);
    await db.run(
      `UPDATE contracts SET min_hours_per_month=?,hourly_rate=?,start_date=?,end_date=?,notes=?,active=? WHERE id=?`,
      [parseFloat(min_hours_per_month), hourly_rate ? parseFloat(hourly_rate) : null, start_date, end_date || null, notes || null, active ? 1 : 0, req.params.id]
    );
    log(res.locals.user, 'Edycja umowy', _cu ? _cu.name : `ID: ${req.params.id}`);
    req.flash('success', 'Umowa zaktualizowana.');
    res.redirect('/contracts');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const _cd = await db.get('SELECT u.name FROM contracts c JOIN users u ON u.id=c.user_id WHERE c.id=?', [req.params.id]);
    await db.run(`DELETE FROM contracts WHERE id=?`, [req.params.id]);
    log(res.locals.user, 'Usunięcie umowy', _cd ? _cd.name : `ID: ${req.params.id}`);
    req.flash('success', 'Umowa usunięta.');
    res.redirect('/contracts');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

module.exports = router;
