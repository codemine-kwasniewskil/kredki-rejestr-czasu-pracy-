-- ============================================================
-- Finance Module Migration
-- Run: node database/run_finance_migration.js
-- ============================================================
SET NAMES utf8mb4;

-- ============================================================
-- 1. FINANCE CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS finance_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(80) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  event_type ENUM('income','cost','transfer','excluded') NOT NULL,
  display_order INT DEFAULT 0,
  active TINYINT DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO finance_categories (slug, name, event_type, display_order) VALUES
('card_terminal_sales',      'Sprzedaż kartą (terminal)',         'income',   10),
('cash_sales_deposit',       'Wpłata gotówki ze sprzedaży',       'income',   20),
('too_good_to_go',           'Too Good To Go',                     'income',   30),
('tax_refund',               'Zwrot podatku',                      'income',   40),
('supplier_refund',          'Zwrot od dostawcy',                  'income',   50),
('other_income',             'Inne przychody',                     'income',   99),
('employee_cost',            'Wynagrodzenia pracowników',          'cost',    110),
('zus',                      'ZUS',                                'cost',    120),
('tax_vat',                  'Podatek VAT',                        'cost',    130),
('tax_pit',                  'Podatek PIT-4',                      'cost',    140),
('payment_provider_fee',     'Prowizja terminala płatniczego',     'cost',    150),
('bank_fee',                 'Opłaty bankowe',                     'cost',    160),
('food_beverage_supplier',   'Dostawca jedzenia/napojów',          'cost',    170),
('coffee_supplier',          'Dostawca kawy',                      'cost',    180),
('bakery_supplier',          'Dostawca pieczywa',                  'cost',    190),
('packaging',                'Opakowania',                         'cost',    200),
('cleaning',                 'Artykuły czyszczące',                'cost',    210),
('rent_or_location',         'Czynsz/lokal',                       'cost',    220),
('shop_inventory',           'Towar sklepowy',                     'cost',    230),
('equipment',                'Wyposażenie/sprzęt',                 'cost',    240),
('software_subscription',    'Subskrypcja oprogramowania',         'cost',    250),
('delivery_transport',       'Dostawy/transport',                  'cost',    260),
('accounting',               'Księgowość',                         'cost',    270),
('other_cost',               'Inne koszty',                        'cost',    299),
('owner_transfer',           'Przelew właściciela',                'excluded',310),
('internal_transfer',        'Przelew wewnętrzny',                 'excluded',320),
('donation_or_private_transfer','Darowizna/przelew prywatny',      'excluded',330),
('not_relevant',             'Nieistotne',                         'excluded',399);

-- ============================================================
-- 2. CATEGORIZATION RULES
-- ============================================================
CREATE TABLE IF NOT EXISTS categorization_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  priority INT NOT NULL DEFAULT 100,
  match_field ENUM('operation_type','title','counterparty_name','any') NOT NULL,
  match_type ENUM('contains','regex','equals') NOT NULL,
  pattern VARCHAR(500) NOT NULL,
  category_id INT NOT NULL,
  default_status ENUM('relevant','not_relevant','review') DEFAULT 'relevant',
  default_is_relevant TINYINT DEFAULT 1,
  creates_split_events TINYINT DEFAULT 0,
  active TINYINT DEFAULT 1,
  UNIQUE KEY uk_rule (match_field, match_type, pattern(200)),
  FOREIGN KEY (category_id) REFERENCES finance_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed categorization rules (INSERT IGNORE uses the UNIQUE KEY to skip duplicates)
INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant, creates_split_events)
SELECT 10, 'any', 'contains', 'U.S. BANK EUROPE', id, 'relevant', 1, 1 FROM finance_categories WHERE slug = 'card_terminal_sales';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant, creates_split_events)
SELECT 11, 'title', 'contains', 'KWOTA BRUTTO', id, 'relevant', 1, 1 FROM finance_categories WHERE slug = 'card_terminal_sales';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 20, 'title', 'contains', 'GOTOWKA KREDKI KASA', id, 'relevant', 1 FROM finance_categories WHERE slug = 'cash_sales_deposit';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 21, 'title', 'contains', 'GOTÓWKA KREDKI KASA', id, 'relevant', 1 FROM finance_categories WHERE slug = 'cash_sales_deposit';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 30, 'counterparty_name', 'contains', 'Too Good To Go', id, 'relevant', 1 FROM finance_categories WHERE slug = 'too_good_to_go';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 35, 'title', 'contains', 'Zwrot z podatku VAT', id, 'relevant', 1 FROM finance_categories WHERE slug = 'tax_refund';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 40, 'title', 'contains', 'WYNAGRODZENIE', id, 'relevant', 1 FROM finance_categories WHERE slug = 'employee_cost';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 41, 'counterparty_name', 'regex', 'ANISA SUBAT|JULIANNA STOPNICKA|IGOR STEPANOV|ALEKSANDRA SZAJNECKA|MARIA BUJAKOWSKA|HLEB KRYRANOSAN|MAGDALENA CZARNOWSKA', id, 'relevant', 1 FROM finance_categories WHERE slug = 'employee_cost';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 50, 'counterparty_name', 'contains', 'ZAKŁAD UBEZPIECZEŃ', id, 'relevant', 1 FROM finance_categories WHERE slug = 'zus';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 51, 'operation_type', 'contains', 'DO ZUS', id, 'relevant', 1 FROM finance_categories WHERE slug = 'zus';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 60, 'title', 'contains', 'VAT', id, 'relevant', 1 FROM finance_categories WHERE slug = 'tax_vat';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 61, 'title', 'contains', 'PIT-4', id, 'relevant', 1 FROM finance_categories WHERE slug = 'tax_pit';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 70, 'operation_type', 'contains', 'OPŁATA ZA PRZELEW', id, 'relevant', 1 FROM finance_categories WHERE slug = 'bank_fee';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 71, 'operation_type', 'contains', 'PROW. ZA PRZELEW', id, 'relevant', 1 FROM finance_categories WHERE slug = 'bank_fee';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 80, 'counterparty_name', 'contains', 'BIOPACK', id, 'relevant', 1 FROM finance_categories WHERE slug = 'packaging';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 85, 'counterparty_name', 'contains', 'JAVA COFFEE', id, 'relevant', 1 FROM finance_categories WHERE slug = 'coffee_supplier';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 86, 'counterparty_name', 'contains', 'BAKERY', id, 'relevant', 1 FROM finance_categories WHERE slug = 'bakery_supplier';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 87, 'counterparty_name', 'contains', 'CHEF ATELIER', id, 'relevant', 1 FROM finance_categories WHERE slug = 'food_beverage_supplier';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 90, 'counterparty_name', 'contains', 'GOODSPIN', id, 'review', 1 FROM finance_categories WHERE slug = 'shop_inventory';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 91, 'counterparty_name', 'contains', 'PJ SYSTEM', id, 'review', 1 FROM finance_categories WHERE slug = 'equipment';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 92, 'counterparty_name', 'regex', 'BLOGO|B.OGO|BŁOGO', id, 'review', 1 FROM finance_categories WHERE slug = 'rent_or_location';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 100, 'title', 'contains', 'PRZELEW ŚRODKÓW', id, 'not_relevant', 0 FROM finance_categories WHERE slug = 'owner_transfer';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 101, 'title', 'contains', 'PRZELEW SRODKOW', id, 'not_relevant', 0 FROM finance_categories WHERE slug = 'owner_transfer';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 102, 'operation_type', 'contains', 'PRZELEW WŁASNY', id, 'not_relevant', 0 FROM finance_categories WHERE slug = 'owner_transfer';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 110, 'counterparty_name', 'contains', 'FUNDACJA', id, 'not_relevant', 0 FROM finance_categories WHERE slug = 'donation_or_private_transfer';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 111, 'title', 'contains', 'DAROWIZNA', id, 'not_relevant', 0 FROM finance_categories WHERE slug = 'donation_or_private_transfer';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 120, 'title', 'contains', 'Spotify', id, 'relevant', 1 FROM finance_categories WHERE slug = 'software_subscription';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 121, 'counterparty_name', 'contains', 'Infakt', id, 'relevant', 1 FROM finance_categories WHERE slug = 'accounting';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 130, 'title', 'contains', 'UBER', id, 'review', 1 FROM finance_categories WHERE slug = 'delivery_transport';

INSERT IGNORE INTO categorization_rules (priority, match_field, match_type, pattern, category_id, default_status, default_is_relevant)
SELECT 131, 'counterparty_name', 'contains', 'UBER', id, 'review', 1 FROM finance_categories WHERE slug = 'delivery_transport';

