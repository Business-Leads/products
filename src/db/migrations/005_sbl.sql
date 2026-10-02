-- Events pushed by Sbl.so (LinkedIn outreach for Linkn), stored as received.
CREATE TABLE IF NOT EXISTS sbl_events (
  id           BIGSERIAL PRIMARY KEY,
  event        TEXT NOT NULL,
  campaign_id  TEXT,
  customer_id  BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sbl_events_customer ON sbl_events (customer_id, received_at);
