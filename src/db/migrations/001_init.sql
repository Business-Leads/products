-- Core schema for the products HQ.

CREATE TABLE IF NOT EXISTS leads (
  id            BIGSERIAL PRIMARY KEY,
  product       TEXT NOT NULL,
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  business      TEXT,
  website       TEXT,
  town          TEXT,
  message       TEXT,
  data          JSONB NOT NULL DEFAULT '{}',
  source        TEXT NOT NULL DEFAULT 'website',
  status        TEXT NOT NULL DEFAULT 'new',   -- new | contacted | followed_up | replied | won | lost | unsubscribed
  next_touch_at TIMESTAMPTZ,
  touches       INT NOT NULL DEFAULT 0,
  customer_id   BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_product_status ON leads (product, status);
CREATE INDEX IF NOT EXISTS leads_email ON leads (lower(email));

CREATE TABLE IF NOT EXISTS customers (
  id                      BIGSERIAL PRIMARY KEY,
  product                 TEXT NOT NULL,
  plan                    TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'onboarding', -- onboarding | active | past_due | paused | cancelled
  name                    TEXT,
  business                TEXT,
  email                   TEXT NOT NULL,
  phone                   TEXT,
  data                    JSONB NOT NULL DEFAULT '{}',  -- intake answers and product-specific state
  intake_token            TEXT UNIQUE,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT UNIQUE,
  stripe_checkout_id      TEXT UNIQUE,
  amount_pence            INT NOT NULL DEFAULT 0,
  interval                TEXT NOT NULL DEFAULT 'month',
  lead_id                 BIGINT REFERENCES leads(id),
  past_due_since          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_product_status ON customers (product, status);

CREATE TABLE IF NOT EXISTS onboarding_steps (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  position     INT NOT NULL,
  key          TEXT NOT NULL,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- auto | customer | approval | manual
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | waiting | done | failed | skipped
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  task_id      BIGINT,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (customer_id, key)
);

-- The inbox: everything that needs a person (approvals, manual steps, alerts).
CREATE TABLE IF NOT EXISTS tasks (
  id           BIGSERIAL PRIMARY KEY,
  product      TEXT,
  customer_id  BIGINT REFERENCES customers(id) ON DELETE CASCADE,
  lead_id      BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,            -- approval | manual | alert
  priority     INT NOT NULL DEFAULT 2,   -- 1 urgent, 2 normal, 3 low
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  action       TEXT,                     -- handler to run when approved
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'open', -- open | approved | rejected | done | dismissed
  dedupe_key   TEXT UNIQUE,
  due_at       TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolution   TEXT
);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (status, priority, created_at);

CREATE TABLE IF NOT EXISTS emails (
  id           BIGSERIAL PRIMARY KEY,
  product      TEXT,
  customer_id  BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id      BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,            -- lead_reply | welcome | reminder | dunning | report | digest | alert ...
  to_address   TEXT NOT NULL,
  from_address TEXT NOT NULL,
  reply_to     TEXT,
  subject      TEXT NOT NULL,
  body_text    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- draft | queued | sent | failed | cancelled
  attempts     INT NOT NULL DEFAULT 0,
  error        TEXT,
  send_after   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emails_queue ON emails (status, send_after);

-- Recurring work delivered to customers (monthly reports, weekly harvests...).
CREATE TABLE IF NOT EXISTS deliveries (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product      TEXT NOT NULL,
  routine      TEXT NOT NULL,
  period       TEXT NOT NULL,            -- e.g. 2026-10 or 2026-W41
  status       TEXT NOT NULL DEFAULT 'due', -- due | working | awaiting_approval | delivered | failed | blocked
  content      JSONB NOT NULL DEFAULT '{}',
  last_error   TEXT,
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (customer_id, routine, period)
);

CREATE TABLE IF NOT EXISTS disputes (
  id            TEXT PRIMARY KEY,        -- Stripe dispute id
  customer_id   BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  product       TEXT,
  amount_pence  INT NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL,
  evidence_due  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  relevant     BOOLEAN NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  product      TEXT,
  customer_id  BIGINT,
  lead_id      BIGINT,
  level        TEXT NOT NULL DEFAULT 'info', -- info | warn | error
  type         TEXT NOT NULL,
  message      TEXT NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_at ON events (at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id           BIGSERIAL PRIMARY KEY,
  job          TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running', -- running | ok | error
  summary      TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs (job, started_at DESC);

CREATE TABLE IF NOT EXISTS health_checks (
  id           BIGSERIAL PRIMARY KEY,
  target       TEXT NOT NULL,
  url          TEXT NOT NULL,
  ok           BOOLEAN NOT NULL,
  status_code  INT,
  latency_ms   INT,
  error        TEXT,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_checks_target ON health_checks (target, checked_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
