'use strict';
const db = require('../database/db');

let _rulesCache = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

async function loadRules() {
  const now = Date.now();
  if (_rulesCache && now - _cacheTime < CACHE_TTL_MS) return _rulesCache;
  _rulesCache = await db.all(`
    SELECT cr.*, fc.slug AS category_slug, fc.event_type AS category_event_type
    FROM categorization_rules cr
    JOIN finance_categories fc ON fc.id = cr.category_id
    WHERE cr.active = 1
    ORDER BY cr.priority ASC, cr.id ASC
  `);
  _cacheTime = now;
  return _rulesCache;
}

function invalidateCache() {
  _rulesCache = null;
}

function matchesRule(tx, rule) {
  const { match_field, match_type, pattern } = rule;
  const fields = {
    operation_type:    (tx.operation_type    || ''),
    title:             (tx.title             || ''),
    counterparty_name: (tx.counterparty_name || ''),
  };

  const candidates = match_field === 'any'
    ? Object.values(fields)
    : [fields[match_field] || ''];

  return candidates.some(val => {
    if (!val) return false;
    switch (match_type) {
      case 'contains':
        return val.toLowerCase().includes(pattern.toLowerCase());
      case 'equals':
        return val.toLowerCase() === pattern.toLowerCase();
      case 'regex': {
        try { return new RegExp(pattern, 'i').test(val); }
        catch { return false; }
      }
      default: return false;
    }
  });
}

/**
 * Categorize a single transaction against all active rules.
 * Returns { category_id, category_slug, default_status, default_is_relevant, creates_split_events }
 * or null if no rule matched.
 */
async function categorizeOne(tx) {
  const rules = await loadRules();
  for (const rule of rules) {
    if (matchesRule(tx, rule)) {
      return {
        category_id:          rule.category_id,
        category_slug:        rule.category_slug,
        default_status:       rule.default_status,
        default_is_relevant:  rule.default_is_relevant,
        creates_split_events: rule.creates_split_events,
      };
    }
  }
  return null;
}

/**
 * Categorize a batch of transactions and persist results to DB.
 * Skips rows where manually_categorized = 1 unless overwrite = true.
 */
async function categorizeAndSave(transactions, { overwrite = false } = {}) {
  const rules = await loadRules();
  let updated = 0;
  let skipped = 0;

  for (const tx of transactions) {
    if (!overwrite && tx.manually_categorized) { skipped++; continue; }

    let matched = null;
    for (const rule of rules) {
      if (matchesRule(tx, rule)) { matched = rule; break; }
    }

    if (matched) {
      await db.run(`
        UPDATE bank_transactions
        SET category_id = ?, status = ?, is_relevant = ?, updated_at = NOW()
        WHERE id = ?
      `, [matched.category_id, matched.default_status, matched.default_is_relevant, tx.id]);
      updated++;
    } else {
      // No rule matched: keep as review with no category
      await db.run(`
        UPDATE bank_transactions
        SET status = 'review', updated_at = NOW()
        WHERE id = ? AND category_id IS NULL
      `, [tx.id]);
    }
  }

  return { updated, skipped };
}

module.exports = { categorizeOne, categorizeAndSave, loadRules, invalidateCache };
