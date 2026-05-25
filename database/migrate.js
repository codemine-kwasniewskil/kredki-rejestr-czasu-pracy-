// Migrates existing data from local cafe.db → Aiven MySQL
// Run AFTER setup.js: node database/migrate.js
require('dotenv').config();
const { Database } = require('node-sqlite3-wasm');
const mysql = require('mysql2/promise');
const path = require('path');

const sqlite = new Database(path.join(__dirname, 'cafe.db'));

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    dateStrings: true,
  });

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  // Order matters: users first (others reference it)
  const tables = [
    'users',
    'contracts',
    'shift_templates',
    'schedules',
    'schedule_entries',
    'availability',
    'activity_logs',
  ];

  for (const table of tables) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) {
      console.log(`${table}: empty, skipping`);
      continue;
    }

    await conn.query(`DELETE FROM \`${table}\``);

    for (const row of rows) {
      const keys = Object.keys(row);
      const vals = Object.values(row);
      const cols = keys.map(k => `\`${k}\``).join(', ');
      const placeholders = keys.map(() => '?').join(', ');
      await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders})`, vals);
    }

    const maxId = rows.reduce((max, r) => Math.max(max, r.id || 0), 0);
    if (maxId > 0) {
      await conn.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${maxId + 1}`);
    }

    console.log(`✓ ${table}: ${rows.length} rows migrated`);
  }

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await conn.end();
  console.log('\nMigration complete! All data copied to Aiven MySQL.');
}

migrate().catch(err => { console.error(err); process.exit(1); });
