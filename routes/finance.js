'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const crypto  = require('crypto');
const db      = require('../database/db');
const { requireRole }         = require('../middleware/auth');
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

// All finance routes: admin only
router.use(requireRole('admin'));

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n === null || n === undefined) return '0,00';
  return Number(n).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function getAllCategories() {
  return db.all('SELECT * FROM finance_categories ORDER BY display_order');
}

async function getAvailableMonths() {
  return db.all(`
    SELECT DISTINCT month_key
    FROM bank_transactions
    ORDER BY month_key DESC
    LIMIT 36
  `);
}

// ─── Generate financial events for all transactions in an import file ─────────

async function generateFinancialEvents(importFileId) {
  const categories  = await getAllCategories();
  const catMap      = new Map(categories.map(c => [c.id, c]));
  const catSlugMap  = new Map(categories.map(c => [c.slug, c]));
  const EXCLUDED    = new Set(['owner_transfer','internal_transfer','donation_or_private_transfer','not_relevant']);

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
             amount, gross_amount, net_amount, fee_amount, description, counterparty_name, is_relevant, status)
          VALUES (?, ?, ?, 'bank', 'income', ?, ?, ?, ?, ?, ?, ?, 1, 'relevant')
        `, [tx.id, tx.booking_date, tx.month_key, tx.category_id,
            parsed.gross, parsed.gross, tx.amount, parsed.fee,
            tx.title, tx.counterparty_name]);

        if (feeCat && parsed.fee > 0) {
          await db.run(`
            INSERT INTO financial_events
              (bank_transaction_id, event_date, month_key, source, event_type, category_id,
               amount, description, counterparty_name, is_relevant, status)
            VALUES (?, ?, ?, 'bank', 'cost', ?, ?, ?, ?, 1, 'relevant')
          `, [tx.id, tx.booking_date, tx.month_key, feeCat.id,
              -parsed.fee, 'Prowizja terminala', tx.counterparty_name]);
        }
        continue;
      }
    }

    // Normal single event
    const eventType = tx.direction === 'income' ? 'income'
                    : (cat && cat.event_type === 'cost' ? 'cost' : 'cost');

    await db.run(`
      INSERT INTO financial_events
        (bank_transaction_id, event_date, month_key, source, event_type, category_id,
         amount, description, counterparty_name, is_relevant, status)
      VALUES (?, ?, ?, 'bank', ?, ?, ?, ?, ?, ?, ?)
    `, [tx.id, tx.booking_date, tx.month_key, eventType, tx.category_id,
        tx.amount, tx.title, tx.counterparty_name, tx.is_relevant ? 1 : 0, status]);
  }
}

// ─── GET /finance ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => res.redirect('/finance/monthly'));

// ─── GET /finance/import ──────────────────────────────────────────────────────
router.get('/import', async (req, res) => {
  try {
    const imports = await db.all(`
      SELECT bif.*, u.name AS imported_by_name
      FROM bank_import_files bif
      LEFT JOIN users u ON u.id = bif.imported_by_user_id
      ORDER BY bif.imported_at DESC
      LIMIT 20
    `);
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

    const buffer   = req.file.buffer;
    const fileName = req.file.originalname;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Check if this exact file was already imported
    const existingImport = await db.get(
      'SELECT id, file_name, imported_at FROM bank_import_files WHERE file_hash = ?',
      [fileHash]
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
           transaction_count_from_statement, file_hash, imported_by_user_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        fileName, 'mBank', meta.account_number,
        meta.period_start, meta.period_end,
        meta.currency || 'PLN',
        meta.opening_balance, lastBalance,
        meta.income_total, meta.expense_total,
        meta.transaction_count, fileHash,
        req.session.userId,
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
             direction, month_key, raw_row_number, raw_hash, is_relevant, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'review')
        `, [
          importFileId, tx.booking_date, tx.operation_date, tx.operation_type,
          tx.title, tx.counterparty_name, tx.counterparty_account,
          tx.amount, tx.balance_after, meta.currency || 'PLN',
          tx.direction, tx.month_key, tx.raw_row_number, tx.raw_hash,
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
      await generateFinancialEvents(importFileId);
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
      ORDER BY bif.imported_at DESC
      LIMIT 20
    `);

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

    const availableMonths = await getAvailableMonths();
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
      WHERE fe.month_key = ?
    `, [monthKey]) || {};

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
      WHERE month_key = ?
    `, [monthKey]) || {};

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
      WHERE fe.month_key = ? AND fe.is_relevant = 1
      GROUP BY fc.id, fc.slug, fc.name, fc.event_type
      ORDER BY fc.display_order
    `, [monthKey]);

    // All transactions for this month
    const transactions = await db.all(`
      SELECT bt.*,
             fc.slug     AS category_slug,
             fc.name     AS category_name,
             fc.event_type AS category_event_type
      FROM bank_transactions bt
      LEFT JOIN finance_categories fc ON fc.id = bt.category_id
      WHERE bt.month_key = ?
      ORDER BY bt.booking_date, bt.id
    `, [monthKey]);

    res.render('finance/monthly', {
      title: 'Finanse ' + monthLabel,
      currentPath: '/finance/monthly',
      monthKey, monthLabel, availableMonths, categories,
      summary, bankSummary, catBreakdown, transactions, fmt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Błąd serwera.' });
  }
});

