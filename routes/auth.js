const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { log } = require('../utils/logger');

router.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const { id, role } = res.locals.user;
    const workers = await db.get(`SELECT COUNT(*) as cnt FROM users WHERE role='worker' AND active=1`);
    const pending = await db.get(`SELECT COUNT(*) as cnt FROM schedules WHERE status='submitted'`);

    let myShifts = [];
    let mySchedule = null;
    if (role === 'worker') {
      const { toDateString } = require('../utils/helpers');
      const todayStr = toDateString(new Date());
      myShifts = await db.all(`
        SELECT se.id, se.date, se.confirmed_by_employee,
               COALESCE(st.name,'Własna') as shift_name,
               COALESCE(se.custom_start, st.start_time) as start_time,
               COALESCE(se.custom_end, st.end_time) as end_time,
               COALESCE(st.color,'#6B7280') as color
        FROM schedule_entries se
        LEFT JOIN shift_templates st ON st.id = se.shift_template_id
        JOIN schedules s ON s.id = se.schedule_id
        WHERE s.status='approved' AND se.user_id=? AND se.date>=?
        ORDER BY se.date ASC
      `, [id, todayStr]);
    } else if (role === 'location_manager') {
      const { getMonday, toDateString } = require('../utils/helpers');
      const todayStr = toDateString(new Date());
      const weekStart = toDateString(getMonday(new Date()));
      const schedule = await db.get(`SELECT * FROM schedules WHERE week_start=?`, [weekStart]);
      mySchedule = schedule || null;
      myShifts = await db.all(`
        SELECT se.id, se.date, se.confirmed_by_employee,
               COALESCE(st.name,'Własna') as shift_name,
               COALESCE(se.custom_start, st.start_time) as start_time,
               COALESCE(se.custom_end, st.end_time) as end_time,
               COALESCE(st.color,'#6B7280') as color
        FROM schedule_entries se
        LEFT JOIN shift_templates st ON st.id = se.shift_template_id
        JOIN schedules s ON s.id = se.schedule_id
        WHERE s.status='approved' AND se.user_id=? AND se.date>=?
        ORDER BY se.date ASC
      `, [id, todayStr]);
    }

    let workerHours = [];
    if (role === 'location_manager' || role === 'admin') {
      const { calcHours } = require('../utils/helpers');
      const today = new Date();
      const monthPrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const allWorkers = await db.all(`
        SELECT u.id, u.name, c.min_hours_per_month
        FROM users u
        LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
        WHERE u.role='worker' AND u.active=1
        ORDER BY u.name
      `);
      const monthEntries = await db.all(`
        SELECT se.user_id,
               COALESCE(se.custom_start, st.start_time) as start_time,
               COALESCE(se.custom_end, st.end_time) as end_time
        FROM schedule_entries se
        LEFT JOIN shift_templates st ON st.id = se.shift_template_id
        WHERE se.date LIKE ?
      `, [monthPrefix + '%']);
      workerHours = allWorkers.map(w => {
        const total = monthEntries
          .filter(e => e.user_id === w.id)
          .reduce((sum, e) => sum + calcHours(e.start_time, e.end_time), 0);
        return { ...w, scheduledHours: total };
      });
    }

    const pendingSchedules = role === 'admin'
      ? await db.all(`SELECT * FROM schedules WHERE status='submitted' ORDER BY week_start`)
      : [];

    const approvedSchedules = role === 'admin'
      ? await db.all(`SELECT * FROM schedules WHERE status='approved' ORDER BY week_start DESC LIMIT 20`)
      : [];

    const { calcHours } = require('../utils/helpers');
    const MONTHS_PL = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
    const monthlyHoursHistory = [];
    const today2 = new Date();
    const currentPrefix = `${today2.getFullYear()}-${String(today2.getMonth() + 1).padStart(2, '0')}`;

    if (role === 'admin') {
      for (let i = 0; i < 6; i++) {
        const d = new Date(today2.getFullYear(), today2.getMonth() - i, 1);
        const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = MONTHS_PL[d.getMonth()] + ' ' + d.getFullYear();
        const entries = await db.all(`
          SELECT COALESCE(se.custom_start, st.start_time) as start_time,
                 COALESCE(se.custom_end, st.end_time) as end_time
          FROM schedule_entries se
          LEFT JOIN shift_templates st ON st.id=se.shift_template_id
          WHERE se.date LIKE ? AND se.user_id=?
        `, [prefix + '%', id]);
        const hours = entries.reduce((sum, e) => sum + calcHours(e.start_time, e.end_time), 0);
        if (i === 0 || hours > 0) monthlyHoursHistory.push({ prefix, label, hours });
      }
    } else {
      const label = MONTHS_PL[today2.getMonth()] + ' ' + today2.getFullYear();
      const entries = await db.all(`
        SELECT COALESCE(se.custom_start, st.start_time) as start_time,
               COALESCE(se.custom_end, st.end_time) as end_time
        FROM schedule_entries se
        LEFT JOIN shift_templates st ON st.id=se.shift_template_id
        JOIN schedules s ON s.id=se.schedule_id
        WHERE se.date LIKE ? AND se.user_id=? AND s.status='approved'
      `, [currentPrefix + '%', id]);
      const hours = entries.reduce((sum, e) => sum + calcHours(e.start_time, e.end_time), 0);
      monthlyHoursHistory.push({ prefix: currentPrefix, label, hours });
    }

    res.render('dashboard', { workers: workers.cnt, pending: pending.cnt, myShifts, mySchedule, workerHours, pendingSchedules, approvedSchedules, monthlyHoursHistory });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('auth/login');
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE username=? AND active=1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      log({ id: null, name: username || '?', role: '?' }, 'Nieudana próba logowania', username || '');
      req.flash('error', 'Nieprawidłowa nazwa użytkownika lub hasło.');
      return res.redirect('/login');
    }
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userRole = user.role;
    log(user, 'Logowanie', user.username);
    if (user.must_change_password) return res.redirect('/change-password');
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/change-password', requireAuth, (req, res) => {
  res.render('auth/change-password');
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { password, password_confirm } = req.body;
    if (!password || password.length < 6) {
      req.flash('error', 'Hasło musi mieć co najmniej 6 znaków.');
      return res.redirect('/change-password');
    }
    if (password !== password_confirm) {
      req.flash('error', 'Hasła nie są identyczne.');
      return res.redirect('/change-password');
    }
    const hash = bcrypt.hashSync(password, 10);
    await db.run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', [hash, req.session.userId]);
    log(res.locals.user, 'Zmiana hasła');
    req.flash('success', 'Hasło zostało zmienione.');
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/logout', (req, res) => {
  if (res.locals.user) log(res.locals.user, 'Wylogowanie');
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
