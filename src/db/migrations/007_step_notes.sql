-- What happened when an onboarding step finished (e.g. "Version 1 published to obb-x.netlify.app"),
-- shown on the customer's onboarding checklist in HQ.
ALTER TABLE onboarding_steps ADD COLUMN IF NOT EXISTS note TEXT;
