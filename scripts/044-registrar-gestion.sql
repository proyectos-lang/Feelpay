-- ============================================================================
-- 044 - registrar_gestion: la única puerta de escritura de gestiones
-- ============================================================================
-- PARTE DE LA FASE 1. Correr en la ceremonia del corte (ver 049), tras el 043.
--
-- QUÉ TRAE
--   1) siguiente_fecha_cobro()      helper de fechas (salta domingos en diario)
--   2) registrar_gestion()          pago / no_pago / cancelación / reversa
--   3) aprobar_solicitud_revision() v3 — aprueba/rechaza gestiones en revisión
--                                   y conserva los caminos viejos (venta/abono)
--   4) registrar_pago_atomico()     v8 — ADAPTER: traduce el payload viejo al
--                                   nuevo núcleo (colas offline y PWA viejas
--                                   siguen funcionando después del corte)
--   5) ajustar_cuota_control_pagos() v2 — las ediciones de Control de Pagos
--                                   se convierten en eventos del ledger
--
-- EL CONTRATO DE registrar_gestion — NUNCA no-op, NUNCA pierde plata:
--   · Todo evento ENTRA (INSERT). Las anomalías no rechazan: clasifican.
--     Si algo no cuadra (fecha retro > 1 día, préstamo cancelado, umbral,
--     reversa inválida) el evento queda 'en_revision' + una solicitud para
--     la bandeja de secretaría. La plata existe desde el segundo cero.
--   · La cuota ancla es una PISTA: si llegó vieja, la cascada asigna la
--     plata a la cuota más antigua sin cubrir. Desaparece el conflicto
--     "la cuota ya fue gestionada".
--   · Cancelación: el servidor cobra el saldo real derivado — el monto del
--     dispositivo no se cree.
--   · Retro: fecha_gestion = ayer se aplica directo (decisión del dueño:
--     1 día). Más atrás o futuro → en_revision. Secretaría no tiene límite.
--   · Reversa: anula un evento por referencia (monto completo). El cobrador
--     solo puede reversar SUS gestiones DEL DÍA; el resto, secretaría.
--   · Idempotencia por el id del dispositivo: replay = mismo resultado.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Helper de fechas: avanzar un período de cobro ─────────────────
CREATE OR REPLACE FUNCTION public.siguiente_fecha_cobro(p_fecha date, p_frecuencia text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v date;
BEGIN
  CASE lower(COALESCE(p_frecuencia, 'daily'))
    WHEN 'weekly', 'semanal'      THEN v := p_fecha + 7;
    WHEN 'biweekly', 'quincenal'  THEN v := p_fecha + 15;
    WHEN 'monthly', 'mensual'     THEN v := p_fecha + 30;
    ELSE
      v := p_fecha + 1;
      IF EXTRACT(dow FROM v) = 0 THEN v := v + 1; END IF;  -- domingo no se cobra
  END CASE;
  RETURN v;
END;
$$;


-- ── PASO 2) registrar_gestion ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_gestion(
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
  v_id             uuid;
  v_tipo           text;
  v_loan_id        uuid;
  v_monto          numeric;
  v_num_cuotas     int;
  v_fecha          date;
  v_fh             timestamptz;
  v_hoy            date;
  v_cuota_obj      uuid;
  v_multa_id       uuid;
  v_metodo         text;
  v_cliente_nombre text;
  v_gen_cuota      boolean;
  v_ext            int;
  v_obs            text;
  v_lat            numeric;
  v_lon            numeric;
  v_geo_estado     text;
  v_geo_motivo     text;
  v_geo_dist       numeric;
  v_ubic_capturada boolean := false;
  v_rol_priv       boolean;
  v_loan           record;
  v_ref            record;
  v_referencia     uuid;
  v_estado_g       text := 'aplicada';
  v_motivo         text := NULL;
  v_pagado_antes   numeric;
  v_saldo_antes    numeric;
  v_ya_gestionado  boolean;
  v_umbral         record;
  v_cli_lat        numeric;
  v_cli_lon        numeric;
  v_multa_valor    numeric;
  v_multa_upd      int;
  v_multa_cobrada  boolean := false;
  v_ext_aplicada   boolean := false;
  v_ext_motivo     text := NULL;
  v_cuota_adic     boolean := false;
  v_interes_ref    numeric;
  v_last           record;
  v_tpl            record;
  v_fecha_n        date;
  v_num_max        int;
  v_i              int;
  v_recalc         jsonb;
  v_resultado      jsonb;
  v_prev           jsonb;
BEGIN
  -- Entrada mínima
  v_id      := NULLIF(p_payload->>'id', '')::uuid;
  v_tipo    := p_payload->>'tipo';
  v_loan_id := NULLIF(p_payload->>'loan_id', '')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Falta id (llave de idempotencia generada en el dispositivo)';
  END IF;
  IF v_tipo IS NULL OR v_tipo NOT IN ('pago','no_pago','cancelacion','reversa') THEN
    RAISE EXCEPTION 'Tipo de gestion no soportado: %', COALESCE(v_tipo, '(nulo)');
  END IF;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'Falta loan_id';
  END IF;

  v_monto := COALESCE(NULLIF(p_payload->>'monto','')::numeric, 0);
  IF v_monto < 0 THEN
    RAISE EXCEPTION 'El monto no puede ser negativo';
  END IF;

  v_num_cuotas     := NULLIF(p_payload->>'num_cuotas','')::int;
  v_cuota_obj      := NULLIF(p_payload->>'cuota_objetivo','')::uuid;
  v_multa_id       := NULLIF(p_payload->>'multa_id','')::uuid;
  v_metodo         := NULLIF(p_payload->>'metodo_pago','');
  v_cliente_nombre := NULLIF(p_payload->>'cliente_nombre','');
  v_gen_cuota      := COALESCE((p_payload->>'generar_cuota_si_debe')::boolean, false);
  v_ext            := COALESCE(NULLIF(p_payload->>'extender_cuotas','')::int, 0);
  v_obs            := NULLIF(p_payload->>'observacion','');
  v_lat            := NULLIF(p_payload->>'latitud','')::numeric;
  v_lon            := NULLIF(p_payload->>'longitud','')::numeric;
  v_geo_estado     := NULLIF(p_payload->>'geocerca_estado','');
  v_geo_motivo     := NULLIF(p_payload->>'geocerca_motivo','');
  v_rol_priv       := lower(COALESCE(p_rol,'')) IN ('secretaria','secretario','admin','administrador');

  -- Idempotencia: reservar la llave; si ya estaba, devolver el resultado
  -- original sin re-aplicar nada.
  INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
  VALUES (v_id, 'gestion_' || v_tipo, p_user_id, p_ruta_id)
  ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_id;
    RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
  END IF;

  v_hoy   := (now() AT TIME ZONE 'America/Bogota')::date;
  v_fecha := COALESCE(NULLIF(p_payload->>'fecha_gestion','')::date, v_hoy);
  v_fh    := COALESCE(NULLIF(p_payload->>'fecha_hora','')::timestamptz, now());

  -- Préstamo. Si ya no existe (cola vieja, venta borrada), la operación NO
  -- se pierde: payload íntegro a revisión de secretaría.
  SELECT id, estado, client_id, COALESCE(valor_a_pagar, valor) AS total,
         valor, tipo_amortizacion, frecuencia_pago, prestamo_empleado
    INTO v_loan
    FROM loans WHERE id = v_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO solicitudes_revision (
      tipo, ruta_id, solicitado_por, solicitado_por_nombre, monto, descripcion, payload
    ) VALUES (
      'abono', p_ruta_id, p_user_id,
      (SELECT nombre FROM usuarios WHERE id = p_user_id),
      v_monto,
      COALESCE(v_cliente_nombre, 'Cliente') || ' — El préstamo ya no existe',
      jsonb_build_object('p_payload', p_payload)
    );
    v_resultado := jsonb_build_object(
      'ok', true, 'gestion_id', v_id, 'estado_gestion', 'en_revision',
      'enviado_a_revision', true, 'motivo', 'El préstamo ya no existe',
      'cuotas_actualizadas', 0);
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_id;
    RETURN v_resultado;
  END IF;

  SELECT COALESCE(pagado_neto, 0) INTO v_pagado_antes
    FROM v_pagos_netos WHERE loan_id = v_loan_id;
  v_pagado_antes := COALESCE(v_pagado_antes, 0);
  v_saldo_antes  := GREATEST(0, v_loan.total - v_pagado_antes);

  v_ya_gestionado := EXISTS (
    SELECT 1 FROM gestiones
     WHERE loan_id = v_loan_id AND fecha_gestion = v_fecha
       AND estado = 'aplicada' AND tipo IN ('pago','no_pago','cancelacion'));

  -- Cancelación: se cobra el saldo real derivado, no lo que diga el payload.
  IF v_tipo = 'cancelacion' THEN
    v_monto := v_saldo_antes;
  END IF;

  -- ── Clasificación de anomalías (nunca rechazan: clasifican) ─────────────
  IF v_fecha > v_hoy THEN
    v_estado_g := 'en_revision';
    v_motivo   := 'Gestión con fecha futura (' || v_fecha || ')';
  ELSIF v_fecha < v_hoy - 1 AND NOT v_rol_priv THEN
    v_estado_g := 'en_revision';
    v_motivo   := 'Gestión con fecha de hace más de 1 día (' || v_fecha || ')';
  END IF;

  IF v_estado_g = 'aplicada' AND v_loan.estado = 'cancelado'
     AND v_tipo IN ('pago','cancelacion') THEN
    v_estado_g := 'en_revision';
    v_motivo   := 'El préstamo ya estaba cancelado';
  END IF;

  -- Umbral de abono por cuotas: chequeo EN EL SERVIDOR (el del cliente es
  -- solo un aviso previo; si su config no cargó, esto lo atrapa igual).
  IF v_estado_g = 'aplicada' AND v_tipo = 'pago' AND NOT v_rol_priv THEN
    SELECT abono_habilitado, abono_umbral_cuotas INTO v_umbral
      FROM ruta_config_umbrales WHERE ruta_id = p_ruta_id;
    IF FOUND AND COALESCE(v_umbral.abono_habilitado, false)
       AND v_umbral.abono_umbral_cuotas IS NOT NULL
       AND COALESCE(v_num_cuotas, 1) > v_umbral.abono_umbral_cuotas THEN
      v_estado_g := 'en_revision';
      v_motivo   := 'Abono de ' || COALESCE(v_num_cuotas, 1) ||
                    ' cuotas supera el umbral de la ruta (' ||
                    v_umbral.abono_umbral_cuotas || ')';
    END IF;
  END IF;

  -- Reversa: validar la referencia
  IF v_tipo = 'reversa' THEN
    v_referencia := NULLIF(p_payload->>'referencia_gestion_id','')::uuid;
    IF v_referencia IS NULL THEN
      IF NOT v_rol_priv THEN
        v_estado_g := 'en_revision';
        v_motivo   := 'Una reversa sin referencia (ajuste de dinero) requiere secretaría';
      END IF;
    ELSE
      SELECT id, loan_id, tipo, monto, fecha_gestion, user_id, estado
        INTO v_ref FROM gestiones WHERE id = v_referencia;
      IF NOT FOUND OR v_ref.loan_id IS DISTINCT FROM v_loan_id THEN
        v_estado_g := 'en_revision';
        v_motivo   := 'La gestión a reversar no existe en este préstamo';
      ELSIF v_ref.estado <> 'aplicada' THEN
        v_estado_g := 'en_revision';
        v_motivo   := 'La gestión a reversar está ' || v_ref.estado;
      ELSIF EXISTS (SELECT 1 FROM gestiones r
                     WHERE r.referencia_gestion_id = v_referencia
                       AND r.tipo = 'reversa' AND r.estado = 'aplicada') THEN
        v_estado_g := 'en_revision';
        v_motivo   := 'Esa gestión ya fue reversada';
      ELSE
        v_monto := v_ref.monto;  -- la reversa anula el monto original completo
        IF NOT v_rol_priv
           AND NOT (v_ref.fecha_gestion = v_hoy
                    AND v_ref.user_id IS NOT DISTINCT FROM p_user_id) THEN
          v_estado_g := 'en_revision';
          v_motivo   := 'Solo secretaría reversa gestiones de otros días u otros usuarios';
        END IF;
      END IF;
    END IF;
  END IF;

  -- ── Geocerca: la distancia se calcula ACÁ; la del teléfono no se cree ───
  IF v_loan.client_id IS NOT NULL AND v_lat IS NOT NULL AND v_lon IS NOT NULL THEN
    SELECT latitud, longitud INTO v_cli_lat, v_cli_lon
      FROM clients WHERE id = v_loan.client_id FOR UPDATE;
    IF v_cli_lat IS NULL OR v_cli_lon IS NULL THEN
      UPDATE clients
         SET latitud = v_lat, longitud = v_lon,
             ubicacion_capturada_at = NOW(), updated_at = NOW()
       WHERE id = v_loan.client_id;
      v_ubic_capturada := true;
      v_geo_estado := COALESCE(v_geo_estado, 'sin_referencia');
    ELSE
      v_geo_dist := public.distancia_metros(v_lat, v_lon, v_cli_lat, v_cli_lon);
    END IF;
  END IF;

  -- ── EL EVENTO. Pase lo que pase después, la visita ya quedó escrita. ────
  INSERT INTO gestiones (
    id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion, monto,
    cuota_objetivo, num_cuotas, fecha_hora, metodo_pago, multa_id,
    latitud, longitud, geocerca_estado, geocerca_distancia_m, geocerca_motivo,
    origen, referencia_gestion_id, observacion, motivo_revision, detalle
  ) VALUES (
    v_id, v_loan_id, v_loan.client_id, p_ruta_id, p_user_id, v_tipo, v_estado_g,
    v_fecha, v_monto,
    v_cuota_obj, v_num_cuotas, v_fh, v_metodo, v_multa_id,
    v_lat, v_lon, v_geo_estado, v_geo_dist, v_geo_motivo,
    'campo', v_referencia, v_obs, v_motivo,
    jsonb_build_object('rol', p_rol)
  )
  ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'duplicado', true);
  END IF;

  -- ── En revisión: solicitud para la bandeja y listo ──────────────────────
  IF v_estado_g = 'en_revision' THEN
    INSERT INTO solicitudes_revision (
      tipo, ruta_id, solicitado_por, solicitado_por_nombre, monto, descripcion, payload
    ) VALUES (
      'abono', p_ruta_id, p_user_id,
      (SELECT nombre FROM usuarios WHERE id = p_user_id),
      v_monto,
      COALESCE(v_cliente_nombre, 'Cliente') || ' — ' || v_motivo,
      jsonb_build_object('gestion_id', v_id)
    );
    v_resultado := jsonb_build_object(
      'ok', true, 'gestion_id', v_id, 'estado_gestion', 'en_revision',
      'enviado_a_revision', true, 'motivo', v_motivo,
      'cuotas_actualizadas', 0, 'nuevo_saldo', v_saldo_antes,
      'loan_estado_final', v_loan.estado);
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_id;
    RETURN v_resultado;
  END IF;

  -- ── Cobro de multa en la misma transacción ──────────────────────────────
  IF v_multa_id IS NOT NULL THEN
    UPDATE multas
       SET estado = 'pagada', pagada_at = NOW(), pagada_por = p_user_id,
           metodo_pago = v_metodo
     WHERE id = v_multa_id AND estado = 'pendiente'
    RETURNING valor INTO v_multa_valor;
    GET DIAGNOSTICS v_multa_upd = ROW_COUNT;
    IF v_multa_upd > 0 THEN
      INSERT INTO gastosregistros (
        fechahorasol, adminid, ruta, concepto, limite, valor, observacion,
        foto, tipo, estadoadmin, estadosecre
      ) VALUES (
        COALESCE(v_fh, NOW()), p_user_id, p_ruta_id,
        'Multa — ' || COALESCE(v_cliente_nombre, 'Cliente'),
        NULL, v_multa_valor, 'Pago de multa por fallas',
        NULL, 'Ingreso', 'NA', 'NA'
      );
      v_multa_cobrada := true;
    END IF;
  END IF;

  -- ── Prórroga americana (viaja con el pago; si no aplica, el pago sigue) ─
  IF v_ext > 0 AND v_tipo = 'pago' THEN
    IF v_loan.tipo_amortizacion <> 'americano' THEN
      v_ext_motivo := 'La extensión solo aplica a créditos americano; el pago se registró normal';
    ELSE
      SELECT id, numero_cuota, fecha_pago, interes INTO v_last
        FROM payment_plan WHERE loan_id = v_loan_id
       ORDER BY fecha_pago DESC, numero_cuota DESC LIMIT 1;
      IF NOT FOUND THEN
        v_ext_motivo := 'El préstamo no tiene cronograma; el pago se registró normal';
      ELSE
        v_interes_ref := COALESCE(v_last.interes, 0);
        -- La que era la última ya no recoge capital: solo interés.
        UPDATE payment_plan
           SET capital = 0, valor_cuota = v_interes_ref, updated_at = NOW()
         WHERE id = v_last.id;

        v_fecha_n := v_last.fecha_pago;
        v_num_max := v_last.numero_cuota;
        FOR v_i IN 1..v_ext LOOP
          v_fecha_n := public.siguiente_fecha_cobro(v_fecha_n, v_loan.frecuencia_pago);
          v_num_max := v_num_max + 1;
          INSERT INTO payment_plan (
            loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
            saldo, estado, ruta, es_extra
          ) VALUES (
            v_loan_id, v_num_max, v_fecha_n,
            CASE WHEN v_i = v_ext THEN v_loan.valor + v_interes_ref ELSE v_interes_ref END,
            CASE WHEN v_i = v_ext THEN v_loan.valor ELSE 0 END,
            v_interes_ref, 0, 'pendiente', p_ruta_id, true
          );
        END LOOP;

        -- Cada período nuevo causa interés nuevo: el contrato crece. (En el
        -- sistema viejo valor_a_pagar no se tocaba y el saldo se descuadraba.)
        UPDATE loans
           SET valor_a_pagar = COALESCE(valor_a_pagar, valor) + v_interes_ref * v_ext,
               updated_at = NOW()
         WHERE id = v_loan_id;
        -- No hace falta refrescar el total en memoria: `recalcular_prestamo`
        -- vuelve a leerlo de la tabla más abajo.

        INSERT INTO gestiones (
          id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
          monto, origen, detalle
        ) VALUES (
          gen_random_uuid(), v_loan_id, v_loan.client_id, p_ruta_id, p_user_id,
          'extension', 'aplicada', v_fecha, 0, 'campo',
          jsonb_build_object('clase', 'prorroga_americano', 'cuotas', v_ext,
                             'interes_por_cuota', v_interes_ref,
                             'gestion_pago', v_id)
        );
        v_ext_aplicada := true;
      END IF;
    END IF;
  END IF;

  -- ── Derivar todo ────────────────────────────────────────────────────────
  v_recalc := public.recalcular_prestamo(v_loan_id);

  -- ── Cuota adicional si quedó deuda sin cuotas por cobrar ────────────────
  IF v_gen_cuota AND v_tipo IN ('pago','no_pago')
     AND (v_recalc->>'nuevo_saldo')::numeric > 0
     AND NOT EXISTS (SELECT 1 FROM payment_plan
                      WHERE loan_id = v_loan_id
                        AND estado IN ('pendiente','parcial','no_pago')) THEN
    SELECT valor_cuota, capital, interes INTO v_tpl
      FROM payment_plan WHERE loan_id = v_loan_id AND NOT es_extra
     ORDER BY numero_cuota ASC LIMIT 1;
    SELECT fecha_pago, numero_cuota INTO v_last
      FROM payment_plan WHERE loan_id = v_loan_id
     ORDER BY fecha_pago DESC, numero_cuota DESC LIMIT 1;
    IF v_tpl.valor_cuota IS NOT NULL AND v_last.numero_cuota IS NOT NULL THEN
      INSERT INTO payment_plan (
        loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
        saldo, estado, ruta, es_extra
      ) VALUES (
        v_loan_id, v_last.numero_cuota + 1,
        public.siguiente_fecha_cobro(
          GREATEST(v_last.fecha_pago, v_hoy),
          CASE WHEN COALESCE(v_loan.prestamo_empleado, false) THEN 'daily'
               ELSE v_loan.frecuencia_pago END),
        LEAST(v_tpl.valor_cuota, (v_recalc->>'nuevo_saldo')::numeric),
        v_tpl.capital, v_tpl.interes, 0, 'pendiente', p_ruta_id, true
      );
      INSERT INTO gestiones (
        id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
        monto, origen, detalle
      ) VALUES (
        gen_random_uuid(), v_loan_id, v_loan.client_id, p_ruta_id, p_user_id,
        'extension', 'aplicada', v_fecha, 0, 'campo',
        jsonb_build_object('clase', 'cuota_adicional', 'gestion_origen', v_id)
      );
      v_cuota_adic := true;
      v_recalc := public.recalcular_prestamo(v_loan_id);
    END IF;
  END IF;

  -- ── Evaluar multa tras un no pago (la función llega en el script 047) ───
  IF v_tipo = 'no_pago'
     AND to_regprocedure('public.evaluar_multa_prestamo(uuid)') IS NOT NULL THEN
    PERFORM public.evaluar_multa_prestamo(v_loan_id);
  END IF;

  -- ── Resultado ───────────────────────────────────────────────────────────
  v_resultado := jsonb_build_object(
    'ok', true,
    'gestion_id', v_id,
    'estado_gestion', 'aplicada',
    'cuotas_actualizadas', GREATEST(1, COALESCE(v_num_cuotas, 1)),
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'loan_estado_final', v_recalc->>'loan_estado_final',
    'cuotas_cubiertas', (v_recalc->>'cuotas_cubiertas')::int,
    'cuotas_totales', (v_recalc->>'cuotas_totales')::int,
    'sobrepago', CASE WHEN v_tipo = 'pago' AND v_monto > v_saldo_antes
                      THEN v_monto - v_saldo_antes ELSE 0 END,
    'ya_gestionado_dia', v_ya_gestionado,
    'multa_cobrada', v_multa_cobrada,
    'extension_aplicada', v_ext_aplicada,
    'extension_motivo', v_ext_motivo,
    'cuota_adicional_generada', v_cuota_adic,
    'cliente_marcado_sin_prestamo', (v_recalc->>'loan_estado_final') = 'cancelado',
    'enviado_a_revision', false,
    'fila_hoy_creada', false,
    'ubicacion_cliente_capturada', v_ubic_capturada,
    'geocerca_distancia_m', v_geo_dist
  );
  UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_id;
  RETURN v_resultado;
