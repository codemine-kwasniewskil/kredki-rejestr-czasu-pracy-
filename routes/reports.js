const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { calcHours, formatHours } = require('../utils/helpers');
const { buildDay, summarize } = require('../utils/workTime');

router.get('/', requireRole('admin', 'location_manager'), requireFeature('reports'), async (req, res) => {
  try {
    const today = new Date();
    const defaultMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const month = (req.query.month || defaultMonth).substring(0, 7);
    const [mYear, mMonth] = month.split('-').map(Number);
    const locationId = getLocationId(req);

    const daysInMonth = new Date(mYear, mMonth, 0).getDate();
    const allDates = Array.from({ length: daysInMonth }, (_, i) =>
      `${month}-${String(i + 1).padStart(2, '0')}`
    );

    const workers = await db.all(`
      SELECT u.id, u.name, c.min_hours_per_month, c.hourly_rate
      FROM users u
      LEFT JOIN contracts c ON c.user_id = u.id AND c.active = 1
      WHERE u.active = 1 AND u.role IN ('worker', 'location_manager') AND u.location_id = ?
      ORDER BY u.name
    `, [locationId]);

    const workerIds = workers.map(w => w.id);

    const availRows = workerIds.length
      ? await db.all(
          `SELECT user_id, date, status, start_time, end_time FROM availability WHERE user_id IN (?) AND date LIKE ?`,
          [workerIds, month + '%']
        )
      : [];

    const schedRows = workerIds.length
      ? await db.all(`
          SELECT se.user_id, se.date,
                 COALESCE(se.custom_start, st.start_time) AS start_time,
                 COALESCE(se.custom_end, st.end_time) AS end_time
          FROM schedule_entries se
          LEFT JOIN shift_templates st ON st.id = se.shift_template_id
          WHERE se.date LIKE ? AND se.user_id IN (?)
        `, [month + '%', workerIds])
      : [];

    const availByUserDate = {};
    for (const a of availRows) {
      availByUserDate[`${a.user_id}_${a.date}`] = a;
    }
    const schedByUserDate = {};
    for (const s of schedRows) {
      schedByUserDate[`${s.user_id}_${s.date}`] = s;
    }

    const MONTHS_PL = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];

    const workerStats = workers.map(w => {
      const myAvail = availRows.filter(a => a.user_id === w.id);
      const mySched = schedRows.filter(s => s.user_id === w.id);

      const availDays = myAvail.filter(a => a.status === 'available').length;
      const unavailDays = myAvail.filter(a => a.status === 'unavailable').length;

      const availHoursWithTime = myAvail
        .filter(a => a.status === 'available' && a.start_time && a.end_time)
        .reduce((sum, a) => sum + calcHours(a.start_time, a.end_time), 0);
      const availDaysNoTime = myAvail.filter(a => a.status === 'available' && (!a.start_time || !a.end_time)).length;

      const scheduledHours = mySched.reduce((sum, s) => sum + calcHours(s.start_time, s.end_time), 0);
      const scheduledDays = mySched.length;

      const conflicts = [];
      for (const s of mySched) {
        const avail = availByUserDate[`${w.id}_${s.date}`];
        if (!avail) {
          conflicts.push({ date: s.date, type: 'no_availability', shiftStart: s.start_time, shiftEnd: s.end_time });
        } else if (avail.status === 'unavailable') {
          conflicts.push({ date: s.date, type: 'unavailable', shiftStart: s.start_time, shiftEnd: s.end_time });
        } else if (avail.status === 'available' && avail.start_time && avail.end_time) {
          const shiftStartMin = timeToMin(s.start_time);
          const shiftEndMin = timeToMin(s.end_time);
          const availStartMin = timeToMin(avail.start_time);
          const availEndMin = timeToMin(avail.end_time);
          if (shiftStartMin < availStartMin || shiftEndMin > availEndMin) {
            conflicts.push({
              date: s.date, type: 'outside_hours',
              shiftStart: s.start_time, shiftEnd: s.end_time,
              availStart: avail.start_time, availEnd: avail.end_time
            });
          }
        }
      }

      const hourlyRate = w.hourly_rate || 0;
      const totalCost = scheduledHours * hourlyRate;

      return {
        ...w,
        availDays,
        unavailDays,
        availHoursWithTime,
        availDaysNoTime,
        scheduledHours,
        scheduledDays,
        conflicts,
        hourlyRate,
        totalCost,
      };
    });

    const monthOptions = [];
    const base = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    for (let i = 0; i < 18; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = MONTHS_PL[d.getMonth()] + ' ' + d.getFullYear();
      monthOptions.push({ val, label });
    }

    const monthLabel = MONTHS_PL[mMonth - 1] + ' ' + mYear;
    const tab = req.query.tab === 'costs' ? 'costs' : 'availability';

    res.render('reports/index', {
      month, monthLabel, monthOptions, workerStats, formatHours, tab,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

const MONTHS_PL_FULL = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
const DAYS_PL = ['Nd','Pon','Wt','Śr','Czw','Pt','Sob'];

function loadEmployee(userId) {
  return db.get(`
    SELECT u.id, u.name, u.role, c.min_hours_per_month, c.hourly_rate
    FROM users u LEFT JOIN contracts c ON c.user_id=u.id AND c.active=1
    WHERE u.id=?`, [userId]);
}

// Wspólne źródło dla Karty czasu pracy i raportu rzeczywistego czasu pracy —
// oba muszą obejmować dokładnie ten sam zakres dni.
function loadMonthEntries(userId, month) {
  return db.all(`
    SELECT se.id, se.date, se.notes, se.confirmed_by_employee,
           se.work_started_at, se.work_ended_at,
           COALESCE(st.name,'Własna') as shift_name,
           COALESCE(se.custom_start, st.start_time) as start_time,
           COALESCE(se.custom_end, st.end_time) as end_time
    FROM schedule_entries se
    LEFT JOIN shift_templates st ON st.id=se.shift_template_id
    JOIN schedules s ON s.id=se.schedule_id
    WHERE se.user_id=? AND se.date LIKE ? AND s.status='approved'
    ORDER BY se.date
  `, [userId, month + '%']);
}

function buildMonthDays(entries, month) {
  const [mYear, mMonth] = month.split('-').map(Number);
  const entryByDate = {};
  for (const e of entries) entryByDate[e.date] = e;

  const daysInMonth = new Date(mYear, mMonth, 0).getDate();
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${month}-${String(d).padStart(2, '0')}`;
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    days.push({
      date: dateStr,
      day: d,
      dayLabel: DAYS_PL[dow],
      isWeekend: dow === 0 || dow === 6,
      entry: entryByDate[dateStr] || null,
    });
  }
  return days;
}

// Historia zmian godzin dla konkretnych dni raportu. Wpisy nie mają kolumny z id
// zmiany — wiąże je prefiks "Zmiana #<id>" w details (patrz describeTimeChange).
const TIME_LOG_ACTIONS = [
  'Edycja godzin w Karcie czasu pracy',
  'Przepisanie odbicia do grafiku',
  'Korekta czasu pracy',
];

async function loadEntryLogs(entryIds) {
  const ids = entryIds.map(Number).filter(Boolean);
  if (!ids.length) return [];
  return db.all(`
    SELECT created_at, user_name, user_role, action, details
    FROM activity_logs
    WHERE action IN (?) AND details REGEXP ?
    ORDER BY created_at DESC
    LIMIT 200
  `, [TIME_LOG_ACTIONS, `#(${ids.join('|')})([^0-9]|$)`]);
}

function listEmployees(locationId) {
  return db.all(`
    SELECT id, name FROM users
    WHERE active=1 AND role IN ('worker','location_manager') AND location_id=?
    ORDER BY name
  `, [locationId]);
}

function buildMonthOptions() {
  const today = new Date();
  const base = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const options = [];
  for (let i = 0; i < 18; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    options.push({ val, label: MONTHS_PL_FULL[d.getMonth()] + ' ' + d.getFullYear() });
  }
  return options;
}

async function buildEmployeeReport(userId, month) {
  const [mYear, mMonth] = month.split('-').map(Number);
  const employee = await loadEmployee(userId);
  if (!employee) return null;

  const entries = await loadMonthEntries(userId, month);
  const days = buildMonthDays(entries, month).map(d => ({
    ...d,
    hours: d.entry ? calcHours(d.entry.start_time, d.entry.end_time) : 0,
  }));

  const totalHours = days.reduce((sum, d) => sum + d.hours, 0);
  const workedDays = days.filter(d => d.entry).length;
  const monthLabel = MONTHS_PL_FULL[mMonth - 1] + ' ' + mYear;

  return { employee, days, totalHours, workedDays, monthLabel, month, mYear, mMonth };
}

// Raport rzeczywistego czasu pracy: plan z grafiku vs. odbicia Start/Koniec pracy.
async function buildActualReport(userId, month) {
  const [mYear, mMonth] = month.split('-').map(Number);
  const employee = await loadEmployee(userId);
  if (!employee) return null;

  const entries = await loadMonthEntries(userId, month);
  const days = buildMonthDays(entries, month).map(d => ({ ...d, ...buildDay(d.entry) }));
  const summary = summarize(days);
  const monthLabel = MONTHS_PL_FULL[mMonth - 1] + ' ' + mYear;

  return { employee, days, summary, monthLabel, month, mYear, mMonth };
}

router.get('/employee', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const today = new Date();
    const defaultMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const month = (req.query.month || defaultMonth).substring(0, 7);
    const locationId = getLocationId(req);

    const employees = await listEmployees(locationId);
    const monthOptions = buildMonthOptions();

    if (req.query.userId && req.query.userId !== '') {
      return res.redirect(`/reports/employee/${req.query.userId}/${month}`);
    }

    res.render('reports/employee-select', { employees, monthOptions, month });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/employee/:userId/:month', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const data = await buildEmployeeReport(req.params.userId, req.params.month);
    if (!data) return res.status(404).render('error', { message: 'Pracownik nie znaleziony.' });
    const employees = await listEmployees(getLocationId(req));
    const monthOptions = buildMonthOptions();
    const changeLog = await loadEntryLogs(data.days.filter(d => d.entry).map(d => d.entry.id));

    res.render('reports/employee-hours', { ...data, employees, monthOptions, changeLog, formatHours });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/employee/:userId/:month/csv', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const data = await buildEmployeeReport(req.params.userId, req.params.month);
    if (!data) return res.status(404).send('Not found');

    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      [esc('Data'), esc('Dzień'), esc('Zmiana'), esc('Od'), esc('Do'), esc('Godziny'), esc('Uwagi')].join(';'),
    ];
    for (const d of data.days) {
      lines.push([
        esc(d.date),
        esc(d.dayLabel),
        esc(d.entry ? d.entry.shift_name : ''),
        esc(d.entry ? d.entry.start_time : ''),
        esc(d.entry ? d.entry.end_time : ''),
        esc(d.hours > 0 ? d.hours.toFixed(2).replace('.', ',') : ''),
        esc(d.entry && d.entry.notes ? d.entry.notes : ''),
      ].join(';'));
    }
    lines.push(['', '', '', '', esc('RAZEM'), esc(data.totalHours.toFixed(2).replace('.', ',')), ''].join(';'));

    const filename = `godziny_${data.employee.name.replace(/\s+/g, '_')}_${data.month}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Błąd serwera.');
  }
});

// ── Rzeczywisty czas pracy (odbicia Start/Koniec pracy) ─────────────────────

const STATUS_LABELS = {
  zgodne: 'zgodne',
  roznica: 'różnica',
  do_sprawdzenia: 'do sprawdzenia — niezgodne z grafikiem',
  brak_zmiany: '',
};

function formatDiff(hours) {
  if (hours === null) return '—';
  if (Math.abs(hours) < 1 / 120) return '0';
  return (hours > 0 ? '+' : '−') + formatHours(Math.abs(hours));
}

const currentMonth = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
};

router.get('/actual', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const month = (req.query.month || currentMonth()).substring(0, 7);
    const employees = await listEmployees(getLocationId(req));
    if (!employees.length) {
      return res.status(404).render('error', { message: 'Brak aktywnych pracowników w tej lokalizacji.' });
    }
    const userId = req.query.userId || employees[0].id;
    res.redirect(`/reports/actual/${userId}/${month}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/actual/:userId/:month', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const data = await buildActualReport(req.params.userId, req.params.month);
    if (!data) return res.status(404).render('error', { message: 'Pracownik nie znaleziony.' });

    const employees = await listEmployees(getLocationId(req));
    const monthOptions = buildMonthOptions();

    res.render('reports/actual-hours', {
      ...data, employees, monthOptions, formatHours, formatDiff, STATUS_LABELS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.get('/actual/:userId/:month/csv', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const data = await buildActualReport(req.params.userId, req.params.month);
    if (!data) return res.status(404).send('Not found');

    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const num = v => (v === null || v === undefined ? '' : v.toFixed(2).replace('.', ','));
    const lines = [
      ['Data', 'Dzień', 'Zmiana', 'Plan od', 'Plan do', 'Plan godz.',
       'Faktycznie od', 'Faktycznie do', 'Faktycznie godz.', 'Różnica', 'Status'].map(esc).join(';'),
    ];
    for (const d of data.days) {
      lines.push([
        esc(d.date),
        esc(d.dayLabel),
        esc(d.entry ? d.entry.shift_name : ''),
        esc(d.entry ? d.entry.start_time : ''),
        esc(d.entry ? d.entry.end_time : ''),
        esc(d.entry ? num(d.plannedHours) : ''),
        esc(d.actualStart),
        esc(d.actualEnd),
        esc(num(d.actualHours)),
        esc(num(d.diff)),
        esc(STATUS_LABELS[d.status]),
      ].join(';'));
    }
    lines.push([
      esc('RAZEM'), '', '', '', '',
      esc(num(data.summary.totalPlanned)), '', '',
      esc(num(data.summary.totalActual)),
      esc(num(data.summary.totalDiff)),
      esc(`odbicia z ${data.summary.matchedDays} z ${data.summary.scheduledDays} dni`),
    ].join(';'));

    const filename = `odbicia_${data.employee.name.replace(/\s+/g, '_')}_${data.month}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Błąd serwera.');
  }
});

module.exports = router;
