-- BarHub Supabase Schema
-- Ejecutar en SQL Editor de Supabase → proyecto BarHub

-- Ventas por mesero (del PDF SoftRestaurant)
CREATE TABLE IF NOT EXISTS ventas_mesero (
  id            SERIAL PRIMARY KEY,
  semana        TEXT NOT NULL,
  semana_inicio DATE,
  semana_fin    DATE,
  nombre        TEXT NOT NULL,
  venta         NUMERIC DEFAULT 0,
  prop_tarjeta  NUMERIC DEFAULT 0,
  propina       NUMERIC DEFAULT 0,
  efectivo      NUMERIC DEFAULT 0,
  comensales    INT DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, nombre)
);

-- Ventas por grupo (del PDF SoftRestaurant)
CREATE TABLE IF NOT EXISTS ventas_grupo (
  id            SERIAL PRIMARY KEY,
  semana        TEXT NOT NULL,
  semana_inicio DATE,
  semana_fin    DATE,
  grupo         TEXT NOT NULL,
  venta         NUMERIC DEFAULT 0,
  cantidad      INT DEFAULT 0,
  es_subgrupo   BOOLEAN DEFAULT false,
  grupo_padre   TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, grupo)
);

-- Asistencias (del PDF SoftRestaurant)
CREATE TABLE IF NOT EXISTS asistencias (
  id              SERIAL PRIMARY KEY,
  semana          TEXT NOT NULL,
  semana_inicio   DATE,
  semana_fin      DATE,
  nombre          TEXT NOT NULL,
  horas_reales    NUMERIC DEFAULT 0,
  dias_asistidos  INT DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, nombre)
);

-- Compras / gastos variables
CREATE TABLE IF NOT EXISTS compras (
  id            SERIAL PRIMARY KEY,
  semana        TEXT NOT NULL,
  semana_inicio DATE,
  semana_fin    DATE,
  fecha         DATE,
  proveedor     TEXT NOT NULL,
  descripcion   TEXT,
  monto         NUMERIC DEFAULT 0,
  area          TEXT DEFAULT 'compartido',
  estado_pago   TEXT DEFAULT 'pagado',
  plazo_dias    INT  DEFAULT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Gastos fijos mensuales (renta, servicios, etc.)
CREATE TABLE IF NOT EXISTS gastos_fijos (
  id         BIGSERIAL PRIMARY KEY,
  año        INT NOT NULL,
  mes        INT NOT NULL,
  concepto   TEXT NOT NULL,
  monto      NUMERIC DEFAULT 0,
  area       TEXT DEFAULT 'compartido',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Catálogo editable de empleados (reemplaza los arrays hardcodeados
-- EMPLEADOS_BASE/PISO de barhub.html y el EMPLEADOS obsoleto de nomina.js)
CREATE TABLE IF NOT EXISTS empleados (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT NOT NULL,
  nombre_key    TEXT GENERATED ALWAYS AS (lower(trim(nombre))) STORED,
  area          TEXT,
  dept          TEXT,
  sal_diario    NUMERIC DEFAULT 0,
  hrs_prog      NUMERIC DEFAULT 0,
  pago_fijo     NUMERIC,               -- NULL = se paga por día (sal_diario * dias)
  admin_fijo    BOOLEAN DEFAULT false, -- siempre cobra completo, sin importar asistencia
  en_piso       BOOLEAN DEFAULT false, -- recibe reparto de "moche"
  piso_flexible BOOLEAN DEFAULT false, -- sin registro de asistencia = 0h (no jornada completa)
  activo        BOOLEAN DEFAULT true,  -- baja lógica; nunca se borra físicamente
  orden         INT DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(nombre_key)
);

-- Overrides editables de nómina/propinas por semana + empleado.
-- NULL en cualquier *_override = usar el cálculo por defecto (nominaCalc.js);
-- valor no-nulo = edición guardada desde la UI. "comida" no es un override,
-- es un valor directo (dobla lo que antes vivía en una tabla "comida" separada).
CREATE TABLE IF NOT EXISTS nomina_semanal (
  id                    SERIAL PRIMARY KEY,
  semana                TEXT NOT NULL,
  nombre_key            TEXT NOT NULL,
  pago_override         NUMERIC,
  moche_override        NUMERIC,
  prop_tarjeta_override NUMERIC,
  prop_piso_override    NUMERIC,
  comida                NUMERIC DEFAULT 0,
  nota                  TEXT,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, nombre_key)
);

-- Resumen semanal (totales)
CREATE TABLE IF NOT EXISTS resumen_semanal (
  id           SERIAL PRIMARY KEY,
  semana       TEXT UNIQUE NOT NULL,
  total_ventas NUMERIC DEFAULT 0,
  fecha_inicio TEXT,
  fecha_fin    TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Log de sincronizaciones
CREATE TABLE IF NOT EXISTS sync_log (
  id                   SERIAL PRIMARY KEY,
  semana               TEXT,
  archivos_procesados  INT DEFAULT 0,
  resultados           TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