END;
$$;


-- ── PASO 3) aprobar_solicitud_revision v3 ─────────────────────────────────
-- Novedades: (a) solicitudes cuyo payload trae `gestion_id` (núcleo nuevo)
-- se resuelven cambiando el estado del evento + recálculo; (b) fix del bug
-- 7.9: al aprobar una VENTA también se quita la llave de idempotencia usada,
-- igual que ya se hacía con los abonos; (c) admin también puede aprobar.
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
AS $$
DECLARE
  v_solicitud_id uuid;
  v_decision     text;
  v_row          record;
  v_gestion_id   uuid;
  v_gestion      record;
  v_nombre       text;
BEGIN
  IF lower(COALESCE(p_rol,'')) NOT IN ('secretaria','secretario','admin','administrador') THEN
    RAISE EXCEPTION 'Solo secretaría o admin puede resolver solicitudes (rol: %)', p_rol;
  END IF;

  v_solicitud_id := NULLIF(p_payload->>'solicitud_id','')::uuid;
  v_decision     := p_payload->>'decision';
  IF v_solicitud_id IS NULL OR v_decision NOT IN ('aprobado','rechazado') THEN
    RAISE EXCEPTION 'Payload inválido: se requiere solicitud_id y decision aprobado|rechazado';
  END IF;

  SELECT * INTO v_row FROM solicitudes_revision
   WHERE id = v_solicitud_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La solicitud no existe';
  END IF;
  IF v_row.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'La solicitud ya fue resuelta (estado: %)', v_row.estado;
  END IF;

  SELECT nombre INTO v_nombre FROM usuarios WHERE id = p_user_id;
  v_gestion_id := NULLIF(v_row.payload->>'gestion_id','')::uuid;

  IF v_decision = 'rechazado' THEN
    IF v_gestion_id IS NOT NULL THEN
      SELECT loan_id INTO v_gestion FROM gestiones
       WHERE id = v_gestion_id AND estado = 'en_revision';
      IF FOUND THEN
        UPDATE gestiones
           SET estado = 'rechazada', revisado_por = p_user_id,
               revisado_nombre = v_nombre, revisado_at = NOW()
         WHERE id = v_gestion_id;
        PERFORM public.recalcular_prestamo(v_gestion.loan_id);
      END IF;
    END IF;
    UPDATE solicitudes_revision
       SET estado = 'rechazado', revisado_por = p_user_id,
           revisado_por_nombre = v_nombre, revisado_at = NOW(),
           motivo_rechazo = NULLIF(p_payload->>'motivo_rechazo','')
     WHERE id = v_solicitud_id;
    RETURN jsonb_build_object('ok', true, 'tipo', v_row.tipo, 'estado', 'rechazado');
  END IF;

  -- Aprobado
  IF v_gestion_id IS NOT NULL THEN
    SELECT loan_id INTO v_gestion FROM gestiones
     WHERE id = v_gestion_id AND estado = 'en_revision';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La gestión de esta solicitud ya no está en revisión';
    END IF;
    UPDATE gestiones
       SET estado = 'aplicada', revisado_por = p_user_id,
           revisado_nombre = v_nombre, revisado_at = NOW()
     WHERE id = v_gestion_id;
    PERFORM public.recalcular_prestamo(v_gestion.loan_id);

  ELSIF v_row.tipo = 'venta' THEN
    PERFORM public.crear_venta_atomica(
      p_user_id, v_row.ruta_id, p_rol,
      v_row.payload->'p_cliente',
      (v_row.payload->'p_loan') - 'idempotency_key',
      v_row.payload->'p_payment_plan');

  ELSIF v_row.tipo = 'abono' THEN
    PERFORM public.registrar_pago_atomico(
      p_user_id, v_row.ruta_id, p_rol,
      (v_row.payload->'p_payload') - 'idempotency_key');

  ELSIF v_row.tipo = 'gasto' THEN
    RAISE EXCEPTION 'Los gastos se aprueban desde la app (requieren la foto en Blob)';
  END IF;

  UPDATE solicitudes_revision
     SET estado = 'aprobado', revisado_por = p_user_id,
         revisado_por_nombre = v_nombre, revisado_at = NOW()
   WHERE id = v_solicitud_id;

  RETURN jsonb_build_object('ok', true, 'tipo', v_row.tipo, 'estado', 'aprobado');
