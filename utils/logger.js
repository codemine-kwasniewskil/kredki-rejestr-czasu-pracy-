const db = require('../database/db');

function log(user, action, details) {
  try {
    db.prepare(`INSERT INTO activity_logs (user_id, user_name, user_role, action, details) VALUES (?,?,?,?,?)`)
      .run(user.id || null, user.name || '?', user.role || '?', action, details || null);
  } catch (_) {}
}

module.exports = { log };
