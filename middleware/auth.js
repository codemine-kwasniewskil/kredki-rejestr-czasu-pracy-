function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    // super_admin passes all role checks
    if (req.session.userRole === 'super_admin') return next();
    if (!roles.includes(req.session.userRole)) {
      return res.status(403).render('error', { message: 'Brak uprawnień do tej strony.' });
    }
    next();
  };
}

// Returns the active location_id for the current request.
// super_admin uses currentLocationId (switchable); others use their own userLocationId.
function getLocationId(req) {
  if (req.session.userRole === 'super_admin') {
    return req.session.currentLocationId || null;
  }
  return req.session.userLocationId || null;
}

// Blocks access when a feature is disabled for the user's role at their location.
// super_admin always passes. Absence of a feature key in res.locals.features = enabled.
function requireFeature(slug) {
  return (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    if (req.session.userRole === 'super_admin') return next();
    const features = res.locals.features || {};
    if (features[slug] === false) {
      return res.status(403).render('error', {
        message: 'Ta funkcja jest niedostępna dla Twojej roli w tej lokalizacji.',
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, getLocationId, requireFeature };
