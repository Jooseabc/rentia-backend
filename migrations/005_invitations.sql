-- =========================================================
-- SAA - Sistema de invitaciones para registro controlado
-- =========================================================

CREATE TABLE IF NOT EXISTS invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,         -- código de un solo uso
  email       TEXT,                         -- opcional: si está, sólo ese correo puede usarla
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  used_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  notes       TEXT
);

CREATE INDEX IF NOT EXISTS invitations_code_idx     ON invitations(code);
CREATE INDEX IF NOT EXISTS invitations_unused_idx   ON invitations(used_at) WHERE used_at IS NULL;
