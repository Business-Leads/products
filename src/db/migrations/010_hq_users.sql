-- People who can sign in to HQ with their own email and password (alongside
-- the main ADMIN_PASSWORD). Each is invited by email and sets their own password.
CREATE TABLE IF NOT EXISTS hq_users (
  id                SERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  password_hash     TEXT,
  invite_token      TEXT,
  invite_expires_at TIMESTAMPTZ,
  invited_at        TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  disabled          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS hq_user_id INTEGER REFERENCES hq_users(id) ON DELETE CASCADE;

INSERT INTO hq_users (email, name) VALUES ('hello@business-leads.co.uk', 'Felix Clarke') ON CONFLICT (email) DO NOTHING;
