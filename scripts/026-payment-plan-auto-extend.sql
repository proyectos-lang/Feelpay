-- ============================================================================
-- 026 - Generar cuota adicional cuando se acaba el plan de pagos y el
-- cliente aun debe (evita que un prestamo quede "sin fechas" a las que
-- caer para seguir cobrando).
-- ============================================================================
-- Causa raiz: el "Saldo" que ve la app viene de la vista
-- saldo_prestamos_clientes, que se calcula como (total a pagar del
-- prestamo) - (suma de todo lo realmente recaudado) -- independiente de
-- si quedan filas 'pendiente' en payment_plan. registrar_pago_atomico, en
-- cambio, cancelaba el prestamo apenas dejaban de existir filas
-- 'pendiente', sin mirar si esa vista todavia mostraba saldo positivo.
--
-- Este script:
--   1. Agrega generar_cuota_adicional(loan_id): inserta UNA cuota nueva
--      clonando el patron recurrente del prestamo (toma como plantilla la
--      cuota numero_cuota=1, valida para cualquier tipo de amortizacion).
--   2. Redefine registrar_pago_atomico para que, cuando se agoten las
--      cuotas pendientes (en 'no_pago', 'pago_normal' y 'pago_parcial'),
--      SOLO SI el payload trae `generar_cuota_si_debe: true` (el cobrador
--      lo confirmo explicitamente en el front al estar en la ultima
--      cuota), revise saldo_prestamos_clientes: si el cliente aun debe,
--      genera la cuota adicional en vez de cancelar el prestamo. Si el
--      flag no viene o es false, el comportamiento es IDENTICO al
--      original (scripts/010-fn-registrar-pago-atomico.sql) -- cancela
--      sin generar nada.
-- ============================================================================

