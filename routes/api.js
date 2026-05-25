const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calcHours } = require('../utils/helpers');
const { log } = require('../utils/logger');

router.post('/schedule/entry', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const { scheduleId, userId, date, shiftTemplateId, customStart, customEnd, notes } = req.body;
    if (!scheduleId || !userId || !date) {
      return res.status(400).json({ error: 'Brakuje wymaganych danych.' });
    }
    const schedule = await db.get('SELECT * FROM schedules WHERE id=?', [scheduleId]);
    const isAdmin = res.locals.user.role === 'admin';
    if (!schedule || (schedule.status === 'approved' && !isAdmin)) {
      return res.status(403).json({ error: 'Nie można edytować zatwierdzonego grafiku.' });
    }

    let startTime, endTime, color = '#6B7280', shiftName = 'Własna';
    if (shiftTemplateId) {
      const tmpl = await db.get('SELECT * FROM shift_templates WHERE id=?', [shiftTemplateId]);
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
      const r = await db.run(`
        INSERT INTO schedule_entries (schedule_id, user_id, date, shift_template_id, custom_start, custom_end, notes, modified_by_admin, modified_by_user_id)
        VALUES (?,?,?,?,?,?,?,?,?)
      `, [scheduleId, userId, date, shiftTemplateId || null, shiftTemplateId ? null : customStart, shiftTemplateId ? null : customEnd, notes || null, modifiedByAdmin, modifiedByUserId]);

      const entry = await db.get('SELECT * FROM schedule_entries WHERE id=?', [r.insertId]);
      const _w = await db.get('SELECT name FROM users WHERE id=?', [userId]);
      log(res.locals.user, 'Dodanie zmiany w grafiku', `${_w ? _w.name : userId} | ${date} | ${shiftName} (${startTime}–${endTime})`);
      res.json({ success: true, entry: { ...entry, shift_name: shiftName, start_time: startTime, end_time: endTime, color } });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ta osoba ma już zmianę w tym dniu.' });
      throw e;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

router.put('/schedule/entry/:id/move', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const { newDate, newUserId } = req.body;
    const entry = await db.get('SELECT * FROM schedule_entries WHERE id=?', [req.params.id]);
    if (!entry) return res.status(404).json({ error: 'Wpis nie znaleziony.' });

    const schedule = await db.get('SELECT * FROM schedules WHERE id=?', [entry.schedule_id]);
    const isAdmin = res.locals.user.role === 'admin';
    if (!schedule || (schedule.status === 'approved' && !isAdmin)) {
      return res.status(403).json({ error: 'Nie można edytować zatwierdzonego grafiku.' });
    }

    const conflict = await db.get(
      `SELECT id FROM schedule_entries WHERE schedule_id=? AND user_id=? AND date=? AND id!=?`,
      [entry.schedule_id, newUserId || entry.user_id, newDate || entry.date, entry.id]
    );
    if (conflict) return res.status(409).json({ error: 'Ta osoba ma już zmianę w tym dniu.' });

    const isAdminEdit = (schedule.status === 'submitted' || schedule.status === 'approved') && isAdmin;
    await db.run(
      `UPDATE schedule_entries SET date=?, user_id=?, modified_by_admin=?, modified_by_user_id=? WHERE id=?`,
      [newDate || entry.date, newUserId || entry.user_id, isAdminEdit ? 1 : 0, isAdminEdit ? res.locals.user.id : null, entry.id]
    );

    const _mw = await db.get('SELECT name FROM users WHERE id=?', [entry.user_id]);
    let _md = `${_mw ? _mw.name : entry.user_id} | ${entry.date}`;
    if (newDate && newDate !== entry.date) _md += ` → ${newDate}`;
    if (newUserId && String(newUserId) !== String(entry.user_id)) {
      const _nw = await db.get('SELECT name FROM users WHERE id=?', [newUserId]);
      _md += ` | → ${_nw ? _nw.name : newUserId}`;
    }
    log(res.locals.user, 'Przeniesienie zmiany w grafiku', _md);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

router.delete('/schedule/entry/:id', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const entry = await db.get('SELECT * FROM schedule_entries WHERE id=?', [req.params.id]);
    if (!entry) return res.status(404).json({ error: 'Wpis nie znaleziony.' });

    const schedule = await db.get('SELECT * FROM schedules WHERE id=?', [entry.schedule_id]);
    const isAdmin = res.locals.user.role === 'admin';
    if (!schedule || (schedule.status === 'approved' && !isAdmin)) {
      return res.status(403).json({ error: 'Nie można edytować zatwierdzonego grafiku.' });
    }

    const _dw = await db.get('SELECT name FROM users WHERE id=?', [entry.user_id]);
    await db.run('DELETE FROM schedule_entries WHERE id=?', [entry.id]);
    log(res.locals.user, 'Usunięcie zmiany z grafiku', `${_dw ? _dw.name : entry.user_id} | ${entry.date}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

router.put('/availability/:date', requireAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const { status, targetUserId } = req.body;
    const role = res.locals.user.role;

    let userId = res.locals.user.id;
    if (targetUserId && (role === 'admin' || role === 'location_manager')) {
      userId = parseInt(targetUserId);
    }

    if (role !== 'admin') {
      const targetUser = await db.get('SELECT availability_locked FROM users WHERE id=?', [userId]);
      if (targetUser && targetUser.availability_locked) {
        return res.status(403).json({ error: 'Dostępność tego pracownika jest zablokowana przez administratora.' });
      }
    }

    if (role !== 'admin') {
      const today = new Date();
      const lockBeforeStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      if (date < lockBeforeStr) {
        return res.status(403).json({ error: 'Ten miesiąc jest zablokowany do edycji.' });
      }
    }

    const _avUser = userId !== res.locals.user.id ? await db.get('SELECT name FROM users WHERE id=?', [userId]) : null;
    const _avPrefix = _avUser ? `${_avUser.name} | ` : '';

    if (!status) {
      await db.run('DELETE FROM availability WHERE user_id=? AND date=?', [userId, date]);
      log(res.locals.user, 'Usunięcie dostępności', `${_avPrefix}${date}`);
      return res.json({ success: true, status: null });
    }

    const existing = await db.get('SELECT * FROM availability WHERE user_id=? AND date=?', [userId, date]);
    const startTime = existing ? existing.start_time : null;
    const endTime = existing ? existing.end_time : null;

    await db.run(`
      INSERT INTO availability (user_id, date, status, start_time, end_time) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE status=VALUES(status), start_time=VALUES(start_time), end_time=VALUES(end_time)
    `, [userId, date, status, startTime, endTime]);

    const _statusLabel = status === 'available' ? 'dostępny' : 'niedostępny';
    log(res.locals.user, 'Zmiana dostępności', `${_avPrefix}${date}: ${_statusLabel}`);
    res.json({ success: true, status, startTime, endTime });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

router.put('/availability/:date/time', requireAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const { startTime, endTime, targetUserId } = req.body || {};
    const role = res.locals.user.role;

    let userId = res.locals.user.id;
    if (targetUserId && (role === 'admin' || role === 'location_manager')) {
      userId = parseInt(targetUserId);
    }

    if (role !== 'admin') {
      const targetUser = await db.get('SELECT availability_locked FROM users WHERE id=?', [userId]);
      if (targetUser && targetUser.availability_locked) {
        return res.status(403).json({ error: 'Dostępność tego pracownika jest zablokowana.' });
      }
    }

    if (role !== 'admin') {
      const today = new Date();
      const lockBeforeStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      if (date < lockBeforeStr) {
        return res.status(403).json({ error: 'Ten miesiąc jest zablokowany do edycji.' });
      }
    }

    const existing = await db.get('SELECT * FROM availability WHERE user_id=? AND date=?', [userId, date]);
    if (!existing) {
      await db.run(
        `INSERT INTO availability (user_id, date, status, start_time, end_time) VALUES (?,?,'available',?,?)`,
        [userId, date, startTime || null, endTime || null]
      );
    } else {
      await db.run(
        `UPDATE availability SET start_time=?, end_time=? WHERE user_id=? AND date=?`,
        [startTime || null, endTime || null, userId, date]
      );
    }

    const row = await db.get('SELECT * FROM availability WHERE user_id=? AND date=?', [userId, date]);
    const _tUser = userId !== res.locals.user.id ? await db.get('SELECT name FROM users WHERE id=?', [userId]) : null;
    log(res.locals.user, 'Ustawienie godzin dostępności', `${_tUser ? _tUser.name + ' | ' : ''}${date}: ${startTime || '?'}–${endTime || '?'}`);
    res.json({ success: true, status: row.status, startTime: row.start_time, endTime: row.end_time });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

// Bulk must come before /:id to avoid route conflict
router.put('/users/availability-lock-all', requireRole('admin'), async (req, res) => {
  try {
    const { locked } = req.body;
    await db.run("UPDATE users SET availability_locked=? WHERE role != 'admin'", [locked ? 1 : 0]);
    log(res.locals.user, locked ? 'Zablokowanie dostępności (wszyscy)' : 'Odblokowanie dostępności (wszyscy)');
    res.json({ success: true, locked: locked ? 1 : 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

router.put('/users/:id/availability-lock', requireRole('admin'), async (req, res) => {
  try {
    const { locked } = req.body;
    const _lu = await db.get('SELECT name FROM users WHERE id=?', [req.params.id]);
    await db.run('UPDATE users SET availability_locked=? WHERE id=?', [locked ? 1 : 0, req.params.id]);
    log(res.locals.user, locked ? 'Zablokowanie dostępności' : 'Odblokowanie dostępności', _lu ? _lu.name : `ID: ${req.params.id}`);
    res.json({ success: true, locked: locked ? 1 : 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

router.get('/schedule/week-hours/:weekStart', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const schedule = await db.get('SELECT * FROM schedules WHERE week_start=?', [req.params.weekStart]);
    if (!schedule) return res.json({ workers: [] });

    const workers = await db.all(`
      SELECT u.id, u.name, c.min_hours_per_month
      FROM users u
      LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
      WHERE u.role='worker' AND u.active=1
      ORDER BY u.name
    `);

    const entries = await db.all(`
      SELECT se.user_id,
             COALESCE(se.custom_start, st.start_time) as start_time,
             COALESCE(se.custom_end, st.end_time) as end_time
      FROM schedule_entries se
      LEFT JOIN shift_templates st ON st.id=se.shift_template_id
      WHERE se.schedule_id=?
    `, [schedule.id]);

    const result = workers.map(w => ({
      ...w,
      scheduledHours: entries.filter(e => e.user_id === w.id).reduce((s, e) => s + calcHours(e.start_time, e.end_time), 0)
    }));

    res.json({ workers: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd serwera.' });
  }
});

module.exports = router;
