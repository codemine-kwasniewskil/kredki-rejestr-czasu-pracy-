const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getMonday, toDateString, getWeekDates } = require('../utils/helpers');

router.get('/', requireAuth, (req, res) => {
  const { role, id: loggedInUserId } = res.locals.user;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = getMonday(today);

  // Worker selector: admin/manager can view/edit for any user
  let allUsers = [];
  let targetUserId = loggedInUserId;
  if (role === 'admin' || role === 'location_manager') {
    allUsers = db.prepare(`SELECT id, name, role, availability_locked FROM users WHERE active=1 AND role != 'admin' ORDER BY name`).all();
    if (req.query.userId) {
      const qId = parseInt(req.query.userId);
      if (allUsers.some(u => u.id === qId)) targetUserId = qId;
    } else if (role === 'admin' && allUsers.length > 0) {
      // Admin is not in allUsers — default to first worker so dropdown matches data
      targetUserId = allUsers[0].id;
    }
  }
  const targetUser = role === 'worker'
    ? res.locals.user
    : (allUsers.find(u => u.id === targetUserId) || res.locals.user);

  const weeks = [];
  for (let w = 0; w < 26; w++) {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() + w * 7);
    weeks.push(getWeekDates(toDateString(weekStart)));
  }

  const allDates = weeks.flat().map(toDateString);
  const availRows = db.prepare(`
    SELECT * FROM availability WHERE user_id=? AND date IN (${allDates.map(() => '?').join(',')})
  `).all(targetUserId, ...allDates);

  const availMap = {};
  for (const a of availRows) availMap[a.date] = { status: a.status, startTime: a.start_time, endTime: a.end_time };

  const todayStr = toDateString(today);

  // Lock: admin = no lock; worker/manager = locked before the 1st of next-editable month
  // Rule: after the 10th of month M, month M+1 is locked (M+2 becomes first editable)
  let lockBeforeStr = null;
  if (role !== 'admin') {
    const cutoff = 10;
    const firstEditable = today.getDate() <= cutoff
      ? new Date(today.getFullYear(), today.getMonth() + 1, 1)
      : new Date(today.getFullYear(), today.getMonth() + 2, 1);
    const fy = firstEditable.getFullYear();
    const fm = String(firstEditable.getMonth() + 1).padStart(2, '0');
    lockBeforeStr = `${fy}-${fm}-01`;
  }

  // Check if target user's availability is admin-locked
  // For workers, re-query from DB since res.locals.user lacks availability_locked
  const targetUserDbRow = role === 'worker'
    ? db.prepare('SELECT availability_locked FROM users WHERE id=?').get(loggedInUserId)
    : null;
  const targetUserLocked = !!(
    (targetUserDbRow && targetUserDbRow.availability_locked) ||
    (targetUser && targetUser.availability_locked)
  );

  res.render('availability/index', {
    weeks, availMap, todayStr, allUsers, targetUserId, targetUser, lockBeforeStr, targetUserLocked
  });
});

module.exports = router;
