-- Migracion 002 - Portal del Inquilino
-- Agrega columna para guardar la contrasena hasheada del inquilino

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS portal_password TEXT;

CREATE INDEX IF NOT EXISTS tenants_dni_idx ON tenants(dni) WHERE dni IS NOT NULL;
