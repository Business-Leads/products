-- Outbound prospecting: prospect lists per product and a global do-not-contact list.

CREATE TABLE IF NOT EXISTS prospects (
  id            BIGSERIAL PRIMARY KEY,
  product       TEXT NOT NULL,
  email         TEXT NOT NULL,
  name          TEXT,
  business      TEXT,
  company_type  TEXT NOT NULL DEFAULT 'unknown', -- limited | llp | plc | public_sector | sole_trader | partnership | unknown
  website       TEXT,
  town          TEXT,
  data          JSONB NOT NULL DEFAULT '{}',
  source        TEXT NOT NULL DEFAULT 'import',
  status        TEXT NOT NULL DEFAULT 'new',     -- new | in_sequence | finished | replied | suppressed | converted | skipped
  step          INT NOT NULL DEFAULT 0,          -- emails sent so far
  next_send_at  TIMESTAMPTZ,
  lead_id       BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product, email)
);
CREATE INDEX IF NOT EXISTS prospects_due ON prospects (product, status, next_send_at);

CREATE TABLE IF NOT EXISTS suppressions (
  value       TEXT PRIMARY KEY,   -- an email address, or a domain as '@example.com'
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE emails ADD COLUMN IF NOT EXISTS prospect_id BIGINT REFERENCES prospects(id) ON DELETE SET NULL;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS prospect_id BIGINT REFERENCES prospects(id) ON DELETE SET NULL;
