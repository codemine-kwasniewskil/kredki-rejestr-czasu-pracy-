// One-off: import availability from "Wolne i Wyjazdy" CSV data (May-Jun 2026)
// Delete after use.
require('dotenv').config();
const mysql = require('mysql2/promise');

// Manually parsed from the CSV (year 2026, weekends only)
// "wolne"/"wyjazd" = unavailable; Anisa has permanent Saturday-off
const DATA = [
  // Igor: wolne 30.05, 31.05
  { name: 'Igor', unavailable: ['2026-05-30', '2026-05-31'] },
  // Juliana (DB: Julianna): Wolne 17.05, wolne 24.05, wyjazd 13.06, 14.06
  { name: 'Julianna', unavailable: ['2026-05-17', '2026-05-24', '2026-06-13', '2026-06-14'] },
  // Maria: Wolne 02.05, 03.05
  { name: 'Maria', unavailable: ['2026-05-02', '2026-05-03'] },
  // Anisa: stały wolny w sobotę – all Saturdays in range
  { name: 'Anisa', unavailable: [
    '2026-05-02','2026-05-09','2026-05-16','2026-05-23','2026-05-30',
    '2026-06-06','2026-06-13','2026-06-20','2026-06-27',
  ]},
  // Karolina: wolne 21.06
  { name: 'Karolina', unavailable: ['2026-06-21'] },
];

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
  });

  // Build name→id map
  const [users] = await conn.query('SELECT id, name FROM users WHERE active=1');
  const nameToId = {};
  for (const u of users) nameToId[u.name] = u.id;

  let inserted = 0;
  for (const { name, unavailable } of DATA) {
    const userId = nameToId[name];
    if (!userId) { console.warn(`Skipping unknown user: ${name}`); continue; }
    for (const date of unavailable) {
      await conn.query(
        `INSERT INTO availability (user_id, date, status)
         VALUES (?,?,'unavailable')
         ON DUPLICATE KEY UPDATE status='unavailable'`,
        [userId, date]
      );
      inserted++;
    }
    console.log(`  ${name} (id=${userId}): ${unavailable.length} unavailable days`);
  }

  console.log(`Done – inserted/updated ${inserted} availability rows.`);
  await conn.end();
}

run().catch(err => { console.error(err); process.exit(1); });