// ─── GET /finance/payroll ─────────────────────────────────────────────────────
router.get('/payroll', async (req, res) => {
  try {
    const availableMonths = await getAvailableMonths();

    // Employee bank payments by month
    const employeePayments = await db.all(`
      SELECT bt.month_key, bt.counterparty_name, bt.amount, bt.booking_date,
             bt.title, bt.status, bt.id
      FROM bank_transactions bt
      JOIN finance_categories fc ON fc.id = bt.category_id
      WHERE fc.slug = 'employee_cost'
      ORDER BY bt.month_key DESC, bt.counterparty_name
    `);

    // Payroll costs (if imported)
    const payrollCosts = await db.all(`
      SELECT pc.*, u.name AS employee_name
      FROM payroll_costs pc
      LEFT JOIN users u ON u.id = pc.employee_id
      ORDER BY pc.period_month DESC, pc.employee_name_raw
    `);

    res.render('finance/payroll', {
      title: 'Koszty pracownicze',
      currentPath: '/finance/payroll',
      availableMonths, employeePayments, payrollCosts, fmt,
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

  if (cat && cat.slug === 'card_terminal_sales' && tx.direction === 'income') {
    const parsed = parseCardTerminalTitle(tx.title);
    if (parsed && parsed.gross > 0) {
      const feeCat = catSlugMap.get('payment_provider_fee');
      await db.run(`
        INSERT INTO financial_events
          (bank_transaction_id, event_date, month_key, source, event_type, category_id,
           amount, gross_amount, net_amount, fee_amount, description, counterparty_name, is_relevant, status)
        VALUES (?, ?, ?, 'bank', 'income', ?, ?, ?, ?, ?, ?, ?, 1, 'relevant')
      `, [tx.id, tx.booking_date, tx.month_key, tx.category_id,
          parsed.gross, parsed.gross, tx.amount, parsed.fee,
          tx.title, tx.counterparty_name]);
      if (feeCat && parsed.fee > 0) {
        await db.run(`
          INSERT INTO financial_events
            (bank_transaction_id, event_date, month_key, source, event_type, category_id,
             amount, description, counterparty_name, is_relevant, status)
          VALUES (?, ?, ?, 'bank', 'cost', ?, ?, ?, ?, 1, 'relevant')
        `, [tx.id, tx.booking_date, tx.month_key, feeCat.id,
            -parsed.fee, 'Prowizja terminala', tx.counterparty_name]);
      }
      return;
    }
  }

  const eventType = tx.direction === 'income' ? 'income'
                  : (cat && cat.event_type === 'cost' ? 'cost' : 'cost');
  await db.run(`
    INSERT INTO financial_events
      (bank_transaction_id, event_date, month_key, source, event_type, category_id,
       amount, description, counterparty_name, is_relevant, status)
    VALUES (?, ?, ?, 'bank', ?, ?, ?, ?, ?, ?, ?)
  `, [tx.id, tx.booking_date, tx.month_key, eventType, tx.category_id,
      tx.amount, tx.title, tx.counterparty_name, tx.is_relevant ? 1 : 0, status]);
}

module.exports = router;
