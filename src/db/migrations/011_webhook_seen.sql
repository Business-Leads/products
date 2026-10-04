-- Webhook deliveries already handled, so a repeat (two subscriptions, or a
-- retry) never sends the same emails twice.
CREATE TABLE IF NOT EXISTS webhook_seen (
  key  TEXT PRIMARY KEY,
  at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
