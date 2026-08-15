-- ============================================================================
-- 042 - `gestiones`: el libro de eventos (ledger) del núcleo nuevo
-- ============================================================================
-- PARTE DE LA FASE 1. Correr en la ceremonia del corte (ver script 049),
-- después del 041.
--
-- QUÉ ES
-- Una tabla INSERT-only donde cada visita/movimiento de un préstamo queda
-- como UN evento inmutable:
--
--   tipo         qué pasó
--   ───────────  ──────────────────────────────────────────────────────────
--   pago         el cliente entregó plata (cubre 1 o varias cuotas — da igual,
--                la asignación a cuotas es derivada, no guardada)
--   no_pago      se visitó y no pagó
--   cancelacion  canceló el crédito (el monto = saldo real cobrado)
--   abono_venta  abono inicial entregado al momento de la venta
--   extension    se extendió el plan (prórroga americana / cuota adicional)
--   ajuste       secretaría cambió algo (el before/after va en `detalle`)
--   reversa      anula o corrige un evento anterior (evento compensatorio;
--                puede venir sin referencia cuando es un ajuste de dinero)
--
--   estado       'aplicada'    → cuenta para saldo/mora/caja
--                'en_revision' → quedó registrada pero NO cuenta hasta que
--                                secretaría la apruebe (la plata nunca se
--                                pierde, solo espera)
--                'rechazada'   → revisada y descartada (tampoco cuenta)
--
--   fecha_gestion  el DÍA DE NEGOCIO al que aplica (la gestión retro de
--                  "ayer no se gestionó" es simplemente fecha_gestion = ayer).
--                  "Gestionado el día D" = existe evento aplicado con esa
--                  fecha — UNA sola definición para toda la app.
--
--   origen       'campo' (cobrador), 'venta' (abono inicial),
--                'homologacion' (venta migrada con historia — NO cuenta en
--                la caja diaria), 'revision' (aplicada al aprobar),
--                'ajuste' (editor de secretaría), 'migracion' (reservado)
--
-- INMUTABILIDAD
-- Un trigger prohíbe DELETE siempre, y solo permite el UPDATE de la
-- transición en_revision → aplicada|rechazada (con su metadata). Todo lo
-- demás se corrige con eventos nuevos (reversa). Auditoría gratis.
--
-- El `id` lo genera el DISPOSITIVO al capturar (llave de idempotencia):
-- reintentar/sincronizar dos veces el mismo evento no lo duplica.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) La tabla ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gestiones (
  id                    UUID PRIMARY KEY,
  loan_id               UUID NOT NULL REFERENCES public.loans(id),
  client_id             UUID,
  ruta                  BIGINT NOT NULL,
  user_id               BIGINT,
  tipo                  TEXT NOT NULL CHECK (tipo IN
                          ('pago','no_pago','cancelacion','abono_venta',
                           'extension','ajuste','reversa')),
  estado                TEXT NOT NULL DEFAULT 'aplicada' CHECK (estado IN
                          ('aplicada','en_revision','rechazada')),
  fecha_gestion         DATE NOT NULL,
  monto                 NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),
  cuota_objetivo        UUID REFERENCES public.payment_plan(id) ON DELETE SET NULL,
  num_cuotas            INTEGER,
  fecha_hora            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metodo_pago           TEXT,
  multa_id              UUID,
  latitud               NUMERIC,
  longitud              NUMERIC,
  geocerca_estado       TEXT,
  geocerca_distancia_m  NUMERIC,
  geocerca_motivo       TEXT,
  origen                TEXT NOT NULL DEFAULT 'campo' CHECK (origen IN
                          ('campo','venta','homologacion','revision','ajuste','migracion')),
  referencia_gestion_id UUID REFERENCES public.gestiones(id),
  observacion           TEXT,
  detalle               JSONB NOT NULL DEFAULT '{}'::jsonb,
  motivo_revision       TEXT,
  revisado_por          BIGINT,
  revisado_nombre       TEXT,
  revisado_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── PASO 2) Sin RLS (convención del proyecto: filtrado por ruta en la app)
