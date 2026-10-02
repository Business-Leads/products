-- Call events pushed by Awaz (Speed to Lead's phone assistant), stored as received.
CREATE TABLE IF NOT EXISTS awaz_events (
  id           BIGSERIAL PRIMARY KEY,
  event        TEXT NOT NULL,
  agent_id     TEXT,
  customer_id  BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS awaz_events_customer ON awaz_events (customer_id, received_at);
