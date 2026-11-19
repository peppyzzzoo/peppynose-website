-- Email sending for an EXISTING shop database: remember send attempts per email.
-- Run once, after db/auth-migration-005.sql:
--   npx wrangler d1 execute peppynose_shop --remote --file=db/auth-migration-006.sql
--
-- Adds two columns to outbox. Nothing is dropped. Emails stored before this
-- (never sent) start with 0 attempts, so once sending is switched on they are
-- sent too. To skip old ones instead, mark them as given up after running this file:
--   npx wrangler d1 execute peppynose_shop --remote --command "UPDATE outbox SET attempts = 5 WHERE sent_at IS NULL"
-- A second run stops with "duplicate column name" and changes nothing.
-- Skip this file if the database was created from the current schema.sql.

ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN last_error TEXT;
