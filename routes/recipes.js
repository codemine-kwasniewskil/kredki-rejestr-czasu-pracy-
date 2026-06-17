const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { log } = require('../utils/logger');

// View = everyone; edit = kierownik / admin / super_admin.
const canView = [requireAuth, requireFeature('recipes')];
const canEdit = [requireAuth, requireFeature('recipes'), requireRole('admin', 'location_manager', 'super_admin')];

// Recipe categories with icons — shared with the views.
const CATEGORIES = [
  { value: 'kawa',         label: 'Kawa',          icon: '☕' },
  { value: 'matcha',       label: 'Matcha',        icon: '🌿' },
  { value: 'herbata',      label: 'Herbata',       icon: '🍵' },
  { value: 'napoje_zimne', label: 'Napoje zimne',  icon: '🧊' },
  { value: 'czekolada',    label: 'Czekolada',     icon: '🍫' },
  { value: 'inne',         label: 'Inne',          icon: '🧾' },
];
const CATEGORY_VALUES = CATEGORIES.map(c => c.value);

function isManager(req) {
  return ['admin', 'location_manager', 'super_admin'].includes(req.session.userRole);
}
function actor(req) {
  return { id: req.session.userId, name: req.session.userName, role: req.session.userRole };
}

// GET / — list with search + category filter
router.get('/', canView, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const q = (req.query.q || '').trim();
    const cat = CATEGORY_VALUES.includes(req.query.cat) ? req.query.cat : '';

    const where = ['location_id = ?'];
    const params = [locationId];
    if (q) { where.push('name LIKE ?'); params.push('%' + q + '%'); }
    if (cat) { where.push('category = ?'); params.push(cat); }

    // Sort: by date added (newest first, default) or alphabetically.
    const sort = req.query.sort === 'name' ? 'name' : 'date';
    const orderBy = sort === 'name' ? 'name ASC' : 'created_at DESC, id DESC';

    const recipes = await db.all(
      `SELECT id, name, category, price, temperature_c, dose, glass, prep_time_min, ingredients, active, created_at
       FROM recipes WHERE ${where.join(' AND ')}
       ORDER BY active DESC, ${orderBy}`,
      params
    );

    // Counts per category for the filter chips.
    const countRows = await db.all(
      `SELECT category, COUNT(*) AS cnt FROM recipes WHERE location_id=? GROUP BY category`,
      [locationId]
    );
    const counts = {};
    let total = 0;
    for (const r of countRows) { counts[r.category] = Number(r.cnt); total += Number(r.cnt); }

    res.render('recipes/index', {
      currentPath: '/recipes', recipes, categories: CATEGORIES, counts, total,
      q, cat, sort, canEdit: isManager(req),
    });
  } catch (err) {
    console.error('recipes list error:', err);
    res.status(500).render('error', { message: 'Błąd ładowania przepisów.' });
  }
});

// GET /new — form (managers)
router.get('/new', canEdit, (req, res) => {
  res.render('recipes/form', {
    currentPath: '/recipes', categories: CATEGORIES,
    recipe: { name: '', category: 'kawa', price: '', temperature_c: '', dose: '', pours: '', grind: '',
              glass: '', prep_time_min: '', ingredients: '', steps: '', notes: '', active: 1 },
    isNew: true,
  });
});

