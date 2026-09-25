-- Replies and other mail received into the monitored mailbox.
CREATE TABLE IF NOT EXISTS inbound_emails (
  id           BIGSERIAL PRIMARY KEY,
  message_id   TEXT UNIQUE,
  from_address TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  body_text    TEXT NOT NULL DEFAULT '',
  product      TEXT,
  lead_id      BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  customer_id  BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  intent       TEXT,          -- auto_reply | stop | not_interested | interested | question | other
  summary      TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbound_from ON inbound_emails (lower(from_address));
