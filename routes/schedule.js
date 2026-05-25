const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getMonday, getWeekDates, toDateString, calcHours, formatHours, prevWeekStart, nextWeekStart, formatDayHeader, formatWeekRange } = require('../utils/helpers');
const { log } = require('../utils/logger');

router.get('/', requireAuth, (req, res) => {
  const weekStart = toDateString(getMonday(new Date()));
  res.redirect(`/schedule/week/${weekStart}`);
});

router.get('/week/:weekStart', requireAuth, (req, res) => {
  const { weekStart } = req.params;
  const weekDates = getWeekDates(weekStart);
  const { role, id: userId } = res.locals.user;

  let schedule = db.prepare(`SELECT * FROM schedules WHERE week_start=?`).get(weekStart);
  if (role === 'worker') {
    // Workers only see approved schedules
    schedule = (schedule && schedule.status === 'approved') ? schedule : null;
  } else if (!schedule) {
    const r = db.prepare(`INSERT INTO schedules (week_start, created_by) VALUES (?,?)`).run(weekStart, userId);
    schedule = db.prepare('SELECT * FROM schedules WHERE id=?').get(r.lastInsertRowid);
  }

  const workers = db.prepare(`
    SELECT u.id, u.name, c.min_hours_per_month, c.hourly_rate
    FROM users u
    LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
    WHERE u.active=1 AND u.role IN ('worker','location_manager')
    ORDER BY u.name
  `).all();

  const entries = schedule
    ? db.prepare(`
        SELECT se.*, COALESCE(st.name,'Własna') as shift_name,
               COALESCE(se.custom_start, st.start_time) as start_time,
               COALESCE(se.custom_end, st.end_time) as end_time,
               COALESCE(st.color,'#6B7280') as color
        FROM schedule_entries se
        LEFT JOIN shift_templates st ON st.id=se.shift_template_id
        WHERE se.schedule_id=?
      `).all(schedule.id)
    : [];

  const dateStrings = weekDates.map(toDateString);
  const workerIds = workers.map(w => w.id);

  let availabilityRows = [];
  if (workerIds.length && dateStrings.length) {
    const placeholders = workerIds.map(() => '?').join(',');
    const datePlaceholders = dateStrings.map(() => '?').join(',');
    availabilityRows = db.prepare(`
      SELECT * FROM availability
      WHERE user_id IN (${placeholders}) AND date IN (${datePlaceholders})
    `).all(...workerIds, ...dateStrings);
  }

  const entriesMap = {};
  for (const e of entries) entriesMap[`${e.user_id}_${e.date}`] = e;

  const availMap = {};
  for (const a of availabilityRows) availMap[`${a.user_id}_${a.date}`] = { status: a.status, startTime: a.start_time, endTime: a.end_time };

  const workerWeekHours = {};
  for (const w of workers) {
    workerWeekHours[w.id] = entries
      .filter(e => e.user_id === w.id)
      .reduce((sum, e) => sum + calcHours(e.start_time, e.end_time), 0);
  }

  const workerRateMap = {};
  for (const w of workers) workerRateMap[w.id] = w.hourly_rate || 0;

  const entryCostMap = {};
  const dailyCostMap = {};
  for (const e of entries) {
    const rate = workerRateMap[e.user_id] || 0;
    if (rate > 0) {
      const cost = calcHours(e.start_time, e.end_time) * rate;
      entryCostMap[`${e.user_id}_${e.date}`] = cost;
      dailyCostMap[e.date] = (dailyCostMap[e.date] || 0) + cost;
    }
  }

  // Monthly hours: all entries for the calendar month containing this week
  const monthPrefix = weekStart.substring(0, 7);
  const monthEntries = db.prepare(`
    SELECT se.user_id,
           COALESCE(se.custom_start, st.start_time) as start_time,
           COALESCE(se.custom_end, st.end_time) as end_time
    FROM schedule_entries se
    LEFT JOIN shift_templates st ON st.id = se.shift_template_id
    WHERE se.date LIKE ?
  `).all(monthPrefix + '%');

  const workerMonthlyHours = {};
  for (const w of workers) {
    workerMonthlyHours[w.id] = monthEntries
      .filter(e => e.user_id === w.id)
      .reduce((sum, e) => sum + calcHours(e.start_time, e.end_time), 0);
  }

  const MONTHS_PL = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
  const [mYear, mMonth] = monthPrefix.split('-').map(Number);
  const monthLabel = MONTHS_PL[mMonth - 1] + ' ' + mYear;

  const shiftTemplates = db.prepare(`SELECT * FROM shift_templates WHERE active=1 ORDER BY start_time`).all();

  // Admin can always edit; manager can only edit non-approved
  const isEditable = schedule && (role === 'admin' || (schedule.status !== 'approved' && role === 'location_manager'));

  const adminChanges = (schedule && (role === 'location_manager' || role === 'admin'))
    ? db.prepare(`
        SELECT se.*, u.name as user_name, COALESCE(st.name,'Własna') as shift_name,
               COALESCE(se.custom_start, st.start_time) as start_time,
               COALESCE(se.custom_end, st.end_time) as end_time,
               adm.name as admin_name
        FROM schedule_entries se
        JOIN users u ON u.id = se.user_id
        LEFT JOIN shift_templates st ON st.id = se.shift_template_id
        LEFT JOIN users adm ON adm.id = se.modified_by_user_id
        WHERE se.schedule_id = ? AND se.modified_by_admin = 1
        ORDER BY se.date, u.name
      `).all(schedule.id)
    : [];

  res.render('schedule/index', {
    schedule, workers, weekDates, weekStart,
    entriesMap, availMap, workerWeekHours, workerMonthlyHours, monthLabel,
    shiftTemplates, isEditable, adminChanges,
    entryCostMap, dailyCostMap,
    formatHours, formatDayHeader, formatWeekRange,
    prevWeek: prevWeekStart(weekStart),
    nextWeek: nextWeekStart(weekStart),
  });
});

