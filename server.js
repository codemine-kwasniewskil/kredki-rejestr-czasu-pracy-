const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const path = require('path');
const MySQLStore = require('express-mysql-session')(session);
const db = require('./database/db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Use MySQL session store on Vercel (needed for serverless persistence).
// Use fast in-memory store locally — avoids ~100-200ms Aiven round-trip per request.
const sessionStore = process.env.VERCEL
  ? new MySQLStore({ createDatabaseTable: true }, db.pool)
  : undefined; // express-session MemoryStore (default)

app.use(session({
  secret: process.env.SESSION_SECRET || 'kredki-cafe-secret-2024',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

app.use(flash());

app.use(async (req, res, next) => {
  res.locals.user = req.session.userId
    ? { id: req.session.userId, name: req.session.userName, role: req.session.userRole }
    : null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.features = {};

  if (req.session.userId) {
    const locationId = req.session.userRole === 'super_admin'
      ? req.session.currentLocationId
      : req.session.userLocationId;

    // --- currentLocation: use session cache, fallback to DB once ---
    if (locationId) {
      if (req.session.cachedLocationId === locationId && req.session.cachedLocationName) {
        res.locals.currentLocation = { id: locationId, name: req.session.cachedLocationName };
      } else {
        try {
          const loc = await db.get('SELECT id, name FROM locations WHERE id=?', [locationId]);
          if (loc) {
            res.locals.currentLocation = loc;
            req.session.cachedLocationId = loc.id;
            req.session.cachedLocationName = loc.name;
          } else {
            res.locals.currentLocation = null;
          }
        } catch (_) { res.locals.currentLocation = null; }
      }
    } else {
      res.locals.currentLocation = null;
    }

    // --- allLocations for super_admin switcher: session cache ---
    if (req.session.userRole === 'super_admin') {
      if (req.session.cachedAllLocations) {
        res.locals.allLocations = req.session.cachedAllLocations;
      } else {
        try {
          const locs = await db.all('SELECT id, name FROM locations WHERE active=1 ORDER BY id');
          res.locals.allLocations = locs;
          req.session.cachedAllLocations = locs;
        } catch (_) { res.locals.allLocations = []; }
      }
    }

    // --- pending registrations count for super_admin only ---
    if (req.session.userRole === 'super_admin') {
      try {
        const pr = await db.get('SELECT COUNT(*) as cnt FROM users WHERE registration_pending=1');
        res.locals.pendingRegistrations = pr ? pr.cnt : 0;
      } catch (_) { res.locals.pendingRegistrations = 0; }
    } else {
      res.locals.pendingRegistrations = 0;
    }

    // --- feature flags: session cache, keyed by locationId + role ---
    if (req.session.userRole !== 'super_admin' && locationId) {
      const cacheKey = `${locationId}:${req.session.userRole}`;
      if (req.session.cachedFeaturesKey === cacheKey && req.session.cachedFeatures) {
        res.locals.features = req.session.cachedFeatures;
      } else {
        try {
          const rows = await db.all(
            'SELECT feature, enabled FROM location_features WHERE location_id=? AND role=?',
            [locationId, req.session.userRole]
          );
          const features = {};
          for (const r of rows) if (!r.enabled) features[r.feature] = false;
          res.locals.features = features;
          req.session.cachedFeatures = features;
          req.session.cachedFeaturesKey = cacheKey;
        } catch (_) { res.locals.features = {}; }
      }
    }
  }

  next();
});

// Auto-migrations (safe to run on every startup)
// Stored as a promise so the middleware below can await it on the first request.
const migrationsReady = (async () => {
  try {
    // schedule_comments table
    await db.run(`CREATE TABLE IF NOT EXISTS schedule_comments (
      id INT NOT NULL AUTO_INCREMENT,
      schedule_id INT NOT NULL,
      user_id INT NOT NULL,
      parent_id INT DEFAULT NULL,
      body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES schedule_comments(id) ON DELETE CASCADE
    )`);

    // Make legacy email column nullable so new users don't need it
    try { await db.run(`ALTER TABLE users MODIFY COLUMN email VARCHAR(255) DEFAULT NULL`); } catch(e) {}

    // Unique index on email (allows multiple NULLs in MySQL)
    const emailIdx = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND INDEX_NAME='idx_users_email'`);
    if (!emailIdx || emailIdx.cnt === 0) {
      try { await db.run(`CREATE UNIQUE INDEX idx_users_email ON users (email)`); } catch(e) {}
    }

    // registration_pending: marks self-registered users awaiting admin approval
    const regPendingCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='registration_pending'`);
    if (!regPendingCol || regPendingCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN registration_pending TINYINT(1) DEFAULT 0`);
    }

    // Password reset token columns
    const resetTokenCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='reset_token'`);
    if (!resetTokenCol || resetTokenCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN reset_token VARCHAR(100) DEFAULT NULL`);
      await db.run(`ALTER TABLE users ADD COLUMN reset_token_expires DATETIME DEFAULT NULL`);
    }

    // company_name: cafe/restaurant name provided during self-registration
    const companyNameCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='company_name'`);
    if (!companyNameCol || companyNameCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN company_name VARCHAR(255) DEFAULT NULL`);
    }

    // username column (login identifier, replaces email in UI)
    const umCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='username'`);
    if (!umCol || umCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN username VARCHAR(255)`);
      await db.run(`UPDATE users SET username=email WHERE username IS NULL OR username=''`);
      try { await db.run(`CREATE UNIQUE INDEX idx_users_username ON users (username)`); } catch(e) {}
    }

    // contact_email column (optional, separate from login)
    const ceCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='contact_email'`);
    if (!ceCol || ceCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN contact_email VARCHAR(255)`);
    }

    // phone column (optional)
    const phCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='phone'`);
    if (!phCol || phCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN phone VARCHAR(50)`);
    }

    // availability_month_locks: admin/kierownik can lock a specific month per worker
    await db.run(`CREATE TABLE IF NOT EXISTS availability_month_locks (
      user_id INT NOT NULL,
      \`year_month\` VARCHAR(7) NOT NULL,
      locked_by INT NOT NULL,
      locked TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, \`year_month\`),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE CASCADE
    )`);
    // Add locked column to existing availability_month_locks tables
    const lockedCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='availability_month_locks' AND COLUMN_NAME='locked'`);
    if (!lockedCol || lockedCol.cnt === 0) {
      await db.run(`ALTER TABLE availability_month_locks ADD COLUMN locked TINYINT NOT NULL DEFAULT 1`);
    }

    // ── Stock report tables ────────────────────────────────────────────────
    await db.run(`CREATE TABLE IF NOT EXISTS stock_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      report_type ENUM('daily_morning','biweekly','cakes_noon','products_shift') NOT NULL,
      category VARCHAR(100),
      name VARCHAR(200) NOT NULL,
      unit VARCHAR(50),
      target_qty VARCHAR(100),
      sort_order INT DEFAULT 0,
      active TINYINT DEFAULT 1
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS stock_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      report_date DATE NOT NULL,
      report_type ENUM('daily_morning','biweekly','cakes_noon','products_shift') NOT NULL,
      submitted_by INT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (submitted_by) REFERENCES users(id),
      UNIQUE KEY uq_stock_report (report_date, report_type)
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS stock_report_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      report_id INT NOT NULL,
      item_id INT NOT NULL,
      quantity VARCHAR(200),
      stan_otwarcie VARCHAR(50),
      dostawa VARCHAR(50),
      stan_16 VARCHAR(50),
      stan_zamkniecie VARCHAR(50),
      uszkodzone VARCHAR(50),
      notes VARCHAR(500),
      FOREIGN KEY (report_id) REFERENCES stock_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES stock_items(id),
      UNIQUE KEY uq_stock_entry (report_id, item_id)
    )`);

    // Migrate report_type ENUM → VARCHAR (safe to re-run)
    try { await db.run(`ALTER TABLE stock_items MODIFY COLUMN report_type VARCHAR(100) NOT NULL`); } catch(e) {}
    try { await db.run(`ALTER TABLE stock_reports MODIFY COLUMN report_type VARCHAR(100) NOT NULL`); } catch(e) {}

    // stock_report_types table
    await db.run(`CREATE TABLE IF NOT EXISTS stock_report_types (
      id VARCHAR(100) PRIMARY KEY,
      label VARCHAR(200) NOT NULL,
      icon VARCHAR(20) DEFAULT '📋',
      description TEXT,
      freq VARCHAR(100),
      is_shift_type TINYINT DEFAULT 0,
      sort_order INT DEFAULT 0,
      active TINYINT DEFAULT 1
    )`);

    // min_qty column on stock_items
    const minQtyCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='min_qty'`);
    if (!minQtyCol || minQtyCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_items ADD COLUMN min_qty DECIMAL(10,2) DEFAULT NULL`);
    }

    // hidden_items column on stock_reports (comma-separated item IDs hidden per report)
    const hiCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_reports' AND COLUMN_NAME='hidden_items'`);
    if (!hiCol || hiCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_reports ADD COLUMN hidden_items TEXT DEFAULT NULL`);
    }

    // hopper_qty on stock_report_entries (fraction: 0.25/0.5/0.75/1.0)
    const hopperQtyCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_report_entries' AND COLUMN_NAME='hopper_qty'`);
    if (!hopperQtyCol || hopperQtyCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_report_entries ADD COLUMN hopper_qty DECIMAL(4,2) DEFAULT NULL`);
    }
    // delivery_date on stock_report_entries (cake/cookie shelf-life tracking)
    const deliveryDateCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_report_entries' AND COLUMN_NAME='delivery_date'`);
    if (!deliveryDateCol || deliveryDateCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_report_entries ADD COLUMN delivery_date DATE DEFAULT NULL`);
    }
    // shelf_life_days on stock_items (cake/cookie validity period in days, default 3 in UI)
    const shelfLifeCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='shelf_life_days'`);
    if (!shelfLifeCol || shelfLifeCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_items ADD COLUMN shelf_life_days INT DEFAULT NULL`);
    }
    // hopper_weight on stock_items (full hopper capacity in kg, default 1.2)
    const hopperWeightCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='hopper_weight'`);
    if (!hopperWeightCol || hopperWeightCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_items ADD COLUMN hopper_weight DECIMAL(5,2) DEFAULT 1.2`);
    }
    // hopper_enabled on stock_items (opt-in per item, default 0)
    const hopperEnabledCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='hopper_enabled'`);
    if (!hopperEnabledCol || hopperEnabledCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_items ADD COLUMN hopper_enabled TINYINT DEFAULT 0`);
    }

    // Standalone category/unit catalogs
    await db.run(`CREATE TABLE IF NOT EXISTS stock_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      report_type VARCHAR(100) NOT NULL,
      name VARCHAR(100) NOT NULL,
      UNIQUE KEY uq_stock_cat (report_type, name)
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS stock_units (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      UNIQUE KEY uq_stock_unit (name)
    )`);

    // Seed stock_report_types if empty
    const rtCount = await db.get(`SELECT COUNT(*) as cnt FROM stock_report_types`);
    if (rtCount && rtCount.cnt === 0) {
      const defaultTypes = [
        ['daily_morning','Poranny stan zapasów','☕','Sprawdzić rano każdego dnia – mleko, kawa, lód, kakao','Codziennie rano',0,10],
        ['biweekly','Stan materiałów','📦','Papier, kubki, chemia, worki na śmieci','Środa i Sobota',0,20],
        ['cakes_noon','Stan ciast (12:00)','🎂','Ilość ciast na ladzie ok. godz. 12:00','Codziennie ok. 12:00',0,30],
        ['products_shift','Stan produktów – zmiana','📋','Kanapki i ciasta jednodniowe: otwarcie / 16:00 / zamknięcie','Codziennie 3× dziennie',1,40],
      ];
      for (const [id, label, icon, desc, freq, is_shift, sort] of defaultTypes) {
        await db.run(`INSERT INTO stock_report_types (id,label,icon,description,freq,is_shift_type,sort_order) VALUES (?,?,?,?,?,?,?)`,
          [id, label, icon, desc, freq, is_shift, sort]);
      }
    }

    // ── Multi-location migrations ──────────────────────────────────────────

    // Check if locations table exists (first time running this migration)
    const locTableExists = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='locations'`);
    const isFirstLocationMigration = !locTableExists || locTableExists.cnt === 0;

    if (isFirstLocationMigration) {
      console.log('Running multi-location migration — creating backup first...');
      try {
        const { createBackup } = require('./database/backup');
        const backupFile = await createBackup();
        console.log(`✓ Backup saved: ${backupFile}`);
      } catch (e) {
        console.error('Backup failed (continuing):', e.message);
      }
    }

    // locations table
    await db.run(`CREATE TABLE IF NOT EXISTS locations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(50) UNIQUE NOT NULL,
      address VARCHAR(255),
      active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Seed first location
    await db.run(`INSERT IGNORE INTO locations (id, name, slug) VALUES (1, 'Kredki', 'kredki')`);

    // location_features: per-(location, role, feature) visibility toggles
    await db.run(`CREATE TABLE IF NOT EXISTS location_features (
      location_id INT NOT NULL,
      role        VARCHAR(50) NOT NULL,
      feature     VARCHAR(50) NOT NULL,
      enabled     TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (location_id, role, feature),
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    )`);

    // Add super_admin to role ENUM
    try {
      await db.run(`ALTER TABLE users MODIFY COLUMN role ENUM('super_admin','admin','location_manager','worker') NOT NULL`);
    } catch(e) {}

    // must_change_password column
    const mcpCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='must_change_password'`);
    if (!mcpCol || mcpCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) DEFAULT 0`);
    }

    // sort_order on shift_templates
    const soCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='shift_templates' AND COLUMN_NAME='sort_order'`);
    if (!soCol || soCol.cnt === 0) {
      await db.run(`ALTER TABLE shift_templates ADD COLUMN sort_order INT DEFAULT 0`);
    }

    // confirmed_by_employee on schedule_entries
    const cbeCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schedule_entries' AND COLUMN_NAME='confirmed_by_employee'`);
    if (!cbeCol || cbeCol.cnt === 0) {
      await db.run(`ALTER TABLE schedule_entries ADD COLUMN confirmed_by_employee TINYINT(1) DEFAULT 0`);
    }

    // Add location_id to each table (non-destructive — DEFAULT 1 so existing rows auto-assign)
    const locColMigrations = [
      { table: 'shift_templates', def: 'INT NOT NULL DEFAULT 1' },
      { table: 'schedules', def: 'INT NULL' },
      { table: 'contracts', def: 'INT NOT NULL DEFAULT 1' },
      { table: 'stock_items', def: 'INT NOT NULL DEFAULT 1' },
      { table: 'stock_reports', def: 'INT NOT NULL DEFAULT 1' },
      { table: 'activity_logs', def: 'INT NULL' },
    ];
    for (const m of locColMigrations) {
      const check = await db.get(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='location_id'`,
        [m.table]
      );
      if (!check || check.cnt === 0) {
        await db.run(`ALTER TABLE \`${m.table}\` ADD COLUMN location_id ${m.def}`);
        console.log(`✓ Added location_id to ${m.table}`);
      }
    }

    // users.location_id — nullable so super_admin can have NULL
    const usersLocCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='location_id'`);
    if (!usersLocCol || usersLocCol.cnt === 0) {
      await db.run(`ALTER TABLE users ADD COLUMN location_id INT NULL`);
      console.log('✓ Added location_id to users');
    }

    // Backfill users: existing admins + workers get location_id=1
    await db.run(`UPDATE users SET location_id = 1 WHERE location_id IS NULL AND role != 'super_admin'`);

    // Backfill schedules: set location_id=1 for all existing rows
    await db.run(`UPDATE schedules SET location_id = 1 WHERE location_id IS NULL`);

    // Fix schedules UNIQUE constraint: week_start → (week_start, location_id)
    const schedConstraint = await db.get(
      `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schedules' AND CONSTRAINT_NAME='week_start' AND CONSTRAINT_TYPE='UNIQUE'`
    );
    if (schedConstraint && schedConstraint.cnt > 0) {
      try {
        await db.run(`ALTER TABLE schedules DROP INDEX week_start`);
        await db.run(`ALTER TABLE schedules ADD UNIQUE KEY uq_schedule_week_location (week_start, location_id)`);
        console.log('✓ Fixed schedules UNIQUE constraint to (week_start, location_id)');
      } catch(e) { console.error('Schedules constraint fix:', e.message); }
    }

    // Fix stock_reports UNIQUE constraint: (report_date, report_type) → (report_date, report_type, location_id)
    const stockConstraint = await db.get(
      `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_reports' AND CONSTRAINT_NAME='uq_stock_report' AND CONSTRAINT_TYPE='UNIQUE'`
    );
    if (stockConstraint && stockConstraint.cnt > 0) {
      const stockLocColExists = await db.get(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_reports' AND COLUMN_NAME='location_id'`
      );
      if (stockLocColExists && stockLocColExists.cnt > 0) {
        try {
          await db.run(`ALTER TABLE stock_reports DROP INDEX uq_stock_report`);
          await db.run(`ALTER TABLE stock_reports ADD UNIQUE KEY uq_stock_report_location (report_date, report_type, location_id)`);
          console.log('✓ Fixed stock_reports UNIQUE constraint');
        } catch(e) { console.error('Stock reports constraint fix:', e.message); }
      }
    }

    // Finance tables: add location_id if they exist
    const financeTablesWithLoc = ['bank_import_files', 'bank_transactions', 'financial_events', 'payroll_costs'];
    for (const tbl of financeTablesWithLoc) {
      const tblExists = await db.get(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [tbl]
      );
      if (!tblExists || tblExists.cnt === 0) continue;
      const colExists = await db.get(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME='location_id'`, [tbl]
      );
      if (!colExists || colExists.cnt === 0) {
        await db.run(`ALTER TABLE \`${tbl}\` ADD COLUMN location_id INT NOT NULL DEFAULT 1`);
        console.log(`✓ Added location_id to ${tbl}`);
      }
    }

    // Seed stock_items if empty
    const stockItemCount = await db.get(`SELECT COUNT(*) as cnt FROM stock_items`);
    if (stockItemCount && stockItemCount.cnt === 0) {
      const seedItems = [
        // daily_morning – Mleko
        ['daily_morning','Mleko','Mleko Zwykłe','l','~4 l',10],
        ['daily_morning','Mleko','Mleko Bez Laktozy','l','~6.5 l',20],
        ['daily_morning','Mleko','Mleko Owsiane','l','~38 l',30],
        ['daily_morning','Mleko','Mleko Kokosowe (0.75l)','szt','~17 szt',40],
        ['daily_morning','Mleko','Mleko Grochowe','l','~22.5 l',50],
        ['daily_morning','Mleko','Śmietanka (0.5l)','op','~5.5 op',60],
        ['daily_morning','Mleko','Śmietanka Vege','l','~3 l',70],
        ['daily_morning','Mleko','Masala','l','~9 l',80],
        ['daily_morning','Napoje','Tonic Classic','l','~19.5 l',90],
        ['daily_morning','Napoje','Tonic Zero','l','~12.5 l',100],
        ['daily_morning','Kawa','Espresso Classic','kg','~1 kg + hopper',110],
        ['daily_morning','Kawa','Espresso Kredki','kg','~0.5 kg + hopper',120],
        ['daily_morning','Kawa','Szybki Classic (Eth Abeba)','kg','~1.06 kg',130],
        ['daily_morning','Kawa','Szybki Kredki (Rwanda)','kg','~0.93 kg',140],
        ['daily_morning','Kawa','ICE (Kenya)','kg','~2.42 kg',150],
        ['daily_morning','Kawa','Ręczny DAK','szt','~12 szt',160],
        ['daily_morning','Kawa','Ręczny Tanat','szt','~6 szt',170],
        ['daily_morning','Kawa','Ręczny Sheep&Raven','szt','~6 szt',180],
        ['daily_morning','Kawa','Decaf','kg','~0.8 kg',190],
        ['daily_morning','Inne','Lód','worki','~2 worki',200],
        ['daily_morning','Inne','Kakao','kg','~3 kg',210],
        ['daily_morning','Inne','Cytryna 🍋','szt','~2 szt',220],
        ['daily_morning','Inne','Limonka','szt','~2 szt',230],
        ['biweekly','Papier i higiena','Ręczniki papierowe','szt','~24 szt',10],
        ['biweekly','Papier i higiena','Papier toaletowy','szt','~86 szt',20],
        ['biweekly','Papier i higiena','Ręczniki ZZ','szt','~36+ szt',30],
        ['biweekly','Kubki i opakowania','Kubki duże','op','~21 op',40],
        ['biweekly','Kubki i opakowania','Kubki małe','op','~20 op',50],
        ['biweekly','Kubki i opakowania','Przykrywki kubki duże','op','~4+ op',60],
        ['biweekly','Kubki i opakowania','Przykrywki kubki małe','op','~5 op',70],
        ['biweekly','Kubki i opakowania','Kubki plastikowe','op','~10 op',80],
        ['biweekly','Kubki i opakowania','Przykrywki plastikowe','op','~4 op',90],
        ['biweekly','Kubki i opakowania','Słomki','op','~2+ op',100],
        ['biweekly','Kubki i opakowania','Mieszadełka','op','~2 op',110],
        ['biweekly','Kubki i opakowania','Pudełka na ciasta duże','szt','~100 szt',120],
        ['biweekly','Kubki i opakowania','Pudełka na ciasta małe','szt','~100 szt',130],
        ['biweekly','Kubki i opakowania','Saszetki papierowe na ciacho','szt','~1000 szt',140],
        ['biweekly','Kubki i opakowania','Torebki papierowe na kanapki','szt','~2000 szt',150],
        ['biweekly','Kubki i opakowania','Serwetki','op','~12+ op',160],
        ['biweekly','Kubki i opakowania','Jednorazowe rękawiczki','szt','~2000 szt',170],
        ['biweekly','Kubki i opakowania','Torby papierowe duże','-','dużo',180],
        ['biweekly','Kubki i opakowania','Torby papierowe małe','-','dużo',190],
        ['biweekly','Kubki i opakowania','Widelczyki jednorazowe','op','~1+ op',200],
        ['biweekly','Kubki i opakowania','Talerzyki papierowe','op','~1 op',210],
        ['biweekly','Kubki i opakowania','Podstawki na dwie kawy','-','dużo',220],
        ['biweekly','Kubki i opakowania','Cukier trzcinowy','-','dużo',225],
        ['biweekly','Chemia i sprzątanie','Mydło dla gości','op','~1 op',230],
        ['biweekly','Chemia i sprzątanie','Patyczki zapachowe do łazienki','szt','~1.5 szt',240],
        ['biweekly','Chemia i sprzątanie','Cafiza ⚠️','op','~1 op',250],
        ['biweekly','Chemia i sprzątanie','Rinza ⚠️','op','~1 op',260],
        ['biweekly','Chemia i sprzątanie','Odkamieniacz','op','~1+ op',270],
        ['biweekly','Chemia i sprzątanie','Clin (do szyb)','szt','~4 szt',280],
        ['biweekly','Chemia i sprzątanie','Uniwersalny płyn','l','~2.5 l',290],
        ['biweekly','Chemia i sprzątanie','Pronto','l','~2.5 l',300],
        ['biweekly','Chemia i sprzątanie','Domestos ⚠️','op','~0.5 op',310],
        ['biweekly','Chemia i sprzątanie','Płyn do naczyń','l','~2.5 l',320],
        ['biweekly','Chemia i sprzątanie','Płyn do mycia podłogi','op','~3 op',330],
        ['biweekly','Chemia i sprzątanie','Mydło do rąk','l','~4 l',340],
        ['biweekly','Chemia i sprzątanie','Rękawiczki grube','par','~5 par',350],
        ['biweekly','Chemia i sprzątanie','Gąbki','szt','~5 szt',360],
        ['biweekly','Chemia i sprzątanie','Mopy','szt','~10 szt',370],
        ['biweekly','Worki na śmieci','Worki 80L','op','~2.5 op',380],
        ['biweekly','Worki na śmieci','Worki 60L','op','~2.5 op',390],
        ['biweekly','Worki na śmieci','Worki BIO','op','~2.5 op',400],
        ['cakes_noon',null,'Baskijski','szt',null,10],
        ['cakes_noon',null,'Banofee','szt',null,20],
        ['cakes_noon',null,'Cherry pie','szt',null,30],
        ['cakes_noon',null,'Ciasto matcha','szt',null,40],
        ['cakes_noon',null,'Ciasto Ruby','szt',null,50],
        ['cakes_noon',null,'Ciastko chocolate chip','szt',null,60],
        ['products_shift','Kanapki','Kanapka z serk. szcz. i jajkiem','szt',null,10],
        ['products_shift','Kanapki','Kanapka z twarogiem ziołowym','szt',null,20],
        ['products_shift','Kanapki','Kanapka z szynką Cotto','szt',null,30],
        ['products_shift','Kanapki','Kanapka pesto','szt',null,40],
        ['products_shift','Kanapki','Kanapka hummus','szt',null,50],
        ['products_shift','Ciasta jednodniowe','Ciastko chocolate chip','szt',null,60],
        ['products_shift','Ciasta jednodniowe','Ciasto matcha','szt',null,70],
        ['products_shift','Ciasta jednodniowe','Ciasto Ruby','szt',null,80],
        ['products_shift','Ciasta jednodniowe','Croissant z maliną','szt',null,90],
        ['products_shift','Ciasta jednodniowe','Croissant z kremem pistacjowym','szt',null,100],
        ['products_shift','Ciasta jednodniowe','Pain au chocolate','szt',null,110],
        ['products_shift','Ciasta jednodniowe','Gallette','szt',null,120],
        ['products_shift','Ciasta jednodniowe','Cynamonka','szt',null,130],
        ['products_shift','Ciasta jednodniowe','Banofee','szt',null,140],
        ['products_shift','Ciasta jednodniowe','Danish z truskawką','szt',null,150],
        ['products_shift','Ciasta jednodniowe','Mini canoli','szt',null,160],
        ['products_shift','Ciasta jednodniowe','Mini croissant','szt',null,170],
        ['products_shift','Ciasta jednodniowe','Tiramisú','szt',null,180],
        ['products_shift','Ciasta jednodniowe','Finansier','szt',null,190],
        ['products_shift','Ciasta jednodniowe','Tarta cytrynowa','szt',null,200],
        ['products_shift','Ciasta jednodniowe','Cherry pie','szt',null,210],
        ['products_shift','Ciasta jednodniowe','Baskijski','szt',null,220],
      ];
      for (const [rt, cat, name, unit, tq, so] of seedItems) {
        await db.run(
          `INSERT INTO stock_items (report_type, category, name, unit, target_qty, sort_order) VALUES (?,?,?,?,?,?)`,
          [rt, cat, name, unit, tq, so]
        );
      }
    }

    // Initialize sort_order for existing templates (only when all are 0)
    const sortCheck = await db.get('SELECT COUNT(*) as cnt FROM shift_templates WHERE sort_order > 0');
    if (sortCheck && sortCheck.cnt === 0) {
      const tpls = await db.all('SELECT id FROM shift_templates ORDER BY start_time');
      for (let i = 0; i < tpls.length; i++) {
        await db.run('UPDATE shift_templates SET sort_order=? WHERE id=?', [i, tpls[i].id]);
      }
      if (tpls.length) console.log('✓ Initialized shift_templates sort_order');
    }

    // ── Ordering / procurement ─────────────────────────────────────────────

    // vendor_product_key: links a stock item to the supplier's SKU
    const vpkCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='vendor_product_key'`);
    if (!vpkCol || vpkCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_items ADD COLUMN vendor_product_key VARCHAR(100) DEFAULT NULL`);
      console.log('✓ Added vendor_product_key to stock_items');
    }

    await db.run(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      location_id INT NOT NULL,
      status ENUM('draft','pending_approval','approved','rejected','placed') DEFAULT 'draft',
      total_netto DECIMAL(10,2) DEFAULT 0,
      created_by INT NOT NULL,
      approved_by INT DEFAULT NULL,
      reject_reason VARCHAR(500) DEFAULT NULL,
      vendor_order_id VARCHAR(200) DEFAULT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id),
      FOREIGN KEY (created_by) REFERENCES users(id),
      FOREIGN KEY (approved_by) REFERENCES users(id)
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      stock_item_id INT DEFAULT NULL,
      vendor_product_key VARCHAR(100),
      product_name VARCHAR(200) NOT NULL,
      unit VARCHAR(50),
      quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
      unit_price_netto DECIMAL(10,2) DEFAULT NULL,
      total_netto DECIMAL(10,2) DEFAULT NULL,
      FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE SET NULL
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS order_settings (
      location_id INT PRIMARY KEY,
      min_order_value DECIMAL(10,2) DEFAULT 500.00,
      FOREIGN KEY (location_id) REFERENCES locations(id)
    )`);

    // Per-location vendor API credentials
    const vcidCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_settings' AND COLUMN_NAME='vendor_client_id'`);
    if (!vcidCol || vcidCol.cnt === 0) {
      await db.run(`ALTER TABLE order_settings ADD COLUMN vendor_client_id VARCHAR(50) DEFAULT NULL`);
      await db.run(`ALTER TABLE order_settings ADD COLUMN vendor_api_key VARCHAR(200) DEFAULT NULL`);
      // Seed Kredki (location 1) with default credentials
      await db.run(
        `INSERT INTO order_settings (location_id, min_order_value, vendor_client_id, vendor_api_key)
         VALUES (1, 500.00, ?, ?)
         ON DUPLICATE KEY UPDATE
           vendor_client_id = COALESCE(vendor_client_id, VALUES(vendor_client_id)),
           vendor_api_key   = COALESCE(vendor_api_key,   VALUES(vendor_api_key))`,
        [process.env.VENDOR_CLIENT_ID || '17456', process.env.VENDOR_API_KEY || '1186D3D1-0CD9-45BB-9FE0-0C398D22694D']
      );
    }

    // Disable 'orders' feature for all non-Kredki locations (only on first run — no rows yet)
    const ordersFeatureCount = await db.get(`SELECT COUNT(*) as cnt FROM location_features WHERE feature='orders'`);
    if (ordersFeatureCount && ordersFeatureCount.cnt === 0) {
      await db.run(
        `INSERT IGNORE INTO location_features (location_id, role, feature, enabled)
         SELECT l.id, r.role, 'orders', 0
         FROM locations l
         JOIN (SELECT 'admin' AS role UNION SELECT 'location_manager' UNION SELECT 'worker') r
         WHERE l.id != 1`
      );
    }

  } catch (e) {
    console.error('Auto-migration error:', e.message);
  }

  // ── Vendors table (independent — runs even if earlier migrations threw) ───
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS vendors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      location_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(50) NOT NULL,
      api_type VARCHAR(50) DEFAULT 'manual',
      client_id VARCHAR(100) DEFAULT NULL,
      api_key VARCHAR(200) DEFAULT NULL,
      website VARCHAR(255) DEFAULT NULL,
      active TINYINT DEFAULT 1,
      sort_order INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
      UNIQUE KEY uq_vendor_slug_loc (location_id, slug)
    )`);
    console.log('✓ vendors table ready');
  } catch (e) {
    console.error('Vendors table migration error:', e.message);
  }

  // ── Seed Inter-Mlecz (independent) ────────────────────────────────────────
  try {
    const existingIM = await db.get(`SELECT id FROM vendors WHERE location_id=1 AND slug='intermlecz'`);
    if (!existingIM) {
      const os = await db.get(`SELECT vendor_client_id, vendor_api_key FROM order_settings WHERE location_id=1`).catch(() => null);
      await db.run(
        `INSERT IGNORE INTO vendors (location_id, name, slug, api_type, client_id, api_key, sort_order)
         VALUES (1, 'Inter-Mlecz', 'intermlecz', 'intermlecz', ?, ?, 0)`,
        [os?.vendor_client_id || process.env.VENDOR_CLIENT_ID || '17456',
         os?.vendor_api_key   || process.env.VENDOR_API_KEY   || '1186D3D1-0CD9-45BB-9FE0-0C398D22694D']
      );
      console.log('✓ Seeded Inter-Mlecz vendor');
    }
  } catch (e) {
    console.error('Inter-Mlecz seed error:', e.message);
  }

  // ── vendor_id column on stock_items (independent) ─────────────────────────
  try {
    const vendorIdCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='vendor_id'`);
    if (!vendorIdCol || vendorIdCol.cnt === 0) {
      await db.run(`ALTER TABLE stock_items ADD COLUMN vendor_id INT DEFAULT NULL`);
      console.log('✓ Added vendor_id to stock_items');
      // Best-effort auto-assign Inter-Mlecz to items with existing SKU
      await db.run(
        `UPDATE stock_items si
         JOIN vendors v ON v.location_id = si.location_id AND v.slug = 'intermlecz'
         SET si.vendor_id = v.id
         WHERE si.vendor_product_key IS NOT NULL AND si.vendor_product_key != ''`
      ).catch(e => console.error('vendor_id backfill error:', e.message));
    }
  } catch (e) {
    console.error('vendor_id column migration error:', e.message);
  }

  // ── min_order_value on vendors ────────────────────────────────────────────
  try {
    const minCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='vendors' AND COLUMN_NAME='min_order_value'`);
    if (!minCol || minCol.cnt === 0) {
      await db.run(`ALTER TABLE vendors ADD COLUMN min_order_value DECIMAL(10,2) DEFAULT NULL`);
      console.log('✓ Added min_order_value to vendors');
    }
  } catch (e) {
    console.error('min_order_value on vendors migration error:', e.message);
  }

  // ── vendor_id on purchase_orders ──────────────────────────────────────────
  try {
    const vidOnPO = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_orders' AND COLUMN_NAME='vendor_id'`);
    if (!vidOnPO || vidOnPO.cnt === 0) {
      await db.run(`ALTER TABLE purchase_orders ADD COLUMN vendor_id INT DEFAULT NULL`);
      try {
        await db.run(`ALTER TABLE purchase_orders ADD CONSTRAINT fk_po_vendor FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL`);
      } catch (_) {}
      console.log('✓ Added vendor_id to purchase_orders');
    }
  } catch (e) {
    console.error('vendor_id on purchase_orders migration error:', e.message);
  }

  // ── delivery / payment fields on purchase_orders ──────────────────────────
  const poExtraCols = [
    { col: 'delivery_date',    ddl: 'DATE DEFAULT NULL' },
    { col: 'delivery_address', ddl: 'VARCHAR(500) DEFAULT NULL' },
    { col: 'payment_method',   ddl: "VARCHAR(100) DEFAULT NULL" },
    { col: 'own_order_number', ddl: 'VARCHAR(100) DEFAULT NULL' },
    { col: 'vendor_order_status',     ddl: 'VARCHAR(200) DEFAULT NULL' },
    { col: 'vendor_order_paid',       ddl: 'TINYINT(1) DEFAULT NULL' },
    { col: 'vendor_status_synced_at', ddl: 'DATETIME DEFAULT NULL' },
  ];
  for (const { col, ddl } of poExtraCols) {
    try {
      const r = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_orders' AND COLUMN_NAME=?`, [col]);
      if (!r || r.cnt === 0) {
        await db.run(`ALTER TABLE purchase_orders ADD COLUMN ${col} ${ddl}`);
        console.log(`✓ Added ${col} to purchase_orders`);
      }
    } catch (e) {
      console.error(`${col} migration error:`, e.message);
    }
  }

  // ── vendor_basket_id on purchase_orders ──────────────────────────────────
  try {
    const vbidCol = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_orders' AND COLUMN_NAME='vendor_basket_id'`);
    if (!vbidCol || vbidCol.cnt === 0) {
      await db.run(`ALTER TABLE purchase_orders ADD COLUMN vendor_basket_id VARCHAR(200) DEFAULT NULL`);
      console.log('✓ Added vendor_basket_id to purchase_orders');
    }
  } catch (e) {
    console.error('vendor_basket_id migration error:', e.message);
  }

  // ── basket_created status in purchase_orders ENUM ─────────────────────────
  try {
    const bcEnum = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='purchase_orders' AND COLUMN_NAME='status' AND COLUMN_TYPE LIKE '%basket_created%'`);
    if (!bcEnum || bcEnum.cnt === 0) {
      await db.run(`ALTER TABLE purchase_orders MODIFY COLUMN status ENUM('draft','pending_approval','approved','rejected','placed','basket_created') DEFAULT 'draft'`);
      console.log('✓ Added basket_created to purchase_orders status ENUM');
    }
  } catch (e) {
    console.error('basket_created ENUM migration error:', e.message);
  }

  // ── deliveries table ──────────────────────────────────────────────────────
  await db.run(`CREATE TABLE IF NOT EXISTS deliveries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    location_id INT NOT NULL,
    delivered_at DATE NOT NULL,
    supplier VARCHAR(200) DEFAULT NULL,
    category VARCHAR(100) DEFAULT NULL,
    description TEXT NOT NULL,
    quantity VARCHAR(100) DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    created_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_deliveries_location_date (location_id, delivered_at)
  )`);

  // ── design_sales table (Kredki only) ──────────────────────────────────────
  await db.run(`CREATE TABLE IF NOT EXISTS design_sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    location_id INT NOT NULL,
    sold_at DATE NOT NULL,
    brand VARCHAR(200) DEFAULT NULL,
    color VARCHAR(100) DEFAULT NULL,
    quantity INT DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    created_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_design_sales_location_date (location_id, sold_at)
  )`);

  // Restrict 'designsales' to Kredki (location 1): disable for everyone elsewhere (first run only)
  const designSalesFeatureCount = await db.get(`SELECT COUNT(*) as cnt FROM location_features WHERE feature='designsales'`);
  if (designSalesFeatureCount && designSalesFeatureCount.cnt === 0) {
    await db.run(
      `INSERT IGNORE INTO location_features (location_id, role, feature, enabled)
       SELECT l.id, r.role, 'designsales', 0
       FROM locations l
       JOIN (SELECT 'admin' AS role UNION SELECT 'location_manager' UNION SELECT 'worker') r
       WHERE l.id != 1`
    );
  }

  // ── cafe address fields on order_settings ─────────────────────────────────
  const osCols = [
    { col: 'cafe_address',      ddl: 'VARCHAR(500) DEFAULT NULL' },
    { col: 'cafe_name',         ddl: 'VARCHAR(200) DEFAULT NULL' },
    { col: 'cafe_street',       ddl: 'VARCHAR(200) DEFAULT NULL' },
    { col: 'cafe_house_number', ddl: 'VARCHAR(20) DEFAULT NULL' },
    { col: 'cafe_postal_code',  ddl: 'VARCHAR(10) DEFAULT NULL' },
    { col: 'cafe_city',         ddl: 'VARCHAR(100) DEFAULT NULL' },
    { col: 'cafe_country_id',   ddl: 'INT DEFAULT 1' },
    { col: 'cafe_phone',        ddl: 'VARCHAR(50) DEFAULT NULL' },
    { col: 'cafe_email',        ddl: 'VARCHAR(200) DEFAULT NULL' },
    { col: 'cafe_address_id',    ddl: 'INT DEFAULT NULL' },
    { col: 'cafe_delivery_name', ddl: 'VARCHAR(200) DEFAULT NULL' },
    { col: 'cafe_payment_name',  ddl: 'VARCHAR(200) DEFAULT NULL' },
    { col: 'cafe_payment_id',    ddl: 'INT DEFAULT NULL' },
  ];
  for (const { col, ddl } of osCols) {
    try {
      const r = await db.get(`SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_settings' AND COLUMN_NAME=?`, [col]);
      if (!r || r.cnt === 0) {
        await db.run(`ALTER TABLE order_settings ADD COLUMN ${col} ${ddl}`);
        console.log(`✓ Added ${col} to order_settings`);
      }
    } catch (e) {
      console.error(`${col} migration error:`, e.message);
    }
  }
})();

// Gate: wait for migrations before handling any route on the first cold-start request.
// On Vercel serverless, the IIFE above is async and can still be running when
// the first HTTP request arrives. Awaiting the promise here ensures all ALTER TABLEs
// have completed before any route handler can access the DB.
app.use(async (req, res, next) => {
  try { await migrationsReady; } catch (_) {}
  next();
});

app.use('/', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/schedule', require('./routes/schedule'));
app.use('/shifts', require('./routes/shifts'));
app.use('/availability', require('./routes/availability'));
app.use('/contracts', require('./routes/contracts'));
app.use('/api', require('./routes/api'));
app.use('/logs', require('./routes/logs'));
app.use('/reports', require('./routes/reports'));
app.use('/finance', require('./routes/finance'));
app.use('/stock', require('./routes/stock'));
app.use('/orders', require('./routes/orders'));
app.use('/deliveries', require('./routes/deliveries'));
app.use('/design-sales', require('./routes/designsales'));
app.use('/locations', require('./routes/locations'));

app.use((req, res) => res.status(404).render('error', { message: 'Strona nie istnieje.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Błąd serwera.' });
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Kafejka Manager → http://localhost:${PORT}`));
}

module.exports = app;
