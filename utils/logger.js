const db = require('../database/db');

async function log(user, action, details) {
  try {
    await db.run(
      `INSERT INTO activity_logs (user_id, user_name, user_role, action, details) VALUES (?,?,?,?,?)`,
      [user.id || null, user.name || '?', user.role || '?', action, details || null]
    );
  } catch (_) {}
}

module.exports = { log };
