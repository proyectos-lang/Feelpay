-- ============================================================================
-- 045 - Ventas: cronograma en el servidor, homologación y edición atómica
-- ============================================================================
-- PARTE DE LA FASE 1. Correr en la ceremonia del corte (ver 049), tras el 044.
--
-- QUÉ TRAE
--   1) generar_cronograma()   ÚNICA fuente de verdad de la matemática del
--      plan (aleman / americano / empleado; domingos con la fórmula buena;
--      `dia_semana` POR FIN ancla la primera cuota semanal — decisión del
--      dueño; redondeo exacto: la última cuota absorbe el residuo para que
--      la suma dé exactamente el total).
--   2) crear_venta_atomica    v-next:
--      · si el payload NO trae plan, el servidor lo genera (app nueva);
--        si lo trae, se respeta (compatibilidad con colas/PWA viejas)
--      · guarda los campos que antes se descartaban en silencio (telefono2,
--        tipo_comercio, ref1_*, cuenta_id)
--      · abono inicial = EVENTO 'abono_venta' fechado con la fecha del
--        dispositivo (ya no una cuota extra disfrazada)
--      · VENTA HOMOLOGADA: `p_loan.historial` = [{fecha, tipo, monto}, ...]
--        crea un evento por día con origen='homologacion' → el saldo, la
--        mora y el X/Y quedan 100% reales al día de hoy. Estos eventos NO
--        cuentan en la caja diaria (esa plata entró en el sistema viejo).
--   3) editar_venta_atomica   reemplaza el DELETE/INSERT no atómico del
--      navegador. Para secretaría funciona AUNQUE haya gestiones: regenera
--      el cronograma, el ledger queda intacto y la cascada reasigna sola.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) generar_cronograma ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generar_cronograma(
  p_valor             numeric,
  p_tasa              numeric,
  p_num_cuotas        int,
  p_tipo_amortizacion text,
  p_frecuencia        text,
  p_empleado          boolean,
  p_fecha_inicio      date,
  p_dia_semana        text
)
RETURNS TABLE (numero_cuota int, fecha_pago date, valor_cuota numeric,
               capital numeric, interes numeric)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_tasa_dec numeric;
  v_tipo     text;
  v_freq     text;
  v_inicio   date;
  v_pos      int;
  v_target   int;
  v_paso     int;
  v_total    numeric;
  v_int      numeric;
  v_cuota_b  numeric;
  v_cap_b    numeric;
  v_i        int;
