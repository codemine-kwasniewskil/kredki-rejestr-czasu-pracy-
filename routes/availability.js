const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, getLocationId, requireFeature } = require('../middleware/auth');
const { getMonday, toDateString, getWeekDates } = require('../utils/helpers');

router.get('/', requireAuth, requireFeature('availability'), async (req, res) => {
  try {
    const { role, id: loggedInUserId } = res.locals.user;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = getMonday(today);

    let allUsers = [];
    let targetUserId = loggedInUserId;
    if (role === 'admin' || role === 'location_manager' || role === 'super_admin') {
      const locationId = getLocationId(req);
      allUsers = await db.all(
        `SELECT id, name, role FROM users WHERE active=1 AND role NOT IN ('admin','super_admin') AND location_id=? ORDER BY name`,
        [locationId]
      );
      if (req.query.userId) {
        const qId = parseInt(req.query.userId);
        if (allUsers.some(u => u.id === qId)) targetUserId = qId;
      } else if (allUsers.length > 0) {
        targetUserId = allUsers[0].id;
      }
    }
    const targetUser = role === 'worker'
      ? res.locals.user
      : (allUsers.find(u => u.id === targetUserId) || res.locals.user);

    const isManager = role === 'admin' || role === 'location_manager' || role === 'super_admin';
    const pastWeeks = isManager ? 12 : 0;
    const rangeStart = new Date(start);
    rangeStart.setDate(start.getDate() - pastWeeks * 7);

    const weeks = [];
    for (let w = 0; w < 26 + pastWeeks; w++) {
      const weekStart = new Date(rangeStart);
      weekStart.setDate(rangeStart.getDate() + w * 7);
      weeks.push(getWeekDates(toDateString(weekStart)));
    }

    const allDates = weeks.flat().map(toDateString);
    const availRows = await db.all(
      `SELECT * FROM availability WHERE user_id=? AND date IN (?)`,
      [targetUserId, allDates]
    );

    const availMap = {};
    for (const a of availRows) availMap[a.date] = { status: a.status, startTime: a.start_time, endTime: a.end_time };

    const todayStr = toDateString(today);

    // Workers: current month + past always locked; editable from next month onward
    let lockBeforeStr = null;
    if (role === 'worker') {
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      lockBeforeStr = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
    }

    // Auto-lock: after the 10th of each month, the next month is locked (standard scheduling cutoff).
    // The current month is therefore always auto-locked (it was locked when we passed the 10th of the
    // previous month); the next month is additionally auto-locked once we're past the 10th.
    // Computed for all roles so admin view can show it as informational.
    const autoLockedMonths = new Set();
    autoLockedMonths.add(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`);
    if (today.getDate() > 10) {
      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      autoLockedMonths.add(`${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`);
    }

    const currentWeekStart = toDateString(start);

    // Load month-specific locks for the target user (admin-set)
    const monthLockRows = await db.all(
      'SELECT `year_month`, locked FROM availability_month_locks WHERE user_id=?',
      [targetUserId]
    );
    const lockedMonths = new Set(monthLockRows.filter(r => r.locked).map(r => r.year_month));
    const unlockedMonths = new Set(monthLockRows.filter(r => !r.locked).map(r => r.year_month));

    // targetUserLocked: true if current or next month is admin-locked via month locks
    const todayYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const nextMDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextYM = `${nextMDate.getFullYear()}-${String(nextMDate.getMonth() + 1).padStart(2, '0')}`;
    const targetUserLocked = lockedMonths.has(todayYM) || lockedMonths.has(nextYM);

    res.render('availability/index', {
      weeks, availMap, todayStr, allUsers, targetUserId, targetUser,
      lockBeforeStr, targetUserLocked, currentWeekStart, lockedMonths, unlockedMonths, autoLockedMonths
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

module.exports = router;
