'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { log } = require('../utils/logger');

const requireManager = requireRole('admin', 'location_manager');

// ── Duplicate-detection helpers (product grouping) ──────────────────────────
const GROUP_STOPWORDS = new Set(['z', 'i', 'w', 'na', 'do', 'ze', 'o', 'a', 'au', 'the']);

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function normTokens(s) {
  return normName(s).split(' ').filter(t => t && !GROUP_STOPWORDS.has(t));
}
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}
// Size/colour qualifiers that distinguish product variants (not duplicates).
const GROUP_DISTINGUISH = new Set(['duze', 'duzy', 'duza', 'male', 'maly', 'mala', 'maxi', 'mini', 'small', 'large', 'xl', 'niebieski', 'przezroczysty', 'czerwony', 'zielony', 'bialy', 'czarny']);
function isDistinguishingTok(t) { return GROUP_DISTINGUISH.has(t) || /\d/.test(t); }

function similarItems(a, b) {
  if (a.norm && a.norm === b.norm) return true;
  // Block merges where the only token differences are size/colour/number qualifiers.
  const symDiff = [...new Set([...a.tokens, ...b.tokens])].filter(t => !(a.tokens.has(t) && b.tokens.has(t)));
  if (symDiff.length > 0 && symDiff.every(isDistinguishingTok)) return false;
  const lev = levenshtein(a.normNoStop, b.normNoStop);
  const maxLen = Math.max(a.normNoStop.length, b.normNoStop.length);
  if (maxLen > 0 && lev <= 2 && lev / maxLen <= 0.34) return true;
  const inter = [...a.tokens].filter(t => b.tokens.has(t)).length;
  const uni = new Set([...a.tokens, ...b.tokens]).size;
  if (uni > 0 && inter / uni >= 0.5) return true;
  return false;
}
// Pick a canonical group label from member names: most frequent, tie-break shortest.
function canonicalName(names) {
  const freq = new Map();
  for (const n of names) freq.set(n, (freq.get(n) || 0) + 1);
  return [...freq.entries()].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)[0][0];
}
// Build {strong, weak} duplicate proposals from a flat item list (excludes already-grouped pairs).
function buildGroupProposals(items) {
  const enriched = items.map(it => {
    const norm = normName(it.name);
    const toks = normTokens(it.name);
    return { ...it, norm, normNoStop: toks.join(' '), tokens: new Set(toks) };
  });

  // Strong: identical normalized name across ≥2 distinct items.
  const byNorm = new Map();
  for (const it of enriched) {
    if (!it.norm) continue;
    if (!byNorm.has(it.norm)) byNorm.set(it.norm, []);
    byNorm.get(it.norm).push(it);
  }
  const strong = [];
  const inStrong = new Set();
  for (const [, group] of byNorm) {
    if (group.length < 2) continue;
    group.forEach(g => inStrong.add(g.id));
    const grouped = group.map(g => (g.group_name || '').trim()).filter(Boolean);
    const allSameGroup = grouped.length === group.length && new Set(grouped.map(s => s.toLowerCase())).size === 1;
    if (allSameGroup) continue; // already merged
    strong.push({ suggested: canonicalName(group.map(g => g.name)), members: group });
  }

  // Weak: fuzzy clusters among the rest (union-find).
  const rest = enriched.filter(it => !inStrong.has(it.id));
  const parent = new Map(rest.map(it => [it.id, it.id]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { parent.set(find(a), find(b)); };
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      if (similarItems(rest[i], rest[j])) union(rest[i].id, rest[j].id);
    }
  }
  const clusters = new Map();
  for (const it of rest) {
    const root = find(it.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(it);
  }
  const weak = [];
  for (const [, group] of clusters) {
    if (group.length < 2) continue;
    const grouped = group.map(g => (g.group_name || '').trim()).filter(Boolean);
    const allSameGroup = grouped.length === group.length && new Set(grouped.map(s => s.toLowerCase())).size === 1;
    if (allSameGroup) continue;
    weak.push({ suggested: canonicalName(group.map(g => g.name)), members: group });
  }
  return { strong, weak };
}

router.use(requireAuth);
router.use(requireFeature('stock'));

function sessionUser(req) {
  return { id: req.session.userId, name: req.session.userName, role: req.session.userRole };
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadMeta() {
  const rows = await db.all(`SELECT * FROM stock_report_types ORDER BY sort_order, id`);
  const REPORT_META = {};
  for (const r of rows) {
    REPORT_META[r.id] = {
      label: r.label, icon: r.icon,
      desc: r.description || '', freq: r.freq || '',
      isShift: !!r.is_shift_type, active: !!r.active,
    };
  }
  return { reportTypes: rows, REPORT_META };
}

// Normalizes an entry row's delivery dates into an array of 'YYYY-MM-DD' strings.
// Prefers the JSON delivery_dates column; falls back to the single legacy delivery_date.
function parseDeliveryDates(entry) {
  if (!entry) return [];
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (entry.delivery_dates) {
    try {
      const arr = JSON.parse(entry.delivery_dates);
      if (Array.isArray(arr)) {
        const out = arr.map(d => (typeof d === 'string' ? d.slice(0, 10) : '')).filter(isDate);
        if (out.length) return out;
      }
    } catch (_) { /* fall through to legacy */ }
  }
  if (entry.delivery_date) {
    const d = String(entry.delivery_date).slice(0, 10);
    if (isDate(d)) return [d];
  }
  return [];
}

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// A delivery batch is expired on `today` once today >= deliveryDate + shelfLifeDays.
function isDeliveryExpired(dateStr, days, today) {
  if (!dateStr) return false;
  return today >= addDaysStr(dateStr, days);
}

function groupByCategory(items) {
  const grouped = [];
  let lastCat = undefined;
  for (const item of items) {
    if (item.category !== lastCat) {
      grouped.push({ category: item.category, items: [] });
      lastCat = item.category;
    }
    grouped[grouped.length - 1].items.push(item);
  }
  return grouped;
}

// ── Dashboard ──────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const { REPORT_META } = await loadMeta();
    const reportDate = req.query.date || today();

    const locationId = getLocationId(req);
    const reports = await db.all(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id
       WHERE sr.report_date = ? AND sr.location_id = ? ORDER BY sr.report_type`,
      [reportDate, locationId]
    );
    const reportsByType = {};
    for (const r of reports) reportsByType[r.report_type] = r;

    const history = await db.all(
      `SELECT sr.report_date, sr.report_type, u.name AS submitted_by_name, sr.id
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id
       WHERE sr.report_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND sr.location_id = ?
       ORDER BY sr.report_date DESC, sr.report_type`,
      [locationId]
    );

    // Day messages + per-user read state (powers the bell badge next to the date)
    const messages = await db.all(
      `SELECT sm.id, sm.body, sm.user_id, sm.created_at, sm.done_by, sm.done_at,
              u.name AS author_name, du.name AS done_by_name,
              EXISTS(SELECT 1 FROM stock_message_reads r WHERE r.message_id = sm.id AND r.user_id = ?) AS is_read
       FROM stock_messages sm
       JOIN users u ON sm.user_id = u.id
       LEFT JOIN users du ON sm.done_by = du.id
       WHERE sm.message_date = ? AND sm.location_id <=> ?
       ORDER BY sm.created_at ASC`,
      [req.session.userId, reportDate, locationId]
    );
    const unreadCount = messages.filter(m => !m.is_read).length;

    res.render('stock/index', {
      title: 'Raport Stanów', currentPath: '/stock',
      reportDate, reportsByType, history, REPORT_META,
      messages, unreadCount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Day messages ─────────────────────────────────────────────────────────────

// Add a message for a given day (any authenticated stock user)
router.post('/messages', async (req, res) => {
  const messageDate = req.body.message_date || today();
  try {
    const body = (req.body.body || '').trim();
    if (!body) {
      req.flash('error', 'Wiadomość jest pusta.');
      return res.redirect(`/stock?date=${messageDate}`);
    }
    const locationId = getLocationId(req);
    const result = await db.run(
      `INSERT INTO stock_messages (location_id, message_date, user_id, body) VALUES (?,?,?,?)`,
      [locationId, messageDate, req.session.userId, body]
    );
    // Author has implicitly read their own message
    await db.run(`INSERT IGNORE INTO stock_message_reads (message_id, user_id) VALUES (?,?)`, [result.insertId, req.session.userId]);
    await log(sessionUser(req), 'Raport Stanów – dodano wiadomość', `Data: ${messageDate}`);
    res.redirect(`/stock?date=${messageDate}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu wiadomości.');
    res.redirect(`/stock?date=${messageDate}`);
  }
});

