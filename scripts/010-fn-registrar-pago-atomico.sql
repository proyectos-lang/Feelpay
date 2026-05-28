-- ============================================================================
-- registrar_pago_atomico
-- ============================================================================
-- Funcion atomica que ejecuta TODOS los efectos secundarios de un pago en una
-- sola transaccion: fija las session vars RLS via SET LOCAL, actualiza las
-- cuotas de payment_plan afectadas, ajusta loans.saldo / loans.estado y
-- clients.tiene_prestamo_activo. Devuelve un JSON con el resultado.
--
-- POR QUE ESTA FUNCION
-- --------------------
-- Sin esta funcion, el cliente JavaScript debe hacer:
--   1. RPC fijar_sesion_usuario  (deja vars en conexion A del pool)
--   2. UPDATE payment_plan       (puede caer en conexion B, sin vars → RLS bloquea)
--   3. UPDATE loans              (puede caer en conexion C, sin vars → RLS bloquea)
--   4. UPDATE clients            (puede caer en conexion D, sin vars → RLS bloquea)
--
-- PgBouncer en modo transaccional libera la conexion despues de CADA
-- statement, asi que es practicamente imposible garantizar que las 4
-- operaciones caigan en la misma conexion. El resultado son "0 filas
-- afectadas" silenciosos.
--
-- Esta funcion lo resuelve de RAIZ: PostgREST envuelve la llamada RPC en una
-- unica transaccion, dentro de la cual SET LOCAL aplica para TODOS los
-- statements del bloque. Las session vars y los UPDATEs viven en la misma
-- transaccion y conexion → RLS siempre las ve.
--
-- TIPOS DE OPERACION SOPORTADOS
-- -----------------------------
--   - 'pago_normal':       paga 1+ cuotas completas
--   - 'pago_parcial':      paga monto parcial de la cuota actual
--   - 'cancelacion_total': cliente paga el saldo completo y cancela
--   - 'no_pago':           registra visita sin pago
--
-- ENTRADA (jsonb p_payload)
-- -------------------------
--   {
--     "tipo": "pago_normal" | "pago_parcial" | "cancelacion_total" | "no_pago",
--     "loan_id": "uuid",
--     "client_id": "uuid",
--     "monto": numeric,                 // 0 para no_pago
--     "num_cuotas": int,                // para pago_normal
--     "fecha_pago": "YYYY-MM-DD",       // fecha programada de la cuota objetivo
--     "fecha_pago_real": "ISO8601",     // timestamp en zona Colombia
--     "latitud": numeric | null,
--     "longitud": numeric | null
--   }
--
-- SALIDA (jsonb)
-- --------------
--   {
--     "ok": true,
--     "cuotas_actualizadas": int,
--     "nuevo_saldo": numeric,
--     "loan_estado_final": "activo" | "cancelado",
--     "cliente_marcado_sin_prestamo": bool
--   }
--
--   En caso de error la funcion hace RAISE EXCEPTION con un mensaje claro
--   que se propaga a PostgREST como error 4xx/5xx con detalle legible.
-- ============================================================================

DROP FUNCTION IF EXISTS public.registrar_pago_atomico(bigint, bigint, text, jsonb);