router.post('/week/:weekStart/submit', requireRole('location_manager', 'admin'), (req, res) => {
  const schedule = db.prepare(`SELECT * FROM schedules WHERE week_start=?`).get(req.params.weekStart);
  if (schedule && schedule.status === 'draft') {
    db.prepare(`UPDATE schedules SET status='submitted' WHERE id=?`).run(schedule.id);
    log(res.locals.user, 'Wysłanie grafiku do akceptacji', `Tydzień: ${req.params.weekStart}`);
    req.flash('success', 'Grafik wysłany do akceptacji.');
  }
  res.redirect(`/schedule/week/${req.params.weekStart}`);
});

router.post('/week/:weekStart/approve', requireRole('admin'), (req, res) => {
  const schedule = db.prepare(`SELECT * FROM schedules WHERE week_start=?`).get(req.params.weekStart);
  if (schedule && schedule.status !== 'approved') {
    db.prepare(`UPDATE schedules SET status='approved', approved_by=? WHERE id=?`)
      .run(res.locals.user.id, schedule.id);
    log(res.locals.user, 'Zatwierdzenie grafiku', `Tydzień: ${req.params.weekStart}`);
    req.flash('success', 'Grafik zatwierdzony.');
  }
  res.redirect(`/schedule/week/${req.params.weekStart}`);
});

router.post('/week/:weekStart/reject', requireRole('admin'), (req, res) => {
  const schedule = db.prepare(`SELECT * FROM schedules WHERE week_start=?`).get(req.params.weekStart);
  if (schedule && schedule.status === 'submitted') {
    db.prepare(`UPDATE schedules SET status='rejected', rejection_notes=? WHERE id=?`)
      .run(req.body.notes || '', schedule.id);
    log(res.locals.user, 'Odrzucenie grafiku', `Tydzień: ${req.params.weekStart}${req.body.notes ? ' | ' + req.body.notes : ''}`);
    req.flash('error', 'Grafik odrzucony.');
  }
  res.redirect(`/schedule/week/${req.params.weekStart}`);
});

router.post('/week/:weekStart/reopen', requireRole('admin', 'location_manager'), (req, res) => {
  const schedule = db.prepare(`SELECT * FROM schedules WHERE week_start=?`).get(req.params.weekStart);
  if (schedule && (schedule.status === 'rejected' || schedule.status === 'submitted')) {
    db.prepare(`UPDATE schedules SET status='draft', rejection_notes=NULL WHERE id=?`).run(schedule.id);
    log(res.locals.user, 'Przywrócenie grafiku do szkicu', `Tydzień: ${req.params.weekStart}`);
    req.flash('success', 'Grafik przywrócony do szkicu.');
  }
  res.redirect(`/schedule/week/${req.params.weekStart}`);
});

module.exports = router;
