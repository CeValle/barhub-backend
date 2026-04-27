-- BarHub Supabase Schema
-- Ejecutar en SQL Editor de Supabase → proyecto BarHub

-- Ventas por mesero (del PDF SoftRestaurant)
CREATE TABLE IF NOT EXISTS ventas_mesero (
  id           SERIAL PRIMARY KEY,
  semana       TEXT NOT NULL,
  nombre       TEXT NOT NULL,
  venta        NUMERIC DEFAULT 0,
  prop_tarjeta NUMERIC DEFAULT 0,
  efectivo     NUMERIC DEFAULT 0,
  comensales   INT DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, nombre)
);

-- Ventas por grupo (del PDF SoftRestaurant)
CREATE TABLE IF NOT EXISTS ventas_grupo (
  id         SERIAL PRIMARY KEY,
  semana     TEXT NOT NULL,
  grupo      TEXT NOT NULL,
  venta      NUMERIC DEFAULT 0,
  cantidad   INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, grupo)
);

-- Asistencias (del PDF SoftRestaurant)
CREATE TABLE IF NOT EXISTS asistencias (
  id              SERIAL PRIMARY KEY,
  semana          TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  horas_reales    NUMERIC DEFAULT 0,
  dias_asistidos  INT DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, nombre)
);

-- Nómina calculada por semana
CREATE TABLE IF NOT EXISTS nomina_semanal (
  id            SERIAL PRIMARY KEY,
  semana        TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  area          TEXT,
  sueldo        NUMERIC DEFAULT 0,
  moche         NUMERIC DEFAULT 0,
  prop_tarjeta  NUMERIC DEFAULT 0,
  prop_piso     NUMERIC DEFAULT 0,
  comida        NUMERIC DEFAULT 0,
  deuda         NUMERIC DEFAULT 0,
  total_pago    NUMERIC DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(semana, nombre)
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