BEGIN
  IF p_valor IS NULL OR p_valor <= 0 THEN
    RAISE EXCEPTION 'El valor del préstamo debe ser mayor que cero';
  END IF;
  IF p_num_cuotas IS NULL OR p_num_cuotas < 1 THEN
    RAISE EXCEPTION 'El número de cuotas debe ser al menos 1';
  END IF;
  IF p_fecha_inicio IS NULL THEN
    RAISE EXCEPTION 'Falta la fecha del primer pago';
  END IF;

  v_tasa_dec := COALESCE(p_tasa, 0) / 100.0;
  v_tipo := CASE WHEN COALESCE(p_empleado, false) THEN 'empleado'
                 ELSE lower(COALESCE(p_tipo_amortizacion, 'aleman')) END;
  v_freq := CASE WHEN COALESCE(p_empleado, false) THEN 'daily'
                 ELSE lower(COALESCE(p_frecuencia, 'daily')) END;

  -- Fecha de inicio ajustada
  v_inicio := p_fecha_inicio;
  IF v_freq IN ('daily','diario') AND EXTRACT(dow FROM v_inicio) = 0 THEN
    v_inicio := v_inicio + 1;  -- domingo no se cobra
  END IF;
  IF v_freq IN ('weekly','semanal') AND p_dia_semana IS NOT NULL THEN
    v_target := CASE lower(p_dia_semana)
      WHEN 'domingo' THEN 0 WHEN 'lunes' THEN 1 WHEN 'martes' THEN 2
      WHEN 'miercoles' THEN 3 WHEN 'miércoles' THEN 3 WHEN 'jueves' THEN 4
      WHEN 'viernes' THEN 5 WHEN 'sabado' THEN 6 WHEN 'sábado' THEN 6
      ELSE NULL END;
    IF v_target IS NOT NULL THEN
      v_inicio := v_inicio
        + ((v_target - EXTRACT(dow FROM v_inicio)::int) % 7 + 7) % 7;
    END IF;
  END IF;

  v_paso := CASE v_freq
    WHEN 'weekly' THEN 7 WHEN 'semanal' THEN 7
    WHEN 'biweekly' THEN 15 WHEN 'quincenal' THEN 15
    WHEN 'monthly' THEN 30 WHEN 'mensual' THEN 30
    ELSE 1 END;

  -- Totales por tipo
  IF v_tipo = 'empleado' THEN
    v_total   := p_valor;
    v_cap_b   := round(p_valor / p_num_cuotas, 2);
  ELSIF v_tipo = 'americano' THEN
    v_int     := round(p_valor * v_tasa_dec, 2);
    v_total   := p_valor + v_int * p_num_cuotas;
  ELSE  -- aleman
    v_total   := round(p_valor * (1 + v_tasa_dec), 2);
    v_cuota_b := round(v_total / p_num_cuotas, 2);
    v_cap_b   := round(p_valor / p_num_cuotas, 2);
  END IF;

  v_pos := (EXTRACT(dow FROM v_inicio)::int + 6) % 7;  -- lunes=0 ... domingo=6

  FOR v_i IN 1..p_num_cuotas LOOP
    numero_cuota := v_i;

    IF v_paso = 1 THEN
      -- i-ésimo día de cobro saltando domingos de corrido (semana lun-sáb)
      fecha_pago := v_inicio + (v_i - 1) + ((v_pos + v_i - 1) / 6);
    ELSE
      fecha_pago := v_inicio + v_paso * (v_i - 1);
    END IF;

    IF v_tipo = 'empleado' THEN
      capital := CASE WHEN v_i = p_num_cuotas
                      THEN p_valor - v_cap_b * (p_num_cuotas - 1)
                      ELSE v_cap_b END;
      interes := 0;
      valor_cuota := capital;
    ELSIF v_tipo = 'americano' THEN
      IF v_i < p_num_cuotas THEN
        valor_cuota := v_int; capital := 0; interes := v_int;
      ELSE
        valor_cuota := p_valor + v_int; capital := p_valor; interes := v_int;
      END IF;
    ELSE  -- aleman
      valor_cuota := CASE WHEN v_i = p_num_cuotas
                          THEN v_total - v_cuota_b * (p_num_cuotas - 1)
                          ELSE v_cuota_b END;
      capital := CASE WHEN v_i = p_num_cuotas
                      THEN p_valor - v_cap_b * (p_num_cuotas - 1)
                      ELSE v_cap_b END;
      interes := valor_cuota - capital;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;


