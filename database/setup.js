// Run once to create tables in Aiven MySQL: node database/setup.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function setup() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });

  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT NOT NULL AUTO_INCREMENT,
      name TEXT NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role ENUM('admin','location_manager','worker') NOT NULL,
      active TINYINT(1) DEFAULT 1,
      availability_locked TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )`,
    `CREATE TABLE IF NOT EXISTS contracts (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      min_hours_per_month DOUBLE NOT NULL DEFAULT 0,
      hourly_rate DOUBLE,
      start_date DATE NOT NULL,
      end_date DATE,
      active TINYINT(1) DEFAULT 1,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS shift_templates (
      id INT NOT NULL AUTO_INCREMENT,
      name TEXT NOT NULL,
      start_time VARCHAR(5) NOT NULL,
      end_time VARCHAR(5) NOT NULL,
      color VARCHAR(7) DEFAULT '#3B82F6',
      active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )`,
    `CREATE TABLE IF NOT EXISTS schedules (
      id INT NOT NULL AUTO_INCREMENT,
      week_start DATE NOT NULL UNIQUE,
      status ENUM('draft','submitted','approved','rejected') DEFAULT 'draft',
      created_by INT,
      approved_by INT,
      rejection_notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (approved_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS schedule_entries (
      id INT NOT NULL AUTO_INCREMENT,
      schedule_id INT NOT NULL,
      user_id INT NOT NULL,
      date DATE NOT NULL,
      shift_template_id INT,
      custom_start VARCHAR(5),
      custom_end VARCHAR(5),
      notes TEXT,
      modified_by_admin TINYINT(1) DEFAULT 0,
      modified_by_user_id INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_schedule_user_date (schedule_id, user_id, date),
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (shift_template_id) REFERENCES shift_templates(id)
    )`,
    `CREATE TABLE IF NOT EXISTS availability (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      date DATE NOT NULL,
      status ENUM('available','unavailable') NOT NULL,
      start_time VARCHAR(5),
      end_time VARCHAR(5),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_date (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS activity_logs (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT,
      user_name VARCHAR(255) NOT NULL,
      user_role VARCHAR(50) NOT NULL,
      action VARCHAR(255) NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )`,
  ];

  for (const sql of tables) {
    await conn.query(sql);
  }
  console.log('✓ All tables created/verified');

  const [rows] = await conn.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
  if (rows.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await conn.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)`,
      ['Administrator', 'admin@cafe.com', hash, 'admin']
    );
    const templates = [
      ['Zmiana 1 (Rano)', '07:00', '15:00', '#3B82F6'],
      ['Zmiana 2 (Popołudnie)', '12:00', '19:00', '#8B5CF6'],
      ['Zmiana 3 (Krótka)', '11:00', '15:00', '#10B981'],
      ['Zmiana 4 (Wieczór)', '15:00', '23:00', '#F59E0B'],
    ];
    for (const [name, start, end, color] of templates) {
      await conn.query(
        `INSERT INTO shift_templates (name, start_time, end_time, color) VALUES (?,?,?,?)`,
        [name, start, end, color]
      );
    }
    console.log('✓ Default admin and shift templates created');
    console.log('  Login: admin@cafe.com / admin123');
  } else {
    console.log('✓ Admin already exists, skipping seed');
  }

  await conn.end();
  console.log('\nSetup complete!');
}

setup().catch(err => { console.error(err); process.exit(1); });
