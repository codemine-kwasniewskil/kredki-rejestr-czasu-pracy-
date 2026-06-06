'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const crypto  = require('crypto');
const db      = require('../database/db');
const { requireRole, getLocationId, requireFeature } = require('../middleware/auth');
const { parseMbankCSV, parseCardTerminalTitle } = require('../utils/bankParser');
const { categorizeAndSave }   = require('../utils/categorizer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Tylko pliki CSV są dozwolone.'));
    }
  },
});

// All finance routes: admin only + feature check
router.use(requireRole('admin'));
router.use(requireFeature('finance'));

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n === null || n === undefined) return '0,00';
  return Number(n).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Billing-month extraction ──────────────────────────────────────────────────
// Returns the difference in months: laterKey − earlierKey (positive if later is after)
function monthDiff(laterKey, earlierKey) {
  const [ly, lm] = laterKey.split('-').map(Number);
  const [ey, em] = earlierKey.split('-').map(Number);
  return (ly - ey) * 12 + (lm - em);
}

// Polish month prefixes long enough to avoid false matches
const MONTHS_PL_RE = [
  [/\bstycze[nń]/i, 1],
  [/\bluty?\b/i, 2],
  [/\bmarzec\b/i, 3],
  [/\bkwietni/i, 4],
  [/\bmaj[au]?\b/i, 5],
  [/\bczerwi?e/i, 6],
  [/\blipiec\b|lipc/i, 7],
  [/\bsierpni/i, 8],
  [/\bwrześni|wrzesni/i, 9],
  [/\bpaździe|pazdzier/i, 10],
  [/\blistopa/i, 11],
  [/\bgrudni/i, 12],
];

function prevMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Try to extract a billing month from a bank transfer title.
 * Only re-dates to a month that is 1–3 months BEFORE the booking month,
 * so future-dating and ancient references are ignored.
 * Returns a YYYY-MM string (either extracted or the original txMonthKey).
 */
function extractBillingMonth(title, txMonthKey) {
  if (!title) return txMonthKey;

  // Numeric MM/YYYY or MM.YYYY  (e.g. "03/2024", "03.2024")
  const m1 = title.match(/\b(0?[1-9]|1[0-2])[\/\.](20\d{2})\b/);
  if (m1) {
    const candidate = `${m1[2]}-${String(parseInt(m1[1], 10)).padStart(2, '0')}`;
    const diff = monthDiff(txMonthKey, candidate);
    if (diff >= 1 && diff <= 3) return candidate;
  }

  // Numeric MM/YY  (e.g. "03/24")
  if (!m1) {
    const m2 = title.match(/\b(0?[1-9]|1[0-2])\/(2\d)\b/);
    if (m2) {
      const candidate = `20${m2[2]}-${String(parseInt(m2[1], 10)).padStart(2, '0')}`;
      const diff = monthDiff(txMonthKey, candidate);
      if (diff >= 1 && diff <= 3) return candidate;
    }
  }

  // Polish month name + 4-digit year  (e.g. "za marzec 2024")
  const yearM = title.match(/\b(20\d{2})\b/);
  if (yearM) {
    for (const [re, monthNum] of MONTHS_PL_RE) {
      if (re.test(title)) {
        const candidate = `${yearM[1]}-${String(monthNum).padStart(2, '0')}`;
        const diff = monthDiff(txMonthKey, candidate);
        if (diff >= 1 && diff <= 3) return candidate;
        break;
      }
    }
  }

  return txMonthKey;
}

async function getAllCategories() {
  return db.all('SELECT * FROM finance_categories ORDER BY display_order');
}

async function getAvailableMonths(locationId) {
  return db.all(`
    SELECT DISTINCT month_key
    FROM bank_transactions
    WHERE location_id = ?
    ORDER BY month_key DESC
    LIMIT 36
  `, [locationId]);
}

// ─── Generate financial events for all transactions in an import file ─────────