END;
$$;


-- ── PASO 4) registrar_pago_atomico v8 — ADAPTER de compatibilidad ─────────
-- Un PWA con la versión vieja cacheada, o una cola offline capturada antes
-- del corte, sigue mandando el payload viejo. Este adapter lo traduce al
-- núcleo nuevo y devuelve la forma de respuesta que esa app espera.
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
AS $$
DECLARE
  v_tipo_viejo text;
  v_tipo       text;
  v_r          jsonb;
BEGIN
  v_tipo_viejo := p_payload->>'tipo';
  v_tipo := CASE v_tipo_viejo
    WHEN 'pago_normal'      THEN 'pago'
    WHEN 'pago_parcial'     THEN 'pago'
    WHEN 'cancelacion_total' THEN 'cancelacion'
    WHEN 'no_pago'          THEN 'no_pago'
    WHEN 'pago'             THEN 'pago'
    WHEN 'cancelacion'      THEN 'cancelacion'
    ELSE NULL END;
  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'Tipo de operacion no soportado: %', COALESCE(v_tipo_viejo, '(nulo)');
  END IF;

  v_r := public.registrar_gestion(p_user_id, p_ruta_id, p_rol, jsonb_build_object(
    'id',                  COALESCE(NULLIF(p_payload->>'idempotency_key',''), gen_random_uuid()::text),
    'tipo',                v_tipo,
    'loan_id',             p_payload->>'loan_id',
    'client_id',           p_payload->>'client_id',
    'monto',               COALESCE(p_payload->>'monto', '0'),
    'num_cuotas',          p_payload->>'num_cuotas',
    'fecha_gestion',       p_payload->>'fecha_pago',
    'fecha_hora',          p_payload->>'fecha_pago_real',
    'cuota_objetivo',      p_payload->>'payment_plan_id',
    'generar_cuota_si_debe', p_payload->>'generar_cuota_si_debe',
    'extender_cuotas',     p_payload->>'extender_cuotas',
    'multa_id',            p_payload->>'multa_id',
    'metodo_pago',         p_payload->>'metodo_pago',
    'cliente_nombre',      p_payload->>'cliente_nombre',
    'latitud',             p_payload->>'latitud',
    'longitud',            p_payload->>'longitud',
    'geocerca_estado',     p_payload->>'geocerca_estado',
    'geocerca_motivo',     p_payload->>'geocerca_motivo'
  ));

  RETURN v_r;
