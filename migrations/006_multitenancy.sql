-- =========================================================
-- Rentia: multi-tenancy
-- Agrega owner_id a todas las tablas de negocio para aislar
-- los datos de cada propietario (usuario SaaS).
-- =========================================================

-- properties
ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS properties_owner_idx ON properties(owner_id);

-- units (hereda owner via property, pero indexamos directamente para queries rápidas)
ALTER TABLE units ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS units_owner_idx ON units(owner_id);

-- tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS tenants_owner_idx ON tenants(owner_id);

-- payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS payments_owner_idx ON payments(owner_id);

-- incidents
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS incidents_owner_idx ON incidents(owner_id);

-- rent_changes
ALTER TABLE rent_changes ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS rent_changes_owner_idx ON rent_changes(owner_id);

-- notifications_log
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS notifications_log_owner_idx ON notifications_log(owner_id);

-- unit_assignments (de migración 004)
ALTER TABLE unit_assignments ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS unit_assignments_owner_idx ON unit_assignments(owner_id);