CREATE OR REPLACE FUNCTION public.registrar_pago_atomico(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol     text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
-- SECURITY DEFINER permite que la funcion corra con privilegios del owner
-- (normalmente postgres), de modo que SET LOCAL y los UPDATEs funcionan
-- aunque el rol del cliente (authenticated, anon) no tenga permisos directos
-- sobre las tablas. Las politicas RLS siguen aplicandose porque la funcion
-- usa `current_setting('app.current_*')` para identificar al usuario logico.
SECURITY DEFINER
-- search_path explicito por seguridad: evita ataques de hijacking via
-- temp schemas. SECURITY DEFINER + search_path mutable = vulnerabilidad.
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_tipo            text;
  v_loan_id         uuid;
  v_client_id       uuid;
  v_monto           numeric;
  v_num_cuotas      int;
  v_fecha_pago      date;
  v_fecha_pago_real timestamptz;
  v_latitud         numeric;
  v_longitud        numeric;

  v_saldo_actual    numeric;
  v_loan_estado     text;
  v_loan_ruta_id    bigint;
  v_nuevo_saldo     numeric;
  v_loan_final      text;
  v_marcar_sin_prestamo boolean := false;

  v_total_capital   numeric := 0;
  v_cuotas_upd      int     := 0;
  v_monto_restante  numeric;
  v_cuotas_a_pagar  int;
  v_cuota_record    record;
  v_estado_destino  text;
  v_monto_cuota     numeric;
BEGIN
  -- --------------------------------------------------------------------------
  -- 1) FIJAR SESSION VARS PARA RLS
  --
  -- SET LOCAL aplica solo dentro de la transaccion actual. Como toda la
  -- funcion corre en UNA sola transaccion (PostgREST asi lo envuelve), las
  -- politicas RLS de payment_plan / loans / clients que leen
  -- current_setting('app.current_ruta_id') etc. encuentran SIEMPRE el valor
  -- correcto. Cero condicion de carrera.
  --
  -- Nota: usamos `is_local := true` (3er argumento de set_config) que es
  -- equivalente a SET LOCAL pero permite valores dinamicos via expresion.
  -- --------------------------------------------------------------------------
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_ruta_id', p_ruta_id::text, true);
  PERFORM set_config('app.current_rol',    COALESCE(p_rol, ''), true);

  -- --------------------------------------------------------------------------
  -- 2) PARSEAR PAYLOAD
  -- --------------------------------------------------------------------------
  v_tipo            := p_payload->>'tipo';
  v_loan_id         := (p_payload->>'loan_id')::uuid;
  v_client_id       := (p_payload->>'client_id')::uuid;
  v_monto           := COALESCE((p_payload->>'monto')::numeric, 0);
  v_num_cuotas      := COALESCE((p_payload->>'num_cuotas')::int, 1);
  v_fecha_pago      := (p_payload->>'fecha_pago')::date;
  v_fecha_pago_real := (p_payload->>'fecha_pago_real')::timestamptz;
  v_latitud         := NULLIF(p_payload->>'latitud', '')::numeric;
  v_longitud        := NULLIF(p_payload->>'longitud', '')::numeric;

  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'payload.tipo es requerido';
  END IF;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'payload.loan_id es requerido';
  END IF;

  -- --------------------------------------------------------------------------
  -- 3) LOCK + VALIDACION DEL PRESTAMO
  --
  -- SELECT ... FOR UPDATE bloquea la fila del loan durante la transaccion,
  -- impidiendo escrituras concurrentes que produzcan saldos inconsistentes
  -- (p.ej. dos cobradores registrando pagos al mismo tiempo).
  -- --------------------------------------------------------------------------
  SELECT saldo, estado, client_id
    INTO v_saldo_actual, v_loan_estado, v_client_id
    FROM loans
   WHERE id = v_loan_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prestamo % no encontrado o RLS bloqueo el acceso', v_loan_id;
  END IF;

  IF v_loan_estado = 'cancelado' AND v_tipo IN ('pago_normal', 'pago_parcial', 'cancelacion_total') THEN
    RAISE EXCEPTION 'El prestamo ya esta cancelado';
  END IF;

  v_nuevo_saldo := v_saldo_actual;
  v_loan_final  := v_loan_estado;

  -- --------------------------------------------------------------------------
  -- 4) PROCESAR SEGUN TIPO DE OPERACION
  -- --------------------------------------------------------------------------
  IF v_tipo = 'no_pago' THEN
    -- Buscar la cuota pendiente del dia (o la mas antigua vencida).
    SELECT id
      INTO v_cuota_record
      FROM payment_plan
     WHERE loan_id = v_loan_id
       AND estado  = 'pendiente'
       AND fecha_pago <= v_fecha_pago
     ORDER BY (fecha_pago = v_fecha_pago) DESC, fecha_pago ASC
     LIMIT 1;

    IF FOUND THEN
      UPDATE payment_plan
         SET estado          = 'no_pago',
             fecha_pago_real = v_fecha_pago_real,
             monto_pagado    = 0,
             latitud         = v_latitud,
             longitud        = v_longitud,
             updated_at      = NOW()
       WHERE id = v_cuota_record.id;
      v_cuotas_upd := 1;
    END IF;

  ELSIF v_tipo = 'cancelacion_total' THEN
    -- Marcar la primera cuota pendiente con monto_pagado = saldo_total,
    -- el resto en estado "cancelada" con monto NULL.
    FOR v_cuota_record IN
      SELECT id, capital
        FROM payment_plan
       WHERE loan_id = v_loan_id
         AND estado  = 'pendiente'
       ORDER BY numero_cuota ASC
    LOOP
      IF v_cuotas_upd = 0 THEN
        -- Primera pendiente: lleva el monto total del saldo.
        UPDATE payment_plan
           SET estado          = 'cancelada',
               monto_pagado    = v_saldo_actual,
               fecha_pago      = v_fecha_pago,
               fecha_pago_real = v_fecha_pago_real,
               latitud         = v_latitud,
               longitud        = v_longitud,
               updated_at      = NOW()
         WHERE id = v_cuota_record.id;
      ELSE
        -- Cuotas futuras: cancelada sin monto.
        UPDATE payment_plan
           SET estado          = 'cancelada',
               monto_pagado    = NULL,
               fecha_pago_real = v_fecha_pago_real,
               latitud         = v_latitud,
               longitud        = v_longitud,
               updated_at      = NOW()
         WHERE id = v_cuota_record.id;
      END IF;
      v_cuotas_upd := v_cuotas_upd + 1;
    END LOOP;

    v_nuevo_saldo         := 0;
    v_loan_final          := 'cancelado';
    v_marcar_sin_prestamo := true;

  ELSIF v_tipo IN ('pago_normal', 'pago_parcial') THEN
    -- Pago de 1+ cuotas. Para pago_parcial siempre cuotas_a_pagar = 1.
    v_cuotas_a_pagar := CASE WHEN v_tipo = 'pago_parcial' THEN 1 ELSE v_num_cuotas END;
    v_monto_restante := v_monto;

    FOR v_cuota_record IN
      SELECT id, valor_cuota, capital
        FROM payment_plan
       WHERE loan_id = v_loan_id
         AND estado  = 'pendiente'
       ORDER BY numero_cuota ASC
       LIMIT v_cuotas_a_pagar
    LOOP
      v_monto_cuota := CASE
        WHEN v_cuotas_a_pagar = 1 THEN v_monto
        ELSE LEAST(v_monto_restante, v_cuota_record.valor_cuota)
      END;

      v_estado_destino := CASE
        WHEN v_tipo = 'pago_parcial' THEN 'parcial'
        ELSE 'pagado'
      END;

      UPDATE payment_plan
         SET estado          = v_estado_destino,
             monto_pagado    = v_monto_cuota,
             fecha_pago      = v_fecha_pago,
             fecha_pago_real = v_fecha_pago_real,
             latitud         = v_latitud,
             longitud        = v_longitud,
             updated_at      = NOW()
       WHERE id = v_cuota_record.id;

      v_total_capital  := v_total_capital + v_cuota_record.capital;
      v_monto_restante := v_monto_restante - v_monto_cuota;
      v_cuotas_upd     := v_cuotas_upd + 1;

      EXIT WHEN v_monto_restante <= 0;
    END LOOP;

    v_nuevo_saldo := GREATEST(0, v_saldo_actual - v_total_capital);

    -- Si ya no quedan cuotas pendientes, el prestamo se cancela.
    IF NOT EXISTS (
      SELECT 1 FROM payment_plan
       WHERE loan_id = v_loan_id AND estado = 'pendiente'
    ) THEN
      v_loan_final          := 'cancelado';
      v_marcar_sin_prestamo := true;
    END IF;

  ELSE
    RAISE EXCEPTION 'Tipo de operacion no soportado: %', v_tipo;
  END IF;

  -- --------------------------------------------------------------------------
  -- 5) ACTUALIZAR loans
  -- --------------------------------------------------------------------------
  UPDATE loans
     SET saldo      = v_nuevo_saldo,
         estado     = v_loan_final,
         updated_at = NOW()
   WHERE id = v_loan_id;

  -- --------------------------------------------------------------------------
  -- 6) ACTUALIZAR clients si el prestamo se cancelo
  -- --------------------------------------------------------------------------
  IF v_marcar_sin_prestamo AND v_client_id IS NOT NULL THEN
    UPDATE clients
       SET tiene_prestamo_activo = false,
           updated_at            = NOW()
     WHERE id = v_client_id;
  END IF;

  -- --------------------------------------------------------------------------
  -- 7) RESPUESTA
  -- --------------------------------------------------------------------------
  RETURN jsonb_build_object(
    'ok',                            true,
    'cuotas_actualizadas',           v_cuotas_upd,
    'nuevo_saldo',                   v_nuevo_saldo,
    'loan_estado_final',             v_loan_final,
    'cliente_marcado_sin_prestamo',  v_marcar_sin_prestamo
  );
