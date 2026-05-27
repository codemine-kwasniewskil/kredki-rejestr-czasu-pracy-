// Import historical schedule + availability into existing app tables.
// Delete after use.
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'kredki_mysql_ready');

function parseCSV(file) {
  const lines = fs.readFileSync(path.join(DIR, file), 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    // Handle quoted fields
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += ch;
    }
    vals.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

function toHHMM(timeStr) {
  if (!timeStr) return null;
  // '09:00:00' → '09:00'
  return timeStr.slice(0, 5);
}

function getMonday(dateStr) {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, ssl: { rejectUnauthorized: false },
  });

  // Build name → user_id map (Juliana/Julianna normalised)
  const [users] = await conn.query('SELECT id, name FROM users WHERE active=1');
  const nameMap = {};
  for (const u of users) {
    nameMap[u.name.toLowerCase()] = u.id;
  }
  // Alias: CSV uses "Juliana", DB has "Julianna"
  if (nameMap['julianna']) nameMap['juliana'] = nameMap['julianna'];

  console.log('Name→ID map:', nameMap);

  // --- SCHEDULES + SCHEDULE_ENTRIES from employee_shifts.csv ---
  const shifts = parseCSV('employee_shifts.csv');
  const workStatuses = new Set(['WORK', 'EVENT']);

  // Collect all weeks that have WORK shifts for known users
  const weekSet = new Set();
  for (const s of shifts) {
    if (!workStatuses.has(s.status)) continue;
    const uid = nameMap[s.employee_name.toLowerCase()];
    if (!uid) continue;
    weekSet.add(getMonday(s.work_date));
  }

  // Insert schedules (one per week, approved, created by admin)
  const [adminRow] = await conn.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
  const adminId = adminRow[0]?.id ?? 1;

  let schedInserted = 0, schedExisted = 0;
  const weekToScheduleId = {};
  for (const weekStart of [...weekSet].sort()) {
    const [existing] = await conn.query('SELECT id FROM schedules WHERE week_start=?', [weekStart]);
    if (existing.length > 0) {
      weekToScheduleId[weekStart] = existing[0].id;
      // Ensure approved status for historical weeks
      await conn.query(`UPDATE schedules SET status='approved' WHERE id=?`, [existing[0].id]);
      schedExisted++;
    } else {
      const [res] = await conn.query(
        `INSERT INTO schedules (week_start, status, created_by) VALUES (?, 'approved', ?)`,
        [weekStart, adminId]
      );
      weekToScheduleId[weekStart] = res.insertId;
      schedInserted++;
    }
  }
  console.log(`Schedules: ${schedInserted} inserted, ${schedExisted} already existed`);

  // Insert schedule_entries
  let entryInserted = 0, entrySkipped = 0, entryUnknownUser = 0;
  for (const s of shifts) {
    if (!workStatuses.has(s.status)) continue;
    const uid = nameMap[s.employee_name.toLowerCase()];
    if (!uid) { entryUnknownUser++; continue; }

    const weekStart = getMonday(s.work_date);
    const schedId = weekToScheduleId[weekStart];
    const customStart = toHHMM(s.start_time);
    const customEnd = toHHMM(s.end_time);
    const notes = s.note || null;

    try {
      await conn.query(
        `INSERT INTO schedule_entries
           (schedule_id, user_id, date, shift_template_id, custom_start, custom_end, notes)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
        [schedId, uid, s.work_date, customStart, customEnd, notes]
      );
      entryInserted++;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') { entrySkipped++; }
      else throw e;
    }
  }
  console.log(`Schedule entries: ${entryInserted} inserted, ${entrySkipped} duplicates skipped, ${entryUnknownUser} unknown users skipped`);

  // --- AVAILABILITY from employee_availability.csv ---
  const avail = parseCSV('employee_availability.csv');
  let availInserted = 0, availUpdated = 0, availUnknown = 0;
  for (const a of avail) {
    const uid = nameMap[a.employee_name.toLowerCase()];
    if (!uid) { availUnknown++; continue; }
    // All OFF/TRIP statuses → 'unavailable'
    const [res] = await conn.query(
      `INSERT INTO availability (user_id, date, status)
       VALUES (?, ?, 'unavailable')
       ON DUPLICATE KEY UPDATE status='unavailable'`,
      [uid, a.availability_date]
    );
    if (res.affectedRows === 1) availInserted++;
    else availUpdated++;
  }
  console.log(`Availability: ${availInserted} inserted, ${availUpdated} updated, ${availUnknown} unknown users skipped`);

  // Summary
  const [[{ sc }]] = await conn.query('SELECT COUNT(*) as sc FROM schedules');
  const [[{ se }]] = await conn.query('SELECT COUNT(*) as se FROM schedule_entries');
  const [[{ av }]] = await conn.query('SELECT COUNT(*) as av FROM availability');
  console.log(`\nFinal counts → schedules: ${sc}, schedule_entries: ${se}, availability: ${av}`);

  await conn.end();
}

run().catch(err => { console.error(err); process.exit(1); });