// Mark all of a day's messages as read for the current user (fired when the panel opens)
router.post('/messages/read', async (req, res) => {
  try {
    const messageDate = req.body.message_date || today();
    const locationId = getLocationId(req);
    const rows = await db.all(
      `SELECT id FROM stock_messages WHERE message_date = ? AND location_id <=> ?`,
      [messageDate, locationId]
    );
    for (const r of rows) {
      await db.run(`INSERT IGNORE INTO stock_message_reads (message_id, user_id) VALUES (?,?)`, [r.id, req.session.userId]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// Toggle the "zrobione" checkbox — stamps/clears who completed the message
router.post('/messages/:id/done', async (req, res) => {
  const messageDate = req.body.message_date || today();
  try {
    const msg = await db.get(`SELECT id, done_by FROM stock_messages WHERE id=?`, [req.params.id]);
    if (msg) {
      if (msg.done_by) {
        await db.run(`UPDATE stock_messages SET done_by=NULL, done_at=NULL WHERE id=?`, [req.params.id]);
      } else {
        await db.run(`UPDATE stock_messages SET done_by=?, done_at=NOW() WHERE id=?`, [req.session.userId, req.params.id]);
      }
    }
    res.redirect(`/stock?date=${messageDate}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/stock?date=${messageDate}`);
  }
});

// Delete a message (author or manager)
router.delete('/messages/:id', async (req, res) => {
  const msg = await db.get(`SELECT * FROM stock_messages WHERE id=?`, [req.params.id]).catch(() => null);
  const messageDate = msg?.message_date || req.body.message_date || '';
  try {
    const isManager = ['admin', 'location_manager', 'super_admin'].includes(req.session.userRole);
    if (msg && (msg.user_id === req.session.userId || isManager)) {
      await db.run(`DELETE FROM stock_messages WHERE id=?`, [req.params.id]);
      await log(sessionUser(req), 'Raport Stanów – usunięto wiadomość', `Data: ${messageDate}`);
    } else if (msg) {
      req.flash('error', 'Brak uprawnień do usunięcia tej wiadomości.');
    }
    res.redirect(`/stock?date=${messageDate}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/stock?date=${messageDate}`);
  }
});

// ── Form ───────────────────────────────────────────────────────────────────

router.get('/form/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { REPORT_META } = await loadMeta();
    const meta = REPORT_META[type];
    if (!meta) return res.redirect('/stock');

    const reportDate = req.query.date || today();

    const locationId = getLocationId(req);
    const items = await db.all(
      `SELECT * FROM stock_items WHERE report_type = ? AND active = 1 AND location_id = ? ORDER BY sort_order, id`,
      [type, locationId]
    );
    const existing = await db.get(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id
       WHERE sr.report_date = ? AND sr.report_type = ? AND sr.location_id = ?`,
      [reportDate, type, locationId]
    );
    const entries = {};
    if (existing) {
      const rows = await db.all(`SELECT * FROM stock_report_entries WHERE report_id = ?`, [existing.id]);
      for (const e of rows) entries[e.item_id] = e;
    }

    // Delivery batches per item — populated below, after the last-report lookup so that
    // batches can be carried forward from the previous day when today has none yet.
    const deliveryMap = {};

    // Lock past reports for workers
    const isWorker = req.session.userRole === 'worker';
    if (isWorker && reportDate !== today()) {
      if (existing) return res.redirect(`/stock/view/${existing.id}`);
      return res.redirect(`/stock?date=${reportDate}`);
    }

    const minQtyMap = {};
    for (const item of items) {
      if (item.min_qty !== null && item.min_qty !== undefined) minQtyMap[item.id] = Number(item.min_qty);
    }

    // Hidden items for this report (per-report hide, stored in stock_reports.hidden_items)
    const hiddenSet = new Set(
      (existing?.hidden_items || '').split(',').filter(Boolean).map(Number)
    );

    // Types that allow worker quick-add/hide
    const QUICK_MANAGE_TYPES = ['cakes_noon', 'products_shift'];
    const canManageItems = QUICK_MANAGE_TYPES.includes(type);

    // Last reported value per item (most recent report before this date)
    const lastRows = await db.all(
      `SELECT sre.item_id, sre.quantity, sre.stan_zamkniecie, sre.hopper_qty, sr.report_date AS last_date
       FROM stock_report_entries sre
       INNER JOIN (
         SELECT sre2.item_id, MAX(sr2.report_date) AS max_date
         FROM stock_report_entries sre2
         JOIN stock_reports sr2 ON sr2.id = sre2.report_id
         WHERE sr2.report_type = ? AND sr2.location_id = ? AND sr2.report_date < ?
         GROUP BY sre2.item_id
       ) latest ON latest.item_id = sre.item_id
       JOIN stock_reports sr ON sr.id = sre.report_id AND sr.report_date = latest.max_date
       WHERE sr.report_type = ? AND sr.location_id = ?`,
      [type, locationId, reportDate, type, locationId]
    );
    const lastValues = {};
    for (const row of lastRows) lastValues[row.item_id] = row;

    // Most recent prior entry that actually carries delivery dates (skip later reports that
    // left them blank), so batches persist day-to-day even if a day was left empty.
    const lastDeliveryRows = await db.all(
      `SELECT sre.item_id, sre.delivery_date, sre.delivery_dates, sr.report_date AS last_date
       FROM stock_report_entries sre
       INNER JOIN (
         SELECT sre2.item_id, MAX(sr2.report_date) AS max_date
         FROM stock_report_entries sre2
         JOIN stock_reports sr2 ON sr2.id = sre2.report_id
         WHERE sr2.report_type = ? AND sr2.location_id = ? AND sr2.report_date < ?
           AND ((sre2.delivery_dates IS NOT NULL AND sre2.delivery_dates <> '') OR sre2.delivery_date IS NOT NULL)
         GROUP BY sre2.item_id
       ) latest ON latest.item_id = sre.item_id
       JOIN stock_reports sr ON sr.id = sre.report_id AND sr.report_date = latest.max_date
       WHERE sr.report_type = ? AND sr.location_id = ?`,
      [type, locationId, reportDate, type, locationId]
    );
    const lastDelivery = {};
    for (const row of lastDeliveryRows) lastDelivery[row.item_id] = row;

    // Delivery batches: use today's saved batches; otherwise carry forward the still-valid
    // (non-expired) batches from the most recent prior report so dates persist day-to-day.
    for (const item of items) {
      let dates = parseDeliveryDates(entries[item.id]);
      if ((!dates || !dates.length) && !entries[item.id]) {
        const lv = lastDelivery[item.id];
        if (lv) {
          const shelf = item.shelf_life_days != null ? Number(item.shelf_life_days) : 3;
          dates = parseDeliveryDates(lv).filter(d => !isDeliveryExpired(d, shelf, reportDate));
        }
      }
      deliveryMap[item.id] = dates || [];
    }

    res.render('stock/form', {
      title: meta.label, currentPath: '/stock',
      type, meta, reportDate, existing,
      grouped: groupByCategory(items), entries, REPORT_META, minQtyMap, lastValues,
      hiddenSet: [...hiddenSet], canManageItems, todayStr: today(), deliveryMap,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Save ───────────────────────────────────────────────────────────────────

router.post('/save', async (req, res) => {
  try {
    const { report_type, report_date, notes } = req.body;
    const { REPORT_META } = await loadMeta();
    const meta = REPORT_META[report_type];
    if (!meta) return res.redirect('/stock');

    const userId = req.session.userId;

    const locationId = getLocationId(req);
    let report = await db.get(
      `SELECT id FROM stock_reports WHERE report_date = ? AND report_type = ? AND location_id = ?`,
      [report_date, report_type, locationId]
    );
    const hiddenItems = (req.body.hidden_items || '').trim();
    const hiddenSaveSet = new Set(hiddenItems.split(',').filter(Boolean).map(Number));

    const wasNew = !report;
    if (report) {
      await db.run(
        `UPDATE stock_reports SET submitted_by=?, notes=?, hidden_items=?, updated_at=NOW() WHERE id=?`,
        [userId, notes || null, hiddenItems || null, report.id]
      );
    } else {
      const result = await db.run(
        `INSERT INTO stock_reports (report_date, report_type, submitted_by, notes, hidden_items, location_id) VALUES (?,?,?,?,?,?)`,
        [report_date, report_type, userId, notes || null, hiddenItems || null, locationId]
      );
      report = { id: result.insertId };
    }

    const items = await db.all(
      `SELECT id FROM stock_items WHERE report_type = ? AND active = 1 AND location_id = ?`, [report_type, locationId]
    );
    // Pick last non-empty value from potential array (desktop inputs come after mobile in DOM);
    // normalize decimal separator
    const pick = (v) => {
      const raw = (Array.isArray(v)
        ? ([...v].reverse().find(x => x && x.trim()) || '')
        : v || '').trim();
      if (!raw || raw === '—' || raw === '-') return null;
      const normalized = raw.replace(',', '.');
      const n = parseFloat(normalized);
      if (isNaN(n)) return null;
      // Store without trailing zeros: "0.50" → "0.5", "2.0" → "2"
      return String(parseFloat(n.toPrecision(10)));
    };
    // Delivery batches arrive as a JSON array string in delivery_dates_<id> (managed by one
    // hidden input per item, so no dual-layout duplication). Returns { json, earliest }.
    const pickDeliveryDates = (v) => {
      const raw = (Array.isArray(v) ? ([...v].reverse().find(x => x && x.trim()) || '') : v || '').trim();
      let arr = [];
      if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch (_) {} }
      const valid = [...new Set(arr.map(d => (typeof d === 'string' ? d.slice(0, 10) : ''))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
      return { json: valid.length ? JSON.stringify(valid) : null, earliest: valid[0] || null };
    };
    // Shelf-life (days) is a per-item property edited inline in the cake/cookie rows.
    const pickShelfLife = (v) => {
      const raw = (Array.isArray(v) ? ([...v].reverse().find(x => x && String(x).trim()) || '') : v || '').toString().trim();
      if (raw === '') return undefined; // field absent → don't touch the item
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    for (const item of items) {
      const id = item.id;
      if (hiddenSaveSet.has(id)) continue;
      const hqRaw = req.body[`hopper_qty_${id}`];
      const hqStr = Array.isArray(hqRaw) ? (hqRaw.find(v => v && v.trim()) || '') : (hqRaw || '');
      const hq = hqStr.trim() ? parseFloat(hqStr) || null : null;

      const { json: deliveryDates, earliest: deliveryDate } = pickDeliveryDates(req.body[`delivery_dates_${id}`]);

      // Persist an inline shelf-life edit back onto the product itself (affects all reports).
      const shelfLife = pickShelfLife(req.body[`shelf_life_${id}`]);
      if (shelfLife !== undefined) {
        await db.run(`UPDATE stock_items SET shelf_life_days=? WHERE id=? AND location_id=?`, [shelfLife, id, locationId]);
      }

      if (meta.isShift) {
        const s_o = pick(req.body[`stan_otwarcie_${id}`]);
        const d   = pick(req.body[`dostawa_${id}`]);
        const s16 = pick(req.body[`stan_16_${id}`]);
        const s_z = pick(req.body[`stan_zamkniecie_${id}`]);
        const usz = pick(req.body[`uszkodzone_${id}`]);
        await db.run(
          `INSERT INTO stock_report_entries (report_id,item_id,stan_otwarcie,dostawa,stan_16,stan_zamkniecie,uszkodzone,hopper_qty,delivery_date,delivery_dates)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE stan_otwarcie=VALUES(stan_otwarcie),dostawa=VALUES(dostawa),
             stan_16=VALUES(stan_16),stan_zamkniecie=VALUES(stan_zamkniecie),uszkodzone=VALUES(uszkodzone),hopper_qty=VALUES(hopper_qty),delivery_date=VALUES(delivery_date),delivery_dates=VALUES(delivery_dates)`,
          [report.id, id, s_o, d, s16, s_z, usz, hq, deliveryDate, deliveryDates]
        );
      } else {
        const qty = pick(req.body[`qty_${id}`]);
        const n   = (req.body[`notes_${id}`] || '').trim() || null;
        await db.run(
          `INSERT INTO stock_report_entries (report_id,item_id,quantity,notes,hopper_qty,delivery_date,delivery_dates)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE quantity=VALUES(quantity),notes=VALUES(notes),hopper_qty=VALUES(hopper_qty),delivery_date=VALUES(delivery_date),delivery_dates=VALUES(delivery_dates)`,
          [report.id, id, qty, n, hq, deliveryDate, deliveryDates]
        );
      }
    }

    const action = wasNew ? 'Raport Stanów – nowy raport' : 'Raport Stanów – aktualizacja raportu';
    await log(sessionUser(req), action, `Typ: ${meta.label} | Data: ${report_date}`);
    req.flash('success', 'Raport zapisany.');
    res.redirect(`/stock/view/${report.id}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy zapisie raportu.');
    res.redirect('/stock');
  }
});

// ── View ───────────────────────────────────────────────────────────────────

router.get('/view/:id', async (req, res) => {
  try {
    const { REPORT_META } = await loadMeta();
    const report = await db.get(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by = u.id WHERE sr.id = ?`,
      [req.params.id]
    );
    if (!report) return res.status(404).render('error', { message: 'Raport nie istnieje.' });

    const meta = REPORT_META[report.report_type] || { label: report.report_type, icon: '📋', isShift: false };

    let items;
    try {
      items = await db.all(
        `SELECT si.*, v.name AS vendor_name,
                sre.quantity, sre.stan_otwarcie, sre.dostawa, sre.stan_16, sre.stan_zamkniecie, sre.uszkodzone, sre.hopper_qty, sre.delivery_date, sre.delivery_dates
         FROM stock_items si
         LEFT JOIN vendors v ON v.id = si.vendor_id
         LEFT JOIN stock_report_entries sre ON sre.item_id=si.id AND sre.report_id=?
         WHERE si.report_type=? AND si.active=1 AND si.location_id=? ORDER BY si.sort_order, si.id`,
        [report.id, report.report_type, report.location_id]
      );
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      // vendors table / vendor_id column not present — fall back without the supplier name
      items = await db.all(
        `SELECT si.*, NULL AS vendor_name,
                sre.quantity, sre.stan_otwarcie, sre.dostawa, sre.stan_16, sre.stan_zamkniecie, sre.uszkodzone, sre.hopper_qty, sre.delivery_date, sre.delivery_dates
         FROM stock_items si
         LEFT JOIN stock_report_entries sre ON sre.item_id=si.id AND sre.report_id=?
         WHERE si.report_type=? AND si.active=1 AND si.location_id=? ORDER BY si.sort_order, si.id`,
        [report.id, report.report_type, report.location_id]
      );
    }

    const deliveryMap = {};
    for (const item of items) deliveryMap[item.id] = parseDeliveryDates(item);

    res.render('stock/view', {
      title: meta.label, currentPath: '/stock',
      report, grouped: groupByCategory(items), meta, REPORT_META, todayStr: today(), deliveryMap,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Monthly summary (products + quantities, grouped by supplier) ────────────

const SUMMARY_MONTHS_PL = ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'];

function toNum(v) {
  if (v == null || v === '' || v === '—' || v === '-') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : n;
}

router.get('/summary', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { REPORT_META } = await loadMeta();
    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = (req.query.month || defaultMonth).substring(0, 7);

    let rows;
    try {
      rows = await db.all(
        `SELECT si.id, si.name, si.unit, si.report_type, si.group_name, v.name AS vendor_name,
                sre.quantity, sre.dostawa
         FROM stock_report_entries sre
         JOIN stock_reports sr ON sr.id = sre.report_id
         JOIN stock_items si ON si.id = sre.item_id
         LEFT JOIN vendors v ON v.id = si.vendor_id
         WHERE sr.location_id = ? AND DATE_FORMAT(sr.report_date, '%Y-%m') = ?`,
        [locationId, month]
      );
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      rows = await db.all(
        `SELECT si.id, si.name, si.unit, si.report_type, NULL AS group_name, NULL AS vendor_name,
                sre.quantity, sre.dostawa
         FROM stock_report_entries sre
         JOIN stock_reports sr ON sr.id = sre.report_id
         JOIN stock_items si ON si.id = sre.item_id
         WHERE sr.location_id = ? AND DATE_FORMAT(sr.report_date, '%Y-%m') = ?`,
        [locationId, month]
      );
    }

    // Aggregate by supplier → product. Products sharing a group_name are merged into one line.
    // For shift reports "ilość" = sum of deliveries (dostawa); for snapshot reports = sum of reported quantity.
    const suppliersMap = new Map();
    for (const r of rows) {
      const isShift = !!(REPORT_META[r.report_type] && REPORT_META[r.report_type].isShift);
      const val = toNum(isShift ? r.dostawa : r.quantity);
      if (val == null) continue;
      const supplierKey = r.vendor_name || 'Bez dostawcy';
      if (!suppliersMap.has(supplierKey)) suppliersMap.set(supplierKey, new Map());
      const productsMap = suppliersMap.get(supplierKey);
      const grp = (r.group_name && r.group_name.trim()) || '';
      const key = grp ? `g:${grp.toLowerCase()}` : `i:${r.id}`;
      const displayName = grp || r.name;
      if (!productsMap.has(key)) {
        productsMap.set(key, { name: displayName, unit: r.unit || '', total: 0, entries: 0, grouped: !!grp, members: new Set() });
      }
      const p = productsMap.get(key);
      p.total += val;
      p.entries += 1;
      p.members.add(r.id);
    }

    const fmtN = (n) => (Number.isInteger(n) ? n.toString() : n.toFixed(2)).replace('.', ',');
    const suppliers = [...suppliersMap.entries()]
      .map(([name, productsMap]) => ({
        name,
        products: [...productsMap.values()]
          .map(p => ({ ...p, totalStr: fmtN(p.total), memberCount: p.members.size }))
          .sort((a, b) => a.name.localeCompare(b.name, 'pl')),
        total: [...productsMap.values()].reduce((s, p) => s + p.total, 0),
      }))
      .sort((a, b) => {
        if (a.name === 'Bez dostawcy') return 1;
        if (b.name === 'Bez dostawcy') return -1;
        return a.name.localeCompare(b.name, 'pl');
      });

    const monthOptions = [];
    const base = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    for (let i = 0; i < 18; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthOptions.push({ val, label: SUMMARY_MONTHS_PL[d.getMonth()] + ' ' + d.getFullYear() });
    }
    const [mYear, mMonth] = month.split('-').map(Number);
    const monthLabel = SUMMARY_MONTHS_PL[mMonth - 1] + ' ' + mYear;

    res.render('stock/summary', {
      title: 'Podsumowanie miesięczne', currentPath: '/stock',
      suppliers, month, monthLabel, monthOptions,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ── Quick add product (workers, cakes_noon & products_shift only) ──────────

router.post('/quick-add-item', async (req, res) => {
  try {
    const { report_type, name, unit, report_date } = req.body;
    const QUICK_MANAGE_TYPES = ['cakes_noon', 'products_shift'];
    if (!QUICK_MANAGE_TYPES.includes(report_type) || !name?.trim()) {
      return res.redirect(`/stock/form/${report_type || ''}?date=${report_date || ''}`);
    }
    const locationId = getLocationId(req);
    await db.run(
      `INSERT INTO stock_items (report_type, name, unit, sort_order, active, location_id) VALUES (?,?,?,?,?,?)`,
      [report_type, name.trim(), 'szt', 999, 1, locationId]
    );
    await log(sessionUser(req), 'Raport Stanów – dodano produkt (quick add)', `${name.trim()} | Typ: ${report_type}`);
    req.flash('success', `Produkt "${name.trim()}" dodany.`);
    res.redirect(`/stock/form/${report_type}?date=${report_date}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu produktu.');
    res.redirect(`/stock/form/${req.body.report_type || ''}?date=${req.body.report_date || ''}`);
  }
});

// ── Admin panel ────────────────────────────────────────────────────────────

router.get('/admin', requireManager, async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const { reportTypes, REPORT_META } = await loadMeta();
    const tab = req.query.tab || 'items';
    const activeType = req.query.type || (reportTypes[0]?.id || 'daily_morning');
    const editId = req.query.edit ? parseInt(req.query.edit) : null;

    const items = await db.all(
      `SELECT si.*,
         COUNT(sre.id) AS entry_count,
         SUM(CASE WHEN
           (sre.quantity      IS NOT NULL AND sre.quantity      NOT IN ('','0','—')) OR
           (sre.stan_otwarcie IS NOT NULL AND sre.stan_otwarcie NOT IN ('','0','—')) OR
           (sre.dostawa       IS NOT NULL AND sre.dostawa       NOT IN ('','0','—')) OR
           (sre.stan_16       IS NOT NULL AND sre.stan_16       NOT IN ('','0','—')) OR
           (sre.stan_zamkniecie IS NOT NULL AND sre.stan_zamkniecie NOT IN ('','0','—')) OR
           (sre.uszkodzone    IS NOT NULL AND sre.uszkodzone    NOT IN ('','0','—'))
         THEN 1 ELSE 0 END) AS nonzero_count
       FROM stock_items si
       LEFT JOIN stock_report_entries sre ON sre.item_id = si.id
       WHERE si.report_type = ? AND si.location_id = ?
       GROUP BY si.id
       ORDER BY si.sort_order, si.id`,
      [activeType, locationId]
    );
    const editItem = editId ? await db.get(`SELECT * FROM stock_items WHERE id=? AND location_id=?`, [editId, locationId]) : null;

    // Categories for dropdown: merge stock_categories table + distinct from items (this location)
    const categoryRows = await db.all(
      `SELECT DISTINCT name AS category FROM (
         SELECT name FROM stock_categories WHERE report_type=?
         UNION
         SELECT category FROM stock_items WHERE report_type=? AND location_id=? AND category IS NOT NULL
       ) c ORDER BY category`,
      [activeType, activeType, locationId]
    );
    const categories = categoryRows.map(r => r.category);

    // Units for dropdown: merge stock_units table + distinct from items (this location)
    const unitRows = await db.all(
      `SELECT DISTINCT name AS unit FROM (
         SELECT name FROM stock_units
         UNION
         SELECT unit FROM stock_items WHERE location_id=? AND unit IS NOT NULL AND unit != '' AND unit != '-'
       ) u ORDER BY unit`,
      [locationId]
    );
    const units = unitRows.map(r => r.unit);

    // Category stats for management panel (catalog + item counts, this location)
    const categoryStats = await db.all(
      `SELECT c.name AS category, COALESCE(ic.cnt, 0) AS cnt
       FROM (
         SELECT name FROM stock_categories WHERE report_type=?
         UNION
         SELECT DISTINCT category FROM stock_items WHERE report_type=? AND location_id=? AND category IS NOT NULL
       ) c
       LEFT JOIN (
         SELECT category, COUNT(*) AS cnt FROM stock_items WHERE report_type=? AND location_id=? AND category IS NOT NULL GROUP BY category
       ) ic ON ic.category = c.name
       ORDER BY c.name`,
      [activeType, activeType, locationId, activeType, locationId]
    );

    // Unit stats for management panel (catalog + item counts, this location)
    const unitStats = await db.all(
      `SELECT u.name AS unit, COALESCE(ic.cnt, 0) AS cnt
       FROM (
         SELECT name FROM stock_units
         UNION
         SELECT DISTINCT unit FROM stock_items WHERE location_id=? AND unit IS NOT NULL AND unit != '' AND unit != '-'
       ) u
       LEFT JOIN (
         SELECT unit, COUNT(*) AS cnt FROM stock_items WHERE report_type=? AND location_id=? AND unit IS NOT NULL GROUP BY unit
       ) ic ON ic.unit = u.name
       ORDER BY u.name`,
      [locationId, activeType, locationId]
    );

    const history = await db.all(
      `SELECT sr.*, u.name AS submitted_by_name
       FROM stock_reports sr JOIN users u ON sr.submitted_by=u.id
       WHERE sr.location_id = ?
       ORDER BY sr.report_date DESC, sr.report_type LIMIT 100`,
      [locationId]
    );

    let vendors = [];
    try {
      vendors = await db.all(
        `SELECT id, name, api_type FROM vendors WHERE location_id=? AND active=1 ORDER BY sort_order, name`,
        [locationId]
      );
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    // Grouping tab: duplicate proposals + existing groups (computed only when needed)
    let groupProposals = { strong: [], weak: [] };
    let existingGroups = [];
    if (tab === 'groups') {
      let allItems = [];
      try {
        allItems = await db.all(
          `SELECT si.id, si.name, si.category, si.report_type, si.active, si.group_name, si.vendor_id, v.name AS vendor_name
           FROM stock_items si LEFT JOIN vendors v ON v.id = si.vendor_id
           WHERE si.location_id = ? ORDER BY si.name`, [locationId]);
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
        allItems = await db.all(
          `SELECT id, name, category, report_type, active, NULL AS group_name, NULL AS vendor_id, NULL AS vendor_name
           FROM stock_items WHERE location_id = ? ORDER BY name`, [locationId]);
      }
      groupProposals = buildGroupProposals(allItems);
      const gm = new Map();
      for (const it of allItems) {
        const g = (it.group_name || '').trim();
        if (!g) continue;
        const k = g.toLowerCase();
        if (!gm.has(k)) gm.set(k, { name: g, members: [] });
        gm.get(k).members.push(it);
      }
      existingGroups = [...gm.values()].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    }

    res.render('stock/admin', {
      title: 'Zarządzaj – Raport Stanów', currentPath: '/stock',
      tab, activeType, items, editItem, categories, units,
      categoryStats, unitStats,
      history, reportTypes, REPORT_META, vendors,
      groupProposals, existingGroups,
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// Bulk update items
router.post('/admin/items/bulk-update', requireManager, async (req, res) => {
  const back = req.get('Referer') || `/stock/admin?type=${req.body.report_type || ''}`;
  try {
    const locationId = getLocationId(req);
    const ids = (req.body.ids || '').split(',').map(Number).filter(Boolean);
    if (!ids.length) {
      req.flash('error', 'Nie zaznaczono żadnych produktów.');
      return res.redirect(back);
    }
    const { action } = req.body;
    const ph = ids.map(() => '?').join(',');

    if (action === 'assign_vendor') {
      const vId = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) : null;
      try {
        await db.run(`UPDATE stock_items SET vendor_id=? WHERE id IN (${ph}) AND location_id=?`, [vId, ...ids, locationId]);
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
      await log(sessionUser(req), 'Raport Stanów – bulk dostawca', `${ids.length} produktów → vendor_id=${vId}`);
      req.flash('success', `Dostawca przypisany do ${ids.length} produktów.`);
    } else if (action === 'clear_vendor') {
      try {
        await db.run(`UPDATE stock_items SET vendor_id=NULL, vendor_product_key=NULL WHERE id IN (${ph}) AND location_id=?`, [...ids, locationId]);
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
        await db.run(`UPDATE stock_items SET vendor_product_key=NULL WHERE id IN (${ph}) AND location_id=?`, [...ids, locationId]);
      }
      await log(sessionUser(req), 'Raport Stanów – bulk usuń dostawcę', `${ids.length} produktów`);
      req.flash('success', `Dostawca usunięty z ${ids.length} produktów.`);
    } else if (action === 'activate') {
      await db.run(`UPDATE stock_items SET active=1 WHERE id IN (${ph}) AND location_id=?`, [...ids, locationId]);
      req.flash('success', `${ids.length} produktów aktywowanych.`);
    } else if (action === 'deactivate') {
      await db.run(`UPDATE stock_items SET active=0 WHERE id IN (${ph}) AND location_id=?`, [...ids, locationId]);
      req.flash('success', `${ids.length} produktów dezaktywowanych.`);
    } else if (action === 'assign_group') {
      const g = (req.body.group_name || '').trim();
      if (!g) { req.flash('error', 'Podaj nazwę grupy.'); return res.redirect(back); }
      try {
        await db.run(`UPDATE stock_items SET group_name=? WHERE id IN (${ph}) AND location_id=?`, [g, ...ids, locationId]);
      } catch (e) { if (e.code !== 'ER_BAD_FIELD_ERROR') throw e; }
      await log(sessionUser(req), 'Raport Stanów – połączono w grupę', `${ids.length} produktów → ${g}`);
      req.flash('success', `Połączono ${ids.length} produktów w grupę „${g}".`);
    } else if (action === 'clear_group') {
      try {
        await db.run(`UPDATE stock_items SET group_name=NULL WHERE id IN (${ph}) AND location_id=?`, [...ids, locationId]);
      } catch (e) { if (e.code !== 'ER_BAD_FIELD_ERROR') throw e; }
      await log(sessionUser(req), 'Raport Stanów – rozłączono grupę', `${ids.length} produktów`);
      req.flash('success', `Rozłączono ${ids.length} produktów.`);
    } else {
      req.flash('error', 'Nieznana operacja.');
    }
    res.redirect(back);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd operacji zbiorowej.');
    res.redirect(back);
  }
});

// Add item
router.post('/admin/items', requireManager, async (req, res) => {
  try {
    const { report_type, category, name, unit, target_qty, sort_order, min_qty, hopper_weight, shelf_life_days } = req.body;
    if (!name || !report_type) {
      req.flash('error', 'Nazwa i typ raportu są wymagane.');
      return res.redirect(`/stock/admin?type=${report_type || ''}`);
    }
    const locationId = getLocationId(req);
    const minQtyVal = min_qty && min_qty.trim() !== '' ? parseFloat(min_qty) : null;
    const hopperWeightVal = hopper_weight && String(hopper_weight).trim() !== '' ? parseFloat(hopper_weight) : null;
    const shelfLifeVal = shelf_life_days && String(shelf_life_days).trim() !== '' ? parseInt(shelf_life_days, 10) : null;
    const vendorKey = req.body.vendor_product_key?.trim() || null;
    const vendorId  = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) : null;
    try {
      await db.run(
        `INSERT INTO stock_items (report_type, category, name, unit, target_qty, sort_order, min_qty, hopper_weight, shelf_life_days, vendor_product_key, vendor_id, location_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [report_type, category?.trim() || null, name.trim(), unit?.trim() || null,
         target_qty?.trim() || null, parseInt(sort_order) || 0, minQtyVal, hopperWeightVal, shelfLifeVal, vendorKey, vendorId, locationId]
      );
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      await db.run(
        `INSERT INTO stock_items (report_type, category, name, unit, target_qty, sort_order, min_qty, hopper_weight, shelf_life_days, vendor_product_key, location_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [report_type, category?.trim() || null, name.trim(), unit?.trim() || null,
         target_qty?.trim() || null, parseInt(sort_order) || 0, minQtyVal, hopperWeightVal, shelfLifeVal, vendorKey, locationId]
      );
    }
    await log(sessionUser(req), 'Raport Stanów – dodano produkt', `${name.trim()} | Typ: ${report_type}${category ? ' | Kat: ' + category.trim() : ''}`);
    req.flash('success', 'Produkt dodany.');
    res.redirect(`/stock/admin?type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu.');
    res.redirect('/stock/admin');
  }
});

// Update item
router.post('/admin/items/:id', requireManager, async (req, res) => {
  try {
    const { report_type, category, name, unit, target_qty, sort_order, active, min_qty, hopper_weight, hopper_enabled, shelf_life_days } = req.body;
    const minQtyVal = min_qty && min_qty.trim() !== '' ? parseFloat(min_qty) : null;
    const hopperWeightVal = hopper_weight && String(hopper_weight).trim() !== '' ? parseFloat(hopper_weight) : null;
    const shelfLifeVal = shelf_life_days && String(shelf_life_days).trim() !== '' ? parseInt(shelf_life_days, 10) : null;
    const vendorKey = req.body.vendor_product_key?.trim() || null;
    const vendorId  = req.body.vendor_id ? parseInt(req.body.vendor_id, 10) : null;
    try {
      await db.run(
        `UPDATE stock_items SET report_type=?,category=?,name=?,unit=?,target_qty=?,sort_order=?,active=?,min_qty=?,hopper_weight=?,hopper_enabled=?,shelf_life_days=?,vendor_product_key=?,vendor_id=? WHERE id=?`,
        [report_type, category?.trim() || null, name?.trim(), unit?.trim() || null,
         target_qty?.trim() || null, parseInt(sort_order) || 0, active === '1' ? 1 : 0, minQtyVal, hopperWeightVal, hopper_enabled === '1' ? 1 : 0, shelfLifeVal, vendorKey, vendorId || null, req.params.id]
      );
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      await db.run(
        `UPDATE stock_items SET report_type=?,category=?,name=?,unit=?,target_qty=?,sort_order=?,active=?,min_qty=?,hopper_weight=?,hopper_enabled=?,shelf_life_days=?,vendor_product_key=? WHERE id=?`,
        [report_type, category?.trim() || null, name?.trim(), unit?.trim() || null,
         target_qty?.trim() || null, parseInt(sort_order) || 0, active === '1' ? 1 : 0, minQtyVal, hopperWeightVal, hopper_enabled === '1' ? 1 : 0, shelfLifeVal, vendorKey, req.params.id]
      );
    }
    if (req.body.group_name !== undefined) {
      const grp = (req.body.group_name || '').trim() || null;
      try {
        await db.run(`UPDATE stock_items SET group_name=? WHERE id=? AND location_id=?`, [grp, req.params.id, getLocationId(req)]);
      } catch (e) { if (e.code !== 'ER_BAD_FIELD_ERROR') throw e; }
    }
    await log(sessionUser(req), 'Raport Stanów – zaktualizowano produkt', `ID: ${req.params.id} | ${name?.trim()} | Typ: ${report_type}`);
    req.flash('success', 'Produkt zaktualizowany.');
    res.redirect(`/stock/admin?type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy aktualizacji.');
    res.redirect('/stock/admin');
  }
});

// Toggle item active
router.post('/admin/items/:id/toggle', requireManager, async (req, res) => {
  try {
    const item = await db.get(`SELECT * FROM stock_items WHERE id=?`, [req.params.id]);
    if (item) {
      await db.run(`UPDATE stock_items SET active=? WHERE id=?`, [item.active ? 0 : 1, item.id]);
      await log(sessionUser(req), `Raport Stanów – produkt ${item.active ? 'ukryty' : 'aktywowany'}`, `${item.name} | Typ: ${item.report_type}`);
    }
    res.redirect(`/stock/admin?type=${req.body.report_type || ''}`);
  } catch (e) {
    console.error(e);
    res.redirect('/stock/admin');
  }
});

// Delete item (only if no entries with non-zero amounts)
router.delete('/admin/items/:id', requireManager, async (req, res) => {
  try {
    const nonzero = await db.get(
      `SELECT COUNT(*) AS cnt FROM stock_report_entries
       WHERE item_id=? AND (
         (quantity      IS NOT NULL AND quantity      NOT IN ('','0','—')) OR
         (stan_otwarcie IS NOT NULL AND stan_otwarcie NOT IN ('','0','—')) OR
         (dostawa       IS NOT NULL AND dostawa       NOT IN ('','0','—')) OR
         (stan_16       IS NOT NULL AND stan_16       NOT IN ('','0','—')) OR
         (stan_zamkniecie IS NOT NULL AND stan_zamkniecie NOT IN ('','0','—')) OR
         (uszkodzone    IS NOT NULL AND uszkodzone    NOT IN ('','0','—'))
       )`,
      [req.params.id]
    );
    if (nonzero && nonzero.cnt > 0) {
      req.flash('error', 'Nie można usunąć – produkt ma historię z wartościami > 0. Użyj „Ukryj".');
      return res.redirect(`/stock/admin?tab=items&type=${req.body.report_type || ''}`);
    }
    const toDelete = await db.get(`SELECT name, report_type FROM stock_items WHERE id=?`, [req.params.id]);
    await db.run(`DELETE FROM stock_items WHERE id=?`, [req.params.id]);
    await log(sessionUser(req), 'Raport Stanów – usunięto produkt', `${toDelete?.name} | Typ: ${toDelete?.report_type}`);
    req.flash('success', 'Produkt usunięty.');
    res.redirect(`/stock/admin?tab=items&type=${req.body.report_type || ''}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu.');
    res.redirect('/stock/admin');
  }
});

// Add category to catalog
router.post('/admin/categories/add', requireManager, async (req, res) => {
  try {
    const { report_type, name } = req.body;
    if (!name?.trim()) {
      req.flash('error', 'Podaj nazwę kategorii.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    await db.run(`INSERT IGNORE INTO stock_categories (report_type, name) VALUES (?,?)`, [report_type, name.trim()]);
    await log(sessionUser(req), 'Raport Stanów – dodano kategorię', `${name.trim()} | Typ: ${report_type}`);
    req.flash('success', `Kategoria „${name.trim()}" dodana.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu kategorii.');
    res.redirect('/stock/admin');
  }
});

// Add unit to catalog
router.post('/admin/units/add', requireManager, async (req, res) => {
  try {
    const { report_type, name } = req.body;
    if (!name?.trim()) {
      req.flash('error', 'Podaj nazwę jednostki.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    await db.run(`INSERT IGNORE INTO stock_units (name) VALUES (?)`, [name.trim()]);
    await log(sessionUser(req), 'Raport Stanów – dodano jednostkę', name.trim());
    req.flash('success', `Jednostka „${name.trim()}" dodana.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy dodawaniu jednostki.');
    res.redirect('/stock/admin');
  }
});

// Rename category across items + catalog
router.post('/admin/categories/rename', requireManager, async (req, res) => {
  try {
    const { report_type, old_category, new_category } = req.body;
    if (!old_category || !new_category?.trim()) {
      req.flash('error', 'Podaj nową nazwę kategorii.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    const n = new_category.trim();
    await db.run(`UPDATE stock_items SET category=? WHERE report_type=? AND category=?`, [n, report_type, old_category]);
    await db.run(`UPDATE stock_categories SET name=? WHERE report_type=? AND name=?`, [n, report_type, old_category]);
    await log(sessionUser(req), 'Raport Stanów – zmieniono nazwę kategorii', `${old_category} → ${n} | Typ: ${report_type}`);
    req.flash('success', `Kategoria „${old_category}" → „${n}".`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy zmianie nazwy.');
    res.redirect('/stock/admin');
  }
});

// Delete category from items + catalog
router.post('/admin/categories/delete', requireManager, async (req, res) => {
  try {
    const { report_type, category } = req.body;
    await db.run(`UPDATE stock_items SET category=NULL WHERE report_type=? AND category=?`, [report_type, category]);
    await db.run(`DELETE FROM stock_categories WHERE report_type=? AND name=?`, [report_type, category]);
    await log(sessionUser(req), 'Raport Stanów – usunięto kategorię', `${category} | Typ: ${report_type}`);
    req.flash('success', `Kategoria „${category}" usunięta.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu kategorii.');
    res.redirect('/stock/admin');
  }
});

// Rename unit across items + catalog
router.post('/admin/units/rename', requireManager, async (req, res) => {
  try {
    const { report_type, old_unit, new_unit } = req.body;
    if (!old_unit || !new_unit?.trim()) {
      req.flash('error', 'Podaj nową nazwę jednostki.');
      return res.redirect(`/stock/admin?tab=items&type=${report_type}`);
    }
    const n = new_unit.trim();
    await db.run(`UPDATE stock_items SET unit=? WHERE unit=?`, [n, old_unit]);
    await db.run(`UPDATE stock_units SET name=? WHERE name=?`, [n, old_unit]);
    await log(sessionUser(req), 'Raport Stanów – zmieniono nazwę jednostki', `${old_unit} → ${n}`);
    req.flash('success', `Jednostka „${old_unit}" → „${n}".`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy zmianie jednostki.');
    res.redirect('/stock/admin');
  }
});

// Delete unit from items + catalog
router.post('/admin/units/delete', requireManager, async (req, res) => {
  try {
    const { report_type, unit } = req.body;
    await db.run(`UPDATE stock_items SET unit=NULL WHERE unit=?`, [unit]);
    await db.run(`DELETE FROM stock_units WHERE name=?`, [unit]);
    await log(sessionUser(req), 'Raport Stanów – usunięto jednostkę', unit);
    req.flash('success', `Jednostka „${unit}" usunięta.`);
    res.redirect(`/stock/admin?tab=items&type=${report_type}`);
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu jednostki.');
    res.redirect('/stock/admin');
  }
});

// Add report type
router.post('/admin/types', requireManager, async (req, res) => {
  try {
    const { id, label, icon, description, freq, is_shift_type, sort_order } = req.body;
    if (!id || !label) {
      req.flash('error', 'ID i nazwa są wymagane.');
      return res.redirect('/stock/admin?tab=types');
    }
    const slug = id.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    await db.run(
      `INSERT INTO stock_report_types (id,label,icon,description,freq,is_shift_type,sort_order) VALUES (?,?,?,?,?,?,?)`,
      [slug, label.trim(), icon?.trim() || '📋', description?.trim() || null,
       freq?.trim() || null, is_shift_type === '1' ? 1 : 0, parseInt(sort_order) || 50]
    );
    await log(sessionUser(req), 'Raport Stanów – dodano typ raportu', `${slug} | ${label.trim()}`);
    req.flash('success', `Typ raportu "${label}" dodany.`);
    res.redirect('/stock/admin?tab=types');
  } catch (e) {
    console.error(e);
    req.flash('error', e.code === 'ER_DUP_ENTRY' ? 'ID już istnieje – wybierz inne.' : 'Błąd przy dodawaniu.');
    res.redirect('/stock/admin?tab=types');
  }
});

// Update report type
router.post('/admin/types/:id', requireManager, async (req, res) => {
  try {
    const { label, icon, description, freq, is_shift_type, sort_order } = req.body;
    await db.run(
      `UPDATE stock_report_types SET label=?,icon=?,description=?,freq=?,is_shift_type=?,sort_order=? WHERE id=?`,
      [label?.trim(), icon?.trim() || '📋', description?.trim() || null,
       freq?.trim() || null, is_shift_type === '1' ? 1 : 0, parseInt(sort_order) || 0, req.params.id]
    );
    req.flash('success', 'Typ zaktualizowany.');
    res.redirect('/stock/admin?tab=types');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy aktualizacji.');
    res.redirect('/stock/admin?tab=types');
  }
});

// Toggle report type active
router.post('/admin/types/:id/toggle', requireManager, async (req, res) => {
  try {
    const t = await db.get(`SELECT * FROM stock_report_types WHERE id=?`, [req.params.id]);
    if (t) await db.run(`UPDATE stock_report_types SET active=? WHERE id=?`, [t.active ? 0 : 1, t.id]);
    res.redirect('/stock/admin?tab=types');
  } catch (e) {
    console.error(e);
    res.redirect('/stock/admin?tab=types');
  }
});

// Delete report
router.delete('/admin/reports/:id', requireManager, async (req, res) => {
  try {
    const toDelReport = await db.get(`SELECT report_date, report_type FROM stock_reports WHERE id=?`, [req.params.id]);
    await db.run(`DELETE FROM stock_reports WHERE id=?`, [req.params.id]);
    await log(sessionUser(req), 'Raport Stanów – usunięto raport', `Typ: ${toDelReport?.report_type} | Data: ${toDelReport?.report_date}`);
    req.flash('success', 'Raport usunięty.');
    res.redirect('/stock/admin?tab=history');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Błąd przy usuwaniu.');
    res.redirect('/stock/admin?tab=history');
  }
});

module.exports = router;
