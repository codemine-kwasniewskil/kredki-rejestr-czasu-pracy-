const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireRole } = require('../middleware/auth');
const { log } = require('../utils/logger');

const FEATURES = [
  { slug: 'schedule',     label: 'Grafik' },
  { slug: 'availability', label: 'Dostępność' },
  { slug: 'stock',        label: 'Raport Stanów' },
  { slug: 'reports',      label: 'Raporty' },
  { slug: 'shifts',       label: 'Szablony zmian' },
  { slug: 'contracts',    label: 'Umowy' },
  { slug: 'users',        label: 'Użytkownicy' },
  { slug: 'logs',         label: 'Logi aktywności' },
  { slug: 'finance',      label: 'Finanse' },
];

const ROLES = [
  { key: 'admin',            label: 'Administrator' },
  { key: 'location_manager', label: 'Kierownik' },
  { key: 'worker',           label: 'Pracownik' },
];

// Only super_admin can manage locations
router.use(requireRole('super_admin'));

router.get('/', async (req, res) => {
  try {
    const locations = await db.all(`
      SELECT l.*, COUNT(u.id) AS user_count
      FROM locations l
      LEFT JOIN users u ON u.location_id = l.id AND u.active = 1
      GROUP BY l.id
      ORDER BY l.id
    `);
    res.render('locations/index', { locations });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, slug, address } = req.body;
    if (!name || !slug) {
      req.flash('error', 'Nazwa i slug są wymagane.');
      return res.redirect('/locations');
    }
    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const existing = await db.get('SELECT id FROM locations WHERE slug=?', [cleanSlug]);
    if (existing) {
      req.flash('error', 'Ten slug jest już zajęty.');
      return res.redirect('/locations');
    }
    await db.run(
      `INSERT INTO locations (name, slug, address) VALUES (?,?,?)`,
      [name.trim(), cleanSlug, address ? address.trim() : null]
    );
    // Invalidate allLocations cache so switcher updates
    delete req.session.cachedAllLocations;
    log(res.locals.user, 'Dodanie lokalizacji', name.trim());
    req.flash('success', `Lokalizacja "${name.trim()}" dodana.`);
    res.redirect('/locations');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, address, active } = req.body;
    if (!name) {
      req.flash('error', 'Nazwa jest wymagana.');
      return res.redirect('/locations');
    }
    await db.run(
      `UPDATE locations SET name=?, address=?, active=? WHERE id=?`,
      [name.trim(), address ? address.trim() : null, active ? 1 : 0, req.params.id]
    );
    // Invalidate caches (name/list may have changed)
    delete req.session.cachedAllLocations;
    delete req.session.cachedLocationName;
    delete req.session.cachedLocationId;
    log(res.locals.user, 'Edycja lokalizacji', name.trim());
    req.flash('success', 'Lokalizacja zaktualizowana.');
    res.redirect('/locations');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// Switch the active location context for super_admin
router.post('/switch', async (req, res) => {
  try {
    const locationId = parseInt(req.body.locationId, 10);
    if (locationId) {
      const loc = await db.get('SELECT id, name FROM locations WHERE id=? AND active=1', [locationId]);
      if (loc) {
        req.session.currentLocationId = loc.id;
        // Update location name cache for the switched location
        req.session.cachedLocationId = loc.id;
        req.session.cachedLocationName = loc.name;
        // Clear features cache so it reloads for new location (not relevant for super_admin but clean)
        delete req.session.cachedFeatures;
        delete req.session.cachedFeaturesKey;
      }
    }
    const referer = req.get('Referer') || '/dashboard';
    res.redirect(referer);
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

// Feature visibility management for a location
router.get('/:id/features', async (req, res) => {
  try {
    const location = await db.get('SELECT * FROM locations WHERE id=?', [req.params.id]);
    if (!location) return res.status(404).render('error', { message: 'Lokalizacja nie istnieje.' });

    // Load all saved feature rows for this location
    const rows = await db.all(
      'SELECT role, feature, enabled FROM location_features WHERE location_id=?',
      [req.params.id]
    );
    // Build a lookup: featureEnabled[role][feature] = boolean
    const featureEnabled = {};
    for (const { role, feature, enabled } of rows) {
      if (!featureEnabled[role]) featureEnabled[role] = {};
      featureEnabled[role][feature] = !!enabled;
    }

    res.render('locations/features', { location, features: FEATURES, roles: ROLES, featureEnabled });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

router.post('/:id/features', async (req, res) => {
  try {
    const locationId = parseInt(req.params.id, 10);
    const location = await db.get('SELECT name FROM locations WHERE id=?', [locationId]);
    if (!location) return res.status(404).render('error', { message: 'Lokalizacja nie istnieje.' });

    // Save each (role, feature) combination
    // req.body[key] can be '1', '0', or ['0','1'] (array when hidden+checkbox both submit)
    for (const role of ROLES.map(r => r.key)) {
      for (const feature of FEATURES.map(f => f.slug)) {
        const key = `${role}_${feature}`;
        const val = req.body[key];
        const enabled = (val === '1' || (Array.isArray(val) && val.includes('1'))) ? 1 : 0;
        await db.run(
          `INSERT INTO location_features (location_id, role, feature, enabled)
           VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)`,
          [locationId, role, feature, enabled]
        );
      }
    }

    log(res.locals.user, 'Aktualizacja widoczności funkcji', location.name);
    req.flash('success', 'Ustawienia widoczności zapisane.');
    res.redirect(`/locations/${locationId}/features`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

module.exports = router;
