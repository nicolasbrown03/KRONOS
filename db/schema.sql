-- ============================================================
-- KRONOS 3.0 — SCHEMA POSTGRESQL
-- Ejecutar una sola vez al crear la base de datos
-- ============================================================

-- Extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- AREAS
-- ============================================================
CREATE TABLE IF NOT EXISTS areas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(80) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SEDES (con geocercas y rangos de IP)
-- ============================================================
CREATE TABLE IF NOT EXISTS sedes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(80) NOT NULL,
  address         TEXT,
  lat             DECIMAL(10,8),
  lon             DECIMAL(11,8),
  radius_meters   INTEGER DEFAULT 300,
  allowed_ips     JSONB DEFAULT '[]',
  geo_required    BOOLEAN DEFAULT false,
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TURNOS
-- ============================================================
CREATE TABLE IF NOT EXISTS shifts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(60) NOT NULL,
  start_time          TIME NOT NULL,
  end_time            TIME NOT NULL,
  crosses_midnight    BOOLEAN DEFAULT false,
  tolerance_in_min    INTEGER DEFAULT 5,
  tolerance_out_min   INTEGER DEFAULT 10,
  work_hours          DECIMAL(4,2) DEFAULT 8.0,
  active              BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USUARIOS / COLABORADORES
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     VARCHAR(30) UNIQUE NOT NULL,  -- Cédula o código BUK
  full_name       VARCHAR(120) NOT NULL,
  email           VARCHAR(120) UNIQUE,
  phone           VARCHAR(20),
  password_hash   VARCHAR(255),                  -- bcrypt
  role            VARCHAR(20) DEFAULT 'employee' CHECK (role IN ('super_admin','admin','leader','employee')),
  area_id         UUID REFERENCES areas(id),
  sede_id         UUID REFERENCES sedes(id),
  shift_id        UUID REFERENCES shifts(id),
  leader_id       UUID REFERENCES users(id),
  cargo           VARCHAR(80),
  -- Datos BUK
  buk_id          VARCHAR(40),                   -- ID interno BUK
  cost_center     VARCHAR(60),                   -- Centro de costo BUK
  contract_type   VARCHAR(40),                   -- Tipo de contrato
  start_date      DATE,
  status          VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MARCACIONES (append-only por diseño)
-- ============================================================
CREATE TABLE IF NOT EXISTS attendances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  type            VARCHAR(20) NOT NULL CHECK (type IN (
                    'entry','exit',
                    'lunch_out','lunch_in',
                    'break_out','break_in',
                    'overtime_start','overtime_end',
                    'remote_in','remote_out'
                  )),
  marked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Datos de red y dispositivo
  ip_address      INET,
  ip_country      VARCHAR(4),
  ip_city         VARCHAR(60),
  ip_is_vpn       BOOLEAN DEFAULT false,
  ip_provider     VARCHAR(80),
  -- Geolocalización
  lat             DECIMAL(10,8),
  lon             DECIMAL(11,8),
  geo_accuracy_m  INTEGER,
  geo_is_valid    BOOLEAN DEFAULT true,
  geo_distance_m  INTEGER,
  -- Dispositivo
  device_type     VARCHAR(20),
  browser         VARCHAR(60),
  os              VARCHAR(60),
  user_agent      TEXT,
  -- Metadatos operativos
  sede_id         UUID REFERENCES sedes(id),
  shift_id        UUID REFERENCES shifts(id),
  source          VARCHAR(20) DEFAULT 'web' CHECK (source IN ('web','pwa','admin','api')),
  status          VARCHAR(20) DEFAULT 'valid' CHECK (status IN ('valid','suspicious','corrected','rejected')),
  anomaly_flags   JSONB DEFAULT '[]',
  corrected_from  UUID REFERENCES attendances(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- JORNADAS (agrupa entrada/salida por día)
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  session_date    DATE NOT NULL,
  shift_id        UUID REFERENCES shifts(id),
  entry_id        UUID REFERENCES attendances(id),
  exit_id         UUID REFERENCES attendances(id),
  lunch_out_id    UUID REFERENCES attendances(id),
  lunch_in_id     UUID REFERENCES attendances(id),
  -- Cálculos
  total_hours     DECIMAL(5,2),
  overtime_hours  DECIMAL(5,2) DEFAULT 0,
  late_minutes    INTEGER DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','closed','incomplete','corrected')),
  payroll_period  VARCHAR(20),                   -- ej: '2026-05-01/2026-05-31'
  turn_number     INTEGER DEFAULT 1,             -- 1=primer turno, 2=segundo turno (SAC, etc.)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, session_date, turn_number)
);

