-- ═══════════════════════════════════════════════════════════════════════════
-- 077 · CORREGIR UNA GESTIÓN NO ES INVENTAR UNA VISITA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EL SÍNTOMA
--   · "Error en reversión de pagos a no pagos."
--   · "Cuando se corrige de no pago a pago, al final regresa el movimiento
--      al panel de pendientes y finalmente no queda la corrección."
--
-- LA CAUSA — una sola para los dos
--   El script 064 puso una regla justa: un `pago`, `no_pago` o `cancelacion`
--   sin coordenadas es una visita sin prueba de que ocurrió.
--       no_pago              → RAISE EXCEPTION
--       pago / cancelacion   → entra `en_revision`, no cuenta
--
--   Una corrección se hace desde el escritorio y se escribe como un `pago` o
--   un `no_pago` NUEVO. Sin GPS. Así que caía entera en esa regla:
--
--       no pago → pago     el pago quedaba `en_revision`, no sumaba, y el
--                          cliente volvía a Pendientes: "no queda la
--                          corrección".
--       pago → no pago     la reversa se aplicaba y el `no_pago` reventaba
--                          justo después. Quedaba el pago ANULADO y nada en
--                          su lugar: el error que se reportó.
--
--   El comentario de la propia regla ya preveía esto —"las reversas y los
--   ajustes se registran desde un escritorio"— pero el código solo eximía a
--   las reversas por su tipo.
--
-- LO QUE SE VIO EN LA BASE ANTES DE TOCAR NADA
--   · 4 eventos atascados en revisión por este motivo, $11.496 detenidos.
--   · El préstamo ce9353ed (andrés zona azul) con CINCO ciclos
--     "pago aplicada → reversa" y ningún `no_pago`: cinco intentos, cinco
--     fracasos, cinco reversas huérfanas.
--   · Dos de los cuatro atascados dicen "Monto corregido": el defecto ya
--     existía antes de que se pudiera cambiar el estado, solo que callado.
--
-- EL ARREGLO
--   Antes de tratar un evento sin GPS como visita inventada, se pregunta si
--   ESE préstamo YA tiene ese día un evento de visita aplicado CON
--   coordenadas. Si lo tiene, la visita está probada y el evento entra normal.
--
--   No se miran las reversas: que un evento haya sido anulado no borra que el
--   teléfono estuvo en ese punto. Las coordenadas prueban la presencia; la
--   reversa corrige el contenido.
--
--   El servidor NO copia coordenadas al evento nuevo. No inventa una medición
--   que no tomó. La app manda las del evento que corrige —que es un dato
--   real, medido en esa misma visita— para que la corrección salga en el mapa.
--
-- LO QUE NO CAMBIA
--   · Un cobrador con el GPS apagado que no ha visitado al cliente ese día
--     sigue topándose con la regla completa. La puerta se abre SOLO donde ya
--     hay una visita probada de ese mismo cliente ese mismo día.
--   · `origen` sigue siendo 'campo'. Marcar las correcciones como 'ajuste'
--     las sacaría de `recaudo_campo` (script 071) y el Monitoreo dejaría de
--     contarle al cobrador una plata que sí recogió él.
--   · No se toca nada más de la función: es la misma del 069 con este bloque
--     reemplazado.
--
-- PASOS
--   1) registrar_gestion con la regla nueva
--   2) permisos
--   3) verificar que quedó (solo lectura)
--   4) ver los eventos atascados (solo lectura)
--   5) OPCIONAL — rechazar esos atascados. LEER EL PASO ANTES DE CORRERLO.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── PASO 1) La función, con la visita probada ─────────────────────────────
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
  -- ¿La visita de ese día ya está probada por otro evento del préstamo?
  v_visita_probada boolean := false;
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
         valor, tipo_amortizacion, frecuencia_pago, prestamo_empleado,
         -- `ruta` entra al SELECT para poder escribir la gestion en la ruta
         -- DEL CREDITO y no en la de la sesion (ver el encabezado del 069).
         ruta AS ruta_real
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

  -- ── SIN COORDENADAS NO HAY VISITA ──────────────────────────────────────
  -- Una gestión de campo dice "estuve en la puerta del cliente". Sin latitud
  -- y longitud eso no se puede sostener, y es justo lo que el GPS existe para
  -- probar.
  --
  -- El teléfono ya lo bloquea (`resolverGeocerca` corta si el GPS no
  -- responde), pero eso es el cliente: una app vieja en caché, un payload de
  -- la cola capturado antes, o una llamada armada a mano se lo saltan. Acá no.
  --
  -- SE TRATAN DISTINTO A PROPÓSITO:
  --
  --   no_pago  → SE RECHAZA. No hay plata de por medio, y una visita sin
  --              prueba de que ocurrió no vale nada: dejarla entrar es peor
  --              que no tenerla, porque cuenta como ruta hecha.
  --
  --   pago y cancelacion → ENTRAN, pero `en_revision`. El cliente ya entregó
  --              la plata; rechazar el evento la perdería, y la regla del
  --              núcleo es que nada se pierde en silencio. Queda registrada,
  --              no suma hasta que secretaría la firme, y el motivo dice por
  --              qué. Es el mismo trato que reciben la fecha futura o el
  --              préstamo ya cancelado.
  --
  -- Solo se miran los tres tipos que SON una visita. Las reversas y los
  -- ajustes pasan por esta misma función y nunca traen coordenadas: se
  -- registran desde un escritorio, corrigiendo algo que ya pasó. Las
  -- homologaciones y los abonos de venta ni siquiera entran acá — los escribe
  -- `crear_venta_atomica`.
  IF v_lat IS NULL OR v_lon IS NULL THEN
    -- ¿LA VISITA DE ESE DÍA YA ESTÁ PROBADA?
    --
    -- La regla de arriba supone que un evento sin coordenadas es alguien
    -- diciendo "fui" sin haber ido. Pero hay un caso donde no lo es: cuando
    -- se está CORRIGIENDO una visita que ya ocurrió y que dejó su rastro.
    -- Corregir un monto, o pasar un pago a no pago, se hace desde el
    -- escritorio y desde ahí no hay GPS que valga.
    --
    -- El comentario original de esta misma regla ya lo decía —"las reversas
    -- y los ajustes... se registran desde un escritorio"— pero el código solo
    -- eximía a las reversas por su TIPO. Una corrección se escribe como un
    -- `pago` o un `no_pago` nuevo, así que caía de lleno acá: el pago entraba
    -- `en_revision` y no contaba, y el no pago REVENTABA con la excepción
    -- después de que su reversa ya se había aplicado, dejando el pago anulado
    -- y nada en su lugar.
    --
    -- No se miran las reversas para decidir: que un evento haya sido anulado
    -- no borra que el teléfono estuvo en ese punto. Las coordenadas prueban
    -- la presencia; la reversa corrige el contenido.
    --
    -- Tampoco se copian las coordenadas al evento nuevo. El servidor no
    -- inventa una medición que no tomó: si la app quiere que la corrección
    -- salga en el mapa, manda las del evento que corrige, que es un dato real.
    SELECT EXISTS (
      SELECT 1
        FROM gestiones g
       WHERE g.loan_id       = v_loan_id
         AND g.fecha_gestion = v_fecha
         AND g.estado        = 'aplicada'
         AND g.tipo IN ('pago','no_pago','cancelacion')
         AND g.latitud  IS NOT NULL
         AND g.longitud IS NOT NULL
    ) INTO v_visita_probada;

    IF NOT v_visita_probada THEN
      IF v_tipo = 'no_pago' THEN
        RAISE EXCEPTION 'No se puede registrar un no pago sin ubicación: activa el GPS e intenta de nuevo';
      ELSIF v_tipo IN ('pago','cancelacion') THEN
        v_estado_g := 'en_revision';
        v_motivo   := 'Registrada sin ubicación GPS';
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
    v_id, v_loan_id, v_loan.client_id, COALESCE(v_loan.ruta_real, p_ruta_id),
    p_user_id, v_tipo, v_estado_g,
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
            -- Ruta DEL CREDITO, como el resto de su cronograma.
            v_interes_ref, 0, 'pendiente', COALESCE(v_loan.ruta_real, p_ruta_id), true
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
          gen_random_uuid(), v_loan_id, v_loan.client_id,
          COALESCE(v_loan.ruta_real, p_ruta_id), p_user_id,
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
        -- La cuota nueva pertenece a la ruta DEL CREDITO, igual que el resto
        -- de su cronograma: si no, quedaria huerfana en otra ruta.
        v_tpl.capital, v_tpl.interes, 0, 'pendiente',
        COALESCE(v_loan.ruta_real, p_ruta_id), true
      );
      INSERT INTO gestiones (
        id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
        monto, origen, detalle
      ) VALUES (
        gen_random_uuid(), v_loan_id, v_loan.client_id,
        COALESCE(v_loan.ruta_real, p_ruta_id), p_user_id,
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

-- ── PASO 2) Permisos ──────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.registrar_gestion(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 3) Verificar que la regla nueva quedó (SOLO LECTURA) ─────────────
-- Debe decir  regla_nueva = true.
SELECT
  prosrc LIKE '%v_visita_probada%'                     AS regla_nueva,
  prosrc LIKE '%Registrada sin ubicación GPS%'         AS conserva_el_motivo,
  prosrc LIKE '%No se puede registrar un no pago sin%' AS conserva_el_rechazo
  FROM pg_proc
 WHERE proname = 'registrar_gestion'
   AND pronamespace = 'public'::regnamespace;