END;
$func$;

-- ============================================================================
-- Permisos
-- ============================================================================
-- Permitir que los roles autenticados invoquen la funcion.
GRANT EXECUTE ON FUNCTION public.registrar_pago_atomico(bigint, bigint, text, jsonb) TO authenticated;
-- Opcional: si necesitas que el rol anon (anonimo) la pueda llamar, descomenta.
-- GRANT EXECUTE ON FUNCTION public.registrar_pago_atomico(bigint, bigint, text, jsonb) TO anon;

-- ============================================================================
-- USO DESDE EL CLIENTE
-- ============================================================================
-- const { data, error } = await supabase.rpc('registrar_pago_atomico', {
--   p_user_id: user.id,
--   p_ruta_id: ruta.id,
--   p_rol:     user.rol ?? null,
--   p_payload: {
--     tipo:            'pago_normal',          // o 'pago_parcial' / 'cancelacion_total' / 'no_pago'
--     loan_id:         '...',
--     client_id:       '...',
--     monto:           50000,
--     num_cuotas:      1,
--     fecha_pago:      '2026-05-12',
--     fecha_pago_real: '2026-05-12T15:30:00-05:00',
--     latitud:         4.65,
--     longitud:        -74.05,
--   },
-- })
--
-- data = {
--   ok: true,
--   cuotas_actualizadas: 1,
--   nuevo_saldo: 450000,
--   loan_estado_final: 'activo',
--   cliente_marcado_sin_prestamo: false
-- }
-- ============================================================================

