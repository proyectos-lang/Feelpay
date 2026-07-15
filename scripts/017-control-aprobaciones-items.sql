-- ============================================================================
-- 017 - Control de Aprobaciones: umbrales por item (gasto/ingreso/retiro)
-- ============================================================================
-- Migracion incremental sobre 016-umbrales-revision.sql (ya ejecutado en
-- produccion). El umbral de gasto/ingreso/retiro deja de ser un unico valor
-- compartido por ruta y pasa a configurarse por item (concepto especifico
-- de las tablas catalogo gastos/ingresos/retiros) dentro de cada ruta.
-- Ventas (nueva/renovacion) y abonos NO cambian.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ruta_item_umbrales (
  id           BIGSERIAL   PRIMARY KEY,
  ruta_id      BIGINT      NOT NULL,
  item_tipo    TEXT        NOT NULL CHECK (item_tipo IN ('ingreso', 'gasto', 'retiro')),
  item_id      BIGINT      NOT NULL,
  habilitado   BOOLEAN     NOT NULL DEFAULT false,
  umbral       NUMERIC(15,2),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ruta_item_umbrales_unique UNIQUE (ruta_id, item_tipo, item_id)
);

CREATE INDEX IF NOT EXISTS idx_ruta_item_umbrales_ruta ON public.ruta_item_umbrales (ruta_id);
ALTER TABLE public.ruta_item_umbrales DISABLE ROW LEVEL SECURITY;

-- El umbral de gasto/ingreso/retiro ahora vive en ruta_item_umbrales.
ALTER TABLE public.ruta_config_umbrales DROP COLUMN IF EXISTS gasto_habilitado;
ALTER TABLE public.ruta_config_umbrales DROP COLUMN IF EXISTS gasto_umbral;
