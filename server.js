const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const path = require('path');
const db = require('./database/db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'kredki-cafe-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: process.env.VERCEL ? true : false, sameSite: 'lax' }
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
