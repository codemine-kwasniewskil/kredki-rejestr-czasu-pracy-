'use strict';
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (_) {}
}
const db = require('./db');

// All payroll data from accountant PDFs (raport_plac ZIPs, password: 5361813052)
// Columns: period, name, gross (Przychód), zus_emp (ZUS pracownik), nfz, pit,
//          net (Netto), paid (Do wypłaty), zus_firm (ZUS firma), cost (Koszt pracodawcy)
const PAYROLL_DATA = [
  // ── Listopad 2025 ─────────────────────────────────────────────
  { period: '2025-11', name: 'Bujakowska, Maria',       gross: 2505.73, zus_emp:    0, nfz:    0, pit:    0, net: 2505.73, paid: 2505.73, zus_firm:    0, cost: 2505.73 },
  { period: '2025-11', name: 'Klimaszewska, Aleksandra',gross: 3014.32, zus_emp:    0, nfz:    0, pit:    0, net: 3014.32, paid: 3014.32, zus_firm:    0, cost: 3014.32 },
  { period: '2025-11', name: 'Stopnicka, Julianna',     gross: 5270.38, zus_emp:  593.45, nfz: 420.92, pit:    0, net: 4256.01, paid: 4256.01, zus_firm:  950.25, cost: 6220.63 },
  { period: '2025-11', name: 'Stsiapanau, Ihar',        gross: 5319.15, zus_emp:    0, nfz:    0, pit:  319.00, net: 5000.15, paid: 5000.15, zus_firm:    0, cost: 5319.15 },
  { period: '2025-11', name: 'Subat, Anisa',            gross: 7301.96, zus_emp:  822.20, nfz: 583.18, pit:  622.00, net: 5274.58, paid: 5274.58, zus_firm: 1316.54, cost: 8618.50 },
  // ── Grudzień 2025 ─────────────────────────────────────────────
  { period: '2025-12', name: 'Bujakowska, Maria',       gross: 1093.66, zus_emp:    0, nfz:    0, pit:    0, net: 1093.66, paid: 1093.66, zus_firm:    0, cost: 1093.66 },
  { period: '2025-12', name: 'Stopnicka, Julianna',     gross: 6274.11, zus_emp:  706.46, nfz: 501.09, pit:    0, net: 5066.56, paid: 5066.56, zus_firm: 1131.22, cost: 7405.33 },
  { period: '2025-12', name: 'Stsiapanau, Ihar',        gross: 5319.15, zus_emp:    0, nfz:    0, pit:  319.00, net: 5000.15, paid: 5000.15, zus_firm:    0, cost: 5319.15 },
  { period: '2025-12', name: 'Subat, Anisa',            gross: 7171.22, zus_emp:  807.48, nfz: 572.74, pit:  311.00, net: 5480.00, paid: 5480.00, zus_firm: 1292.97, cost: 8464.19 },
  // ── Styczeń 2026 ──────────────────────────────────────────────
  { period: '2026-01', name: 'Bujakowska, Maria',       gross: 2386.40, zus_emp:    0, nfz:    0, pit:    0, net: 2386.40, paid: 2386.40, zus_firm:    0, cost: 2386.40 },
  { period: '2026-01', name: 'Stopnicka, Julianna',     gross: 6303.96, zus_emp:  709.83, nfz: 503.47, pit:    0, net: 5090.66, paid: 5090.66, zus_firm: 1136.61, cost: 7440.57 },
  { period: '2026-01', name: 'Stsiapanau, Ihar',        gross: 5319.15, zus_emp:    0, nfz:    0, pit:  319.00, net: 5000.15, paid: 5000.15, zus_firm:    0, cost: 5319.15 },
  { period: '2026-01', name: 'Subat, Anisa',            gross: 6975.02, zus_emp:  785.39, nfz: 557.07, pit:  294.00, net: 5338.56, paid: 5338.56, zus_firm: 1257.60, cost: 8232.62 },
  // ── Luty 2026 ─────────────────────────────────────────────────
  { period: '2026-02', name: 'Bujakowska, Maria',       gross: 2987.71, zus_emp:    0, nfz:    0, pit:    0, net: 2987.71, paid: 2987.71, zus_firm:    0, cost: 2987.71 },
  { period: '2026-02', name: 'Stopnicka, Julianna',     gross: 5613.53, zus_emp:  632.08, nfz: 448.33, pit:    0, net: 4533.12, paid: 4533.12, zus_firm: 1012.12, cost: 6625.65 },
  { period: '2026-02', name: 'Stsiapanau, Ihar',        gross: 5787.00, zus_emp:    0, nfz:    0, pit:  347.00, net: 5440.00, paid: 5440.00, zus_firm:    0, cost: 5787.00 },
  { period: '2026-02', name: 'Subat, Anisa',            gross: 6713.19, zus_emp:  755.91, nfz: 536.16, pit:  272.00, net: 5149.12, paid: 5149.12, zus_firm: 1210.39, cost: 7923.58 },
  // ── Marzec 2026 ───────────────────────────────────────────────
  { period: '2026-03', name: 'Bujakowska, Maria',       gross: 2674.34, zus_emp:    0, nfz:    0, pit:    0, net: 2674.34, paid: 2674.34, zus_firm:    0, cost: 2674.34 },
  { period: '2026-03', name: 'Stopnicka, Julianna',     gross: 5594.12, zus_emp:  629.90, nfz: 446.78, pit:    0, net: 4517.44, paid: 4517.44, zus_firm: 1008.62, cost: 6602.74 },
  { period: '2026-03', name: 'Stsiapanau, Ihar',        gross: 3600.00, zus_emp:    0, nfz:  324.00, pit:   46.00, net: 3230.00, paid: 3230.00, zus_firm:    0, cost: 3600.00 },
  { period: '2026-03', name: 'Subat, Anisa',            gross: 7935.27, zus_emp:  893.51, nfz: 633.76, pit:  376.00, net: 6032.00, paid: 6032.00, zus_firm: 1430.73, cost: 9366.00 },
  { period: '2026-03', name: 'Szajnecka, Aleksandra',   gross: 3192.00, zus_emp:    0, nfz:  192.00, pit:    0, net: 3000.00, paid: 3000.00, zus_firm:    0, cost: 3192.00 },
];

