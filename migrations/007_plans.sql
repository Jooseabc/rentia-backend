-- =========================================================
-- Rentia: sistema de planes
-- Agrega plan, trial_ends_at y plan_expires_at a users.
-- =========================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan            VARCHAR(20) NOT NULL DEFAULT 'starter'
    CHECK (plan IN ('starter', 'pro', 'business')),
  ADD COLUMN IF NOT EXISTS trial_ends_at   TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