-- ============================================================
-- CORRECCIONES / NOVEDADES
-- ============================================================
CREATE TABLE IF NOT EXISTS corrections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id      UUID NOT NULL REFERENCES users(id),
  target_user_id    UUID NOT NULL REFERENCES users(id),
  attendance_id     UUID REFERENCES attendances(id),
  session_date      DATE NOT NULL,
  type              VARCHAR(30) NOT NULL CHECK (type IN (
                      'time_fix','missing_entry','missing_exit',
                      'location_override','type_change','absence_justify'
                    )),
  original_value    JSONB,
  new_value         JSONB NOT NULL,
  reason            TEXT NOT NULL,
  evidence_url      TEXT,
  -- Flujo de aprobación
  status            VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed')),
  approver_id       UUID REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  approver_comment  TEXT,
  executed_by       UUID REFERENCES users(id),
  executed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PERÍODOS DE NÓMINA
-- ============================================================
CREATE TABLE IF NOT EXISTS payroll_periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(80) NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  type        VARCHAR(20) DEFAULT 'biweekly' CHECK (type IN ('biweekly','monthly')),
  status      VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','closed','exported')),
  closed_at   TIMESTAMPTZ,
  closed_by   UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RESUMEN DE NÓMINA POR COLABORADOR
-- ============================================================
CREATE TABLE IF NOT EXISTS payroll_summaries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  period_id           UUID NOT NULL REFERENCES payroll_periods(id),
  scheduled_hours     DECIMAL(6,2) DEFAULT 0,
  worked_hours        DECIMAL(6,2) DEFAULT 0,
  -- Horas extras (Colombia)
  overtime_hed        DECIMAL(6,2) DEFAULT 0,   -- Extra diurna +25%
  overtime_hen        DECIMAL(6,2) DEFAULT 0,   -- Extra nocturna +75%
  overtime_hedf       DECIMAL(6,2) DEFAULT 0,   -- Extra diurna dom/festivo +100%
  overtime_hendf      DECIMAL(6,2) DEFAULT 0,   -- Extra nocturna dom/festivo +150%
  -- Recargos ordinarios
  recargo_nocturno    DECIMAL(6,2) DEFAULT 0,   -- Horas nocturnas ordinarias +35%
  recargo_dominical   DECIMAL(6,2) DEFAULT 0,   -- Horas dominicales ordinarias +75%
  recargo_festivo     DECIMAL(6,2) DEFAULT 0,   -- Horas festivos ordinarios +75%
  -- Novedades
  late_minutes        INTEGER DEFAULT 0,
  absence_days        DECIMAL(4,1) DEFAULT 0,
  approved_novedades  INTEGER DEFAULT 0,
  -- Estado
  status              VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','reviewed','approved')),
  notes               TEXT,
  approved_by         UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, period_id)
);

-- ============================================================
-- AUDIT LOG — INMUTABLE (solo INSERT)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID REFERENCES users(id),
  actor_name    VARCHAR(120),
  actor_role    VARCHAR(20),
  action        VARCHAR(80) NOT NULL,
  entity_type   VARCHAR(40),
  entity_id     UUID,
  payload_before JSONB,
  payload_after  JSONB,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
-- Revocar UPDATE y DELETE en audit_logs para inmutabilidad
-- REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

-- ============================================================
-- IMPORTACIONES BUK (historial de archivos subidos)
-- ============================================================
CREATE TABLE IF NOT EXISTS buk_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        VARCHAR(200),
  total_rows      INTEGER,
  created_rows    INTEGER DEFAULT 0,
  updated_rows    INTEGER DEFAULT 0,
  error_rows      INTEGER DEFAULT 0,
  errors          JSONB DEFAULT '[]',
  imported_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES PARA PERFORMANCE
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_attendances_user_date   ON attendances(user_id, marked_at);
CREATE INDEX IF NOT EXISTS idx_attendances_type        ON attendances(type);
CREATE INDEX IF NOT EXISTS idx_sessions_user_date      ON attendance_sessions(user_id, session_date);
CREATE INDEX IF NOT EXISTS idx_sessions_date           ON attendance_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_corrections_status      ON corrections(status);
CREATE INDEX IF NOT EXISTS idx_corrections_target      ON corrections(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor        ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_employee_id       ON users(employee_id);
CREATE INDEX IF NOT EXISTS idx_users_area              ON users(area_id);

-- ============================================================
-- DATOS INICIALES
-- ============================================================

-- Áreas base de SOMOS
INSERT INTO areas (name) VALUES
  ('Instalaciones'),('Sac'),('Ventas'),('Ventas Bog'),
  ('Accounting and treasury'),('Soporte N2'),('Soporte en sitio'),
  ('CEDI'),('Relevamiento'),('Noc'),('RRHH'),('Tecnología'),('Gerencia')
ON CONFLICT (name) DO NOTHING;

-- Turnos base
INSERT INTO shifts (name, start_time, end_time, crosses_midnight, tolerance_in_min, work_hours) VALUES
  ('Turno Mañana',   '06:00', '14:00', false, 5, 8.0),
  ('Turno Tarde',    '14:00', '22:00', false, 5, 8.0),
  ('Turno Noche',    '22:00', '06:00', true,  5, 8.0),
  ('Jornada Diurna', '08:00', '17:00', false, 5, 8.0),
  ('Jornada Flexible','07:00','17:00', false, 15, 8.0)
ON CONFLICT DO NOTHING;