END;
$$;


-- ── PASO 5) ajustar_cuota_control_pagos v2 — ediciones como eventos ───────
-- Mismo contrato de payload y respuesta que la v1 (Control de Pagos no
-- cambia), pero por dentro:
--   · fecha_pago / valor_cuota  → edición del CRONOGRAMA (evento 'ajuste')
--   · estado / monto_pagado     → EVENTOS de dinero: pasar a pagado inserta
--     el pago que falta; bajar plata inserta una reversa de ajuste; no_pago
--     inserta la visita anclada. Después recalcula TODO por la cascada.
-- OJO (por diseño): la plata es fungible — subir o bajar dinero afecta la
-- cascada completa, no solo la cuota tocada. Para cirugía fina está el
-- editor total de secretaría (script 046).
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
          p_user_id, 'pago', 'aplicada', v_hoy, v_delta, v_pp_id, 'ajuste',
          'Ajuste desde Control de Pagos',
          jsonb_build_object('cuota', v_pp.numero_cuota));
      ELSIF v_delta < 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, origen, observacion, detalle)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'reversa', 'aplicada', v_hoy, -v_delta, 'ajuste',
          'Ajuste de dinero desde Control de Pagos',
          jsonb_build_object('cuota', v_pp.numero_cuota));
      END IF;

    ELSIF v_estado_des = 'no_pago' THEN
      IF v_asignado > 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, origen, observacion)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'reversa', 'aplicada', v_hoy, v_asignado, 'ajuste',
          'Retiro de plata al marcar no pago desde Control de Pagos');
      END IF;
      INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
        estado, fecha_gestion, monto, cuota_objetivo, origen, observacion)
      VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
        p_user_id, 'no_pago', 'aplicada', v_hoy, 0, v_pp_id, 'ajuste',
        'Marcada no pago desde Control de Pagos');

    ELSIF v_estado_des = 'pendiente' THEN
      IF v_asignado > 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, origen, observacion)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
          p_user_id, 'reversa', 'aplicada', v_hoy, v_asignado, 'ajuste',
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
          p_user_id, 'reversa', 'aplicada', v_hoy, 0, v_g.id, 'ajuste',
          'No pago anulado desde Control de Pagos');
      END LOOP;
    END IF;
  END IF;

  -- 3) Evento de auditoría del ajuste + recálculo
  INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo, estado,
    fecha_gestion, monto, origen, observacion, detalle)
  VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, p_ruta_id,
    p_user_id, 'ajuste', 'aplicada', v_hoy, 0, 'ajuste',
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


-- ── PASO 6) Verificar ─────────────────────────────────────────────────────
-- Deben salir las 5 funciones con su firma.
SELECT p.proname AS funcion, pg_get_function_identity_arguments(p.oid) AS argumentos
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('siguiente_fecha_cobro','registrar_gestion',
                     'aprobar_solicitud_revision','registrar_pago_atomico',
                     'ajustar_cuota_control_pagos')
 ORDER BY p.proname;
