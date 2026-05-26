require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'finance_migration.sql'), 'utf8');

  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    multipleStatements: true,
  });

  try {
    console.log('Running finance migration…');
    await conn.query(sql);
    console.log('Finance migration completed successfully.');
  } finally {
    await conn.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