-- ── PASO 2) crear_venta_atomica v-next ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crear_venta_atomica(
  p_user_id      bigint,
  p_ruta_id      bigint,
  p_rol          text,
  p_cliente      jsonb,
  p_loan         jsonb,
  p_payment_plan jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_idem          uuid;
  v_prev          jsonb;
  v_hoy           date;
  v_manana        date;
  v_lat           numeric;
  v_lon           numeric;
  v_is_new        boolean;
  v_client_id     uuid;
  v_loan_id       uuid;
  v_fecha_primer  date;
  v_historial     jsonb;
  v_origen        text;
  v_plan_cliente  boolean;
  v_valor         numeric;
  v_tasa          numeric;
  v_n             int;
  v_tipo_am       text;
  v_freq          text;
  v_empleado      boolean;
  v_dia_semana    text;
  v_valor_a_pagar numeric;
  v_valor_cuota   numeric;
  v_abono         numeric;
  v_fecha_disp    date;
  v_item          jsonb;
  v_f             date;
  v_t             text;
  v_m             numeric;
  v_hist_n        int := 0;
  v_hist_total    numeric := 0;
  v_recalc        jsonb;
  v_resultado     jsonb;
BEGIN
  -- Idempotencia (la llave viaja dentro de p_loan para no cambiar la firma)
  v_idem := NULLIF(p_loan->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  v_hoy    := (now() AT TIME ZONE 'America/Bogota')::date;
  v_manana := v_hoy + 1;
  v_lat    := NULLIF(p_cliente->>'latitud','')::numeric;
  v_lon    := NULLIF(p_cliente->>'longitud','')::numeric;

  -- ── Cliente ─────────────────────────────────────────────────────────────
  v_is_new := COALESCE((p_cliente->>'is_new')::boolean, false);
  IF v_is_new THEN
    INSERT INTO clients (
      documento, nombre_completo, apodo, telefono, telefono2, direccion,
      sector, tipo_comercio, ref1_nombre, ref1_telefono, ref1_direccion,
      cedula_image_url, ruta, tiene_prestamo_activo,
      latitud, longitud, ubicacion_capturada_at
    ) VALUES (
      p_cliente->>'documento',
      p_cliente->>'nombre_completo',
      NULLIF(p_cliente->>'apodo',''),
      NULLIF(p_cliente->>'telefono',''),
      NULLIF(p_cliente->>'telefono2',''),
      NULLIF(p_cliente->>'direccion',''),
      NULLIF(p_cliente->>'sector',''),
      NULLIF(p_cliente->>'tipo_comercio',''),
      NULLIF(p_cliente->>'ref1_nombre',''),
      NULLIF(p_cliente->>'ref1_telefono',''),
      NULLIF(p_cliente->>'ref1_direccion',''),
      NULLIF(p_cliente->>'cedula_image_url',''),
      p_ruta_id, true,
      v_lat, v_lon,
      CASE WHEN v_lat IS NOT NULL THEN NOW() ELSE NULL END
    ) RETURNING id INTO v_client_id;
  ELSE
    v_client_id := NULLIF(p_cliente->>'id','')::uuid;
    IF v_client_id IS NULL THEN
      RAISE EXCEPTION 'Renovación sin id de cliente';
    END IF;
    -- La ubicación de referencia NUNCA se pisa si ya existe (geocerca).
    UPDATE clients
       SET tiene_prestamo_activo = true,
           latitud  = COALESCE(latitud, v_lat),
           longitud = COALESCE(longitud, v_lon),
           ubicacion_capturada_at = CASE WHEN latitud IS NULL AND v_lat IS NOT NULL
                                         THEN NOW() ELSE ubicacion_capturada_at END,
           updated_at = NOW()
     WHERE id = v_client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El cliente de la renovación no existe';
    END IF;
  END IF;

  -- ── Parámetros del préstamo ─────────────────────────────────────────────
  v_valor      := (p_loan->>'valor')::numeric;
  v_tasa       := COALESCE(NULLIF(p_loan->>'tasa_interes','')::numeric, 0);
  v_n          := (p_loan->>'numero_cuotas')::int;
  v_empleado   := COALESCE((p_loan->>'prestamo_empleado')::boolean, false);
  v_tipo_am    := CASE WHEN v_empleado THEN 'empleado'
                       ELSE COALESCE(NULLIF(p_loan->>'tipo_amortizacion',''),'aleman') END;
  v_freq       := COALESCE(NULLIF(p_loan->>'frecuencia_pago',''), 'daily');
  v_dia_semana := NULLIF(p_loan->>'dia_semana','');
  v_fecha_primer := COALESCE(NULLIF(p_loan->>'fecha_primer_pago','')::date, v_manana);
  v_fecha_disp   := COALESCE(NULLIF(p_loan->>'fecha_dispositivo','')::date, v_hoy);

  v_historial := p_loan->'historial';
  v_origen := CASE WHEN v_historial IS NOT NULL
                    AND jsonb_typeof(v_historial) = 'array'
                    AND jsonb_array_length(v_historial) > 0
                   THEN 'homologado' ELSE 'normal' END;

  v_plan_cliente := (p_payment_plan IS NOT NULL
                     AND jsonb_typeof(p_payment_plan) = 'array'
                     AND jsonb_array_length(p_payment_plan) > 0);

  IF v_plan_cliente THEN
    -- Compatibilidad: la app vieja manda el plan hecho; se respeta.
    v_valor_a_pagar := COALESCE(NULLIF(p_loan->>'valor_a_pagar','')::numeric,
                                NULLIF(p_loan->>'saldo','')::numeric, v_valor);
    v_valor_cuota   := NULLIF(p_loan->>'valor_cuota','')::numeric;
  ELSE
    -- App nueva: el servidor es la fuente de verdad del plan y los totales.
    SELECT COALESCE(SUM(g.valor_cuota), 0),
           (array_agg(g.valor_cuota ORDER BY g.numero_cuota))[1]
      INTO v_valor_a_pagar, v_valor_cuota
      FROM public.generar_cronograma(v_valor, v_tasa, v_n, v_tipo_am,
                                     v_freq, v_empleado, v_fecha_primer,
                                     v_dia_semana) g;
  END IF;

  -- ── Préstamo ────────────────────────────────────────────────────────────
  INSERT INTO loans (
    client_id, valor, saldo, valor_a_pagar, valor_cuota, tasa_interes,
    numero_cuotas, tipo_amortizacion, frecuencia_pago, dia_semana,
    -- OJO: `enrutar_venta` NO va aquí. Está en el CREATE TABLE del script 002
    -- pero NO existe en la base real (la tabla se creó por fuera del repo), y
    -- el formulario nunca la llenó: el estado existía sin ningún input que lo
    -- cambiara, así que siempre viajaba en null. Incluirla hacía fallar TODA
    -- la venta con «column "enrutar_venta" of relation "loans" does not exist».
    tipo_venta, cuenta_id, prestamo_empleado, estado,
    fecha_primer_pago, ruta, origen
  ) VALUES (
    v_client_id, v_valor, v_valor_a_pagar, v_valor_a_pagar, v_valor_cuota,
    v_tasa, v_n, v_tipo_am, v_freq, v_dia_semana,
    COALESCE(NULLIF(p_loan->>'tipo_venta',''), 'efectivo'),
    NULLIF(p_loan->>'cuenta_id','')::bigint,
    v_empleado,
    'activo', v_fecha_primer, p_ruta_id, v_origen
  ) RETURNING id INTO v_loan_id;

  -- ── Cronograma ──────────────────────────────────────────────────────────
  IF v_plan_cliente THEN
    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    )
    SELECT v_loan_id,
           (e->>'numero_cuota')::int,
           (e->>'fecha_pago')::date,
           (e->>'valor_cuota')::numeric,
           COALESCE((e->>'capital')::numeric, 0),
           COALESCE((e->>'interes')::numeric, 0),
           0, 'pendiente', p_ruta_id, false
      FROM jsonb_array_elements(p_payment_plan) e;
  ELSE
    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    )
    SELECT v_loan_id, g.numero_cuota, g.fecha_pago, g.valor_cuota,
           g.capital, g.interes, 0, 'pendiente', p_ruta_id, false
      FROM public.generar_cronograma(v_valor, v_tasa, v_n, v_tipo_am,
                                     v_freq, v_empleado, v_fecha_primer,
                                     v_dia_semana) g;
  END IF;

  -- ── Abono inicial: EVENTO fechado con la fecha del dispositivo ──────────
  v_abono := COALESCE(NULLIF(p_loan->>'abono_inicial','')::numeric, 0);
  IF v_abono > 0 THEN
    v_abono := LEAST(v_abono, v_valor_a_pagar);
    INSERT INTO gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, origen, observacion, fecha_hora
    ) VALUES (
      gen_random_uuid(), v_loan_id, v_client_id, p_ruta_id, p_user_id,
      'abono_venta', 'aplicada', v_fecha_disp, v_abono, 'venta',
      'Abono inicial de la venta', NOW()
    );
  END IF;

  -- ── Venta homologada: historia día a día → eventos ──────────────────────
  IF v_origen = 'homologado' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_historial) LOOP
      v_f := NULLIF(v_item->>'fecha','')::date;
      v_t := v_item->>'tipo';
      v_m := COALESCE(NULLIF(v_item->>'monto','')::numeric, 0);
      IF v_f IS NULL OR v_f > v_hoy THEN
        RAISE EXCEPTION 'Historial: fecha inválida o futura (%)', v_item->>'fecha';
      END IF;
      IF v_t NOT IN ('pago','no_pago') THEN
        RAISE EXCEPTION 'Historial: tipo inválido (%) — solo pago o no_pago', v_t;
      END IF;
      IF v_m < 0 THEN
        RAISE EXCEPTION 'Historial: monto negativo';
      END IF;
      IF v_t = 'pago' THEN
        v_hist_total := v_hist_total + v_m;
        IF v_hist_total + v_abono > v_valor_a_pagar THEN
          RAISE EXCEPTION 'Historial: los pagos (%) más el abono superan el total a pagar (%)',
            v_hist_total + v_abono, v_valor_a_pagar;
        END IF;
      END IF;
      INSERT INTO gestiones (
        id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
        monto, origen, observacion, fecha_hora
      ) VALUES (
        gen_random_uuid(), v_loan_id, v_client_id, p_ruta_id, p_user_id,
        v_t, 'aplicada', v_f,
        CASE WHEN v_t = 'pago' THEN v_m ELSE 0 END,
        'homologacion', 'Homologación de venta migrada',
        (v_f::timestamp + interval '18 hours') AT TIME ZONE 'America/Bogota'
      );
      v_hist_n := v_hist_n + 1;
    END LOOP;
  END IF;

  -- ── Derivar todo ────────────────────────────────────────────────────────
  v_recalc := public.recalcular_prestamo(v_loan_id);

  v_resultado := jsonb_build_object(
    'ok', true,
    'loan_id', v_loan_id,
    'client_id', v_client_id,
    'abono_inicial_aplicado', v_abono,
    'historial_eventos', v_hist_n,
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'total_a_pagar', v_valor_a_pagar
  );
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 3) editar_venta_atomica ──────────────────────────────────────────
-- Secretaría/admin editan CUALQUIER venta, con o sin gestiones: se regeneran
-- las cuotas, el ledger no se toca y la cascada reasigna la plata sola.
-- Un vendedor solo puede editar ventas sin ninguna gestión aplicada.
CREATE OR REPLACE FUNCTION public.editar_venta_atomica(
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
  v_loan_id       uuid;
  v_idem          uuid;
  v_prev          jsonb;
  v_priv          boolean;
  v_loan          record;
  v_tiene_g       boolean;
  v_hoy           date;
  v_valor         numeric;
  v_tasa          numeric;
  v_n             int;
  v_tipo_am       text;
  v_freq          text;
  v_empleado      boolean;
  v_dia_semana    text;
  v_fecha_primer  date;
  v_valor_a_pagar numeric;
  v_valor_cuota   numeric;
  v_antes         jsonb;
  v_recalc        jsonb;
  v_resultado     jsonb;
BEGIN
  v_loan_id := NULLIF(p_payload->>'loan_id','')::uuid;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'Falta loan_id';
  END IF;
  v_priv := lower(COALESCE(p_rol,'')) IN ('secretaria','secretario','admin','administrador');

  SELECT * INTO v_loan FROM loans WHERE id = v_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El préstamo no existe';
  END IF;

  v_tiene_g := EXISTS (
    SELECT 1 FROM gestiones
     WHERE loan_id = v_loan_id AND estado = 'aplicada'
       AND tipo IN ('pago','no_pago','cancelacion','abono_venta'));
  IF NOT v_priv AND v_tiene_g THEN
    RAISE EXCEPTION 'Venta con gestiones registradas: solo secretaría puede editarla';
  END IF;

  v_idem := NULLIF(p_payload->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'editar_venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  v_hoy := (now() AT TIME ZONE 'America/Bogota')::date;

  -- Cada campo cae al valor actual si no viene en el payload
  v_valor      := COALESCE(NULLIF(p_payload->>'valor','')::numeric, v_loan.valor);
  v_tasa       := COALESCE(NULLIF(p_payload->>'tasa_interes','')::numeric, v_loan.tasa_interes, 0);
  v_n          := COALESCE(NULLIF(p_payload->>'numero_cuotas','')::int, v_loan.numero_cuotas);
  v_empleado   := COALESCE((p_payload->>'prestamo_empleado')::boolean, v_loan.prestamo_empleado, false);
  v_tipo_am    := CASE WHEN v_empleado THEN 'empleado'
                       ELSE COALESCE(NULLIF(p_payload->>'tipo_amortizacion',''), v_loan.tipo_amortizacion) END;
  v_freq       := COALESCE(NULLIF(p_payload->>'frecuencia_pago',''), v_loan.frecuencia_pago);
  -- El día de cobro solo existe en los créditos semanales. Si el payload trae
  -- la clave, manda lo que diga (incluido NULL, para poder BORRARLO); si no la
  -- trae, se conserva. Y en cualquier frecuencia que no sea semanal se limpia:
  -- de lo contrario, pasar una venta de semanal a diaria dejaba el día pegado
  -- y el cronograma nuevo se anclaba a un día que ya no significaba nada.
  v_dia_semana := CASE
    WHEN p_payload ? 'dia_semana' THEN NULLIF(p_payload->>'dia_semana','')
    ELSE v_loan.dia_semana END;
  IF lower(COALESCE(v_freq,'')) NOT IN ('weekly','semanal') THEN
    v_dia_semana := NULL;
  END IF;
  v_fecha_primer := COALESCE(NULLIF(p_payload->>'fecha_primer_pago','')::date,
                             v_loan.fecha_primer_pago, v_hoy + 1);

  v_antes := jsonb_build_object(
    'valor', v_loan.valor, 'tasa_interes', v_loan.tasa_interes,
    'numero_cuotas', v_loan.numero_cuotas,
    'tipo_amortizacion', v_loan.tipo_amortizacion,
    'frecuencia_pago', v_loan.frecuencia_pago, 'dia_semana', v_loan.dia_semana,
    'fecha_primer_pago', v_loan.fecha_primer_pago,
    'valor_a_pagar', v_loan.valor_a_pagar, 'valor_cuota', v_loan.valor_cuota);

  -- Totales desde la única fuente de verdad
  SELECT COALESCE(SUM(g.valor_cuota), 0),
         (array_agg(g.valor_cuota ORDER BY g.numero_cuota))[1]
    INTO v_valor_a_pagar, v_valor_cuota
    FROM public.generar_cronograma(v_valor, v_tasa, v_n, v_tipo_am,
                                   v_freq, v_empleado, v_fecha_primer,
                                   v_dia_semana) g;

  -- Regenerar el cronograma (los eventos apuntados quedan con la referencia
  -- de cuota en NULL — el FK es ON DELETE SET NULL; la plata no se toca)
  DELETE FROM payment_plan WHERE loan_id = v_loan_id;

  INSERT INTO payment_plan (
    loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
    saldo, estado, ruta, es_extra
  )
  SELECT v_loan_id, g.numero_cuota, g.fecha_pago, g.valor_cuota,
         g.capital, g.interes, 0, 'pendiente', COALESCE(v_loan.ruta, p_ruta_id), false
    FROM public.generar_cronograma(v_valor, v_tasa, v_n, v_tipo_am,
                                   v_freq, v_empleado, v_fecha_primer,
                                   v_dia_semana) g;

  UPDATE loans
     SET valor = v_valor, tasa_interes = v_tasa, numero_cuotas = v_n,
         tipo_amortizacion = v_tipo_am, frecuencia_pago = v_freq,
         prestamo_empleado = v_empleado, dia_semana = v_dia_semana,
         fecha_primer_pago = v_fecha_primer,
         -- Misma regla que `dia_semana`: si la clave viene, manda; si no
         -- viene, se conserva. Así se puede quitar la cuenta de una venta
         -- que dejó de ser por transferencia.
         tipo_venta = CASE WHEN p_payload ? 'tipo_venta'
                           THEN COALESCE(NULLIF(p_payload->>'tipo_venta',''), 'efectivo')
                           ELSE tipo_venta END,
         cuenta_id  = CASE WHEN p_payload ? 'cuenta_id'
                           THEN NULLIF(p_payload->>'cuenta_id','')::bigint
                           ELSE cuenta_id END,
         valor_a_pagar = v_valor_a_pagar, valor_cuota = v_valor_cuota,
         updated_at = NOW()
   WHERE id = v_loan_id;

  -- Auditoría en el ledger
  INSERT INTO gestiones (
    id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
    monto, origen, observacion, detalle
  ) VALUES (
    gen_random_uuid(), v_loan_id, v_loan.client_id,
    COALESCE(v_loan.ruta, p_ruta_id), p_user_id,
    'ajuste', 'aplicada', v_hoy, 0, 'ajuste', 'Edición de la venta',
    jsonb_build_object('antes', v_antes, 'despues', jsonb_build_object(
      'valor', v_valor, 'tasa_interes', v_tasa, 'numero_cuotas', v_n,
      'tipo_amortizacion', v_tipo_am, 'frecuencia_pago', v_freq,
      'dia_semana', v_dia_semana, 'fecha_primer_pago', v_fecha_primer,
      'valor_a_pagar', v_valor_a_pagar, 'valor_cuota', v_valor_cuota))
  );

  v_recalc := public.recalcular_prestamo(v_loan_id);

  v_resultado := jsonb_build_object(
    'ok', true,
    'loan_id', v_loan_id,
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'loan_estado_final', v_recalc->>'loan_estado_final',
    'total_a_pagar', v_valor_a_pagar,
    'cuotas_totales', (v_recalc->>'cuotas_totales')::int
  );
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 4) Verificar ─────────────────────────────────────────────────────
-- SOLO LECTURA. Prueba del cronograma: diario de 12 cuotas arrancando un
-- sábado — debe saltar los domingos y la suma debe dar exacto.
SELECT g.*, to_char(g.fecha_pago, 'TMDay') AS dia,
       SUM(g.valor_cuota) OVER () AS total
  FROM public.generar_cronograma(300, 20, 12, 'aleman', 'daily', false,
                                 DATE '2026-08-15', NULL) g
 ORDER BY g.numero_cuota;
