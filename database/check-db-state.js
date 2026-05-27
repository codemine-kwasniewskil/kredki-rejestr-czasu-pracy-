require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
  });

  const [users] = await conn.query('SELECT id, name, role, active FROM users ORDER BY id');
  console.log('\nUSERS:', JSON.stringify(users, null, 2));

  const [schedCount] = await conn.query('SELECT COUNT(*) as c FROM schedules');
  console.log('\nSCHEDULES count:', schedCount[0].c);

  const [entryCount] = await conn.query('SELECT COUNT(*) as c FROM schedule_entries');
  console.log('SCHEDULE_ENTRIES count:', entryCount[0].c);

  const [availCount] = await conn.query('SELECT COUNT(*) as c FROM availability');
  console.log('AVAILABILITY count:', availCount[0].c);

  await conn.end();
}
run().catch(err => { console.error(err); process.exit(1); });
