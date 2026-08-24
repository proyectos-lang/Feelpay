-- ============================================================================
-- 066 - Control de Pagos: el ajuste cae en la cuota y en el dia correctos
-- ============================================================================
-- Acompaña al script 065, que parte la plata en "dirigida" y "libre". Este
-- arregla la funcion que escribe esos ajustes.
--
-- DOS COSAS
--
-- 1) LAS REVERSAS DEL AJUSTE NO LLEVABAN `cuota_objetivo`.
--    Con el 065, la bolsa dirigida de cada cuota se netea sumando sus pagos y
--    restando sus reversas. Una reversa sin `cuota_objetivo` sacaba plata del
--    prestamo pero no de la bolsa de esa cuota, asi que BAJAR el monto de una
--    cuota ajustada quedaba a medias: se iba la plata y la cuota seguia
--    marcada. Ahora las tres reversas que genera esta funcion —bajar el monto,
--    marcar no pago, devolver a pendiente— llevan la cuota a la que aplican.
--
-- 2) EL AJUSTE SE REGISTRABA CON LA FECHA DE HOY.
--    Corregir la cuota del 22 un dia 24 metia esa plata en la caja del 24: el
--    resumen del 22 seguia mal y el del 24 quedaba inflado con plata que no
--    entro ese dia. Ahora se registra en el dia de LA CUOTA.
--
--    OJO, ESTO CORRIGE DIAS HACIA ATRAS. Si el dia de la cuota ya se cerro y
--    se aprobo, su resumen cambia. Es lo que se pidio, y es lo correcto para
--    una CORRECCION —la plata pertenece a ese dia—, pero conviene saberlo
--    antes de ajustar cuotas viejas.
--
-- Si se cambia la fecha de la cuota en el mismo ajuste, manda la fecha nueva:
-- es el dia al que la cuota va a pertenecer de ahora en adelante.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) ajustar_cuota_control_pagos ───────────────────────────────────
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
AS $$
DECLARE
  v_pp_id        uuid;
  v_idem         uuid;
  v_prev         jsonb;
  v_pp           record;
  v_loan         record;
  v_saldo_antes  numeric;
  v_fecha_nueva  date;
  v_valor_nuevo  numeric;
  v_estado_des   text;
  v_monto_des    numeric;
  v_asignado     numeric;
  v_delta        numeric;
  v_hoy          date;
  v_fecha_ajuste date;
  v_antes        jsonb;
  v_recalc       jsonb;
  v_resultado    jsonb;
  v_g            record;
