const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');
const { calcHours, formatHours } = require('../utils/helpers');

router.get('/', requireRole('admin', 'location_manager'), async (req, res) => {
  try {
    const today = new Date();
    const defaultMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const month = (req.query.month || defaultMonth).substring(0, 7);
    const [mYear, mMonth] = month.split('-').map(Number);

    // Build list of all calendar days in the month for conflict checking
    const daysInMonth = new Date(mYear, mMonth, 0).getDate();
    const allDates = Array.from({ length: daysInMonth }, (_, i) =>
      `${month}-${String(i + 1).padStart(2, '0')}`
    );

    const workers = await db.all(`
      SELECT u.id, u.name, c.min_hours_per_month
      FROM users u
      LEFT JOIN contracts c ON c.user_id = u.id AND c.active = 1
      WHERE u.active = 1 AND u.role IN ('worker', 'location_manager')
      ORDER BY u.name
    `);

    const availRows = await db.all(
      `SELECT user_id, date, status, start_time, end_time FROM availability WHERE date LIKE ?`,
      [month + '%']
    );

    const schedRows = await db.all(`
      SELECT se.user_id, se.date,
             COALESCE(se.custom_start, st.start_time) AS start_time,
             COALESCE(se.custom_end, st.end_time) AS end_time
      FROM schedule_entries se
      LEFT JOIN shift_templates st ON st.id = se.shift_template_id
      WHERE se.date LIKE ?
    `, [month + '%']);

    // Index by user_id + date
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

      // Hours declared available (only where time range is set)
      const availHoursWithTime = myAvail
        .filter(a => a.status === 'available' && a.start_time && a.end_time)
        .reduce((sum, a) => sum + calcHours(a.start_time, a.end_time), 0);
      const availDaysNoTime = myAvail.filter(a => a.status === 'available' && (!a.start_time || !a.end_time)).length;

      const scheduledHours = mySched.reduce((sum, s) => sum + calcHours(s.start_time, s.end_time), 0);
      const scheduledDays = mySched.length;

      // Conflict detection per scheduled day
      const conflicts = [];
      for (const s of mySched) {
        const avail = availByUserDate[`${w.id}_${s.date}`];
        if (!avail) {
          conflicts.push({ date: s.date, type: 'no_availability', shiftStart: s.start_time, shiftEnd: s.end_time });
        } else if (avail.status === 'unavailable') {
          conflicts.push({ date: s.date, type: 'unavailable', shiftStart: s.start_time, shiftEnd: s.end_time });
        } else if (avail.status === 'available' && avail.start_time && avail.end_time) {
          // Shift starts before or ends after declared availability
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

      return {
        ...w,
        availDays,
        unavailDays,
        availHoursWithTime,
        availDaysNoTime,
        scheduledHours,
        scheduledDays,
        conflicts,
      };
    });

    // Build month options: 12 months back and 6 months forward
    const monthOptions = [];
    const base = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    for (let i = 0; i < 18; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = MONTHS_PL[d.getMonth()] + ' ' + d.getFullYear();
      monthOptions.push({ val, label });
    }

    const monthLabel = MONTHS_PL[mMonth - 1] + ' ' + mYear;

    res.render('reports/index', {
      month, monthLabel, monthOptions, workerStats, formatHours,
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

module.exports = router;