-- ============================================================
-- 3. BANK IMPORT FILES
-- ============================================================
CREATE TABLE IF NOT EXISTS bank_import_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  bank_name VARCHAR(100) DEFAULT 'mBank',
  account_number VARCHAR(60),
  statement_period_start DATE,
  statement_period_end DATE,
  currency VARCHAR(3) DEFAULT 'PLN',
  opening_balance DECIMAL(12,2),
  closing_balance DECIMAL(12,2),
  income_total_from_statement DECIMAL(12,2),
  expense_total_from_statement DECIMAL(12,2),
  transaction_count_from_statement INT,
  file_hash VARCHAR(64),
  imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  imported_by_user_id INT,
  INDEX idx_file_hash (file_hash),
  INDEX idx_period (statement_period_start, statement_period_end),
  FOREIGN KEY (imported_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. BANK TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_file_id INT NOT NULL,
  booking_date DATE NOT NULL,
  operation_date DATE,
  operation_type VARCHAR(200),
  title TEXT,
  counterparty_name VARCHAR(500),
  counterparty_account VARCHAR(60),
  amount DECIMAL(12,2) NOT NULL,
  balance_after DECIMAL(12,2),
  currency VARCHAR(3) DEFAULT 'PLN',
  direction ENUM('income','expense') NOT NULL,
  source ENUM('bank') DEFAULT 'bank',
  month_key CHAR(7) NOT NULL COMMENT '2026-04',
  raw_row_number INT,
  raw_hash VARCHAR(64) UNIQUE,
  is_relevant TINYINT DEFAULT 1,
  manually_categorized TINYINT DEFAULT 0,
  status ENUM('relevant','not_relevant','review','duplicate','internal_transfer') DEFAULT 'review',
  category_id INT,
  user_note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_month_key (month_key),
  INDEX idx_booking_date (booking_date),
  INDEX idx_direction (direction),
  INDEX idx_status (status),
  INDEX idx_is_relevant (is_relevant),
  FOREIGN KEY (import_file_id) REFERENCES bank_import_files(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. FINANCIAL EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS financial_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bank_transaction_id INT,
  payroll_cost_id INT,
  event_date DATE NOT NULL,
  month_key CHAR(7) NOT NULL,
  source ENUM('bank','payroll','manual') DEFAULT 'bank',
  event_type ENUM('income','cost','transfer','adjustment') NOT NULL,
  category_id INT,
  amount DECIMAL(12,2) NOT NULL COMMENT 'positive=income, negative=cost',
  gross_amount DECIMAL(12,2),
  net_amount DECIMAL(12,2),
  fee_amount DECIMAL(12,2),
  description TEXT,
  counterparty_name VARCHAR(500),
  employee_id INT,
  is_relevant TINYINT DEFAULT 1,
  status ENUM('relevant','not_relevant','review') DEFAULT 'review',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_month_key (month_key),
  INDEX idx_event_type (event_type),
  INDEX idx_category (category_id),
  INDEX idx_is_relevant (is_relevant),
  FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES finance_categories(id) ON DELETE SET NULL,
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 6. PAYROLL COSTS (for future payroll ZIP import)
-- ============================================================
CREATE TABLE IF NOT EXISTS payroll_costs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT,
  employee_name_raw VARCHAR(200),
  period_month CHAR(7) NOT NULL,
  gross_amount DECIMAL(12,2),
  net_amount DECIMAL(12,2),
  employer_cost DECIMAL(12,2),
  document_type VARCHAR(100),
  source_file VARCHAR(255),
  confidence_score DECIMAL(5,2),
  review_status ENUM('pending','approved','rejected') DEFAULT 'pending',
  bank_reconciled TINYINT DEFAULT 0,
  bank_transaction_id INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_period_month (period_month),
  INDEX idx_employee_id (employee_id),
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 7. VIEW: v_monthly_bank_summary
-- ============================================================
CREATE OR REPLACE VIEW v_monthly_bank_summary AS
SELECT
  bt.month_key,
  SUM(CASE WHEN bt.direction = 'income' THEN bt.amount ELSE 0 END)             AS raw_bank_income,
  SUM(CASE WHEN bt.direction = 'expense' THEN ABS(bt.amount) ELSE 0 END)       AS raw_bank_expenses,
  SUM(bt.amount)                                                                 AS raw_bank_net_cashflow,
  SUM(CASE WHEN bt.direction = 'income'  AND bt.is_relevant = 1 THEN bt.amount ELSE 0 END)       AS relevant_bank_income,
  SUM(CASE WHEN bt.direction = 'expense' AND bt.is_relevant = 1 THEN ABS(bt.amount) ELSE 0 END)  AS relevant_bank_expenses,
  SUM(CASE WHEN bt.direction = 'income'  AND bt.is_relevant = 0 THEN bt.amount ELSE 0 END)       AS excluded_income,
  SUM(CASE WHEN bt.direction = 'expense' AND bt.is_relevant = 0 THEN ABS(bt.amount) ELSE 0 END)  AS excluded_expenses,
  COUNT(*) AS total_transactions,
  SUM(CASE WHEN bt.status = 'review' THEN 1 ELSE 0 END) AS review_count
FROM bank_transactions bt
GROUP BY bt.month_key;

-- ============================================================
-- 8. VIEW: v_monthly_real_income
-- ============================================================
CREATE OR REPLACE VIEW v_monthly_real_income AS
SELECT
  fe.month_key,
  -- Revenue breakdown
  COALESCE(SUM(CASE WHEN fc.slug = 'card_terminal_sales' AND fe.event_type = 'income' AND fe.is_relevant = 1
                    THEN COALESCE(fe.gross_amount, fe.amount) ELSE 0 END), 0)             AS revenue_card_gross,
  COALESCE(SUM(CASE WHEN fc.slug = 'card_terminal_sales' AND fe.event_type = 'income' AND fe.is_relevant = 1
                    THEN COALESCE(fe.net_amount, fe.amount) ELSE 0 END), 0)               AS revenue_card_net,
  COALESCE(SUM(CASE WHEN fc.slug = 'cash_sales_deposit' AND fe.event_type = 'income' AND fe.is_relevant = 1
                    THEN fe.amount ELSE 0 END), 0)                                         AS revenue_cash,
  COALESCE(SUM(CASE WHEN fc.slug NOT IN ('card_terminal_sales','cash_sales_deposit')
                         AND fe.event_type = 'income' AND fe.is_relevant = 1
                    THEN fe.amount ELSE 0 END), 0)                                         AS revenue_other,
  COALESCE(SUM(CASE WHEN fe.event_type = 'income' AND fe.is_relevant = 1
                    THEN COALESCE(fe.gross_amount, fe.amount) ELSE 0 END), 0)             AS revenue_total,
  -- Cost breakdown
  COALESCE(SUM(CASE WHEN fc.slug IN ('food_beverage_supplier','coffee_supplier','bakery_supplier')
                         AND fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_goods_suppliers,
  COALESCE(SUM(CASE WHEN fc.slug = 'employee_cost' AND fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_employees,
  COALESCE(SUM(CASE WHEN fc.slug = 'zus' AND fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_zus,
  COALESCE(SUM(CASE WHEN fc.slug IN ('tax_vat','tax_pit') AND fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_taxes,
  COALESCE(SUM(CASE WHEN fc.slug = 'payment_provider_fee' AND fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_payment_fees,
  COALESCE(SUM(CASE WHEN fc.slug = 'bank_fee' AND fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_bank_fees,
  COALESCE(SUM(CASE WHEN fc.slug NOT IN (
                        'employee_cost','zus','tax_vat','tax_pit','payment_provider_fee','bank_fee',
                        'food_beverage_supplier','coffee_supplier','bakery_supplier')
                         AND fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_other,
  COALESCE(SUM(CASE WHEN fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS cost_total,
  -- Profit KPIs
  COALESCE(SUM(CASE WHEN fe.event_type = 'income' AND fe.is_relevant = 1
                    THEN COALESCE(fe.gross_amount, fe.amount) ELSE 0 END), 0) -
  COALESCE(SUM(CASE WHEN fe.event_type = 'cost' AND fe.is_relevant = 1
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS real_income,
  -- Operating profit before tax/ZUS
  COALESCE(SUM(CASE WHEN fe.event_type = 'income' AND fe.is_relevant = 1
                    THEN COALESCE(fe.gross_amount, fe.amount) ELSE 0 END), 0) -
  COALESCE(SUM(CASE WHEN fe.event_type = 'cost' AND fe.is_relevant = 1
                         AND fc.slug NOT IN ('tax_vat','tax_pit','zus')
                    THEN ABS(fe.amount) ELSE 0 END), 0)                                    AS operating_profit_before_tax_zus,
  -- Excluded totals
  COALESCE(SUM(CASE WHEN fe.is_relevant = 0 THEN ABS(fe.amount) ELSE 0 END), 0)          AS excluded_not_relevant_total,
  COUNT(CASE WHEN fe.status = 'review' AND fe.is_relevant = 1 THEN 1 END)                 AS transactions_to_review_count
FROM financial_events fe
LEFT JOIN finance_categories fc ON fc.id = fe.category_id
GROUP BY fe.month_key;
