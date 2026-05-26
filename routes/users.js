const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const users = await db.all(`
      SELECT u.*, c.min_hours_per_month
      FROM users u
      LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
      ORDER BY u.role, u.name
    `);
    res.render('users/index', { users, editUser: null });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      req.flash('error', 'Wszystkie pola są wymagane.');
      return res.redirect('/users');
    }
    const existing = await db.get('SELECT id FROM users WHERE email=?', [email]);
    if (existing) {
      req.flash('error', 'Ten e-mail jest już zajęty.');
      return res.redirect('/users');
    }
    const hash = bcrypt.hashSync(password, 10);
    await db.run(`INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?,?,?,?,1)`, [name, email, hash, role]);
    log(res.locals.user, 'Dodanie użytkownika', `${name} | ${role}`);
    req.flash('success', 'Użytkownik został dodany.');
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/:id/edit', requireRole('admin'), async (req, res) => {
  try {
    const users = await db.all(`
      SELECT u.*, c.min_hours_per_month
      FROM users u
      LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
      ORDER BY u.role, u.name
    `);
    const editUser = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!editUser) return res.redirect('/users');
    res.render('users/index', { users, editUser });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { name, email, role, active, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.redirect('/users');
    if (password && password.trim()) {
      const hash = bcrypt.hashSync(password.trim(), 10);
      await db.run(`UPDATE users SET name=?,email=?,role=?,active=?,password_hash=?,must_change_password=1 WHERE id=?`,
        [name, email, role, active ? 1 : 0, hash, req.params.id]);
    } else {
      await db.run(`UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?`,
        [name, email, role, active ? 1 : 0, req.params.id]);
    }
    log(res.locals.user, 'Edycja użytkownika', user.name);
    req.flash('success', 'Dane użytkownika zaktualizowane.');
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (user && user.role === 'admin') {
      req.flash('error', 'Nie można usunąć administratora.');
      return res.redirect('/users');
    }
    await db.run('UPDATE users SET active=0 WHERE id=?', [req.params.id]);
    log(res.locals.user, 'Dezaktywacja użytkownika', user.name);
    req.flash('success', 'Użytkownik dezaktywowany.');
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

module.exports = router;
