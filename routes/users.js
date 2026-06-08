const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { log } = require('../utils/logger');

router.get('/', requireRole('admin'), requireFeature('users'), async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const users = await db.all(`
      SELECT u.*, c.min_hours_per_month, l.name AS location_name
      FROM users u
      LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
      LEFT JOIN locations l ON l.id=u.location_id
      WHERE (u.location_id=? OR u.role='super_admin') AND (u.registration_pending IS NULL OR u.registration_pending=0)
      ORDER BY u.role, u.name
    `, [locationId]);
    const pendingUsers = await db.all(`
      SELECT * FROM users WHERE registration_pending=1 ORDER BY created_at ASC
    `);
    const locations = await db.all('SELECT id, name FROM locations WHERE active=1 ORDER BY id');
    res.render('users/index', { users, editUser: null, locations, currentLocationId: locationId, pendingUsers });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { name, username, email, contact_email, phone, password, role, location_id } = req.body;
    if (!name || !username || !password || !role) {
      req.flash('error', 'Imię, nazwa użytkownika, hasło i rola są wymagane.');
      return res.redirect('/users');
    }
    const existing = await db.get('SELECT id FROM users WHERE username=?', [username]);
    if (existing) {
      req.flash('error', 'Ta nazwa użytkownika jest już zajęta.');
      return res.redirect('/users');
    }
    const trimmedEmail = email ? email.trim().toLowerCase() : null;
    if (trimmedEmail) {
      const emailConflict = await db.get('SELECT id FROM users WHERE email=?', [trimmedEmail]);
      if (emailConflict) {
        req.flash('error', 'Ten adres email jest już przypisany do innego konta.');
        return res.redirect('/users');
      }
    }
    const hash = bcrypt.hashSync(password, 10);
    const assignedLocationId = (res.locals.user.role === 'super_admin' && location_id)
      ? parseInt(location_id)
      : getLocationId(req);
    await db.run(
      `INSERT INTO users (name, username, email, contact_email, phone, password_hash, role, must_change_password, location_id) VALUES (?,?,?,?,?,?,?,1,?)`,
      [name, username, trimmedEmail, contact_email || null, phone || null, hash, role, assignedLocationId || null]
    );
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
    const locationId = getLocationId(req);
    const users = await db.all(`
      SELECT u.*, c.min_hours_per_month, l.name AS location_name
      FROM users u
      LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
      LEFT JOIN locations l ON l.id=u.location_id
      WHERE (u.location_id=? OR u.role='super_admin') AND (u.registration_pending IS NULL OR u.registration_pending=0)
      ORDER BY u.role, u.name
    `, [locationId]);
    const editUser = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!editUser) return res.redirect('/users');
    const pendingUsers = await db.all(`SELECT * FROM users WHERE registration_pending=1 ORDER BY created_at ASC`);
    const locations = await db.all('SELECT id, name FROM locations WHERE active=1 ORDER BY id');
    res.render('users/index', { users, editUser, locations, currentLocationId: locationId, pendingUsers });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { name, username, email, contact_email, phone, role, active, password, location_id, must_change_password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.redirect('/users');
    const conflict = await db.get('SELECT id FROM users WHERE username=? AND id!=?', [username, req.params.id]);
    if (conflict) {
      req.flash('error', 'Ta nazwa użytkownika jest już zajęta.');
      return res.redirect(`/users/${req.params.id}/edit`);
    }
    const trimmedEmail = email ? email.trim().toLowerCase() : null;
    if (trimmedEmail) {
      const emailConflict = await db.get('SELECT id FROM users WHERE email=? AND id!=?', [trimmedEmail, req.params.id]);
      if (emailConflict) {
        req.flash('error', 'Ten adres email jest już przypisany do innego konta.');
        return res.redirect(`/users/${req.params.id}/edit`);
      }
    }
    const assignedLocationId = (res.locals.user.role === 'super_admin' && location_id)
      ? parseInt(location_id)
      : (user.location_id || getLocationId(req));
    const forcePasswordChange = must_change_password ? 1 : 0;
    if (password && password.trim()) {
      const hash = bcrypt.hashSync(password.trim(), 10);
      await db.run(
        `UPDATE users SET name=?,username=?,email=?,contact_email=?,phone=?,role=?,active=?,password_hash=?,must_change_password=?,location_id=? WHERE id=?`,
        [name, username, trimmedEmail, contact_email || null, phone || null, role, active ? 1 : 0, hash, forcePasswordChange, assignedLocationId, req.params.id]
      );
    } else {
      await db.run(
        `UPDATE users SET name=?,username=?,email=?,contact_email=?,phone=?,role=?,active=?,must_change_password=?,location_id=? WHERE id=?`,
        [name, username, trimmedEmail, contact_email || null, phone || null, role, active ? 1 : 0, forcePasswordChange, assignedLocationId, req.params.id]
      );
    }
    log(res.locals.user, 'Edycja użytkownika', user.name);
    req.flash('success', 'Dane użytkownika zaktualizowane.');
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/:id/approve', requireRole('super_admin'), async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=? AND registration_pending=1', [req.params.id]);
    if (!user) return res.redirect('/users');
    const { username, role, location_id } = req.body;
    if (!username || !role) {
      req.flash('error', 'Nazwa użytkownika i rola są wymagane.');
      return res.redirect('/users');
    }
    const conflict = await db.get('SELECT id FROM users WHERE username=?', [username]);
    if (conflict) {
      req.flash('error', 'Ta nazwa użytkownika jest już zajęta.');
      return res.redirect('/users');
    }
    const assignedLocationId = (res.locals.user.role === 'super_admin' && location_id)
      ? parseInt(location_id)
      : getLocationId(req);
    await db.run(
      `UPDATE users SET username=?, role=?, location_id=?, active=1, registration_pending=0, must_change_password=1 WHERE id=?`,
      [username, role, assignedLocationId || null, req.params.id]
    );
    log(res.locals.user, 'Zatwierdzenie rejestracji', `${user.name} | ${username} | ${role}`);
    req.flash('success', `Konto "${user.name}" zostało zatwierdzone.`);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.delete('/:id/pending', requireRole('super_admin'), async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=? AND registration_pending=1', [req.params.id]);
    if (!user) return res.redirect('/users');
    await db.run('DELETE FROM users WHERE id=?', [req.params.id]);
    log(res.locals.user, 'Odrzucenie rejestracji', user.name);
    req.flash('success', `Rejestracja "${user.name}" została odrzucona.`);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (user && (user.role === 'admin' || user.role === 'super_admin')) {
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
