const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calcHours } = require('../utils/helpers');
const { log } = require('../utils/logger');

// Add schedule entry
router.post('/schedule/entry', requireRole('admin', 'location_manager'), (req, res) => {
  const { scheduleId, userId, date, shiftTemplateId, customStart, customEnd, notes } = req.body;

  if (!scheduleId || !userId || !date) {
    return res.status(400).json({ error: 'Brakuje wymaganych danych.' });
  }

  const schedule = db.prepare('SELECT * FROM schedules WHERE id=?').get(scheduleId);
  const isAdmin = res.locals.user.role === 'admin';
  if (!schedule || (schedule.status === 'approved' && !isAdmin)) {
    return res.status(403).json({ error: 'Nie można edytować zatwierdzonego grafiku.' });
  }

  let startTime, endTime, color = '#6B7280', shiftName = 'Własna';
  if (shiftTemplateId) {
    const tmpl = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(shiftTemplateId);
    if (tmpl) { startTime = tmpl.start_time; endTime = tmpl.end_time; color = tmpl.color; shiftName = tmpl.name; }
  } else {
    startTime = customStart;
    endTime = customEnd;
  }

  if (!startTime || !endTime) {
    return res.status(400).json({ error: 'Podaj godziny zmiany.' });
  }

  const isAdminEdit = (schedule.status === 'submitted' || schedule.status === 'approved') && isAdmin;
  const modifiedByAdmin = isAdminEdit ? 1 : 0;
  const modifiedByUserId = isAdminEdit ? res.locals.user.id : null;

  try {
    const r = db.prepare(`
      INSERT INTO schedule_entries (schedule_id, user_id, date, shift_template_id, custom_start, custom_end, notes, modified_by_admin, modified_by_user_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(scheduleId, userId, date, shiftTemplateId || null, shiftTemplateId ? null : customStart, shiftTemplateId ? null : customEnd, notes || null, modifiedByAdmin, modifiedByUserId);

    const entry = db.prepare('SELECT * FROM schedule_entries WHERE id=?').get(r.lastInsertRowid);
    const _w = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
    log(res.locals.user, 'Dodanie zmiany w grafiku', `${_w ? _w.name : userId} | ${date} | ${shiftName} (${startTime}–${endTime})`);
    res.json({ success: true, entry: { ...entry, shift_name: shiftName, start_time: startTime, end_time: endTime, color } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Ta osoba ma już zmianę w tym dniu.' });
    throw e;
  }
});

// Move entry (drag & drop)
router.put('/schedule/entry/:id/move', requireRole('admin', 'location_manager'), (req, res) => {
  const { newDate, newUserId } = req.body;
  const entry = db.prepare('SELECT * FROM schedule_entries WHERE id=?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Wpis nie znaleziony.' });

  const schedule = db.prepare('SELECT * FROM schedules WHERE id=?').get(entry.schedule_id);
  const isAdmin = res.locals.user.role === 'admin';
  if (!schedule || (schedule.status === 'approved' && !isAdmin)) {
    return res.status(403).json({ error: 'Nie można edytować zatwierdzonego grafiku.' });
  }

  const conflict = db.prepare(`SELECT id FROM schedule_entries WHERE schedule_id=? AND user_id=? AND date=? AND id!=?`)
    .get(entry.schedule_id, newUserId || entry.user_id, newDate || entry.date, entry.id);
  if (conflict) return res.status(409).json({ error: 'Ta osoba ma już zmianę w tym dniu.' });

  const isAdminEdit = (schedule.status === 'submitted' || schedule.status === 'approved') && isAdmin;
  db.prepare(`UPDATE schedule_entries SET date=?, user_id=?, modified_by_admin=?, modified_by_user_id=? WHERE id=?`)
    .run(newDate || entry.date, newUserId || entry.user_id, isAdminEdit ? 1 : 0, isAdminEdit ? res.locals.user.id : null, entry.id);

  const _mw = db.prepare('SELECT name FROM users WHERE id=?').get(entry.user_id);
  let _md = `${_mw ? _mw.name : entry.user_id} | ${entry.date}`;
  if (newDate && newDate !== entry.date) _md += ` → ${newDate}`;
  if (newUserId && String(newUserId) !== String(entry.user_id)) {
    const _nw = db.prepare('SELECT name FROM users WHERE id=?').get(newUserId);
    _md += ` | → ${_nw ? _nw.name : newUserId}`;
  }
  log(res.locals.user, 'Przeniesienie zmiany w grafiku', _md);
  res.json({ success: true });
});

// Delete entry
router.delete('/schedule/entry/:id', requireRole('admin', 'location_manager'), (req, res) => {
  const entry = db.prepare('SELECT * FROM schedule_entries WHERE id=?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Wpis nie znaleziony.' });

  const schedule = db.prepare('SELECT * FROM schedules WHERE id=?').get(entry.schedule_id);
  const isAdmin = res.locals.user.role === 'admin';
  if (!schedule || (schedule.status === 'approved' && !isAdmin)) {
    return res.status(403).json({ error: 'Nie można edytować zatwierdzonego grafiku.' });
  }

  const _dw = db.prepare('SELECT name FROM users WHERE id=?').get(entry.user_id);
  db.prepare('DELETE FROM schedule_entries WHERE id=?').run(entry.id);
  log(res.locals.user, 'Usunięcie zmiany z grafiku', `${_dw ? _dw.name : entry.user_id} | ${entry.date}`);
  res.json({ success: true });
});

// Toggle availability status (cycles: none → available → unavailable → none)
router.put('/availability/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  const { status, targetUserId } = req.body;
  const role = res.locals.user.role;

  let userId = res.locals.user.id;
  if (targetUserId && (role === 'admin' || role === 'location_manager')) {
    userId = parseInt(targetUserId);
  }
  // workers always edit their own availability (userId stays as their own id)

  // Check availability_locked — only admin can override
  if (role !== 'admin') {
    const targetUser = db.prepare('SELECT availability_locked FROM users WHERE id=?').get(userId);
    if (targetUser && targetUser.availability_locked) {
      return res.status(403).json({ error: 'Dostępność tego pracownika jest zablokowana przez administratora.' });
    }
  }

  // Enforce time-based lock for workers and managers
  if (role !== 'admin') {
    const today = new Date();
    const cutoff = 10;
    const firstEditable = today.getDate() <= cutoff
      ? new Date(today.getFullYear(), today.getMonth() + 1, 1)
      : new Date(today.getFullYear(), today.getMonth() + 2, 1);
    const lockBeforeStr = `${firstEditable.getFullYear()}-${String(firstEditable.getMonth() + 1).padStart(2, '0')}-01`;
    if (date < lockBeforeStr) {
      return res.status(403).json({ error: 'Ten miesiąc jest zablokowany do edycji (po 10-ym poprzedniego miesiąca).' });
    }
  }

  const _avUser = userId !== res.locals.user.id ? db.prepare('SELECT name FROM users WHERE id=?').get(userId) : null;
  const _avPrefix = _avUser ? `${_avUser.name} | ` : '';

  if (!status) {
    db.prepare('DELETE FROM availability WHERE user_id=? AND date=?').run(userId, date);
    log(res.locals.user, 'Usunięcie dostępności', `${_avPrefix}${date}`);
    return res.json({ success: true, status: null });
  }

  const existing = db.prepare('SELECT * FROM availability WHERE user_id=? AND date=?').get(userId, date);
  const startTime = existing ? existing.start_time : null;
  const endTime = existing ? existing.end_time : null;

  db.prepare(`
    INSERT INTO availability (user_id, date, status, start_time, end_time) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, date) DO UPDATE SET status=excluded.status, start_time=excluded.start_time, end_time=excluded.end_time
  `).run(userId, date, status, startTime, endTime);

  const _statusLabel = status === 'available' ? 'dostępny' : 'niedostępny';
  log(res.locals.user, 'Zmiana dostępności', `${_avPrefix}${date}: ${_statusLabel}`);
  res.json({ success: true, status, startTime, endTime });
});

// Set time range for an availability day
router.put('/availability/:date/time', requireAuth, (req, res) => {
  const { date } = req.params;
  const { startTime, endTime, targetUserId } = req.body || {};
  const role = res.locals.user.role;

  let userId = res.locals.user.id;
  if (targetUserId && (role === 'admin' || role === 'location_manager')) {
    userId = parseInt(targetUserId);
  }
  // workers always edit their own availability

  if (role !== 'admin') {
    const targetUser = db.prepare('SELECT availability_locked FROM users WHERE id=?').get(userId);
    if (targetUser && targetUser.availability_locked) {
      return res.status(403).json({ error: 'Dostępność tego pracownika jest zablokowana.' });
    }
  }

  if (role !== 'admin') {
    const today = new Date();
    const cutoff = 10;
    const firstEditable = today.getDate() <= cutoff
      ? new Date(today.getFullYear(), today.getMonth() + 1, 1)
      : new Date(today.getFullYear(), today.getMonth() + 2, 1);
    const lockBeforeStr = `${firstEditable.getFullYear()}-${String(firstEditable.getMonth() + 1).padStart(2, '0')}-01`;
    if (date < lockBeforeStr) {
      return res.status(403).json({ error: 'Ten miesiąc jest zablokowany do edycji.' });
    }
  }

  const existing = db.prepare('SELECT * FROM availability WHERE user_id=? AND date=?').get(userId, date);
  if (!existing) {
    db.prepare(`INSERT INTO availability (user_id, date, status, start_time, end_time) VALUES (?,?,'available',?,?)`
    ).run(userId, date, startTime || null, endTime || null);
  } else {
    db.prepare(`UPDATE availability SET start_time=?, end_time=? WHERE user_id=? AND date=?`
    ).run(startTime || null, endTime || null, userId, date);
  }

  const row = db.prepare('SELECT * FROM availability WHERE user_id=? AND date=?').get(userId, date);
  const _tUser = userId !== res.locals.user.id ? db.prepare('SELECT name FROM users WHERE id=?').get(userId) : null;
  log(res.locals.user, 'Ustawienie godzin dostępności', `${_tUser ? _tUser.name + ' | ' : ''}${date}: ${startTime || '?'}–${endTime || '?'}`);
  res.json({ success: true, status: row.status, startTime: row.start_time, endTime: row.end_time });
});

// Toggle availability_locked for a user (admin only)
// Bulk must come before /:id to avoid route conflict
router.put('/users/availability-lock-all', requireRole('admin'), (req, res) => {
  const { locked } = req.body;
  db.prepare("UPDATE users SET availability_locked=? WHERE role != 'admin'").run(locked ? 1 : 0);
  log(res.locals.user, locked ? 'Zablokowanie dostępności (wszyscy)' : 'Odblokowanie dostępności (wszyscy)');
  res.json({ success: true, locked: locked ? 1 : 0 });
});

router.put('/users/:id/availability-lock', requireRole('admin'), (req, res) => {
  const { locked } = req.body;
  const _lu = db.prepare('SELECT name FROM users WHERE id=?').get(req.params.id);
  db.prepare('UPDATE users SET availability_locked=? WHERE id=?').run(locked ? 1 : 0, req.params.id);
  log(res.locals.user, locked ? 'Zablokowanie dostępności' : 'Odblokowanie dostępności', _lu ? _lu.name : `ID: ${req.params.id}`);
  res.json({ success: true, locked: locked ? 1 : 0 });
});

// Get worker hours summary for current week (used by dashboard)
router.get('/schedule/week-hours/:weekStart', requireRole('admin', 'location_manager'), (req, res) => {
  const schedule = db.prepare('SELECT * FROM schedules WHERE week_start=?').get(req.params.weekStart);
  if (!schedule) return res.json({ workers: [] });

  const workers = db.prepare(`
    SELECT u.id, u.name, c.min_hours_per_month
    FROM users u
    LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
    WHERE u.role='worker' AND u.active=1
    ORDER BY u.name
  `).all();

  const entries = db.prepare(`
    SELECT se.user_id,
           COALESCE(se.custom_start, st.start_time) as start_time,
           COALESCE(se.custom_end, st.end_time) as end_time
    FROM schedule_entries se
    LEFT JOIN shift_templates st ON st.id=se.shift_template_id
    WHERE se.schedule_id=?
  `).all(schedule.id);

  const result = workers.map(w => ({
    ...w,
    scheduledHours: entries.filter(e => e.user_id === w.id).reduce((s, e) => s + calcHours(e.start_time, e.end_time), 0)
  }));

  res.json({ workers: result });
});

module.exports = router;
