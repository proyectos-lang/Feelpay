-- ============================================================================
-- 033 - Geocerca: el cobro se registra donde vive el cliente
-- ============================================================================
-- Correr DESPUES del 032: aca se redefine registrar_pago_atomico sobre esa
-- version (v5), no sobre la del 030.
--
-- QUE HACE
-- Se guarda la ubicacion del cliente (al crearlo, o en su primer cobro) y al
-- momento de gestionar se compara contra donde esta parado el cobrador. Si
-- esta lejos, la app lo bloquea y solo lo deja continuar escribiendo un
-- motivo, que queda registrado junto con la distancia real.
--
-- LLEGA APAGADA. `geocerca_habilitada` arranca en false para todas las
-- rutas: la captura de ubicaciones corre desde el primer dia, de modo que
-- cuando secretaria la encienda ya haya datos con que comparar.
--
-- POR QUE LA DISTANCIA SE RECALCULA EN EL SERVIDOR
-- El payload de un pago hecho sin senal se guarda tal cual en el dispositivo
-- y nadie lo revisa al sincronizar. Si la distancia viniera del telefono,
-- bastaria con editar la cola para reportar cualquier numero. Aca se calcula
-- de nuevo con `distancia_metros()` sobre las coordenadas del cobro contra
-- las del cliente, y se guarda ESA. El estado y el motivo si vienen del
-- dispositivo: el motivo lo escribe la persona, y el estado depende de la
-- precision que reporto el aparato, que el servidor no puede verificar.
--
-- No se rechaza nada al sincronizar. Un pago hecho sin senal ya recibio la
-- plata; bloquearlo dos horas despues no la devuelve. Lo que sirve es que
-- quede el registro real para que secretaria lo revise.
-- ============================================================================

-- ── 1) Ubicacion del cliente ────────────────────────────────────────────
-- numeric sin escala, grados decimales WGS84: la misma convencion que ya
-- usan payment_plan.latitud/longitud. NO ponerle escala: a la latitud de
-- Bogota 20 m son 0.00018 grados, asi que hacen falta 6 decimales o mas.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS latitud NUMERIC,
  ADD COLUMN IF NOT EXISTS longitud NUMERIC,
  ADD COLUMN IF NOT EXISTS ubicacion_capturada_at TIMESTAMPTZ;

-- ── 2) Configuracion por ruta ───────────────────────────────────────────
-- Va en ruta_config_umbrales y no en rutas porque su lector
-- `getRutaUmbrales()` ya tiene cache en el dispositivo: asi la geocerca
-- tambien funciona sin senal, sin trabajo adicional.
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS geocerca_habilitada BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS geocerca_radio_metros INTEGER NOT NULL DEFAULT 100;

-- ── 3) Resultado de la geocerca en cada gestion ─────────────────────────
-- geocerca_estado: 'dentro' | 'fuera' | 'no_verificable' | 'sin_referencia'
--   sin_referencia  -> el cliente todavia no tenia ubicacion guardada
--   no_verificable  -> el GPS reporto un error mayor que el radio configurado
ALTER TABLE public.payment_plan
  ADD COLUMN IF NOT EXISTS geocerca_estado TEXT,
  ADD COLUMN IF NOT EXISTS geocerca_distancia_m NUMERIC,
  ADD COLUMN IF NOT EXISTS geocerca_motivo TEXT;

