-- Migración 003: log de auditoría + soft-delete de pagos
-- ================================================================

-- ===== AUDIT LOG =====
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action      TEXT NOT NULL,        -- 'create' | 'update' | 'delete' | 'void' | 'reset_portal_password' | ...
  entity      TEXT NOT NULL,        -- 'tenant' | 'payment' | 'property' | 'unit' | ...
  entity_id   TEXT,
  details     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx  ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx   ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);

-- ===== SOFT-DELETE DE PAGOS =====
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_at  TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voided_by  UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- El índice único anterior bloqueaba registrar un nuevo pago para un período
-- después de anular el anterior. Lo reemplazamos por uno parcial que sólo
-- considera pagos vigentes (no anulados).
DROP INDEX IF EXISTS payments_unique_period;
CREATE UNIQUE INDEX IF NOT EXISTS payments_unique_period_active
  ON payments(tenant_id, period_start)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS payments_voided_idx ON payments(voided_at) WHERE voided_at IS NOT NULL;
