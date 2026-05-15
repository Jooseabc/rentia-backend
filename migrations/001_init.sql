-- =========================================================
-- Rentia — Esquema inicial de base de datos
-- =========================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ===== USUARIOS =====
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (LOWER(email));

-- ===== PROPIEDADES =====
CREATE TABLE IF NOT EXISTS properties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  address     TEXT,
  type        TEXT DEFAULT 'Edificio',
  notes       TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== UNIDADES =====
CREATE TABLE IF NOT EXISTS units (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  default_rent  NUMERIC(12,2) DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS units_property_idx ON units(property_id);

-- ===== INQUILINOS =====
CREATE TABLE IF NOT EXISTS tenants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name           TEXT NOT NULL,
  dni                 TEXT,
  phone               TEXT,
  email               TEXT,
  emergency_contact   TEXT,
  emergency_phone     TEXT,
  unit_id             UUID REFERENCES units(id) ON DELETE SET NULL,
  entry_date          DATE NOT NULL,
  monthly_rent        NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit             NUMERIC(12,2) DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes               TEXT,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenants_unit_idx   ON tenants(unit_id);
CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants(status);

-- ===== AUMENTOS DE RENTA =====
CREATE TABLE IF NOT EXISTS rent_changes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  new_rent       NUMERIC(12,2) NOT NULL,
  reason         TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rent_changes_tenant_idx ON rent_changes(tenant_id, effective_date);

-- ===== PAGOS =====
CREATE TABLE IF NOT EXISTS payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  paid_date    DATE NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  method       TEXT DEFAULT 'Efectivo',
  notes        TEXT,
  receipt_no   SERIAL,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_tenant_idx ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS payments_period_idx ON payments(period_start);
CREATE UNIQUE INDEX IF NOT EXISTS payments_unique_period ON payments(tenant_id, period_start);

-- ===== INCIDENCIAS =====
CREATE TABLE IF NOT EXISTS incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Comunicación',
  description TEXT NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_tenant_idx ON incidents(tenant_id);

-- ===== NOTIFICACIONES =====
CREATE TABLE IF NOT EXISTS notifications_log (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  reference TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, kind, reference)
);

-- ===== TRIGGER updated_at =====
CREATE OR REPLACE FUNCTION trg_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['users','properties','units','tenants']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_updated_at()', t, t);
  END LOOP;
END $$;
