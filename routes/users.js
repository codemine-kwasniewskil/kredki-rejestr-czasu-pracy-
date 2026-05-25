const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

router.get('/', requireRole('admin'), (req, res) => {
  const users = db.prepare(`
    SELECT u.*, c.min_hours_per_month
    FROM users u
    LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
    ORDER BY u.role, u.name
  `).all();
  res.render('users/index', { users, editUser: null });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    req.flash('error', 'Wszystkie pola są wymagane.');
    return res.redirect('/users');
  }
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) {
    req.flash('error', 'Ten e-mail jest już zajęty.');
    return res.redirect('/users');
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)`).run(name, email, hash, role);
  log(res.locals.user, 'Dodanie użytkownika', `${name} | ${role}`);
  req.flash('success', 'Użytkownik został dodany.');
  res.redirect('/users');
});

router.get('/:id/edit', requireRole('admin'), (req, res) => {
  const users = db.prepare(`
    SELECT u.*, c.min_hours_per_month
    FROM users u
    LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
    ORDER BY u.role, u.name
  `).all();
  const editUser = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!editUser) return res.redirect('/users');
  res.render('users/index', { users, editUser });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { name, email, role, active, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.redirect('/users');

  if (password && password.trim()) {
    const hash = bcrypt.hashSync(password.trim(), 10);
    db.prepare(`UPDATE users SET name=?,email=?,role=?,active=?,password_hash=? WHERE id=?`)
      .run(name, email, role, active ? 1 : 0, hash, req.params.id);
  } else {
    db.prepare(`UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?`)
      .run(name, email, role, active ? 1 : 0, req.params.id);
  }
  log(res.locals.user, 'Edycja użytkownika', user.name);
  req.flash('success', 'Dane użytkownika zaktualizowane.');
  res.redirect('/users');
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (user && user.role === 'admin') {
    req.flash('error', 'Nie można usunąć administratora.');
    return res.redirect('/users');
  }
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(req.params.id);
  log(res.locals.user, 'Dezaktywacja użytkownika', user.name);
  req.flash('success', 'Użytkownik dezaktywowany.');
  res.redirect('/users');
});

module.exports = router;
