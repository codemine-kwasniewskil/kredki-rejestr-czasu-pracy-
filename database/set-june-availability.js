// One-off: set June 2026 availability pattern for Karolina and Maria.
// Only flips available → unavailable for restricted days; never touches existing unavailable entries.
// Delete after use.
require('dotenv').config();
const mysql = require('mysql2/promise');

const PATTERNS = [
  { name: 'Karolina', availableDays: [1, 5, 6, 0] }, // Mon, Fri, Sat, Sun
  { name: 'Maria',    availableDays: [5, 6, 0] },     // Fri, Sat, Sun
];

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
  });

  const [users] = await conn.query('SELECT id, name FROM users WHERE active=1');
  const nameToId = {};
  for (const u of users) nameToId[u.name] = u.id;

  // Use T12:00:00 to avoid midnight DST edge cases
  const juneDates = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    juneDates.push({ date, day: new Date(date + 'T12:00:00').getDay() });
  }

  for (const { name, availableDays } of PATTERNS) {
    const userId = nameToId[name];
    if (!userId) { console.warn(`Skipping unknown user: ${name}`); continue; }

    let changed = 0;
    for (const { date, day } of juneDates) {
      if (!availableDays.includes(day)) {
        // Restricted day: flip available → unavailable only (leave existing unavailable alone)
        const [r] = await conn.query(
          `UPDATE availability SET status='unavailable' WHERE user_id=? AND date=? AND status='available'`,
          [userId, date]
        );
        if (r.affectedRows > 0) changed++;
      }
    }
    console.log(`  ${name} (id=${userId}): ${changed} restricted days set to unavailable`);
  }

  // Show result
  const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (const { name } of PATTERNS) {
    const userId = nameToId[name];
    if (!userId) continue;
    const [rows] = await conn.query(
      `SELECT date, status FROM availability WHERE user_id=? AND date LIKE '2026-06-%' ORDER BY date`,
      [userId]
    );
    console.log(`\n${name} June availability:`);
    for (const r of rows) {
      const dow = DAY[new Date(r.date + 'T12:00:00').getDay()];
      console.log(`  ${r.date} (${dow}) → ${r.status}`);
    }
  }

  await conn.end();
}

run().catch(err => { console.error(err); process.exit(1); });
