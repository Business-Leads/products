-- Client portals: one password-protected account area per product site.

-- A client's login for one product. Customers of that product with the same
-- email address (e.g. someone who re-subscribes) share the login.
CREATE TABLE IF NOT EXISTS client_users (
  id              BIGSERIAL PRIMARY KEY,
  product         TEXT NOT NULL,
  email           TEXT NOT NULL,
  password_hash   TEXT,
  disabled        BOOLEAN NOT NULL DEFAULT false,
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  password_set_at TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS client_users_login ON client_users (product, lower(email));

-- Only hashes of session and link tokens are stored.
CREATE TABLE IF NOT EXISTS client_sessions (
  token_hash     TEXT PRIMARY KEY,
  client_user_id BIGINT NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

-- One-time links for setting a password (new account) or resetting it.
CREATE TABLE IF NOT EXISTS client_tokens (
  token_hash     TEXT PRIMARY KEY,
  client_user_id BIGINT NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
  purpose        TEXT NOT NULL,          -- setup | reset
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);

-- Invoices as Stripe reports them (from webhooks), for the client's billing page.
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,      -- Stripe invoice id
  subscription_id TEXT,
  customer_id     BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  number          TEXT,
  status          TEXT NOT NULL,
  amount_pence    INT NOT NULL,
  hosted_url      TEXT,
  pdf_url         TEXT,
  issued_at       TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_subscription ON invoices (subscription_id);
CREATE INDEX IF NOT EXISTS invoices_customer ON invoices (customer_id);

-- Messages from clients through the "Contact us" page, and our replies.
CREATE TABLE IF NOT EXISTS support_requests (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open', -- open | answered | closed
  reply        TEXT,
  replied_at   TIMESTAMPTZ,
  task_id      BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_open ON support_requests (status, created_at);

-- Updates shown on the client's timeline (e.g. "your website preview is
-- ready"). An update can ask the client to approve an onboarding step.
CREATE TABLE IF NOT EXISTS client_updates (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  link         TEXT,
  approval_step TEXT,                    -- onboarding step key the client is asked to approve
  response     TEXT,                     -- approved | changes
  response_note TEXT,
  responded_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_updates_customer ON client_updates (customer_id, created_at DESC);

-- Login throttling for the HQ dashboard, kept in the database so it survives restarts.
CREATE TABLE IF NOT EXISTS login_failures (
  id     BIGSERIAL PRIMARY KEY,
  scope  TEXT NOT NULL,                  -- e.g. hq:<ip> or portal:<ip>
  at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_failures_scope ON login_failures (scope, at);
