-- ============================================================================
-- 034 - Ajuste manual de cuota desde Control de Pagos
-- ============================================================================
-- PROBLEMA
-- Control de Pagos editaba `payment_plan` con un UPDATE suelto desde el
-- navegador. Eso dejaba tres cosas desconectadas:
--
--   1. `loans.saldo` no se movia. Es el campo que usa la RPC de pagos para
--      decidir el monto de una cancelacion total y si el cliente "todavia
--      debe", asi que quedaba mintiendo.
--   2. `loans.estado` no cambiaba. Marcabas todas las cuotas como pagadas y
--      el cliente seguia apareciendo en la ruta al dia siguiente.
--   3. `clients.tiene_prestamo_activo` tampoco. El cliente quedaba bloqueado
--      para una venta nueva aunque ya no debiera nada — o al reves.
--
-- Y no quedaba ningun rastro de quien habia tocado que.
--
-- SOLUCION
-- Una sola transaccion que actualiza la cuota, recalcula el saldo desde el
-- plan completo, ajusta el estado del prestamo y del cliente, y deja el
-- cambio registrado.
--
-- COMO SE RECALCULA EL SALDO
--   saldo = max(0, valor_a_pagar - suma de todo lo pagado en el plan)
--
-- Se calcula sobre el plan ENTERO, no restando de a poco. Un ajuste manual
-- puede subir o bajar un monto, o revertir una cuota ya cobrada, y con
-- restas incrementales el saldo se iria desviando ajuste tras ajuste. Sobre
-- el plan completo el resultado es el mismo se corrija lo que se corrija.
--
-- REACTIVACION
-- Si el ajuste deja cuotas pendientes en un prestamo que estaba cancelado,
-- el prestamo VUELVE a activo. Es la unica forma de arreglar desde la app un
-- prestamo que se cerro con deuda viva.
-- ============================================================================

