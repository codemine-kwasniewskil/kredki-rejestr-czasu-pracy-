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

const sessionStore = new MySQLStore({ createDatabaseTable: true }, db.pool);

app.use(session({
  secret: process.env.SESSION_SECRET || 'kredki-cafe-secret-2024',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.userId
    ? { id: req.session.userId, name: req.session.userName, role: req.session.userRole }
    : null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
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

// Auto-migrations (safe to run on every startup)
(async () => {
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
  } catch (e) {
    console.error('Auto-migration error:', e.message);
  }
})();

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
