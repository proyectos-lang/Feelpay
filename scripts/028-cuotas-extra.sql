-- ============================================================================
-- 028 - Cuotas extra separadas de las cuotas base
-- ============================================================================
-- Requisito del negocio: cuando un prestamo se extiende (el cliente paga o
-- se le visita despues de agotarse las fechas del plan, o se pone al dia
-- con un "pago de hoy"), la cuota agregada es una CUOTA EXTRA: cuenta
-- completo en las metricas (meta del dia, recaudo, mora) pero NO modifica
-- el numero de cuotas base del prestamo (loans.numero_cuotas).
--
-- Hasta ahora los tres mecanismos de extension incrementaban
-- loans.numero_cuotas como efecto secundario. Este script:
--   1. Agrega payment_plan.es_extra (default false; historicos quedan en
--      false — decidido: no se reparan hacia atras).
--   2. Redefine generar_cuota_adicional: marca es_extra y deja de tocar
--      loans.numero_cuotas.
--   3. Redefine registrar_pago_atomico (v3, sobre 027): los INSERT de
--      asociar_a_hoy marcan es_extra, se elimina el incremento de
--      numero_cuotas, y el check de cancelacion automatica ahora exige
--      que TANTO loans.saldo COMO saldo_prestamos_clientes.saldo_pendiente
--      digan que no se debe (la vista subestima el saldo de prestamos
--      americanos, y con el check anterior podia cancelar con deuda viva).
--   4. Trae al repo extender_prestamo_americano (antes solo en la DB viva)
--      con el mismo cambio: cuotas insertadas es_extra = true, sin tocar
--      numero_cuotas.
--   5. Redefine v_loan_mora_status para que valor_cuota_referencia (el
--      divisor de dias_mora_calculada) ignore las cuotas extra — un pago
--      grande de ponerse al dia ya no encoge permanentemente los dias de
--      mora del prestamo.
-- ============================================================================

