-- =========================================================
-- Rentia: multi-tenancy
-- Agrega owner_id a todas las tablas de negocio para aislar
-- los datos de cada propietario (usuario SaaS).
--
-- Estrategia en 2 pasos por tabla:
--   1. ADD COLUMN nullable (permite que la migración corra
--      incluso si la tabla tiene filas heredadas de SAA).
--   2. DELETE filas huérfanas + SET NOT NULL para producción.
-- =========================================================

-- ── PASO 1: agregar columnas ──────────────────────────────

ALTER TABLE properties        ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE units             ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE tenants           ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE payments          ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE incidents         ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE rent_changes      ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE unit_assignments  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- ── PASO 2: limpiar huérfanos y aplicar NOT NULL ──────────
-- Orden: tablas hoja primero, luego las que tienen dependientes.

-- tablas hoja (sin hijos que dependan de su PK para owner)
DELETE FROM notifications_log WHERE owner_id IS NULL;
DELETE FROM unit_assignments  WHERE owner_id IS NULL;
DELETE FROM rent_changes      WHERE owner_id IS NULL;
DELETE FROM incidents         WHERE owner_id IS NULL;
DELETE FROM payments          WHERE owner_id IS NULL;

-- tablas con dependientes (eliminamos después de las hojas)
DELETE FROM tenants    WHERE owner_id IS NULL;
DELETE FROM units      WHERE owner_id IS NULL;
DELETE FROM properties WHERE owner_id IS NULL;

-- aplicar NOT NULL
ALTER TABLE notifications_log ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE unit_assignments  ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE rent_changes      ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE incidents         ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE payments          ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE tenants           ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE units             ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE properties        ALTER COLUMN owner_id SET NOT NULL;

-- ── PASO 3: índices ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS properties_owner_idx        ON properties(owner_id);
CREATE INDEX IF NOT EXISTS units_owner_idx             ON units(owner_id);
CREATE INDEX IF NOT EXISTS tenants_owner_idx           ON tenants(owner_id);
CREATE INDEX IF NOT EXISTS payments_owner_idx          ON payments(owner_id);
CREATE INDEX IF NOT EXISTS incidents_owner_idx         ON incidents(owner_id);
CREATE INDEX IF NOT EXISTS rent_changes_owner_idx      ON rent_changes(owner_id);
CREATE INDEX IF NOT EXISTS notifications_log_owner_idx ON notifications_log(owner_id);
CREATE INDEX IF NOT EXISTS unit_assignments_owner_idx  ON unit_assignments(owner_id);
