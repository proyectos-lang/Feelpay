-- ============================================================================
-- 032 - El no pago queda en el dia en que se hizo + logo por ruta
-- ============================================================================
-- PROBLEMA 1 — Los no pagos no aparecian en el Resumen del Dia
-- La rama `no_pago` de registrar_pago_atomico marcaba la cuota pero NO
-- actualizaba `fecha_pago`, a diferencia de la rama de pagos que si lo hace.
-- Si el cobrador marcaba no pago sobre una cuota vencida de otro dia, la fila
-- conservaba su fecha vieja; y como el Resumen del Dia agrupa por
-- `fecha_pago`, esa gestion nunca aparecia.
--   -> Solucion: fijar `fecha_pago = v_fecha_pago` igual que en los pagos, de
--      modo que la gestion quede registrada el dia en que realmente ocurrio.
--
-- PROBLEMA 2 — Logo unico para todas las unidades
-- El recibo y las pantallas usan un logo fijo. Se agrega `logo_url` por ruta.
-- Va en `ruta_config_umbrales` y no en `rutas` porque ya es LA tabla de
-- configuracion por ruta, y sobre todo porque su lector `getRutaUmbrales()`
-- ya tiene cache offline: asi el logo tambien funciona sin senal, sin
-- trabajo adicional. Si la ruta no define logo, se usa el de la app.
-- ============================================================================

ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- ============================================================================
-- registrar_pago_atomico (v5, sobre 030)
-- Unico cambio: `fecha_pago = v_fecha_pago` en los dos UPDATE de la rama
-- `no_pago`. Todo lo demas es identico.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.registrar_pago_atomico(
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
  v_tipo            text;
  v_loan_id         uuid;
  v_client_id       uuid;
  v_monto           numeric;
  v_num_cuotas      int;
  v_fecha_pago      date;
  v_fecha_pago_real timestamptz;
  v_latitud         numeric;
  v_longitud        numeric;
  v_generar_cuota_si_debe boolean;
  v_asociar_a_hoy   boolean;

  v_idem            uuid;
  v_pp_id           uuid;
  v_multa_id        uuid;
  v_metodo_pago     text;
  v_cliente_nombre  text;
  v_extender_cuotas int;

  v_resultado       jsonb;
  v_pp_estado       text;
  v_pp_valor        numeric;
  v_pp_capital      numeric;
  v_motivo          text;
  v_multa_valor     numeric;
  v_multa_upd       int := 0;

  v_saldo_actual    numeric;
  v_loan_estado     text;
  v_nuevo_saldo     numeric;
  v_loan_final      text;
  v_marcar_sin_prestamo boolean := false;
  v_saldo_vista     numeric;
  v_cuota_adicional_generada boolean := false;
  v_fila_hoy_creada boolean := false;
  v_enviado_revision boolean := false;
  v_multa_cobrada   boolean := false;

  v_total_capital   numeric := 0;
  v_cuotas_upd      int     := 0;
  v_monto_restante  numeric;
  v_cuotas_a_pagar  int;
  v_cuota_record    record;
  v_estado_destino  text;
  v_monto_cuota     numeric;

  v_max_numero      int;
  v_ruta_fila       bigint;
BEGIN
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_ruta_id', p_ruta_id::text, true);
  PERFORM set_config('app.current_rol',    COALESCE(p_rol, ''), true);

  v_tipo            := p_payload->>'tipo';
  v_loan_id         := (p_payload->>'loan_id')::uuid;
  v_client_id       := (p_payload->>'client_id')::uuid;
  v_monto           := COALESCE((p_payload->>'monto')::numeric, 0);
  v_num_cuotas      := COALESCE((p_payload->>'num_cuotas')::int, 1);
  v_fecha_pago      := (p_payload->>'fecha_pago')::date;
  v_fecha_pago_real := (p_payload->>'fecha_pago_real')::timestamptz;
  v_latitud         := NULLIF(p_payload->>'latitud', '')::numeric;
  v_longitud        := NULLIF(p_payload->>'longitud', '')::numeric;
  v_generar_cuota_si_debe := COALESCE((p_payload->>'generar_cuota_si_debe')::boolean, false);
  v_asociar_a_hoy   := COALESCE((p_payload->>'asociar_a_hoy')::boolean, false);

  v_idem            := NULLIF(p_payload->>'idempotency_key', '')::uuid;
  v_pp_id           := NULLIF(p_payload->>'payment_plan_id', '')::uuid;
  v_multa_id        := NULLIF(p_payload->>'multa_id', '')::uuid;
  v_metodo_pago     := NULLIF(p_payload->>'metodo_pago', '');
  v_cliente_nombre  := NULLIF(p_payload->>'cliente_nombre', '');
  v_extender_cuotas := COALESCE((p_payload->>'extender_cuotas')::int, 0);

  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'payload.tipo es requerido';
  END IF;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'payload.loan_id es requerido';
  END IF;

  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, v_tipo, p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
      SELECT resultado INTO v_resultado FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_resultado, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  SELECT saldo, estado, client_id
    INTO v_saldo_actual, v_loan_estado, v_client_id
    FROM loans
   WHERE id = v_loan_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prestamo % no encontrado', v_loan_id;
  END IF;

  v_nuevo_saldo := v_saldo_actual;
  v_loan_final  := v_loan_estado;

  -- Conflictos -> revision de secretaria
  v_motivo := NULL;

  IF v_loan_estado = 'cancelado' AND v_tipo IN ('pago_normal', 'pago_parcial', 'cancelacion_total') THEN
    v_motivo := 'El prestamo ya estaba cancelado al sincronizar el pago';
  ELSIF v_pp_id IS NOT NULL AND NOT v_asociar_a_hoy
        AND v_tipo IN ('pago_normal', 'pago_parcial') THEN
    SELECT estado, valor_cuota, capital
      INTO v_pp_estado, v_pp_valor, v_pp_capital
      FROM payment_plan
     WHERE id = v_pp_id AND loan_id = v_loan_id
     FOR UPDATE;

    IF NOT FOUND THEN
      v_motivo := 'La cuota indicada ya no existe';
    ELSIF v_pp_estado <> 'pendiente' THEN
      v_motivo := 'La cuota indicada ya fue gestionada (estado: ' || v_pp_estado || ')';
    END IF;
  END IF;

  IF v_motivo IS NOT NULL THEN
    INSERT INTO solicitudes_revision (
      tipo, ruta_id, solicitado_por, solicitado_por_nombre, monto, descripcion, payload
    ) VALUES (
      'abono', p_ruta_id, p_user_id,
      (SELECT nombre FROM usuarios WHERE id = p_user_id),
      v_monto,
      COALESCE(v_cliente_nombre, 'Cliente') || ' — ' || v_motivo,
      jsonb_build_object('p_payload', p_payload - 'idempotency_key')
    );

    v_resultado := jsonb_build_object(
      'ok', true, 'enviado_a_revision', true, 'motivo', v_motivo,
      'cuotas_actualizadas', 0, 'nuevo_saldo', v_saldo_actual,
      'loan_estado_final', v_loan_estado
    );

    IF v_idem IS NOT NULL THEN
      UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
    END IF;
    RETURN v_resultado;
  END IF;

  -- Prorroga de americano
  IF v_extender_cuotas > 0 AND v_pp_id IS NOT NULL THEN
    UPDATE payment_plan SET valor_cuota = interes, updated_at = NOW()
     WHERE id = v_pp_id AND estado = 'pendiente';
    PERFORM public.extender_prestamo_americano(v_loan_id, v_extender_cuotas, p_ruta_id);
  END IF;

  IF v_tipo = 'no_pago' THEN
    IF v_asociar_a_hoy THEN
      SELECT max(numero_cuota) INTO v_max_numero FROM payment_plan WHERE loan_id = v_loan_id;
      SELECT ruta INTO v_ruta_fila FROM payment_plan WHERE loan_id = v_loan_id ORDER BY numero_cuota DESC LIMIT 1;

      INSERT INTO payment_plan (
        loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo,
        estado, monto_pagado, fecha_pago_real, latitud, longitud, ruta, es_extra
      ) VALUES (
        v_loan_id, COALESCE(v_max_numero, 0) + 1, v_fecha_pago, 0, 0, 0,
        v_saldo_actual, 'no_pago', 0, v_fecha_pago_real, v_latitud, v_longitud, v_ruta_fila, true
      );
      v_cuotas_upd      := 1;
      v_fila_hoy_creada := true;

    ELSE
      IF v_pp_id IS NOT NULL THEN
        SELECT id INTO v_cuota_record
          FROM payment_plan
         WHERE id = v_pp_id AND loan_id = v_loan_id AND estado = 'pendiente'
         FOR UPDATE;
      ELSE
        SELECT id INTO v_cuota_record
          FROM payment_plan
         WHERE loan_id = v_loan_id AND estado = 'pendiente' AND fecha_pago <= v_fecha_pago
         ORDER BY (fecha_pago = v_fecha_pago) DESC, fecha_pago ASC
         LIMIT 1;
      END IF;

      IF FOUND THEN
        -- CAMBIO v5: se fija tambien `fecha_pago`. Sin esto, un no pago sobre
        -- una cuota vencida de otro dia conservaba la fecha vieja y la gestion
        -- no aparecia en el Resumen del Dia (que agrupa por fecha_pago).
        UPDATE payment_plan
           SET estado = 'no_pago', fecha_pago = v_fecha_pago,
               fecha_pago_real = v_fecha_pago_real, monto_pagado = 0,
               latitud = v_latitud, longitud = v_longitud, updated_at = NOW()
         WHERE id = v_cuota_record.id;
        v_cuotas_upd := 1;
      END IF;

      IF v_generar_cuota_si_debe AND NOT EXISTS (
        SELECT 1 FROM payment_plan WHERE loan_id = v_loan_id AND estado = 'pendiente'
      ) THEN
        SELECT saldo_pendiente INTO v_saldo_vista FROM saldo_prestamos_clientes WHERE loan_id = v_loan_id;
        IF v_nuevo_saldo > 0 OR COALESCE(v_saldo_vista, 0) > 0 THEN
          PERFORM public.generar_cuota_adicional(v_loan_id);
          v_cuota_adicional_generada := true;
        END IF;
      END IF;
    END IF;

  ELSIF v_tipo = 'cancelacion_total' THEN
    FOR v_cuota_record IN
      SELECT id, capital FROM payment_plan
       WHERE loan_id = v_loan_id AND estado = 'pendiente'
       ORDER BY numero_cuota ASC
    LOOP
      IF v_cuotas_upd = 0 THEN
        UPDATE payment_plan
           SET estado = 'cancelada', monto_pagado = v_saldo_actual, fecha_pago = v_fecha_pago,
               fecha_pago_real = v_fecha_pago_real, latitud = v_latitud, longitud = v_longitud,
               updated_at = NOW()
         WHERE id = v_cuota_record.id;
      ELSE
        UPDATE payment_plan
           SET estado = 'cancelada', monto_pagado = NULL, fecha_pago_real = v_fecha_pago_real,
               latitud = v_latitud, longitud = v_longitud, updated_at = NOW()
         WHERE id = v_cuota_record.id;
      END IF;
      v_cuotas_upd := v_cuotas_upd + 1;
    END LOOP;

    v_nuevo_saldo         := 0;
    v_loan_final          := 'cancelado';
    v_marcar_sin_prestamo := true;

  ELSIF v_tipo IN ('pago_normal', 'pago_parcial') THEN
    IF v_asociar_a_hoy THEN
      SELECT max(numero_cuota) INTO v_max_numero FROM payment_plan WHERE loan_id = v_loan_id;
      SELECT ruta INTO v_ruta_fila FROM payment_plan WHERE loan_id = v_loan_id ORDER BY numero_cuota DESC LIMIT 1;

      INSERT INTO payment_plan (
        loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo,
        estado, monto_pagado, fecha_pago_real, latitud, longitud, ruta, es_extra
      ) VALUES (
        v_loan_id, COALESCE(v_max_numero, 0) + 1, v_fecha_pago, v_monto, v_monto, 0,
        GREATEST(0, v_saldo_actual - v_monto),
        CASE WHEN v_tipo = 'pago_parcial' THEN 'parcial' ELSE 'pagado' END,
        v_monto, v_fecha_pago_real, v_latitud, v_longitud, v_ruta_fila, true
      );

      v_total_capital   := v_monto;
      v_cuotas_upd      := 1;
      v_fila_hoy_creada := true;
      v_nuevo_saldo     := GREATEST(0, v_saldo_actual - v_total_capital);

    ELSIF v_pp_id IS NOT NULL THEN
      v_estado_destino := CASE WHEN v_tipo = 'pago_parcial' THEN 'parcial' ELSE 'pagado' END;

      UPDATE payment_plan
         SET estado = v_estado_destino, monto_pagado = v_monto, fecha_pago = v_fecha_pago,
             fecha_pago_real = v_fecha_pago_real, latitud = v_latitud, longitud = v_longitud,
             updated_at = NOW()
       WHERE id = v_pp_id;

      v_total_capital := COALESCE(v_pp_capital, 0);
      v_cuotas_upd    := 1;

      IF v_tipo = 'pago_normal' AND v_num_cuotas > 1 THEN
        FOR v_cuota_record IN
          SELECT id, capital FROM payment_plan
           WHERE loan_id = v_loan_id AND estado = 'pendiente'
           ORDER BY numero_cuota ASC
           LIMIT v_num_cuotas - 1
        LOOP
          UPDATE payment_plan
             SET estado = v_estado_destino, monto_pagado = 0, fecha_pago = v_fecha_pago,
                 fecha_pago_real = v_fecha_pago_real, latitud = v_latitud, longitud = v_longitud,
                 updated_at = NOW()
           WHERE id = v_cuota_record.id;
          v_total_capital := v_total_capital + COALESCE(v_cuota_record.capital, 0);
          v_cuotas_upd    := v_cuotas_upd + 1;
        END LOOP;
      END IF;

      v_nuevo_saldo := GREATEST(0, v_saldo_actual - v_total_capital);

    ELSE
      v_cuotas_a_pagar := CASE WHEN v_tipo = 'pago_parcial' THEN 1 ELSE v_num_cuotas END;
      v_monto_restante := v_monto;

      FOR v_cuota_record IN
        SELECT id, valor_cuota, capital FROM payment_plan
         WHERE loan_id = v_loan_id AND estado = 'pendiente'
         ORDER BY numero_cuota ASC
         LIMIT v_cuotas_a_pagar
      LOOP
        v_monto_cuota := CASE
          WHEN v_cuotas_a_pagar = 1 THEN v_monto
          ELSE LEAST(v_monto_restante, v_cuota_record.valor_cuota)
        END;
        v_estado_destino := CASE WHEN v_tipo = 'pago_parcial' THEN 'parcial' ELSE 'pagado' END;

        UPDATE payment_plan
           SET estado = v_estado_destino, monto_pagado = v_monto_cuota, fecha_pago = v_fecha_pago,
               fecha_pago_real = v_fecha_pago_real, latitud = v_latitud, longitud = v_longitud,
               updated_at = NOW()
         WHERE id = v_cuota_record.id;

        v_total_capital  := v_total_capital + v_cuota_record.capital;
        v_monto_restante := v_monto_restante - v_monto_cuota;
        v_cuotas_upd     := v_cuotas_upd + 1;
        EXIT WHEN v_monto_restante <= 0;
      END LOOP;

      v_nuevo_saldo := GREATEST(0, v_saldo_actual - v_total_capital);
    END IF;

    IF NOT v_asociar_a_hoy AND NOT EXISTS (
      SELECT 1 FROM payment_plan WHERE loan_id = v_loan_id AND estado = 'pendiente'
    ) THEN
      IF v_generar_cuota_si_debe THEN
        SELECT saldo_pendiente INTO v_saldo_vista FROM saldo_prestamos_clientes WHERE loan_id = v_loan_id;
        IF v_nuevo_saldo > 0 OR COALESCE(v_saldo_vista, 0) > 0 THEN
          PERFORM public.generar_cuota_adicional(v_loan_id);
          v_cuota_adicional_generada := true;
        ELSE
          v_loan_final := 'cancelado'; v_marcar_sin_prestamo := true;
        END IF;
      ELSE
        v_loan_final := 'cancelado'; v_marcar_sin_prestamo := true;
      END IF;
    END IF;

  ELSE
    RAISE EXCEPTION 'Tipo de operacion no soportado: %', v_tipo;
  END IF;

  -- Cobro de multa dentro de la misma transaccion
  IF v_multa_id IS NOT NULL THEN
    UPDATE multas
       SET estado = 'pagada', pagada_at = NOW(), pagada_por = p_user_id,
           metodo_pago = v_metodo_pago
     WHERE id = v_multa_id AND estado = 'pendiente'
    RETURNING valor INTO v_multa_valor;

    GET DIAGNOSTICS v_multa_upd = ROW_COUNT;

    IF v_multa_upd > 0 THEN
      INSERT INTO gastosregistros (
        fechahorasol, adminid, ruta, concepto, limite, valor, observacion,
        foto, tipo, estadoadmin, estadosecre
      ) VALUES (
        COALESCE(v_fecha_pago_real, NOW()), p_user_id, p_ruta_id,
        'Multa — ' || COALESCE(v_cliente_nombre, 'Cliente'),
        NULL, v_multa_valor, 'Pago de multa por fallas',
        NULL, 'Ingreso', 'NA', 'NA'
      );
      v_multa_cobrada := true;
    END IF;
  END IF;

  UPDATE loans
     SET saldo = v_nuevo_saldo, estado = v_loan_final, updated_at = NOW()
   WHERE id = v_loan_id;

  IF v_marcar_sin_prestamo AND v_client_id IS NOT NULL THEN
    UPDATE clients SET tiene_prestamo_activo = false, updated_at = NOW() WHERE id = v_client_id;
  END IF;

  v_resultado := jsonb_build_object(
    'ok',                            true,
    'cuotas_actualizadas',           v_cuotas_upd,
    'nuevo_saldo',                   v_nuevo_saldo,
    'loan_estado_final',             v_loan_final,
    'cliente_marcado_sin_prestamo',  v_marcar_sin_prestamo,
    'cuota_adicional_generada',      v_cuota_adicional_generada,
    'fila_hoy_creada',               v_fila_hoy_creada,
    'multa_cobrada',                 v_multa_cobrada,
    'enviado_a_revision',            v_enviado_revision
  );

  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;

  RETURN v_resultado;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.registrar_pago_atomico(bigint, bigint, text, jsonb) TO authenticated;
