-- Discount coupons for an EXISTING shop database.
-- Run once, after db/auth-migration-006.sql:
--   npx wrangler d1 execute peppynose_shop --remote --file=db/auth-migration-007.sql
--
-- Adds the coupons table and two order columns (coupon_code, discount).
-- Nothing is dropped; old orders get discount 0 and no coupon.
-- A second run stops with "duplicate column name" and changes nothing.
-- Skip this file if the database was created from the current schema.sql.

ALTER TABLE orders ADD COLUMN coupon_code TEXT;
ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS coupons (
  code              TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('percent', 'amount')),
  value             INTEGER NOT NULL CHECK (value > 0),
  min_subtotal      INTEGER NOT NULL DEFAULT 0,
  max_discount      INTEGER,
  max_uses          INTEGER,
  used_count        INTEGER NOT NULL DEFAULT 0,
  starts_at         TEXT,
  ends_at           TEXT,
  once_per_customer INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);
