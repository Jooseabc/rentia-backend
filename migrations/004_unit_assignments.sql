-- =========================================================
-- SAA - Historial de inquilinos por unidad
-- Tabla unit_assignments + backfill de datos existentes
-- =========================================================

-- Cada fila representa un período en el que un inquilino estuvo
-- asignado a una unidad. end_date NULL = asignación activa.
CREATE TABLE IF NOT EXISTS unit_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     UUID NOT NULL REFERENCES units(id)   ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  start_date  DATE NOT NULL,
  end_date    DATE,                  -- NULL = activa
  reason      TEXT,                  -- motivo del fin (mudanza, fin contrato, etc.)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unit_assignments_unit_idx   ON unit_assignments(unit_id, start_date DESC);
CREATE INDEX IF NOT EXISTS unit_assignments_tenant_idx ON unit_assignments(tenant_id, start_date DESC);

-- Sólo una asignación activa por unidad
CREATE UNIQUE INDEX IF NOT EXISTS unit_assignments_one_active_per_unit
  ON unit_assignments(unit_id) WHERE end_date IS NULL;

-- Backfill: por cada inquilino con unit_id, crea una asignación
-- (activa si está activo; cerrada con today si está inactivo).
INSERT INTO unit_assignments (unit_id, tenant_id, start_date, end_date, reason)
SELECT t.unit_id,
       t.id,
       t.entry_date,
       CASE WHEN t.status = 'inactive' THEN CURRENT_DATE ELSE NULL END,
       CASE WHEN t.status = 'inactive' THEN 'Backfill: inquilino inactivo' ELSE NULL END
  FROM tenants t
 WHERE t.unit_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM unit_assignments ua
      WHERE ua.tenant_id = t.id
        AND ua.unit_id   = t.unit_id
        AND ua.start_date = t.entry_date
   );
