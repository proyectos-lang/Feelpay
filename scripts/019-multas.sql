-- ============================================================================
-- 019 - Sistema de multas por mora
-- ============================================================================
-- Multa automatica cuando un cliente acumula N cuotas vencidas sin pagar
-- (umbral y valor configurables por ruta desde Control de Aprobaciones).
-- La generacion corre al cargar el modulo de pagos (la app no tiene procesos
-- programados). Solo puede existir UNA multa pendiente por prestamo a la vez.
-- ============================================================================

-- Configuracion por ruta (columnas nuevas en la tabla existente)
ALTER TABLE public.ruta_config_umbrales ADD COLUMN IF NOT EXISTS multa_habilitada BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.ruta_config_umbrales ADD COLUMN IF NOT EXISTS multa_cuotas_umbral INTEGER;
ALTER TABLE public.ruta_config_umbrales ADD COLUMN IF NOT EXISTS multa_valor NUMERIC(15,2);

CREATE TABLE IF NOT EXISTS public.multas (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               UUID        NOT NULL,
  client_id             UUID        NOT NULL,
  ruta_id               BIGINT      NOT NULL,
  cliente_nombre        TEXT,                -- desnormalizado para listados
  valor                 NUMERIC(15,2) NOT NULL,
  cuotas_mora           INTEGER,             -- cuotas vencidas al momento de generarla
  estado                TEXT NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente', 'pagada', 'cancelada')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pagada_at             TIMESTAMPTZ,
  pagada_por            BIGINT,
  metodo_pago           TEXT,
  cancelada_at          TIMESTAMPTZ,
  cancelada_por         BIGINT,
  cancelada_por_nombre  TEXT,
  motivo_cancelacion    TEXT
);

-- Solo una multa pendiente por prestamo (indice unico parcial: evita
-- duplicados aun con generacion concurrente desde varios dispositivos)
CREATE UNIQUE INDEX IF NOT EXISTS idx_multas_unica_pendiente
  ON public.multas (loan_id) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_multas_ruta_estado ON public.multas (ruta_id, estado);

ALTER TABLE public.multas DISABLE ROW LEVEL SECURITY;
