-- Vendor product catalog (XML-feed-backed) — replaces per-request /api3 product lookups.
-- The app also auto-provisions this via vendorCatalog.ensureSchema(); this file is for
-- manual/explicit provisioning. Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS vendor_products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  location_id INT NOT NULL,
  sku VARCHAR(64) NOT NULL,
  ean VARCHAR(32) NULL,
  product_id BIGINT NULL,
  name VARCHAR(512) NOT NULL,
  unit VARCHAR(32) NULL,
  price_net DECIMAL(12,4) NULL,
  vat DECIMAL(5,2) NULL,
  retail_gross DECIMAL(12,4) NULL,
  in_stock TINYINT(1) NOT NULL DEFAULT 0,
  qty DECIMAL(12,3) NULL,
  availability VARCHAR(64) NULL,
  photo_url VARCHAR(512) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_loc_sku (location_id, sku),
  KEY idx_loc_name (location_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-vendor XML catalog feed URL. Ignore "Duplicate column" if already present.
ALTER TABLE vendors ADD COLUMN xml_feed_url VARCHAR(512) NULL;

-- Main product photo URL (added 2026-06-11). Ignore "Duplicate column" if present.
ALTER TABLE vendor_products ADD COLUMN photo_url VARCHAR(512) NULL;