async function generateFinancialEvents(importFileId, locationId) {
  const categories  = await getAllCategories();
  const catMap      = new Map(categories.map(c => [c.id, c]));
  const catSlugMap  = new Map(categories.map(c => [c.slug, c]));
  const EXCLUDED    = new Set(['owner_transfer','internal_transfer','donation_or_private_transfer','not_relevant']);

  // Resolve locationId from import file if not passed
  if (!locationId) {
    const importFile = await db.get('SELECT location_id FROM bank_import_files WHERE id=?', [importFileId]);
    locationId = importFile ? importFile.location_id : 1;
  }

  const transactions = await db.all(
    'SELECT * FROM bank_transactions WHERE import_file_id = ?',
    [importFileId]
  );

  // Delete existing events for this import (idempotent)
  await db.run(`
    DELETE fe FROM financial_events fe
    INNER JOIN bank_transactions bt ON bt.id = fe.bank_transaction_id
    WHERE bt.import_file_id = ?
  `, [importFileId]);

  for (const tx of transactions) {
    if (!tx.is_relevant) continue;

    const cat = tx.category_id ? catMap.get(tx.category_id) : null;
    if (cat && EXCLUDED.has(cat.slug)) continue;

    const status = tx.status === 'relevant' ? 'relevant'
                 : tx.status === 'review'   ? 'review'
                 : 'not_relevant';

    // Card terminal: split into gross income + fee cost
    if (cat && cat.slug === 'card_terminal_sales' && tx.direction === 'income') {
      const parsed = parseCardTerminalTitle(tx.title);
      if (parsed && parsed.gross > 0) {
        const feeCat = catSlugMap.get('payment_provider_fee');
        await db.run(`
          INSERT INTO financial_events
            (bank_transaction_id, event_date, month_key, source, event_type, category_id,
             amount, gross_amount, net_amount, fee_amount, description, counterparty_name, is_relevant, status, location_id)
          VALUES (?, ?, ?, 'bank', 'income', ?, ?, ?, ?, ?, ?, ?, 1, 'relevant', ?)
        `, [tx.id, tx.booking_date, tx.month_key, tx.category_id,
            parsed.gross, parsed.gross, tx.amount, parsed.fee,
            tx.title, tx.counterparty_name, locationId]);

        if (feeCat && parsed.fee > 0) {
          await db.run(`
            INSERT INTO financial_events
              (bank_transaction_id, event_date, month_key, source, event_type, category_id,
               amount, description, counterparty_name, is_relevant, status, location_id)
            VALUES (?, ?, ?, 'bank', 'cost', ?, ?, ?, ?, 1, 'relevant', ?)
          `, [tx.id, tx.booking_date, tx.month_key, feeCat.id,
              -parsed.fee, 'Prowizja terminala', tx.counterparty_name, locationId]);
        }
        continue;
      }
    }

    // Normal single event
    const eventType = tx.direction === 'income' ? 'income'
                    : (cat && cat.event_type === 'cost' ? 'cost' : 'cost');

    const billingMonthKey = eventType === 'cost'
      ? (cat && cat.slug === 'employee_cost'
          ? prevMonthKey(tx.month_key)
          : extractBillingMonth(tx.title, tx.month_key))
      : tx.month_key;

    await db.run(`
      INSERT INTO financial_events
        (bank_transaction_id, event_date, month_key, source, event_type, category_id,
         amount, description, counterparty_name, is_relevant, status, location_id)
      VALUES (?, ?, ?, 'bank', ?, ?, ?, ?, ?, ?, ?, ?)
    `, [tx.id, tx.booking_date, billingMonthKey, eventType, tx.category_id,
        tx.amount, tx.title, tx.counterparty_name, tx.is_relevant ? 1 : 0, status, locationId]);
  }
}

// ─── GET /finance ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => res.redirect('/finance/monthly'));

