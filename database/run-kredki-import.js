// One-off: load kredki_mysql_ready SQL into Aiven. Delete after use.
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    multipleStatements: true,
  });

  const sql = fs.readFileSync(
    path.join(__dirname, 'kredki_mysql_ready', 'mysql_schema_and_inserts.sql'),
    'utf8'
  );

  console.log('Running import...');
  await conn.query(sql);
  console.log('Done.');

  const [[{ shifts }]] = await conn.query('SELECT COUNT(*) as shifts FROM employee_shifts');
  const [[{ employees }]] = await conn.query('SELECT COUNT(*) as employees FROM employees');
  const [[{ avail }]] = await conn.query('SELECT COUNT(*) as avail FROM employee_availability');
  const [[{ unmapped }]] = await conn.query('SELECT COUNT(*) as unmapped FROM schedule_unmapped_entries');

  console.log(`  employees: ${employees}`);
  console.log(`  employee_shifts: ${shifts}`);
  console.log(`  employee_availability: ${avail}`);
  console.log(`  schedule_unmapped_entries: ${unmapped}`);

  await conn.end();
}

run().catch(err => { console.error(err); process.exit(1); });
