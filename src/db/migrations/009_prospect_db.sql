-- Our own UK prospect database (loaded from the master prospect file), from
-- which EmailFirst and Good Questions pick each client's daily contacts.
CREATE TABLE IF NOT EXISTS prospect_db (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  first_name   TEXT,
  last_name    TEXT,
  company      TEXT,
  title        TEXT,
  sector       TEXT,
  region       TEXT,
  company_type TEXT,
  extra        JSONB NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS prospect_db_email ON prospect_db (lower(email));
CREATE INDEX IF NOT EXISTS prospect_db_last_used ON prospect_db (last_used_at);

-- Who was sent to whom, so nobody is emailed twice for the same client and
-- everyone gets a rest between clients.
CREATE TABLE IF NOT EXISTS prospect_uses (
  prospect_id  BIGINT NOT NULL REFERENCES prospect_db(id) ON DELETE CASCADE,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  batch        TEXT NOT NULL,
  used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (prospect_id, customer_id)
);
