const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { getMonday, toDateString, getWeekDates } = require('../utils/helpers');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { role, id: loggedInUserId } = res.locals.user;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = getMonday(today);

    let allUsers = [];
    let targetUserId = loggedInUserId;
    if (role === 'admin' || role === 'location_manager') {
      allUsers = await db.all(`SELECT id, name, role, availability_locked FROM users WHERE active=1 AND role != 'admin' ORDER BY name`);
      if (req.query.userId) {
        const qId = parseInt(req.query.userId);
        if (allUsers.some(u => u.id === qId)) targetUserId = qId;
      } else if ((role === 'admin' || role === 'location_manager') && allUsers.length > 0) {
        targetUserId = allUsers[0].id;
      }
    }
    const targetUser = role === 'worker'
      ? res.locals.user
      : (allUsers.find(u => u.id === targetUserId) || res.locals.user);

    const isManager = role === 'admin' || role === 'location_manager';
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

    const targetUserDbRow = role === 'worker'
      ? await db.get('SELECT availability_locked FROM users WHERE id=?', [loggedInUserId])
      : null;
    // Use only fresh DB data for worker's locked status — session data may be stale after admin unlock
    const targetUserLocked = role === 'worker'
      ? !!(targetUserDbRow && targetUserDbRow.availability_locked)
      : !!(targetUser && targetUser.availability_locked);

    let lockBeforeStr = null;
    if (role === 'worker') {
      if (targetUserLocked) {
        // Admin-locked: use the automatic deadline cutoff (irrelevant since all dates are blocked anyway)
        const cutoff = 10;
        const firstEditable = today.getDate() <= cutoff
          ? new Date(today.getFullYear(), today.getMonth() + 1, 1)
          : new Date(today.getFullYear(), today.getMonth() + 2, 1);
        lockBeforeStr = `${firstEditable.getFullYear()}-${String(firstEditable.getMonth() + 1).padStart(2, '0')}-01`;
      } else {
        // Not admin-locked: allow editing from the start of the current month
        lockBeforeStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      }
    }

    const currentWeekStart = toDateString(start);

    // Load month-specific locks for the target user (admin-set)
    const monthLockRows = await db.all(
      'SELECT `year_month` FROM availability_month_locks WHERE user_id=?',
      [targetUserId]
    );
    const lockedMonths = new Set(monthLockRows.map(r => r.year_month));

    res.render('availability/index', {
      weeks, availMap, todayStr, allUsers, targetUserId, targetUser, lockBeforeStr, targetUserLocked, currentWeekStart, lockedMonths
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

module.exports = router;