-- ── PASO 4) Los eventos que quedaron atascados (SOLO LECTURA) ─────────────
-- Son las correcciones que no alcanzaron a entrar. Para cada una, la columna
-- `hay_pago_posterior` dice si en ese préstamo YA se registró otro pago
-- aplicado ese mismo día — es decir, si la persona rehízo la gestión a mano.
--
-- Donde diga true, APROBAR ESE EVENTO SUMARÍA LA PLATA DOS VECES.
SELECT g.id,
       g.ruta,
       c.nombre_completo,
       g.tipo,
       g.monto,
       g.fecha_gestion,
       g.observacion,
       EXISTS (SELECT 1 FROM gestiones p
                WHERE p.loan_id = g.loan_id
                  AND p.fecha_gestion = g.fecha_gestion
                  AND p.estado = 'aplicada'
                  AND p.tipo IN ('pago','cancelacion')
                  AND p.fecha_hora > g.fecha_hora) AS hay_pago_posterior
  FROM gestiones g
  JOIN loans  l ON l.id = g.loan_id
  LEFT JOIN clients c ON c.id = l.client_id
 WHERE g.estado = 'en_revision'
   AND g.motivo_revision = 'Registrada sin ubicación GPS'
 ORDER BY g.fecha_hora DESC;


-- ── PASO 5) OPCIONAL — rechazar los atascados que ya se rehicieron ────────
--
-- LEER ESTO ANTES DE CORRERLO.
--
-- Solo toca los eventos del PASO 4 donde `hay_pago_posterior` sea true: la
-- corrección no entró, la persona la volvió a hacer a mano, y el pago bueno
-- ya está aplicado. Si alguien aprueba estos desde la bandeja de secretaría,
-- la plata se suma DOS VECES.
--
-- Rechazar no mueve plata: solo cierra la solicitud. Si prefiere revisarlos
-- uno por uno desde la app, no corra este paso — pero no los apruebe.
--
-- Al 27/08/2026 esto afecta a 4 eventos por $11.496.
UPDATE gestiones g
   SET estado          = 'rechazada',
       motivo_revision = g.motivo_revision
                       || ' · rechazada por el script 077: la corrección no '
                       || 'entró por el defecto del GPS y ya se rehízo a mano',
       revisado_at     = NOW()
 WHERE g.estado = 'en_revision'
   AND g.motivo_revision = 'Registrada sin ubicación GPS'
   AND g.observacion ILIKE '%desde el módulo de pagos%'
   AND EXISTS (SELECT 1 FROM gestiones p
                WHERE p.loan_id = g.loan_id
                  AND p.fecha_gestion = g.fecha_gestion
                  AND p.estado = 'aplicada'
                  AND p.tipo IN ('pago','cancelacion')
                  AND p.fecha_hora > g.fecha_hora);


-- ── PASO 6) Comprobar que no quedó ninguno colgado (SOLO LECTURA) ─────────
-- Debe devolver 0 filas si se corrió el paso 5.
SELECT COUNT(*) AS correcciones_aun_en_revision
  FROM gestiones
 WHERE estado = 'en_revision'
   AND motivo_revision LIKE 'Registrada sin ubicación GPS%'
   AND observacion ILIKE '%desde el módulo de pagos%';