ALTER TABLE public.gestiones DISABLE ROW LEVEL SECURITY;


-- ── PASO 3) Lectura para la app (browser usa anon key; escribe solo la RPC)
GRANT SELECT ON public.gestiones TO anon, authenticated;


-- ── PASO 4) Índices ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gestiones_loan_fecha
  ON public.gestiones (loan_id, fecha_gestion);


-- ── PASO 5) ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gestiones_ruta_fecha
  ON public.gestiones (ruta, fecha_gestion);


-- ── PASO 6) ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gestiones_en_revision
  ON public.gestiones (ruta) WHERE estado = 'en_revision';


-- ── PASO 7) ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gestiones_referencia
  ON public.gestiones (referencia_gestion_id) WHERE referencia_gestion_id IS NOT NULL;


-- ── PASO 8) Función del trigger de inmutabilidad ──────────────────────────
CREATE OR REPLACE FUNCTION public.gestiones_inmutables()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gestiones es un libro inmutable: no se borra, se registra una reversa (id: %)', OLD.id;
  END IF;

  -- UPDATE: solo la transición de revisión.
  IF OLD.estado <> 'en_revision' THEN
    RAISE EXCEPTION 'La gestión % ya está en estado % y no se puede modificar; usa una reversa', OLD.id, OLD.estado;
  END IF;
  IF NEW.estado NOT IN ('aplicada','rechazada') THEN
    RAISE EXCEPTION 'Desde en_revision solo se puede pasar a aplicada o rechazada';
  END IF;

  -- Nada del contenido del evento puede cambiar en esa transición.
  IF NEW.id                    IS DISTINCT FROM OLD.id
     OR NEW.loan_id            IS DISTINCT FROM OLD.loan_id
     OR NEW.client_id          IS DISTINCT FROM OLD.client_id
     OR NEW.ruta               IS DISTINCT FROM OLD.ruta
     OR NEW.user_id            IS DISTINCT FROM OLD.user_id
     OR NEW.tipo               IS DISTINCT FROM OLD.tipo
     OR NEW.fecha_gestion      IS DISTINCT FROM OLD.fecha_gestion
     OR NEW.monto              IS DISTINCT FROM OLD.monto
     OR NEW.cuota_objetivo     IS DISTINCT FROM OLD.cuota_objetivo
     OR NEW.num_cuotas         IS DISTINCT FROM OLD.num_cuotas
     OR NEW.fecha_hora         IS DISTINCT FROM OLD.fecha_hora
     OR NEW.metodo_pago        IS DISTINCT FROM OLD.metodo_pago
     OR NEW.multa_id           IS DISTINCT FROM OLD.multa_id
     OR NEW.latitud            IS DISTINCT FROM OLD.latitud
     OR NEW.longitud           IS DISTINCT FROM OLD.longitud
     OR NEW.origen             IS DISTINCT FROM OLD.origen
     OR NEW.referencia_gestion_id IS DISTINCT FROM OLD.referencia_gestion_id
     OR NEW.created_at         IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Al revisar una gestión solo cambia su estado y la metadata de revisión';
  END IF;

  RETURN NEW;
END;
$$;


-- ── PASO 9) El trigger ────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_gestiones_inmutables') THEN
    CREATE TRIGGER trg_gestiones_inmutables
      BEFORE UPDATE OR DELETE ON public.gestiones
      FOR EACH ROW EXECUTE FUNCTION public.gestiones_inmutables();
  END IF;
END $$;


-- ── PASO 10) Verificar ────────────────────────────────────────────────────
-- Debe devolver la tabla con su trigger y 4 índices.
SELECT 'tabla' AS objeto, c.relname AS nombre
  FROM pg_class c WHERE c.relname = 'gestiones' AND c.relkind = 'r'
UNION ALL
SELECT 'trigger', t.tgname FROM pg_trigger t WHERE t.tgname = 'trg_gestiones_inmutables'
UNION ALL
SELECT 'indice', i.indexname::name FROM pg_indexes i
 WHERE i.schemaname = 'public' AND i.indexname LIKE 'idx_gestiones%';