-- ============================================================================
-- registrar_pago_revertir
-- ============================================================================
-- Contraparte de la funcion anterior: revierte un pago eliminandolo de
-- "gestionados". Se usa cuando el operador borra una gestion del dia.
--
-- Efectos atomicos:
--   1. payment_plan: cuota vuelve a 'pendiente' con monto/fecha limpios.
--   2. loans.saldo: incrementa en `capital` de la cuota.
--   3. loans.estado: si estaba 'cancelado' vuelve a 'activo'.
--   4. clients.tiene_prestamo_activo: si el loan se reactiva, vuelve a true.
--
-- ENTRADA (jsonb p_payload)
--   { "payment_plan_id": "uuid" }
-- ============================================================================

DROP FUNCTION IF EXISTS public.registrar_pago_revertir(bigint, bigint, text, jsonb);

CREATE OR REPLACE FUNCTION public.registrar_pago_revertir(
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
  v_pp_id          uuid;
  v_loan_id        uuid;
  v_client_id      uuid;
  v_capital        numeric;
  v_saldo_actual   numeric;
  v_loan_estado    text;
  v_was_cancelled  boolean;
  v_nuevo_saldo    numeric;
BEGIN
  -- 1) Session vars RLS
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_ruta_id', p_ruta_id::text, true);
  PERFORM set_config('app.current_rol',    COALESCE(p_rol, ''), true);

  v_pp_id := (p_payload->>'payment_plan_id')::uuid;
  IF v_pp_id IS NULL THEN
    RAISE EXCEPTION 'payload.payment_plan_id es requerido';
  END IF;

  -- 2) Leer cuota + lock
  SELECT loan_id, capital
    INTO v_loan_id, v_capital
    FROM payment_plan
   WHERE id = v_pp_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cuota % no encontrada o RLS bloqueo el acceso', v_pp_id;
  END IF;

  -- 3) Leer loan + lock
  SELECT saldo, estado, client_id
    INTO v_saldo_actual, v_loan_estado, v_client_id
    FROM loans
   WHERE id = v_loan_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prestamo % no encontrado', v_loan_id;
  END IF;

  v_was_cancelled := (v_loan_estado = 'cancelado');
  v_nuevo_saldo   := v_saldo_actual + COALESCE(v_capital, 0);

  -- 4) Revertir cuota
  UPDATE payment_plan
     SET estado          = 'pendiente',
         monto_pagado    = NULL,
         fecha_pago_real = NULL,
         updated_at      = NOW()
   WHERE id = v_pp_id;

  -- 5) Restaurar saldo (y reactivar prestamo si estaba cancelado)
  UPDATE loans
     SET saldo      = v_nuevo_saldo,
         estado     = CASE WHEN v_was_cancelled THEN 'activo' ELSE v_loan_estado END,
         updated_at = NOW()
   WHERE id = v_loan_id;

  -- 6) Reactivar cliente si correspondia
  IF v_was_cancelled AND v_client_id IS NOT NULL THEN
    UPDATE clients
       SET tiene_prestamo_activo = true,
           updated_at            = NOW()
     WHERE id = v_client_id;
  END IF;

  RETURN jsonb_build_object(
    'ok',                  true,
    'nuevo_saldo',         v_nuevo_saldo,
    'prestamo_reactivado', v_was_cancelled
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.registrar_pago_revertir(bigint, bigint, text, jsonb) TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.registrar_pago_revertir(bigint, bigint, text, jsonb) TO anon;