BEGIN
  IF lower(COALESCE(p_rol,'')) NOT IN ('secretaria','secretario','admin','administrador') THEN
    RAISE EXCEPTION 'Solo secretaría o admin puede ajustar cuotas (rol: %)', p_rol;
  END IF;

  v_pp_id := NULLIF(p_payload->>'payment_plan_id','')::uuid;
  IF v_pp_id IS NULL THEN
    RAISE EXCEPTION 'Falta payment_plan_id';
  END IF;

  v_idem := NULLIF(p_payload->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'ajuste_cuota', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  SELECT * INTO v_pp FROM payment_plan WHERE id = v_pp_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuota no existe';
  END IF;

  SELECT id, estado, client_id, saldo INTO v_loan
    FROM loans WHERE id = v_pp.loan_id FOR UPDATE;
  v_saldo_antes := v_loan.saldo;

  SELECT COALESCE(c.monto_asignado, 0) INTO v_asignado
    FROM v_cobertura_cuotas c WHERE c.id = v_pp_id;
  v_asignado := COALESCE(v_asignado, 0);

  v_hoy         := (now() AT TIME ZONE 'America/Bogota')::date;
  v_fecha_nueva := NULLIF(p_payload->>'fecha_pago','')::date;
  v_valor_nuevo := NULLIF(p_payload->>'valor_cuota','')::numeric;
  v_estado_des  := NULLIF(p_payload->>'estado','');
  v_monto_des   := NULLIF(p_payload->>'monto_pagado','')::numeric;

  -- La plata de un ajuste se registra en el dia de LA CUOTA, no en el de hoy.
  -- Corregir la cuota del 22 un dia 24 metia esa plata en la caja del 24: el
  -- resumen del 22 seguia mal y el del 24 quedaba inflado con plata que no
  -- entro ese dia. OJO: esto corrige dias hacia atras, incluso ya cerrados.
  --
  -- Va DESPUES de leer `v_fecha_nueva`: si el mismo ajuste mueve la cuota de
  -- dia, manda el dia nuevo, que es al que la cuota va a pertenecer.
  v_fecha_ajuste := COALESCE(v_fecha_nueva, v_pp.fecha_pago, v_hoy);

  IF v_valor_nuevo IS NOT NULL AND v_valor_nuevo < 0 THEN
    RAISE EXCEPTION 'valor_cuota no puede ser negativo';
  END IF;
  IF v_estado_des IS NOT NULL
     AND v_estado_des NOT IN ('pendiente','pagado','parcial','no_pago') THEN
    RAISE EXCEPTION 'Estado no editable desde aquí: % (la cancelación se hace desde el módulo de pagos)', v_estado_des;
  END IF;

  v_antes := jsonb_build_object(
    'numero_cuota', v_pp.numero_cuota, 'fecha_pago', v_pp.fecha_pago,
    'valor_cuota', v_pp.valor_cuota, 'estado', v_pp.estado,
    'monto_pagado', v_pp.monto_pagado, 'monto_asignado', v_asignado);

  -- 1) Edición del cronograma
  IF (v_fecha_nueva IS NOT NULL AND v_fecha_nueva IS DISTINCT FROM v_pp.fecha_pago)
     OR (v_valor_nuevo IS NOT NULL AND v_valor_nuevo IS DISTINCT FROM v_pp.valor_cuota) THEN
    UPDATE payment_plan
       SET fecha_pago  = COALESCE(v_fecha_nueva, fecha_pago),
           valor_cuota = COALESCE(v_valor_nuevo, valor_cuota),
           updated_at  = NOW()
     WHERE id = v_pp_id;
  END IF;

  -- 2) Ediciones de estado/plata → eventos
  IF v_estado_des IS NOT NULL THEN
    IF v_estado_des IN ('pagado','parcial') THEN
      v_delta := COALESCE(v_monto_des,
                          COALESCE(v_valor_nuevo, v_pp.valor_cuota)) - v_asignado;
      IF v_delta > 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, cuota_objetivo, origen, observacion, detalle)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'pago', 'aplicada', v_fecha_ajuste, v_delta, v_pp_id, 'ajuste',
          'Ajuste desde Control de Pagos',
          jsonb_build_object('cuota', v_pp.numero_cuota));
      ELSIF v_delta < 0 THEN
        -- `cuota_objetivo` TAMBIEN en la reversa: sin eso, bajar el monto de
        -- una cuota sacaba plata del prestamo pero no de la bolsa dirigida de
        -- esa cuota, y el ajuste quedaba a medias (script 065).
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, cuota_objetivo, origen, observacion, detalle)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'reversa', 'aplicada', v_fecha_ajuste, -v_delta, v_pp_id, 'ajuste',
          'Ajuste de dinero desde Control de Pagos',
          jsonb_build_object('cuota', v_pp.numero_cuota));
      END IF;

    ELSIF v_estado_des = 'no_pago' THEN
      IF v_asignado > 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, cuota_objetivo, origen, observacion)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'reversa', 'aplicada', v_fecha_ajuste, v_asignado, v_pp_id, 'ajuste',
          'Retiro de plata al marcar no pago desde Control de Pagos');
      END IF;
      INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
        estado, fecha_gestion, monto, cuota_objetivo, origen, observacion)
      VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
        p_user_id, 'no_pago', 'aplicada', v_fecha_ajuste, 0, v_pp_id, 'ajuste',
        'Marcada no pago desde Control de Pagos');

    ELSIF v_estado_des = 'pendiente' THEN
      IF v_asignado > 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, cuota_objetivo, origen, observacion)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'reversa', 'aplicada', v_fecha_ajuste, v_asignado, v_pp_id, 'ajuste',
          'Cuota devuelta a pendiente desde Control de Pagos');
      END IF;
      FOR v_g IN SELECT g.id FROM gestiones g
                  WHERE g.cuota_objetivo = v_pp_id AND g.tipo = 'no_pago'
                    AND g.estado = 'aplicada'
                    AND NOT EXISTS (SELECT 1 FROM gestiones r
                                     WHERE r.referencia_gestion_id = g.id
                                       AND r.tipo = 'reversa' AND r.estado = 'aplicada')
      LOOP
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, referencia_gestion_id, origen, observacion)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'reversa', 'aplicada', v_fecha_ajuste, 0, v_g.id, 'ajuste',
          'No pago anulado desde Control de Pagos');
      END LOOP;
    END IF;
  END IF;

  -- 3) Evento de auditoría del ajuste + recálculo
  INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo, estado,
    fecha_gestion, monto, origen, observacion, detalle)
  VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
    p_user_id, 'ajuste', 'aplicada', v_fecha_ajuste, 0, 'ajuste',
    'Control de Pagos: ajuste de cuota ' || v_pp.numero_cuota,
    jsonb_build_object('cuota_id', v_pp_id, 'antes', v_antes,
      'despues', jsonb_build_object(
        'fecha_pago', COALESCE(v_fecha_nueva, v_pp.fecha_pago),
        'valor_cuota', COALESCE(v_valor_nuevo, v_pp.valor_cuota),
        'estado', COALESCE(v_estado_des, v_pp.estado),
        'monto_pagado', v_monto_des)));

  v_recalc := public.recalcular_prestamo(v_pp.loan_id);

  v_resultado := jsonb_build_object(
    'ok', true,
    'cuotas_actualizadas', 1,
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'saldo_anterior', v_saldo_antes,
    'total_pagado', (v_recalc->>'total_pagado')::numeric,
    'loan_estado_final', v_recalc->>'loan_estado_final',
    'loan_reactivado', (v_loan.estado = 'cancelado'
                        AND (v_recalc->>'loan_estado_final') = 'activo'),
    'cliente_actualizado', true
  );
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 2) Ejecucion para la app ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.ajustar_cuota_control_pagos(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 3) Verificar que quedo la version nueva ──────────────────────────
-- Debe devolver una fila.
SELECT proname, 'version nueva' AS estado
  FROM pg_proc
 WHERE proname = 'ajustar_cuota_control_pagos'
   AND prosrc LIKE '%v_fecha_ajuste%';


-- ── PASO 4) Probarlo de verdad ────────────────────────────────────────────
-- En Control de Pagos, sobre un cliente que deba varios dias:
--   a) marca UNA cuota del medio como pagada
--   b) confirma que queda pagada ELLA, y que las anteriores siguen pendientes
--   c) confirma que el pago aparece en el resumen del dia de esa cuota
--
-- Aca se ven los ajustes registrados, con el dia al que quedaron aplicados:
SELECT g.fecha_gestion AS dia_aplicado,
       g.fecha_hora    AS registrado_el,
       g.tipo, g.monto, g.cuota_objetivo IS NOT NULL AS dirigido,
       g.observacion, g.user_id
  FROM public.gestiones g
 WHERE g.origen = 'ajuste'
 ORDER BY g.fecha_hora DESC
 LIMIT 30;
