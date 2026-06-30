// One-time seed: create "Bakery" and "Blogo" suppliers (manual vendors) for Kredki (location 1)
// and assign "Bakery" to every product in the bakery categories.
// Idempotent — safe to re-run. Usage: node scripts/seed-bakery-blogo-vendors.js
require('dotenv').config();
const db = require('../database/db');

const LOCATION_ID = 1; // Kredki
const BAKERY_CATEGORIES = ['Kanapki', 'Wypieki w Sobotę i Niedzielę'];

async function ensureVendor(name, slug) {
  await db.run(
    `INSERT INTO vendors (location_id, name, slug, api_type, active, sort_order)
     VALUES (?, ?, ?, 'manual', 1, 10)
     ON DUPLICATE KEY UPDATE name = VALUES(name), active = 1`,
    [LOCATION_ID, name, slug]
  );
  const v = await db.get(`SELECT id FROM vendors WHERE location_id=? AND slug=?`, [LOCATION_ID, slug]);
  return v.id;
}

(async () => {
  try {
    const bakeryId = await ensureVendor('Bakery', 'bakery');
    const blogoId = await ensureVendor('Blogo', 'blogo');
    console.log(`Vendors ready → Bakery=#${bakeryId}, Blogo=#${blogoId}`);

    const ph = BAKERY_CATEGORIES.map(() => '?').join(',');
    const res = await db.run(
      `UPDATE stock_items SET vendor_id=?
       WHERE location_id=? AND category IN (${ph})`,
      [bakeryId, LOCATION_ID, ...BAKERY_CATEGORIES]
    );
    console.log(`Assigned Bakery to ${res.affectedRows} products in categories: ${BAKERY_CATEGORIES.join(', ')}`);

    const check = await db.all(
      `SELECT v.name AS vendor, COUNT(*) AS cnt
       FROM stock_items si LEFT JOIN vendors v ON v.id=si.vendor_id
       WHERE si.location_id=? AND si.category IN (${ph})
       GROUP BY v.name`,
      [LOCATION_ID, ...BAKERY_CATEGORIES]
    );
    console.log('Verification:', JSON.stringify(check));
    process.exit(0);
  } catch (e) {
    console.error('SEED ERROR:', e.message);
    process.exit(1);
  }
})();
