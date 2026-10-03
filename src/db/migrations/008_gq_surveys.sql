-- Good Questions research surveys hosted by HQ (replaces ScoreApp): one per
-- engagement, with the sponsor-approved questions, and the answers people give.
CREATE TABLE IF NOT EXISTS gq_surveys (
  token        TEXT PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  questions    JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gq_responses (
  id           BIGSERIAL PRIMARY KEY,
  token        TEXT NOT NULL REFERENCES gq_surveys(token) ON DELETE CASCADE,
  answers      JSONB NOT NULL,
  scores       JSONB NOT NULL,
  total        INT NOT NULL,
  name         TEXT,
  email        TEXT,
  organisation TEXT,
  role         TEXT,
  opt_in       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gq_responses_token ON gq_responses (token, created_at);
