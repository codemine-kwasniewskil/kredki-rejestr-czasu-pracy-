const db = require('../database/db');

async function log(user, action, details) {
  try {
    let locationId = null;
    if (user && user.id) {
      const u = await db.get('SELECT location_id FROM users WHERE id=?', [user.id]);
      if (u) locationId = u.location_id;
    }
    await db.run(
      `INSERT INTO activity_logs (user_id, user_name, user_role, action, details, location_id) VALUES (?,?,?,?,?,?)`,
      [user ? (user.id || null) : null, user ? (user.name || '?') : '?', user ? (user.role || '?') : '?', action, details || null, locationId]
    );
  } catch (_) {}
}

module.exports = { log };
