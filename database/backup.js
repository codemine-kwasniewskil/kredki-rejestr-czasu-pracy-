const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function createBackup() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
    dateStrings: true,
  });

  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = path.join(backupDir, `backup_${timestamp}.sql`);

  const [tables] = await conn.query('SHOW TABLES');
  const tableNames = tables.map(t => Object.values(t)[0]);

  const lines = [`-- Kredki DB Backup — ${new Date().toISOString()}`, ''];

  for (const table of tableNames) {
    const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
    if (!rows.length) continue;
    lines.push(`-- Table: ${table}`);
    for (const row of rows) {
      const vals = Object.values(row).map(v => {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return v;
        return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
      });
      lines.push(`INSERT INTO \`${table}\` VALUES (${vals.join(', ')});`);
    }
    lines.push('');
  }

  fs.writeFileSync(backupFile, lines.join('\n'), 'utf8');
  await conn.end();
  return backupFile;
}

module.exports = { createBackup };