-- ── 4) Distancia entre dos puntos ───────────────────────────────────────
-- Haversine. Es el mismo calculo que `distanciaMetros` en lib/geo.ts; si se
-- toca uno hay que tocar el otro.
CREATE OR REPLACE FUNCTION public.distancia_metros(
  lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN NULL
    ELSE (2 * 6371000 * asin(least(
      1::float8,
      sqrt(
        power(sin(radians((lat2 - lat1)::float8) / 2), 2)
        + cos(radians(lat1::float8)) * cos(radians(lat2::float8))
          * power(sin(radians((lon2 - lon1)::float8) / 2), 2)
      )
    )))::numeric
  END;
$$;

-- ============================================================================
-- crear_venta_atomica (sobre 031)
-- Cambios: el INSERT de cliente nuevo guarda las coordenadas, y la rama de
-- cliente existente (renovacion) las llena si todavia estaban vacias.
--
-- OJO: ese INSERT enumera columnas una por una. Cualquier campo que se
-- agregue a p_cliente sin agregarlo aca se descarta EN SILENCIO — es lo que
-- ya les pasa hoy a telefono2, tipo_comercio y los ref1_*.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.crear_venta_atomica(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol text,
  p_cliente jsonb,
  p_loan jsonb,
  p_payment_plan jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_client_id uuid;
  v_loan_id uuid;
  v_cuota jsonb;
  v_fecha_manana date;
  v_idem uuid;
  v_resultado jsonb;
  v_latitud numeric;
  v_longitud numeric;
BEGIN
  -- 1) Fijar variables de sesión en esta transacción
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_ruta_id', p_ruta_id::text, true);
  PERFORM set_config('app.current_rol', COALESCE(p_rol, ''), true);

  -- ── Llave de idempotencia ────────────────────────────────────────────
  -- Si la venta ya se creo (reintento por respuesta perdida, o la cola
  -- offline reenviando), devolvemos el resultado original sin duplicar.
  v_idem := NULLIF(p_loan->>'idempotency_key', '')::uuid;

  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
      SELECT resultado INTO v_resultado FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_resultado, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  -- Fecha de manana en zona Colombia (solo se usa como respaldo; la fecha
  -- real del primer pago viene en p_loan.fecha_primer_pago, calculada en el
  -- dispositivo al momento de pactar la venta con el cliente).
  v_fecha_manana := (now() at time zone 'America/Bogota')::date + 1;

  -- Ubicacion donde se hizo la venta. Puede venir vacia: el GPS es de mejor
  -- esfuerzo al crear (una venta es plata entrando, no puede quedar
  -- bloqueada porque el chip no engancho) y de todos modos el primer cobro
  -- la captura.
  v_latitud  := NULLIF(p_cliente->>'latitud', '')::numeric;
  v_longitud := NULLIF(p_cliente->>'longitud', '')::numeric;

  -- 2) Crear o actualizar Cliente
  IF (p_cliente->>'is_new')::boolean = true THEN
    INSERT INTO public.clients (
      documento, nombre_completo, apodo, telefono, direccion, sector, cedula_image_url, ruta, tiene_prestamo_activo,
      latitud, longitud, ubicacion_capturada_at
    ) VALUES (
      p_cliente->>'documento', p_cliente->>'nombre_completo', p_cliente->>'apodo',
      p_cliente->>'telefono', p_cliente->>'direccion', p_cliente->>'sector',
      p_cliente->>'cedula_image_url', p_ruta_id, true,
      v_latitud, v_longitud,
      CASE WHEN v_latitud IS NOT NULL THEN NOW() END
    ) RETURNING id INTO v_client_id;
  ELSE
    v_client_id := (p_cliente->>'id')::uuid;
    -- Renovacion: se aprovecha para llenar la ubicacion si el cliente venia
    -- sin ella. Nunca se pisa una que ya existe — quien esta parado ahi es
    -- el cobrador, y dejarlo reescribir la referencia a voluntad vaciaria
    -- de sentido el control.
    UPDATE public.clients
    SET tiene_prestamo_activo = true,
        latitud  = COALESCE(latitud, v_latitud),
        longitud = COALESCE(longitud, v_longitud),
        ubicacion_capturada_at = CASE
          WHEN latitud IS NULL AND v_latitud IS NOT NULL THEN NOW()
          ELSE ubicacion_capturada_at
        END,
        updated_at = NOW()
    WHERE id = v_client_id;
  END IF;

  -- 3) Crear Préstamo
  --
  -- fecha_primer_pago: se respeta la que trae el payload (la pactada con el
  -- cliente al hacer la venta). Antes se forzaba SIEMPRE a manana, lo que
  -- para una venta sincronizada un dia despues movia el cronograma respecto
  -- de lo acordado. Si no viene, se cae al comportamiento anterior.
  INSERT INTO public.loans (
    client_id, valor, saldo, valor_a_pagar, valor_cuota, tasa_interes, numero_cuotas,
    tipo_amortizacion, frecuencia_pago, dia_semana, tipo_venta, prestamo_empleado,
    fecha_primer_pago, ruta, estado
  ) VALUES (
    v_client_id, (p_loan->>'valor')::numeric, (p_loan->>'saldo')::numeric,
    (p_loan->>'valor_a_pagar')::numeric, (p_loan->>'valor_cuota')::numeric,
    (p_loan->>'tasa_interes')::numeric, (p_loan->>'numero_cuotas')::integer,
    p_loan->>'tipo_amortizacion', p_loan->>'frecuencia_pago',
    NULLIF(p_loan->>'dia_semana', ''), p_loan->>'tipo_venta',
    (p_loan->>'prestamo_empleado')::boolean,
    COALESCE(NULLIF(p_loan->>'fecha_primer_pago', '')::date, v_fecha_manana),
    p_ruta_id, 'activo'
  ) RETURNING id INTO v_loan_id;

  -- 4) Crear Plan de Pagos
  FOR v_cuota IN SELECT * FROM jsonb_array_elements(p_payment_plan)
  LOOP
    INSERT INTO public.payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo, estado, ruta
    ) VALUES (
      v_loan_id, (v_cuota->>'numero_cuota')::integer, (v_cuota->>'fecha_pago')::date,
      (v_cuota->>'valor_cuota')::numeric, (v_cuota->>'capital')::numeric,
      (v_cuota->>'interes')::numeric, (v_cuota->>'saldo')::numeric,
      v_cuota->>'estado', p_ruta_id
    );
  END LOOP;

  v_resultado := jsonb_build_object('ok', true, 'loan_id', v_loan_id, 'client_id', v_client_id);

  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;

  RETURN v_resultado;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.crear_venta_atomica(bigint, bigint, text, jsonb, jsonb, jsonb) TO authenticated;

