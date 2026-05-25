function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    if (!roles.includes(req.session.userRole)) {
      return res.status(403).render('error', { message: 'Brak uprawnień do tej strony.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
