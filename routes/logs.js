const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');

router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const search = req.query.q || '';
    const dateFrom = req.query.from || '';
    const dateTo = req.query.to || '';

    const parts = ['1=1'];
    const params = [];
    if (search) {
      parts.push('(action LIKE ? OR details LIKE ? OR user_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (dateFrom) {
      parts.push('DATE(created_at) >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      parts.push('DATE(created_at) <= ?');
      params.push(dateTo);
    }

    const where = parts.join(' AND ');
    const totalRow = await db.get(`SELECT COUNT(*) as cnt FROM activity_logs WHERE ${where}`, params);
    const total = totalRow.cnt;
    const logs = await db.all(
      `SELECT * FROM activity_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.render('logs/index', { logs, page, totalPages: Math.ceil(total / limit) || 1, total, search, dateFrom, dateTo });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

module.exports = router;