-- ============================================================================
-- registrar_pago_atomico (v6, sobre 032)
-- Cambios respecto a v5, todos al final del cuerpo:
--   1. Si el cliente no tenia ubicacion, se le captura la de este cobro.
--   2. Se recalcula la distancia en el servidor y se sella en las filas que
--      esta operacion acaba de tocar.
-- El resto es identico a v5.
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

  -- Geocerca (v6)
  v_geo_estado      text;
  v_geo_motivo      text;
  v_geo_distancia   numeric;
  v_cli_lat         numeric;
  v_cli_lon         numeric;
  v_ubicacion_capturada boolean := false;
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

  v_geo_estado      := NULLIF(p_payload->>'geocerca_estado', '');
  v_geo_motivo      := NULLIF(p_payload->>'geocerca_motivo', '');

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

  -- ── Geocerca (v6) ────────────────────────────────────────────────────
  IF v_client_id IS NOT NULL AND v_latitud IS NOT NULL AND v_longitud IS NOT NULL THEN
    SELECT latitud, longitud INTO v_cli_lat, v_cli_lon
      FROM clients WHERE id = v_client_id FOR UPDATE;

    IF v_cli_lat IS NULL OR v_cli_lon IS NULL THEN
      -- Cliente sin ubicacion: este cobro la fija. Asi la cartera vieja se
      -- georreferencia sola a medida que se visita, sin salida especial.
      UPDATE clients
         SET latitud = v_latitud, longitud = v_longitud,
             ubicacion_capturada_at = NOW(), updated_at = NOW()
       WHERE id = v_client_id;
      v_ubicacion_capturada := true;
      v_geo_estado := COALESCE(v_geo_estado, 'sin_referencia');
    ELSE
      -- Se calcula aca y no se cree la distancia que mando el telefono: el
      -- payload de un pago offline se guarda tal cual y nadie lo revisa al
      -- sincronizar, asi que un numero venido del dispositivo no prueba nada.
      v_geo_distancia := public.distancia_metros(v_latitud, v_longitud, v_cli_lat, v_cli_lon);
    END IF;
  END IF;

  -- Se sella el resultado en las filas que esta operacion acaba de tocar.
  -- `fecha_pago_real` es el instante exacto de esta gestion y TODAS las
  -- ramas de arriba lo escriben, asi que identifica justo esas filas. Las
  -- cuotas pendientes que crean generar_cuota_adicional o
  -- extender_prestamo_americano lo tienen en NULL y no se ven afectadas.
  IF v_fecha_pago_real IS NOT NULL AND (v_geo_estado IS NOT NULL OR v_geo_distancia IS NOT NULL) THEN
    UPDATE payment_plan
       SET geocerca_estado      = v_geo_estado,
           geocerca_distancia_m = v_geo_distancia,
           geocerca_motivo      = v_geo_motivo
     WHERE loan_id = v_loan_id
       AND fecha_pago_real = v_fecha_pago_real;
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
    'enviado_a_revision',            v_enviado_revision,
    'ubicacion_cliente_capturada',   v_ubicacion_capturada,
    'geocerca_distancia_m',          v_geo_distancia
  );

  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;

  RETURN v_resultado;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.registrar_pago_atomico(bigint, bigint, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.distancia_metros(numeric, numeric, numeric, numeric) TO authenticated;

-- Refrescar el cache de esquema de PostgREST para que las columnas nuevas
-- se puedan leer y escribir desde la app sin esperar.
NOTIFY pgrst, 'reload schema';