// POST / — create (managers)
router.post('/', canEdit, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { name, category, price, temperature_c, dose, pours, grind, glass, prep_time_min, ingredients, steps, notes } = req.body;
    if (!name || !name.trim()) {
      req.flash('error', 'Nazwa przepisu jest wymagana.');
      return res.redirect('/recipes/new');
    }
    const cat = CATEGORY_VALUES.includes(category) ? category : 'inne';
    const result = await db.run(
      `INSERT INTO recipes (location_id, name, category, price, temperature_c, dose, pours, grind, glass, prep_time_min, ingredients, steps, notes, active, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [locationId, name.trim(), cat,
       price !== '' && price != null ? parseFloat(price) : null,
       temperature_c ? parseInt(temperature_c, 10) : null,
       dose?.trim() || null, pours?.trim() || null, grind?.trim() || null,
       glass?.trim() || null, prep_time_min ? parseInt(prep_time_min, 10) : null,
       ingredients?.trim() || null, steps?.trim() || null, notes?.trim() || null,
       req.body.active ? 1 : 0, req.session.userId]
    );
    await log(actor(req), 'recipe_create', `Dodano przepis: ${name.trim()}`);
    req.flash('success', 'Przepis dodany.');
    res.redirect(`/recipes/${result.insertId}`);
  } catch (err) {
    console.error('recipe create error:', err);
    req.flash('error', 'Błąd podczas zapisywania przepisu.');
    res.redirect('/recipes/new');
  }
});

// GET /:id — detail (everyone)
router.get('/:id(\\d+)', canView, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const recipe = await db.get(
      `SELECT r.*, u.name AS created_by_name FROM recipes r
       LEFT JOIN users u ON u.id = r.created_by
       WHERE r.id = ? AND r.location_id = ?`,
      [req.params.id, locationId]
    );
    if (!recipe) return res.status(404).render('error', { message: 'Przepis nie istnieje.' });
    res.render('recipes/show', {
      currentPath: '/recipes', recipe, categories: CATEGORIES, canEdit: isManager(req),
    });
  } catch (err) {
    console.error('recipe show error:', err);
    res.status(500).render('error', { message: 'Błąd ładowania przepisu.' });
  }
});

// GET /:id/edit — form (managers)
router.get('/:id(\\d+)/edit', canEdit, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const recipe = await db.get(`SELECT * FROM recipes WHERE id=? AND location_id=?`, [req.params.id, locationId]);
    if (!recipe) return res.status(404).render('error', { message: 'Przepis nie istnieje.' });
    res.render('recipes/form', { currentPath: '/recipes', categories: CATEGORIES, recipe, isNew: false });
  } catch (err) {
    console.error('recipe edit form error:', err);
    res.status(500).render('error', { message: 'Błąd ładowania przepisu.' });
  }
});

// PUT /:id — update (managers)
router.put('/:id(\\d+)', canEdit, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { name, category, price, temperature_c, dose, pours, grind, glass, prep_time_min, ingredients, steps, notes } = req.body;
    if (!name || !name.trim()) {
      req.flash('error', 'Nazwa przepisu jest wymagana.');
      return res.redirect(`/recipes/${req.params.id}/edit`);
    }
    const cat = CATEGORY_VALUES.includes(category) ? category : 'inne';
    await db.run(
      `UPDATE recipes SET name=?, category=?, price=?, temperature_c=?, dose=?, pours=?, grind=?, glass=?, prep_time_min=?, ingredients=?, steps=?, notes=?, active=?, updated_at=NOW()
       WHERE id=? AND location_id=?`,
      [name.trim(), cat,
       price !== '' && price != null ? parseFloat(price) : null,
       temperature_c ? parseInt(temperature_c, 10) : null,
       dose?.trim() || null, pours?.trim() || null, grind?.trim() || null,
       glass?.trim() || null, prep_time_min ? parseInt(prep_time_min, 10) : null,
       ingredients?.trim() || null, steps?.trim() || null, notes?.trim() || null,
       req.body.active ? 1 : 0, req.params.id, locationId]
    );
    await log(actor(req), 'recipe_update', `Edytowano przepis ID ${req.params.id}`);
    req.flash('success', 'Przepis zaktualizowany.');
    res.redirect(`/recipes/${req.params.id}`);
  } catch (err) {
    console.error('recipe update error:', err);
    req.flash('error', 'Błąd podczas aktualizacji przepisu.');
    res.redirect(`/recipes/${req.params.id}/edit`);
  }
});

// DELETE /:id — delete (managers)
router.delete('/:id(\\d+)', canEdit, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    await db.run(`DELETE FROM recipes WHERE id=? AND location_id=?`, [req.params.id, locationId]);
    await log(actor(req), 'recipe_delete', `Usunięto przepis ID ${req.params.id}`);
    req.flash('success', 'Przepis usunięty.');
    res.redirect('/recipes');
  } catch (err) {
    console.error('recipe delete error:', err);
    req.flash('error', 'Błąd podczas usuwania przepisu.');
    res.redirect('/recipes');
  }
});

module.exports = router;