// ─── GET /finance/import ──────────────────────────────────────────────────────
router.get('/import', async (req, res) => {
  try {
    const locationId = getLocationId(req);
    const imports = await db.all(`
      SELECT bif.*, u.name AS imported_by_name
      FROM bank_import_files bif
      LEFT JOIN users u ON u.id = bif.imported_by_user_id
      WHERE bif.location_id = ?
      ORDER BY bif.imported_at DESC
      LIMIT 20
    `, [locationId]);
    res.render('finance/import', {
      title: 'Import wyciągu bankowego',
      currentPath: '/finance/import',
      imports, fmt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ─── POST /finance/import ─────────────────────────────────────────────────────
router.post('/import', upload.single('csv_file'), async (req, res) => {
  try {
    if (!req.file) {
      req.flash('error', 'Nie przesłano pliku CSV.');
      return res.redirect('/finance/import');
    }

    const locationId = getLocationId(req);
    const buffer   = req.file.buffer;
    const fileName = req.file.originalname;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Check if this exact file was already imported (for this location)
    const existingImport = await db.get(
      'SELECT id, file_name, imported_at FROM bank_import_files WHERE file_hash = ? AND location_id = ?',
      [fileHash, locationId]
    );

    // Parse CSV
    const parsed = parseMbankCSV(buffer);

    if (parsed.errors.length && !parsed.transactions.length) {
      req.flash('error', 'Błąd parsowania: ' + parsed.errors.join('; '));
      return res.redirect('/finance/import');
    }

    const { meta, transactions } = parsed;

    // Validation checks
    const validations = [];
    const actualCount = transactions.length;
    const expectedCount = meta.transaction_count;

    validations.push({
      label: 'Liczba transakcji',
      expected: expectedCount,
      actual: actualCount,
      ok: expectedCount === null || actualCount === expectedCount,
    });

    const actualIncome  = transactions.filter(t => t.direction === 'income')
                                      .reduce((s, t) => s + t.amount, 0);
    const actualExpense = transactions.filter(t => t.direction === 'expense')
                                      .reduce((s, t) => s + Math.abs(t.amount), 0);

    validations.push({
      label: 'Suma przychodów',
      expected: meta.income_total,
      actual: Math.round(actualIncome * 100) / 100,
      ok: meta.income_total === null || Math.abs(actualIncome - meta.income_total) < 0.02,
    });
    validations.push({
      label: 'Suma wydatków',
      expected: meta.expense_total,
      actual: Math.round(actualExpense * 100) / 100,
      ok: meta.expense_total === null || Math.abs(actualExpense - meta.expense_total) < 0.02,
    });

    // First/last balance reconciliation
    if (transactions.length > 0) {
      const firstBalance = transactions[0].balance_after - transactions[0].amount;
      validations.push({
        label: 'Saldo otwarcia',
        expected: meta.opening_balance,
        actual: Math.round(firstBalance * 100) / 100,
        ok: meta.opening_balance === null || Math.abs(firstBalance - meta.opening_balance) < 0.02,
      });
      const lastBalance = transactions[transactions.length - 1].balance_after;
      validations.push({
        label: 'Saldo zamknięcia (ostatnia transakcja)',
        expected: null,
        actual: Math.round(lastBalance * 100) / 100,
        ok: true,
      });
    }

    // Save to DB
    let importFileId;
    let importedCount = 0;
    let skippedCount  = 0;

    if (existingImport) {
      importFileId = existingImport.id;
    } else {
      const lastBalance = transactions.length
        ? transactions[transactions.length - 1].balance_after
        : null;
      const r = await db.run(`
        INSERT INTO bank_import_files
          (file_name, bank_name, account_number, statement_period_start, statement_period_end,
           currency, opening_balance, closing_balance,
           income_total_from_statement, expense_total_from_statement,
           transaction_count_from_statement, file_hash, imported_by_user_id, location_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        fileName, 'mBank', meta.account_number,
        meta.period_start, meta.period_end,
        meta.currency || 'PLN',
        meta.opening_balance, lastBalance,
        meta.income_total, meta.expense_total,
        meta.transaction_count, fileHash,
        req.session.userId, locationId,
      ]);
      importFileId = r.insertId;
    }

    // Insert transactions (skip duplicates via UNIQUE raw_hash)
    for (const tx of transactions) {
      try {
        await db.run(`
          INSERT INTO bank_transactions
            (import_file_id, booking_date, operation_date, operation_type, title,
             counterparty_name, counterparty_account, amount, balance_after, currency,
             direction, month_key, raw_row_number, raw_hash, is_relevant, status, location_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'review',?)
        `, [
          importFileId, tx.booking_date, tx.operation_date, tx.operation_type,
          tx.title, tx.counterparty_name, tx.counterparty_account,
          tx.amount, tx.balance_after, meta.currency || 'PLN',
          tx.direction, tx.month_key, tx.raw_row_number, tx.raw_hash, locationId,
        ]);
        importedCount++;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') { skippedCount++; }
        else throw e;
      }
    }

    // Categorize new transactions
    if (importedCount > 0) {
      const newTxs = await db.all(
        'SELECT * FROM bank_transactions WHERE import_file_id = ?',
        [importFileId]
      );
      await categorizeAndSave(newTxs, { overwrite: false });
      await generateFinancialEvents(importFileId, locationId);
    }

    // Card terminal analysis
    const cardTxs = transactions.filter(t => {
      const m = t.title && t.title.match(/KWOTA BRUTTO\s+([\d.]+)\s+KW\.\s*PROW\.\s*([\d.]+)/i);
      return m;
    });
    const cardGrossTotal = cardTxs.reduce((s, t) => {
      const m = t.title.match(/KWOTA BRUTTO\s+([\d.]+)/i);
      return s + (m ? parseFloat(m[1]) : 0);
    }, 0);
    const cardFeeTotal = cardTxs.reduce((s, t) => {
      const m = t.title.match(/KW\.\s*PROW\.\s*([\d.]+)/i);
      return s + (m ? parseFloat(m[1]) : 0);
    }, 0);

    const imports = await db.all(`
      SELECT bif.*, u.name AS imported_by_name
      FROM bank_import_files bif
      LEFT JOIN users u ON u.id = bif.imported_by_user_id
      WHERE bif.location_id = ?
      ORDER BY bif.imported_at DESC
      LIMIT 20
    `, [locationId]);

    res.render('finance/import', {
      title: 'Import wyciągu bankowego',
      currentPath: '/finance/import',
      imports, fmt,
      result: {
        importFileId,
        fileName,
        alreadyExisted: !!existingImport,
        importedCount,
        skippedCount,
        meta,
        validations,
        totalTransactions: transactions.length,
        cardCount: cardTxs.length,
        cardGrossTotal: Math.round(cardGrossTotal * 100) / 100,
        cardNetTotal: Math.round(cardTxs.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        cardFeeTotal: Math.round(cardFeeTotal * 100) / 100,
        monthKey: meta.period_start ? meta.period_start.substring(0, 7) : null,
      },
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Błąd importu: ' + err.message);
    res.redirect('/finance/import');
  }
});

// ─── GET /finance/monthly ─────────────────────────────────────────────────────
router.get('/monthly', (req, res) => res.redirect(`/finance/monthly/${currentMonthKey()}`));

// ─── GET /finance/monthly/:monthKey ──────────────────────────────────────────
router.get('/monthly/:monthKey', async (req, res) => {
  try {
    const monthKey = req.params.monthKey;
    if (!/^\d{4}-\d{2}$/.test(monthKey)) return res.redirect('/finance/monthly');

    const [year, month] = monthKey.split('-').map(Number);
    const MONTHS_PL = ['styczeń','luty','marzec','kwiecień','maj','czerwiec',
                       'lipiec','sierpień','wrzesień','październik','listopad','grudzień'];
    const monthLabel = MONTHS_PL[month - 1] + ' ' + year;

    const locationId = getLocationId(req);
    const availableMonths = await getAvailableMonths(locationId);
    const categories      = await getAllCategories();

    // Monthly summary from financial_events
    const summary = await db.get(`
      SELECT
        COALESCE(SUM(CASE WHEN fc.slug='card_terminal_sales' AND fe.event_type='income' AND fe.is_relevant=1
                         THEN COALESCE(fe.gross_amount, fe.amount) ELSE 0 END),0) AS revenue_card_gross,
        COALESCE(SUM(CASE WHEN fc.slug='card_terminal_sales' AND fe.event_type='income' AND fe.is_relevant=1
                         THEN COALESCE(fe.net_amount, fe.amount) ELSE 0 END),0)   AS revenue_card_net,
        COALESCE(SUM(CASE WHEN fc.slug='cash_sales_deposit'  AND fe.event_type='income' AND fe.is_relevant=1
                         THEN fe.amount ELSE 0 END),0)                             AS revenue_cash,
        COALESCE(SUM(CASE WHEN fc.slug NOT IN ('card_terminal_sales','cash_sales_deposit')
                              AND fe.event_type='income' AND fe.is_relevant=1
                         THEN fe.amount ELSE 0 END),0)                             AS revenue_other,
        COALESCE(SUM(CASE WHEN fe.event_type='income' AND fe.is_relevant=1
                         THEN COALESCE(fe.gross_amount, fe.amount) ELSE 0 END),0) AS revenue_total,
        COALESCE(SUM(CASE WHEN fc.slug IN ('food_beverage_supplier','coffee_supplier','bakery_supplier')
                              AND fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_goods,
        COALESCE(SUM(CASE WHEN fc.slug='employee_cost' AND fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_employees,
        COALESCE(SUM(CASE WHEN fc.slug='zus' AND fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_zus,
        COALESCE(SUM(CASE WHEN fc.slug IN ('tax_vat','tax_pit') AND fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_taxes,
        COALESCE(SUM(CASE WHEN fc.slug='payment_provider_fee' AND fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_payment_fees,
        COALESCE(SUM(CASE WHEN fc.slug='bank_fee' AND fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_bank_fees,
        COALESCE(SUM(CASE WHEN fc.slug NOT IN
                        ('employee_cost','zus','tax_vat','tax_pit','payment_provider_fee','bank_fee',
                         'food_beverage_supplier','coffee_supplier','bakery_supplier')
                              AND fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_other,
        COALESCE(SUM(CASE WHEN fe.event_type='cost' AND fe.is_relevant=1
                         THEN ABS(fe.amount) ELSE 0 END),0)                       AS cost_total,
        COALESCE(SUM(CASE WHEN fe.is_relevant=0 THEN ABS(fe.amount) ELSE 0 END),0) AS excluded_total,
        COUNT(CASE WHEN fe.status='review' AND fe.is_relevant=1 THEN 1 END)       AS review_count
      FROM financial_events fe
      LEFT JOIN finance_categories fc ON fc.id = fe.category_id
      WHERE fe.month_key = ? AND fe.location_id = ?
    `, [monthKey, locationId]) || {};

    summary.real_income = (summary.revenue_total || 0) - (summary.cost_total || 0);
    summary.operating_profit_before_tax_zus =
      (summary.revenue_total || 0) -
      ((summary.cost_total || 0) - (summary.cost_taxes || 0) - (summary.cost_zus || 0));

    // Bank cashflow
    const bankSummary = await db.get(`
      SELECT
        COALESCE(SUM(amount), 0) AS raw_net_cashflow,
        COALESCE(SUM(CASE WHEN direction='income'  THEN amount ELSE 0 END), 0)       AS raw_income,
        COALESCE(SUM(CASE WHEN direction='expense' THEN ABS(amount) ELSE 0 END), 0)  AS raw_expenses,
        COUNT(*) AS tx_count
      FROM bank_transactions
      WHERE month_key = ? AND location_id = ?
    `, [monthKey, locationId]) || {};

    summary.raw_bank_cashflow = bankSummary.raw_net_cashflow || 0;
    summary.raw_bank_income   = bankSummary.raw_income       || 0;
    summary.raw_bank_expenses = bankSummary.raw_expenses     || 0;
    summary.tx_count          = bankSummary.tx_count         || 0;
    summary.difference_vs_bank = (summary.real_income || 0) - (summary.raw_bank_cashflow || 0);

    // Category breakdown for chart
    const catBreakdown = await db.all(`
      SELECT fc.slug, fc.name, fc.event_type,
             COALESCE(SUM(ABS(fe.amount)), 0) AS total
      FROM financial_events fe
      JOIN finance_categories fc ON fc.id = fe.category_id
      WHERE fe.month_key = ? AND fe.is_relevant = 1 AND fe.location_id = ?
      GROUP BY fc.id, fc.slug, fc.name, fc.event_type
      ORDER BY fc.display_order
    `, [monthKey, locationId]);

    // All transactions for this month
    const transactions = await db.all(`
      SELECT bt.*,
             fc.slug     AS category_slug,
             fc.name     AS category_name,
             fc.event_type AS category_event_type
      FROM bank_transactions bt
      LEFT JOIN finance_categories fc ON fc.id = bt.category_id
      WHERE bt.month_key = ? AND bt.location_id = ?
      ORDER BY bt.booking_date, bt.id
    `, [monthKey, locationId]);

    // Cost transactions from OTHER months whose billing month was re-dated to this month
    const redatedCosts = await db.all(`
      SELECT bt.*,
             fc.slug        AS category_slug,
             fc.name        AS category_name,
             fe.amount      AS event_amount,
             fe.month_key   AS billed_month_key
      FROM financial_events fe
      JOIN bank_transactions bt ON bt.id = fe.bank_transaction_id
      LEFT JOIN finance_categories fc ON fc.id = bt.category_id
      WHERE fe.month_key = ?
        AND bt.month_key != ?
        AND fe.event_type = 'cost'
        AND fe.is_relevant = 1
        AND fe.location_id = ?
      ORDER BY bt.booking_date, bt.id
    `, [monthKey, monthKey, locationId]);

    // Payroll data for this month (employer costs from accountant lista płac)
    let payrollSummary = null;
    try {
      payrollSummary = await db.get(`
        SELECT
          COUNT(*)                AS employee_count,
          SUM(gross_amount)       AS total_gross,
          SUM(paid_amount)        AS total_paid,
          SUM(zus_employer)       AS total_zus_employer,
          SUM(employer_cost)      AS total_employer_cost,
          MAX(payment_date)       AS payment_date
        FROM payroll_costs
        WHERE period_month = ? AND location_id = ?
      `, [monthKey, locationId]);
      if (payrollSummary && !payrollSummary.employee_count) payrollSummary = null;
    } catch (_) { /* columns not yet added — seed not run */ }

    res.render('finance/monthly', {
      title: 'Finanse ' + monthLabel,
      currentPath: '/finance/monthly',
      monthKey, monthLabel, availableMonths, categories,
      summary, bankSummary, catBreakdown, transactions, redatedCosts,
      payrollSummary, fmt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ─── GET /finance/payroll ─────────────────────────────────────────────────────
router.get('/payroll', async (req, res) => {
  try {
    const locationId = getLocationId(req);
    let payrollRows;
    try {
      payrollRows = await db.all(`
        SELECT pc.id, pc.period_month, pc.employee_name_raw,
               u.name AS employee_name,
               pc.gross_amount, pc.zus_employee, pc.nfz_amount, pc.pit_amount,
               pc.net_amount, pc.paid_amount, pc.zus_employer, pc.employer_cost,
               pc.payment_date, pc.review_status, pc.bank_reconciled
        FROM payroll_costs pc
        LEFT JOIN users u ON u.id = pc.employee_id
        WHERE pc.location_id = ?
        ORDER BY pc.period_month DESC, pc.employee_name_raw
      `, [locationId]);
    } catch (_) {
      payrollRows = await db.all(`
        SELECT pc.id, pc.period_month, pc.employee_name_raw,
               u.name AS employee_name,
               pc.gross_amount, pc.net_amount, pc.employer_cost,
               pc.review_status, pc.bank_reconciled,
               0 AS zus_employee, 0 AS nfz_amount, 0 AS pit_amount,
               0 AS zus_employer, pc.employer_cost AS paid_amount, NULL AS payment_date
        FROM payroll_costs pc
        LEFT JOIN users u ON u.id = pc.employee_id
        WHERE pc.location_id = ?
        ORDER BY pc.period_month DESC, pc.employee_name_raw
      `, [locationId]);
    }

    // Group by period_month with totals
    const byMonth = {};
    for (const row of payrollRows) {
      if (!byMonth[row.period_month]) {
        byMonth[row.period_month] = { rows: [], totals: { gross: 0, zus_emp: 0, nfz: 0, pit: 0, net: 0, paid: 0, zus_firm: 0, cost: 0 } };
      }
      byMonth[row.period_month].rows.push(row);
      const t = byMonth[row.period_month].totals;
      t.gross    += Number(row.gross_amount  || 0);
      t.zus_emp  += Number(row.zus_employee  || 0);
      t.nfz      += Number(row.nfz_amount    || 0);
      t.pit      += Number(row.pit_amount    || 0);
      t.net      += Number(row.net_amount    || 0);
      t.paid     += Number(row.paid_amount   || 0);
      t.zus_firm += Number(row.zus_employer  || 0);
      t.cost     += Number(row.employer_cost || 0);
    }

    const payrollMonths = Object.keys(byMonth).sort().reverse();

    // Bank employee payments grouped by month (for reconciliation reference)
    const bankPayments = await db.all(`
      SELECT bt.month_key, bt.counterparty_name, bt.amount, bt.booking_date, bt.title
      FROM bank_transactions bt
      JOIN finance_categories fc ON fc.id = bt.category_id
      WHERE fc.slug = 'employee_cost' AND bt.location_id = ?
      ORDER BY bt.month_key DESC, bt.counterparty_name
    `, [locationId]);
    const bankByMonth = {};
    for (const p of bankPayments) {
      if (!bankByMonth[p.month_key]) bankByMonth[p.month_key] = [];
      bankByMonth[p.month_key].push(p);
    }

    const MONTHS_PL_LABELS = {
      '01': 'Styczeń', '02': 'Luty', '03': 'Marzec', '04': 'Kwiecień',
      '05': 'Maj', '06': 'Czerwiec', '07': 'Lipiec', '08': 'Sierpień',
      '09': 'Wrzesień', '10': 'Październik', '11': 'Listopad', '12': 'Grudzień',
    };
    function monthLabel(mk) {
      const [y, m] = mk.split('-');
      return (MONTHS_PL_LABELS[m] || m) + ' ' + y;
    }

    res.render('finance/payroll', {
      title: 'Koszty pracownicze',
      currentPath: '/finance/payroll',
      byMonth, payrollMonths, bankByMonth, monthLabel, fmt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ─── PATCH /finance/api/transactions/:id ─────────────────────────────────────
router.patch('/api/transactions/:id', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { category_id, status, is_relevant, user_note } = req.body;

    const allowed = ['relevant','not_relevant','review','duplicate','internal_transfer'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: 'Nieprawidłowy status.' });
    }

    const tx = await db.get('SELECT * FROM bank_transactions WHERE id = ?', [id]);
    if (!tx) return res.status(404).json({ error: 'Nie znaleziono transakcji.' });

    const updates  = [];
    const values   = [];
    let didChange  = false;

    if (category_id !== undefined) {
      updates.push('category_id = ?');
      values.push(category_id === '' || category_id === null ? null : parseInt(category_id, 10));
      didChange = true;
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
      const isRel = status === 'relevant' || status === 'review' ? 1 : 0;
      updates.push('is_relevant = ?');
      values.push(isRel);
      didChange = true;
    }
    if (is_relevant !== undefined) {
      updates.push('is_relevant = ?');
      values.push(is_relevant ? 1 : 0);
      didChange = true;
    }
    if (user_note !== undefined) {
      updates.push('user_note = ?');
      values.push(user_note);
    }
    if (didChange) {
      updates.push('manually_categorized = 1');
    }

    if (updates.length) {
      values.push(id);
      await db.run(
        `UPDATE bank_transactions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );
    }

    // Regenerate financial events for this transaction
    const updatedTx = await db.get('SELECT * FROM bank_transactions WHERE id = ?', [id]);
    await db.run('DELETE FROM financial_events WHERE bank_transaction_id = ?', [id]);
    await generateFinancialEventsForSingle(updatedTx);

    const withCat = await db.get(`
      SELECT bt.*, fc.slug AS category_slug, fc.name AS category_name
      FROM bank_transactions bt
      LEFT JOIN finance_categories fc ON fc.id = bt.category_id
      WHERE bt.id = ?
    `, [id]);

    res.json({ success: true, transaction: withCat });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /finance/api/transactions/:id/recategorize ─────────────────────────
router.post('/api/transactions/:id/recategorize', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tx = await db.get('SELECT * FROM bank_transactions WHERE id = ?', [id]);
    if (!tx) return res.status(404).json({ error: 'Nie znaleziono transakcji.' });

    await db.run('UPDATE bank_transactions SET manually_categorized = 0 WHERE id = ?', [id]);
    const fresh = await db.get('SELECT * FROM bank_transactions WHERE id = ?', [id]);
    await require('../utils/categorizer').categorizeAndSave([fresh], { overwrite: true });
    const reCat = await db.get('SELECT * FROM bank_transactions WHERE id = ?', [id]);
    await db.run('DELETE FROM financial_events WHERE bank_transaction_id = ?', [id]);
    await generateFinancialEventsForSingle(reCat);

    const withCat = await db.get(`
      SELECT bt.*, fc.slug AS category_slug, fc.name AS category_name
      FROM bank_transactions bt
      LEFT JOIN finance_categories fc ON fc.id = bt.category_id
      WHERE bt.id = ?
    `, [id]);
    res.json({ success: true, transaction: withCat });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /finance/api/imports/:id/recategorize ───────────────────────────────
router.post('/api/imports/:id/recategorize', express.json(), async (req, res) => {
  try {
    const importFileId   = parseInt(req.params.id, 10);
    const overwriteManual = req.body && req.body.overwrite_manual;

    const txs = await db.all(
      'SELECT * FROM bank_transactions WHERE import_file_id = ?',
      [importFileId]
    );
    if (!overwriteManual) {
      await db.run(
        'UPDATE bank_transactions SET manually_categorized = 0 WHERE import_file_id = ? AND manually_categorized = 0',
        [importFileId]
      );
    }
    const result = await require('../utils/categorizer').categorizeAndSave(txs, { overwrite: !!overwriteManual });
    await generateFinancialEvents(importFileId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper: generate financial events for a single transaction ───────────────
async function generateFinancialEventsForSingle(tx) {
  const categories = await getAllCategories();
  const catMap     = new Map(categories.map(c => [c.id, c]));
  const catSlugMap = new Map(categories.map(c => [c.slug, c]));
  const EXCLUDED   = new Set(['owner_transfer','internal_transfer','donation_or_private_transfer','not_relevant']);

  if (!tx.is_relevant) return;
  const cat = tx.category_id ? catMap.get(tx.category_id) : null;
  if (cat && EXCLUDED.has(cat.slug)) return;

  const status = tx.status === 'relevant' ? 'relevant'
               : tx.status === 'review'   ? 'review'
               : 'not_relevant';

  const txLocationId = tx.location_id || 1;

  if (cat && cat.slug === 'card_terminal_sales' && tx.direction === 'income') {
    const parsed = parseCardTerminalTitle(tx.title);
    if (parsed && parsed.gross > 0) {
      const feeCat = catSlugMap.get('payment_provider_fee');
      await db.run(`
        INSERT INTO financial_events
          (bank_transaction_id, event_date, month_key, source, event_type, category_id,
           amount, gross_amount, net_amount, fee_amount, description, counterparty_name, is_relevant, status, location_id)
        VALUES (?, ?, ?, 'bank', 'income', ?, ?, ?, ?, ?, ?, ?, 1, 'relevant', ?)
      `, [tx.id, tx.booking_date, tx.month_key, tx.category_id,
          parsed.gross, parsed.gross, tx.amount, parsed.fee,
          tx.title, tx.counterparty_name, txLocationId]);
      if (feeCat && parsed.fee > 0) {
        await db.run(`
          INSERT INTO financial_events
            (bank_transaction_id, event_date, month_key, source, event_type, category_id,
             amount, description, counterparty_name, is_relevant, status, location_id)
          VALUES (?, ?, ?, 'bank', 'cost', ?, ?, ?, ?, 1, 'relevant', ?)
        `, [tx.id, tx.booking_date, tx.month_key, feeCat.id,
            -parsed.fee, 'Prowizja terminala', tx.counterparty_name, txLocationId]);
      }
      return;
    }
  }

  const eventType = tx.direction === 'income' ? 'income'
                  : (cat && cat.event_type === 'cost' ? 'cost' : 'cost');

  const billingMonthKey = eventType === 'cost'
    ? extractBillingMonth(tx.title, tx.month_key)
    : tx.month_key;

  await db.run(`
    INSERT INTO financial_events
      (bank_transaction_id, event_date, month_key, source, event_type, category_id,
       amount, description, counterparty_name, is_relevant, status, location_id)
    VALUES (?, ?, ?, 'bank', ?, ?, ?, ?, ?, ?, ?, ?)
  `, [tx.id, tx.booking_date, billingMonthKey, eventType, tx.category_id,
      tx.amount, tx.title, tx.counterparty_name, tx.is_relevant ? 1 : 0, status, txLocationId]);
}

module.exports = router;
