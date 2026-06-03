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
app.use('/stock', require('./routes/stock'));

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

    // Seed items if empty
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
        // daily_morning – Napoje
        ['daily_morning','Napoje','Tonic Classic','l','~19.5 l',90],
        ['daily_morning','Napoje','Tonic Zero','l','~12.5 l',100],
        // daily_morning – Kawa
        ['daily_morning','Kawa','Espresso Classic','kg','~1 kg + hopper',110],
        ['daily_morning','Kawa','Espresso Kredki','kg','~0.5 kg + hopper',120],
        ['daily_morning','Kawa','Szybki Classic (Eth Abeba)','kg','~1.06 kg',130],
        ['daily_morning','Kawa','Szybki Kredki (Rwanda)','kg','~0.93 kg',140],
        ['daily_morning','Kawa','ICE (Kenya)','kg','~2.42 kg',150],
        ['daily_morning','Kawa','Ręczny DAK','szt','~12 szt',160],
        ['daily_morning','Kawa','Ręczny Tanat','szt','~6 szt',170],
        ['daily_morning','Kawa','Ręczny Sheep&Raven','szt','~6 szt',180],
        ['daily_morning','Kawa','Decaf','kg','~0.8 kg',190],
        // daily_morning – Inne
        ['daily_morning','Inne','Lód','worki','~2 worki',200],
        ['daily_morning','Inne','Kakao','kg','~3 kg',210],
        ['daily_morning','Inne','Cytryna 🍋','szt','~2 szt',220],
        ['daily_morning','Inne','Limonka','szt','~2 szt',230],
        // biweekly – Papier i higiena
        ['biweekly','Papier i higiena','Ręczniki papierowe','szt','~24 szt',10],
        ['biweekly','Papier i higiena','Papier toaletowy','szt','~86 szt',20],
        ['biweekly','Papier i higiena','Ręczniki ZZ','szt','~36+ szt',30],
        // biweekly – Kubki i opakowania
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
        // biweekly – Chemia i sprzątanie
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
        // biweekly – Worki na śmieci
        ['biweekly','Worki na śmieci','Worki 80L','op','~2.5 op',380],
        ['biweekly','Worki na śmieci','Worki 60L','op','~2.5 op',390],
        ['biweekly','Worki na śmieci','Worki BIO','op','~2.5 op',400],
        // cakes_noon
        ['cakes_noon',null,'Baskijski','szt',null,10],
        ['cakes_noon',null,'Banofee','szt',null,20],
        ['cakes_noon',null,'Cherry pie','szt',null,30],
        ['cakes_noon',null,'Ciasto matcha','szt',null,40],
        ['cakes_noon',null,'Ciasto Ruby','szt',null,50],
        ['cakes_noon',null,'Ciastko chocolate chip','szt',null,60],
        // products_shift – Kanapki
        ['products_shift','Kanapki','Kanapka z serk. szcz. i jajkiem','szt',null,10],
        ['products_shift','Kanapki','Kanapka z twarogiem ziołowym','szt',null,20],
        ['products_shift','Kanapki','Kanapka z szynką Cotto','szt',null,30],
        ['products_shift','Kanapki','Kanapka pesto','szt',null,40],
        ['products_shift','Kanapki','Kanapka hummus','szt',null,50],
        // products_shift – Ciasta jednodniowe
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