-- ============================================================================
-- generar_cuota_adicional
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generar_cuota_adicional(p_loan_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_max_numero       int;
  v_ultima_fecha     date;
  v_ultimo_saldo     numeric;
  v_ruta             bigint;
  v_template_valor   numeric;
  v_template_capital numeric;
  v_template_interes numeric;
  v_frecuencia       text;
  v_es_empleado      boolean;
  v_nueva_fecha      date;
BEGIN
  SELECT max(numero_cuota) INTO v_max_numero
    FROM payment_plan WHERE loan_id = p_loan_id;

  IF v_max_numero IS NULL THEN
    RETURN; -- sin plan de pagos, no hay nada que extender (no deberia pasar)
  END IF;

  SELECT fecha_pago, saldo, ruta
    INTO v_ultima_fecha, v_ultimo_saldo, v_ruta
    FROM payment_plan
   WHERE loan_id = p_loan_id AND numero_cuota = v_max_numero;

  -- La cuota #1 sirve de plantilla para cualquier tipo de amortizacion: es
  -- la unica que nunca es "especial" (la unica cuota especial es la ULTIMA
  -- de un prestamo americano, que carga todo el capital, y esa nunca se
  -- usa aqui).
  SELECT valor_cuota, capital, interes
    INTO v_template_valor, v_template_capital, v_template_interes
    FROM payment_plan
   WHERE loan_id = p_loan_id AND numero_cuota = 1;

  SELECT frecuencia_pago, prestamo_empleado
    INTO v_frecuencia, v_es_empleado
    FROM loans WHERE id = p_loan_id;

  -- Prestamos empleado cobran diario sin importar frecuencia_pago
  -- configurada (mismo criterio que lib/loan-schedule.ts).
  IF v_es_empleado THEN
    v_frecuencia := 'daily';
  END IF;

  v_nueva_fecha := v_ultima_fecha;
  CASE v_frecuencia
    WHEN 'weekly'   THEN v_nueva_fecha := v_nueva_fecha + 7;
    WHEN 'biweekly' THEN v_nueva_fecha := v_nueva_fecha + 15;
    WHEN 'monthly'  THEN v_nueva_fecha := v_nueva_fecha + 30;
    ELSE                 v_nueva_fecha := v_nueva_fecha + 1; -- daily / default
  END CASE;

  -- Cobro diario no aplica domingos (mismo criterio que
  -- lib/loan-schedule.ts): si cae domingo, se corre al lunes. Solo
  -- aplica cuando el paso fue de 1 dia (diario).
  IF (v_frecuencia IS NULL OR v_frecuencia = 'daily') AND extract(dow from v_nueva_fecha) = 0 THEN
    v_nueva_fecha := v_nueva_fecha + 1;
  END IF;

  INSERT INTO payment_plan (
    loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo, estado, ruta
  ) VALUES (
    p_loan_id, v_max_numero + 1, v_nueva_fecha,
    v_template_valor, v_template_capital, v_template_interes,
    GREATEST(0, COALESCE(v_ultimo_saldo, 0) - COALESCE(v_template_capital, 0)),
    'pendiente', v_ruta
  );

  UPDATE loans
     SET numero_cuotas = v_max_numero + 1,
         updated_at    = NOW()
   WHERE id = p_loan_id;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.generar_cuota_adicional(uuid) TO authenticated;

-- ============================================================================
-- registrar_pago_atomico (redefinicion completa)
-- ============================================================================
-- Identica al original (scripts/010-fn-registrar-pago-atomico.sql) salvo:
--   - nueva variable v_saldo_vista
--   - bloque 'no_pago': si se agota el plan, revisa saldo_prestamos_clientes
--     y genera cuota adicional si el cliente aun debe.
--   - bloque 'pago_normal'/'pago_parcial': el cancelado automatico ahora
--     solo ocurre si saldo_prestamos_clientes ya no muestra deuda; si
--     todavia debe, genera cuota adicional en vez de cancelar.
-- La firma y el tipo de retorno (jsonb) no cambian, por eso no hace falta
-- DROP FUNCTION antes del CREATE OR REPLACE.
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

  v_saldo_actual    numeric;
  v_loan_estado     text;
  v_loan_ruta_id    bigint;
  v_nuevo_saldo     numeric;
  v_loan_final      text;
  v_marcar_sin_prestamo boolean := false;
  v_saldo_vista     numeric;
  v_cuota_adicional_generada boolean := false;

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
  v_generar_cuota_si_debe := COALESCE((p_payload->>'generar_cuota_si_debe')::boolean, false);

  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'payload.tipo es requerido';
  END IF;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'payload.loan_id es requerido';
  END IF;

  -- --------------------------------------------------------------------------
  -- 3) LOCK + VALIDACION DEL PRESTAMO
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

    -- Si con esto se agotaron las cuotas pendientes, el cobrador confirmo
    -- en el front que quiere generar una cuota adicional si aun se debe,
    -- y el cliente aun debe (segun saldo_prestamos_clientes, la misma
    -- fuente que ve la UI), generar la cuota adicional.
    IF v_generar_cuota_si_debe AND NOT EXISTS (
      SELECT 1 FROM payment_plan
       WHERE loan_id = v_loan_id AND estado = 'pendiente'
    ) THEN
      SELECT saldo_pendiente INTO v_saldo_vista
        FROM saldo_prestamos_clientes WHERE loan_id = v_loan_id;

      IF COALESCE(v_saldo_vista, 0) > 0 THEN
        PERFORM public.generar_cuota_adicional(v_loan_id);
        v_cuota_adicional_generada := true;
      END IF;
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

    -- Si ya no quedan cuotas pendientes: si el cobrador confirmo en el
    -- front que quiere generar cuota adicional cuando aun se deba,
    -- verificar el saldo real (segun saldo_prestamos_clientes, la MISMA
    -- fuente que ve la UI) antes de cancelar. Si aun debe, se genera una
    -- cuota adicional en vez de dejar el prestamo cancelado con saldo
    -- pendiente. Si el flag no vino, comportamiento identico al original:
    -- cancela sin mirar el saldo.
    IF NOT EXISTS (
      SELECT 1 FROM payment_plan
       WHERE loan_id = v_loan_id AND estado = 'pendiente'
    ) THEN
      IF v_generar_cuota_si_debe THEN
        SELECT saldo_pendiente INTO v_saldo_vista
          FROM saldo_prestamos_clientes WHERE loan_id = v_loan_id;

        IF COALESCE(v_saldo_vista, 0) > 0 THEN
          PERFORM public.generar_cuota_adicional(v_loan_id);
          v_cuota_adicional_generada := true;
        ELSE
          v_loan_final          := 'cancelado';
          v_marcar_sin_prestamo := true;
        END IF;
      ELSE
        v_loan_final          := 'cancelado';
        v_marcar_sin_prestamo := true;
      END IF;
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
    'cliente_marcado_sin_prestamo',  v_marcar_sin_prestamo,
    'cuota_adicional_generada',      v_cuota_adicional_generada
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.registrar_pago_atomico(bigint, bigint, text, jsonb) TO authenticated;
