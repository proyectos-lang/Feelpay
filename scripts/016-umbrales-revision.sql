-- ============================================================================
-- 016 - Umbrales de aprobación por ruta + cola de revisión de secretaría
-- ============================================================================
-- Introduce dos tablas nuevas (ruta_config_umbrales, solicitudes_revision) y
-- una RPC atómica (aprobar_solicitud_revision). NO modifica ninguna tabla ni
-- función existente (loans, payment_plan, gastosregistros,
-- crear_venta_atomica, registrar_pago_atomico quedan intactas).
-- RLS deshabilitado, consistente con el resto de la app.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ruta_config_umbrales (
  id                           BIGSERIAL   PRIMARY KEY,
  ruta_id                      BIGINT      NOT NULL UNIQUE,
  gasto_habilitado             BOOLEAN     NOT NULL DEFAULT false,
  gasto_umbral                 NUMERIC(15,2),
  venta_nueva_habilitado       BOOLEAN     NOT NULL DEFAULT false,
  venta_nueva_umbral           NUMERIC(15,2),
  venta_renovacion_habilitado  BOOLEAN     NOT NULL DEFAULT false,
  venta_renovacion_umbral      NUMERIC(15,2),
  abono_habilitado             BOOLEAN     NOT NULL DEFAULT false,
  abono_umbral                 NUMERIC(15,2),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Nota: sin FK a rutas(id) porque el esquema exacto de `rutas` en producción
-- no se puede verificar desde el repo (tabla creada fuera de scripts/).

CREATE INDEX IF NOT EXISTS idx_ruta_config_umbrales_ruta ON public.ruta_config_umbrales (ruta_id);
ALTER TABLE public.ruta_config_umbrales DISABLE ROW LEVEL SECURITY;

-- Cola de staging: gasto/venta/abono que superó el umbral de su ruta.
-- payload jsonb = exactamente lo que se le habría pasado al flujo de
-- escritura original (saveTransaction / crear_venta_atomica / registrar_pago_atomico).
CREATE TABLE IF NOT EXISTS public.solicitudes_revision (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                   TEXT        NOT NULL CHECK (tipo IN ('gasto', 'venta', 'abono')),
  subtipo                TEXT        CHECK (subtipo IS NULL OR subtipo IN ('nueva', 'renovacion')),
  ruta_id                BIGINT      NOT NULL,
  solicitado_por         BIGINT      NOT NULL,
  solicitado_por_nombre  TEXT,
  monto                  NUMERIC(15,2) NOT NULL,
  descripcion            TEXT,
  payload                JSONB       NOT NULL,
  estado                 TEXT        NOT NULL DEFAULT 'pendiente'
                                      CHECK (estado IN ('pendiente', 'aprobado', 'rechazado')),
  revisado_por           BIGINT,
  revisado_por_nombre    TEXT,
  revisado_at            TIMESTAMPTZ,
  motivo_rechazo         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_revision_estado_tipo ON public.solicitudes_revision (estado, tipo);
CREATE INDEX IF NOT EXISTS idx_solicitudes_revision_ruta        ON public.solicitudes_revision (ruta_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_revision_created     ON public.solicitudes_revision (created_at);
ALTER TABLE public.solicitudes_revision DISABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RPC: aprobar_solicitud_revision
-- Aprueba/rechaza una solicitud pendiente de tipo 'venta' o 'abono' de forma
-- atómica. NO maneja tipo='gasto' (ver movimientos-revision.tsx, que llama
-- saveTransaction() directamente para ese caso porque necesita subir fotos
-- a Vercel Blob, algo que SQL no puede hacer).
--
-- p_payload: { "solicitud_id": "uuid", "decision": "aprobado"|"rechazado",
--              "motivo_rechazo": "text opcional" }
-- ============================================================================

DROP FUNCTION IF EXISTS public.aprobar_solicitud_revision(bigint, bigint, text, jsonb);

CREATE OR REPLACE FUNCTION public.aprobar_solicitud_revision(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol     text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_solicitud_id   uuid;
  v_decision       text;
  v_motivo         text;
  v_row            record;
  v_user_nombre    text;
BEGIN
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_ruta_id', p_ruta_id::text, true);
  PERFORM set_config('app.current_rol',    COALESCE(p_rol, ''), true);

  IF p_rol IS NULL OR lower(p_rol) NOT IN ('secretaria', 'secretario') THEN
    RAISE EXCEPTION 'Solo la secretaria puede aprobar o rechazar solicitudes de revision';
  END IF;

  v_solicitud_id := (p_payload->>'solicitud_id')::uuid;
  v_decision     := p_payload->>'decision';
  v_motivo       := p_payload->>'motivo_rechazo';

  IF v_solicitud_id IS NULL THEN
    RAISE EXCEPTION 'payload.solicitud_id es requerido';
  END IF;
  IF v_decision NOT IN ('aprobado', 'rechazado') THEN
    RAISE EXCEPTION 'payload.decision debe ser "aprobado" o "rechazado"';
  END IF;

  SELECT id, tipo, ruta_id, payload, estado
    INTO v_row
    FROM solicitudes_revision
   WHERE id = v_solicitud_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud % no encontrada', v_solicitud_id;
  END IF;
  IF v_row.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'La solicitud % ya fue procesada (estado actual: %)', v_solicitud_id, v_row.estado;
  END IF;

  SELECT nombre INTO v_user_nombre FROM usuarios WHERE id = p_user_id;

  IF v_decision = 'rechazado' THEN
    UPDATE solicitudes_revision
       SET estado = 'rechazado', revisado_por = p_user_id,
           revisado_por_nombre = v_user_nombre, revisado_at = NOW(),
           motivo_rechazo = v_motivo
     WHERE id = v_solicitud_id;
    RETURN jsonb_build_object('ok', true, 'tipo', v_row.tipo, 'estado', 'rechazado');
  END IF;

  IF v_row.tipo = 'gasto' THEN
    RAISE EXCEPTION 'Las solicitudes de tipo gasto se aprueban desde el cliente, no via aprobar_solicitud_revision';

  ELSIF v_row.tipo = 'venta' THEN
    -- Firma conocida (new-loan.tsx líneas 887-899):
    -- crear_venta_atomica(p_user_id, p_ruta_id, p_rol, p_cliente, p_loan, p_payment_plan)
    PERFORM public.crear_venta_atomica(
      p_user_id      := p_user_id,
      p_ruta_id      := v_row.ruta_id,
      p_rol          := p_rol,
      p_cliente      := v_row.payload->'p_cliente',
      p_loan         := v_row.payload->'p_loan',
      p_payment_plan := v_row.payload->'p_payment_plan'
    );

  ELSIF v_row.tipo = 'abono' THEN
    -- Firma conocida (scripts/010-fn-registrar-pago-atomico.sql)
    PERFORM public.registrar_pago_atomico(
      p_user_id := p_user_id,
      p_ruta_id := v_row.ruta_id,
      p_rol     := p_rol,
      p_payload := v_row.payload->'p_payload'
    );

  ELSE
    RAISE EXCEPTION 'Tipo de solicitud no soportado: %', v_row.tipo;
  END IF;

  UPDATE solicitudes_revision
     SET estado = 'aprobado', revisado_por = p_user_id,
         revisado_por_nombre = v_user_nombre, revisado_at = NOW()
   WHERE id = v_solicitud_id;

  RETURN jsonb_build_object('ok', true, 'tipo', v_row.tipo, 'estado', 'aprobado');
END;
$func$;

GRANT EXECUTE ON FUNCTION public.aprobar_solicitud_revision(bigint, bigint, text, jsonb) TO authenticated;

-- ============================================================================
-- USO DESDE EL CLIENTE (via lib/api-helper.ts → callRpcAtomic)
-- ============================================================================
-- await callRpcAtomic("aprobar_solicitud_revision", {
--   solicitud_id: "...",
--   decision: "aprobado",       // o "rechazado"
--   motivo_rechazo: null,       // opcional, solo si decision = "rechazado"
-- })
-- ============================================================================
