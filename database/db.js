const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  timezone: '+00:00',
  dateStrings: true,
});

const db = {
  pool,

  async get(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows[0] ?? null;
  },

  async all(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
  },

  async run(sql, params = []) {
    const [result] = await pool.query(sql, params);
    return { insertId: result.insertId, affectedRows: result.affectedRows };
  },
};

module.exports = db;