-- ── Bitacora de ajustes manuales ────────────────────────────────────────
-- Editar plata a mano tiene que dejar rastro: aca queda quien lo hizo, que
-- valores habia antes, cuales quedaron y como se movio el saldo.
CREATE TABLE IF NOT EXISTS public.ajustes_manuales_cuota (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_plan_id   UUID        NOT NULL,
  loan_id           UUID        NOT NULL,
  ruta_id           BIGINT,
  user_id           BIGINT,
  user_nombre       TEXT,
  valores_antes     JSONB       NOT NULL,
  valores_despues   JSONB       NOT NULL,
  saldo_antes       NUMERIC,
  saldo_despues     NUMERIC,
  estado_antes      TEXT,
  estado_despues    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ajustes_manuales_loan ON public.ajustes_manuales_cuota (loan_id);
CREATE INDEX IF NOT EXISTS idx_ajustes_manuales_fecha ON public.ajustes_manuales_cuota (created_at DESC);
ALTER TABLE public.ajustes_manuales_cuota DISABLE ROW LEVEL SECURITY;


-- ============================================================================
-- ajustar_cuota_control_pagos
--
-- p_payload:
--   {
--     "payment_plan_id": "uuid",      -- requerido
--     "fecha_pago":      "YYYY-MM-DD",
--     "valor_cuota":     numeric,
--     "estado":          "pendiente"|"pagado"|"parcial"|"no_pago"|"cancelada",
--     "monto_pagado":    numeric | null,
--     "idempotency_key": "uuid"       -- lo agrega callRpcAtomic
--   }
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ajustar_cuota_control_pagos(
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
  v_pp_id        uuid;
  v_loan_id      uuid;
  v_client_id    uuid;
  v_idem         uuid;
  v_resultado    jsonb;

  v_fecha        date;
  v_valor        numeric;
  v_estado       text;
  v_monto        numeric;

  v_antes        jsonb;
  v_despues      jsonb;

  v_saldo_antes  numeric;
  v_saldo_nuevo  numeric;
  v_estado_antes text;
  v_estado_nuevo text;
  v_valor_a_pagar numeric;
  v_total_pagado numeric;
  v_quedan_pendientes boolean;
  v_filas_cliente int := 0;
  v_user_nombre  text;
BEGIN
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_ruta_id', p_ruta_id::text, true);
  PERFORM set_config('app.current_rol',    COALESCE(p_rol, ''), true);

  IF p_rol IS NULL OR lower(p_rol) NOT IN
     ('secretaria', 'secretario', 'admin', 'administrador') THEN
    RAISE EXCEPTION 'No tienes permiso para ajustar cuotas manualmente';
  END IF;

  v_pp_id := NULLIF(p_payload->>'payment_plan_id', '')::uuid;
  IF v_pp_id IS NULL THEN
    RAISE EXCEPTION 'payload.payment_plan_id es requerido';
  END IF;

  -- Idempotencia: si el ajuste ya se aplico (reintento por mala senal), se
  -- devuelve el resultado original en vez de volver a moverlo.
  v_idem := NULLIF(p_payload->>'idempotency_key', '')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'ajuste_cuota', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
      SELECT resultado INTO v_resultado FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_resultado, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  -- Estado previo de la cuota, para la bitacora.
  SELECT pp.loan_id,
         jsonb_build_object(
           'numero_cuota',    pp.numero_cuota,
           'fecha_pago',      pp.fecha_pago,
           'valor_cuota',     pp.valor_cuota,
           'estado',          pp.estado,
           'monto_pagado',    pp.monto_pagado,
           'fecha_pago_real', pp.fecha_pago_real
         )
    INTO v_loan_id, v_antes
    FROM payment_plan pp
   WHERE pp.id = v_pp_id;

  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'La cuota % no existe', v_pp_id;
  END IF;

  -- Se bloquea el prestamo para que un cobro que entre en paralelo no
  -- recalcule sobre datos a medias.
  SELECT l.saldo, l.estado, l.client_id, COALESCE(l.valor_a_pagar, l.valor)
    INTO v_saldo_antes, v_estado_antes, v_client_id, v_valor_a_pagar
    FROM loans l
   WHERE l.id = v_loan_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El prestamo % no existe', v_loan_id;
  END IF;

  -- ── Normalizar lo que viene del formulario ────────────────────────────
  v_fecha  := COALESCE(NULLIF(p_payload->>'fecha_pago', '')::date, (v_antes->>'fecha_pago')::date);
  v_valor  := COALESCE(NULLIF(p_payload->>'valor_cuota', '')::numeric, (v_antes->>'valor_cuota')::numeric);
  v_estado := COALESCE(NULLIF(p_payload->>'estado', ''), v_antes->>'estado');
  v_monto  := NULLIF(p_payload->>'monto_pagado', '')::numeric;

  IF v_estado NOT IN ('pendiente', 'pagado', 'parcial', 'no_pago', 'cancelada') THEN
    RAISE EXCEPTION 'Estado no valido: %', v_estado;
  END IF;
  IF v_valor < 0 THEN
    RAISE EXCEPTION 'El valor de la cuota no puede ser negativo';
  END IF;

  -- Cada estado tiene su forma coherente de monto. Sin esto quedan filas
  -- como "no pago" con plata cobrada, que despues descuadran el recaudo.
  IF v_estado = 'pendiente' THEN
    v_monto := NULL;
  ELSIF v_estado = 'no_pago' THEN
    v_monto := 0;
  ELSIF v_estado IN ('pagado', 'parcial') AND COALESCE(v_monto, 0) <= 0 THEN
    RAISE EXCEPTION 'Para estado % el monto pagado debe ser mayor a 0', v_estado;
  END IF;

  -- ── Aplicar el cambio ────────────────────────────────────────────────
  UPDATE payment_plan
     SET fecha_pago      = v_fecha,
         valor_cuota     = v_valor,
         estado          = v_estado,
         monto_pagado    = v_monto,
         fecha_pago_real = CASE
                             WHEN v_estado = 'pendiente' THEN NULL
                             ELSE COALESCE(fecha_pago_real, NOW())
                           END,
         updated_at      = NOW()
   WHERE id = v_pp_id;

  -- ── Recalcular el saldo sobre el plan completo ───────────────────────
  SELECT COALESCE(sum(pp.monto_pagado), 0)
    INTO v_total_pagado
    FROM payment_plan pp
   WHERE pp.loan_id = v_loan_id;

  SELECT EXISTS (SELECT 1 FROM payment_plan x
                  WHERE x.loan_id = v_loan_id AND x.estado = 'pendiente')
    INTO v_quedan_pendientes;

  v_saldo_nuevo := GREATEST(0, COALESCE(v_valor_a_pagar, 0) - v_total_pagado);

  -- ── Estado del prestamo ──────────────────────────────────────────────
  -- Se cancela solo cuando no queda nada pendiente NI saldo. Y se REACTIVA
  -- si el ajuste devolvio cuotas pendientes a un prestamo cerrado: es la
  -- unica forma de arreglar desde la app uno que se cancelo con deuda viva.
  IF NOT v_quedan_pendientes AND v_saldo_nuevo <= 0 THEN
    v_estado_nuevo := 'cancelado';
  ELSE
    v_estado_nuevo := 'activo';
  END IF;

  UPDATE loans
     SET saldo = v_saldo_nuevo, estado = v_estado_nuevo, updated_at = NOW()
   WHERE id = v_loan_id;

  -- El cliente queda con prestamo activo si le queda AL MENOS UNO activo.
  IF v_client_id IS NOT NULL THEN
    UPDATE clients c
       SET tiene_prestamo_activo = EXISTS (
             SELECT 1 FROM loans l WHERE l.client_id = c.id AND l.estado = 'activo'
           ),
           updated_at = NOW()
     WHERE c.id = v_client_id
       AND c.tiene_prestamo_activo IS DISTINCT FROM EXISTS (
             SELECT 1 FROM loans l WHERE l.client_id = c.id AND l.estado = 'activo'
           );
    GET DIAGNOSTICS v_filas_cliente = ROW_COUNT;
  END IF;

  -- ── Bitacora ─────────────────────────────────────────────────────────
  SELECT nombre INTO v_user_nombre FROM usuarios WHERE id = p_user_id;

  SELECT jsonb_build_object(
           'numero_cuota',    pp.numero_cuota,
           'fecha_pago',      pp.fecha_pago,
           'valor_cuota',     pp.valor_cuota,
           'estado',          pp.estado,
           'monto_pagado',    pp.monto_pagado,
           'fecha_pago_real', pp.fecha_pago_real
         )
    INTO v_despues
    FROM payment_plan pp WHERE pp.id = v_pp_id;

  INSERT INTO ajustes_manuales_cuota (
    payment_plan_id, loan_id, ruta_id, user_id, user_nombre,
    valores_antes, valores_despues, saldo_antes, saldo_despues,
    estado_antes, estado_despues
  ) VALUES (
    v_pp_id, v_loan_id, p_ruta_id, p_user_id, v_user_nombre,
    v_antes, v_despues, v_saldo_antes, v_saldo_nuevo,
    v_estado_antes, v_estado_nuevo
  );

  v_resultado := jsonb_build_object(
    'ok',                           true,
    'cuotas_actualizadas',          1,
    'nuevo_saldo',                  v_saldo_nuevo,
    'saldo_anterior',               v_saldo_antes,
    'loan_estado_final',            v_estado_nuevo,
    'loan_reactivado',              (v_estado_antes <> 'activo' AND v_estado_nuevo = 'activo'),
    'total_pagado',                 v_total_pagado,
    'cliente_actualizado',          (v_filas_cliente > 0)
  );

  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;

  RETURN v_resultado;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.ajustar_cuota_control_pagos(bigint, bigint, text, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