ALTER TABLE public.payment_plan
  ADD COLUMN IF NOT EXISTS es_extra BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- 1) generar_cuota_adicional — es_extra = true, sin tocar numero_cuotas
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
   WHERE loan_id = p_loan_id AND numero_cuota = v_max_numero
   ORDER BY created_at DESC
   LIMIT 1;

  -- La cuota #1 sirve de plantilla para cualquier tipo de amortizacion: es
  -- la unica que nunca es "especial" (la unica cuota especial es la ULTIMA
  -- de un prestamo americano, que carga todo el capital, y esa nunca se
  -- usa aqui).
  SELECT valor_cuota, capital, interes
    INTO v_template_valor, v_template_capital, v_template_interes
    FROM payment_plan
   WHERE loan_id = p_loan_id AND numero_cuota = 1
   ORDER BY created_at ASC
   LIMIT 1;

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
  -- lib/loan-schedule.ts): si cae domingo, se corre al lunes.
  IF (v_frecuencia IS NULL OR v_frecuencia = 'daily') AND extract(dow from v_nueva_fecha) = 0 THEN
    v_nueva_fecha := v_nueva_fecha + 1;
  END IF;

  INSERT INTO payment_plan (
    loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo, estado, ruta, es_extra
  ) VALUES (
    p_loan_id, v_max_numero + 1, v_nueva_fecha,
    v_template_valor, v_template_capital, v_template_interes,
    GREATEST(0, COALESCE(v_ultimo_saldo, 0) - COALESCE(v_template_capital, 0)),
    'pendiente', v_ruta, true
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.generar_cuota_adicional(uuid) TO authenticated;

-- ============================================================================
-- 2) registrar_pago_atomico (v3, sobre 027)
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

  v_saldo_actual    numeric;
  v_loan_estado     text;
  v_loan_ruta_id    bigint;
  v_nuevo_saldo     numeric;
  v_loan_final      text;
  v_marcar_sin_prestamo boolean := false;
  v_saldo_vista     numeric;
  v_cuota_adicional_generada boolean := false;
  v_fila_hoy_creada boolean := false;

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
  v_asociar_a_hoy   := COALESCE((p_payload->>'asociar_a_hoy')::boolean, false);

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
    IF v_asociar_a_hoy THEN
      -- Registrar como visita de hoy en una CUOTA EXTRA nueva, sin tocar
      -- ninguna cuota pendiente existente (la atrasada sigue igual).
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
      -- y el cliente aun debe (segun loans.saldo O la vista de saldos),
      -- generar la cuota extra.
      IF v_generar_cuota_si_debe AND NOT EXISTS (
        SELECT 1 FROM payment_plan
         WHERE loan_id = v_loan_id AND estado = 'pendiente'
      ) THEN
        SELECT saldo_pendiente INTO v_saldo_vista
          FROM saldo_prestamos_clientes WHERE loan_id = v_loan_id;

        IF v_nuevo_saldo > 0 OR COALESCE(v_saldo_vista, 0) > 0 THEN
          PERFORM public.generar_cuota_adicional(v_loan_id);
          v_cuota_adicional_generada := true;
        END IF;
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
    IF v_asociar_a_hoy THEN
      -- Registrar como pago de hoy en una CUOTA EXTRA nueva, sin repartir
      -- contra cuotas pendientes existentes (quedan intactas).
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
      -- Esta via nunca cancela el prestamo: las cuotas atrasadas existentes
      -- siguen intactas.

    ELSE
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

      -- Si ya no quedan cuotas pendientes: con confirmacion del cobrador,
      -- generar cuota extra si el cliente aun debe. La deuda se evalua con
      -- loans.saldo O saldo_prestamos_clientes: se cancela SOLO si ambas
      -- medidas dicen que no debe (la vista subestima el saldo de
      -- prestamos americanos y podia cancelar con deuda viva).
      IF NOT EXISTS (
        SELECT 1 FROM payment_plan
         WHERE loan_id = v_loan_id AND estado = 'pendiente'
      ) THEN
        IF v_generar_cuota_si_debe THEN
          SELECT saldo_pendiente INTO v_saldo_vista
            FROM saldo_prestamos_clientes WHERE loan_id = v_loan_id;

          IF v_nuevo_saldo > 0 OR COALESCE(v_saldo_vista, 0) > 0 THEN
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
    END IF;

  ELSE
    RAISE EXCEPTION 'Tipo de operacion no soportado: %', v_tipo;
  END IF;

  -- --------------------------------------------------------------------------
  -- 5) ACTUALIZAR loans (numero_cuotas NUNCA se toca aqui: las cuotas
  --    extra no modifican las cuotas base del prestamo)
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
    'cuota_adicional_generada',      v_cuota_adicional_generada,
    'fila_hoy_creada',               v_fila_hoy_creada
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION public.registrar_pago_atomico(bigint, bigint, text, jsonb) TO authenticated;