// Primary payment date per period (last/main payment date)
const PAYMENT_DATES = {
  '2025-11': '2025-12-10',
  '2025-12': '2026-01-10',
  '2026-01': '2026-02-10',
  '2026-02': '2026-03-10',
  '2026-03': '2026-04-10',
};

async function addColumnIfMissing(columnDef) {
  try {
    await db.run(`ALTER TABLE payroll_costs ADD COLUMN ${columnDef}`);
    console.log(`  + Added column: ${columnDef.split(' ')[0]}`);
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log(`  ~ Column already exists: ${columnDef.split(' ')[0]}`);
    } else {
      throw e;
    }
  }
}

async function run() {
  console.log('=== Payroll seed: adding columns ===');
  await addColumnIfMissing('zus_employee  DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('nfz_amount    DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('pit_amount    DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('zus_employer  DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('paid_amount   DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('payment_date  DATE');

  // Add unique constraint so seed is idempotent
  try {
    await db.run(`ALTER TABLE payroll_costs ADD UNIQUE KEY uq_period_employee (period_month, employee_name_raw(100))`);
    console.log('  + Added unique key (period_month, employee_name_raw)');
  } catch (e) {
    if (e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_TABLE_EXISTS_ERROR' || (e.message && e.message.includes('Duplicate key name'))) {
      console.log('  ~ Unique key already exists');
    } else {
      throw e;
    }
  }

  console.log('\n=== Payroll seed: inserting data ===');
  let inserted = 0, updated = 0;

  for (const row of PAYROLL_DATA) {
    const paymentDate = PAYMENT_DATES[row.period];

    // Try to match employee to users table by last name
    const lastName = row.name.split(',')[0].trim();
    const user = await db.get(`SELECT id FROM users WHERE name LIKE ?`, [`%${lastName}%`]);
    const userId = user ? user.id : null;

    const result = await db.run(`
      INSERT INTO payroll_costs
        (employee_id, employee_name_raw, period_month,
         gross_amount, zus_employee, nfz_amount, pit_amount,
         net_amount, paid_amount, zus_employer, employer_cost,
         document_type, source_file, review_status, payment_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lista_plac', 'raport_plac_zip', 'approved', ?)
      ON DUPLICATE KEY UPDATE
        employee_id      = VALUES(employee_id),
        gross_amount     = VALUES(gross_amount),
        zus_employee     = VALUES(zus_employee),
        nfz_amount       = VALUES(nfz_amount),
        pit_amount       = VALUES(pit_amount),
        net_amount       = VALUES(net_amount),
        paid_amount      = VALUES(paid_amount),
        zus_employer     = VALUES(zus_employer),
        employer_cost    = VALUES(employer_cost),
        review_status    = VALUES(review_status),
        payment_date     = VALUES(payment_date)
    `, [
      userId, row.name, row.period,
      row.gross, row.zus_emp, row.nfz, row.pit,
      row.net, row.paid, row.zus_firm, row.cost,
      paymentDate,
    ]);

    if (result.affectedRows === 1) { inserted++; console.log(`  + ${row.period} ${row.name}`); }
    else                           { updated++;  console.log(`  ~ ${row.period} ${row.name} (updated)`); }
  }

  console.log(`\nDone: ${inserted} inserted, ${updated} updated.`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