-- ============================================================================
-- 3) extender_prestamo_americano — traida al repo (antes solo en DB viva).
--    Cambios vs. la version original: cuotas insertadas con es_extra = true
--    y SIN actualizar loans.numero_cuotas (las cuotas de prorroga son
--    extra, no modifican las cuotas base del prestamo).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.extender_prestamo_americano(
  p_loan_id uuid,
  p_nuevas_cuotas integer,
  p_ruta_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_ultimo_num_cuota int;
  v_ultima_fecha date;
  v_valor_cuota numeric;
  v_capital_cuota numeric;
  v_interes_cuota numeric;
  v_saldo_cuota numeric;

  v_frecuencia text;
  v_dia_semana text;
  v_valor_prestamo numeric;

  v_contador int;
  v_nueva_fecha date;
BEGIN
  -- 1) Obtener los datos de la ULTIMA cuota programada actualmente
  SELECT numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo
  INTO v_ultimo_num_cuota, v_ultima_fecha, v_valor_cuota, v_capital_cuota, v_interes_cuota, v_saldo_cuota
  FROM public.payment_plan
  WHERE loan_id = p_loan_id
  ORDER BY numero_cuota DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se encontro un plan de pagos para el prestamo %', p_loan_id;
  END IF;

  -- 2) Obtener la configuracion de frecuencia y el VALOR ORIGINAL del prestamo
  SELECT frecuencia_pago, dia_semana, valor
  INTO v_frecuencia, v_dia_semana, v_valor_prestamo
  FROM public.loans
  WHERE id = p_loan_id;

  -- 3) Ajustar la cuota que ANTES era la ultima: como se extendio, ya no
  --    cobra el capital, solo el interes.
  UPDATE public.payment_plan
  SET capital = 0,
      valor_cuota = interes,
      updated_at = NOW()
  WHERE loan_id = p_loan_id AND numero_cuota = v_ultimo_num_cuota AND estado = 'pendiente';

  -- 4) Insertar las nuevas cuotas extendidas (CUOTAS EXTRA)
  v_nueva_fecha := v_ultima_fecha;

  FOR v_contador IN 1..p_nuevas_cuotas LOOP
    v_ultimo_num_cuota := v_ultimo_num_cuota + 1;

    -- Nueva fecha segun la frecuencia
    IF v_frecuencia IN ('weekly', 'semanal') THEN
        v_nueva_fecha := v_nueva_fecha + interval '7 days';
    ELSIF v_frecuencia IN ('daily', 'diario') THEN
        v_nueva_fecha := v_nueva_fecha + interval '1 day';
        -- Cobro diario no aplica domingos: se corre al lunes
        IF extract(dow from v_nueva_fecha) = 0 THEN
            v_nueva_fecha := v_nueva_fecha + interval '1 day';
        END IF;
    ELSE
        v_nueva_fecha := v_nueva_fecha + interval '1 day';
    END IF;

    -- Monto: intermedias solo interes; la ultima recauda capital + interes
    IF v_contador = p_nuevas_cuotas THEN
      v_capital_cuota := v_valor_prestamo;
      v_valor_cuota := v_valor_prestamo + v_interes_cuota;
    ELSE
      v_capital_cuota := 0;
      v_valor_cuota := v_interes_cuota;
    END IF;

    INSERT INTO public.payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo, estado, ruta, es_extra
    ) VALUES (
      p_loan_id, v_ultimo_num_cuota, v_nueva_fecha, v_valor_cuota, v_capital_cuota, v_interes_cuota, v_valor_prestamo, 'pendiente', p_ruta_id, true
    );
  END LOOP;

  -- NOTA: ya NO se actualiza loans.numero_cuotas — las cuotas de prorroga
  -- son cuotas extra y no modifican las cuotas base del prestamo.

  RETURN jsonb_build_object('ok', true, 'total_cuotas_final', v_ultimo_num_cuota);
END;
$func$;

GRANT EXECUTE ON FUNCTION public.extender_prestamo_americano(uuid, integer, bigint) TO authenticated;

-- ============================================================================
-- 4) v_loan_mora_status — el divisor de dias_mora_calculada ignora las
--    cuotas extra (un pago grande de ponerse al dia ya no encoge los dias
--    de mora). Las extras SIGUEN sumando a total_debido_a_hoy y
--    total_pagado_real: cuentan completo en la deuda, como cuota normal.
-- ============================================================================
CREATE OR REPLACE VIEW public.v_loan_mora_status AS
WITH summary AS (
  SELECT payment_plan.loan_id,
    sum(
      CASE
        WHEN payment_plan.fecha_pago < CURRENT_DATE THEN payment_plan.valor_cuota
        ELSE 0::numeric
      END) AS total_debido_a_hoy,
    sum(payment_plan.monto_pagado) AS total_pagado_real,
    COALESCE(
      max(payment_plan.valor_cuota) FILTER (WHERE NOT payment_plan.es_extra),
      max(payment_plan.valor_cuota)
    ) AS valor_cuota_referencia
  FROM payment_plan
  GROUP BY payment_plan.loan_id
)
SELECT loan_id,
  total_debido_a_hoy,
  total_pagado_real,
  GREATEST(total_debido_a_hoy - total_pagado_real, 0::numeric) AS saldo_en_mora,
  CASE
    WHEN (total_debido_a_hoy - total_pagado_real) > 0::numeric
      THEN ceil((total_debido_a_hoy - total_pagado_real) / NULLIF(valor_cuota_referencia, 0))
    ELSE 0::numeric
  END AS dias_mora_calculada
FROM summary;
