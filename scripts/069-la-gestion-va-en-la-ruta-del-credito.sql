-- ============================================================================
-- 069 - La gestion pertenece a la ruta DEL CREDITO, no a la de la sesion
-- ============================================================================
-- LO QUE SE REPORTO
-- "En la ruta 1, el dia de ayer aparece un recaudo de 762.066, y al mirar el
-- mapa hay pagos de otras rutas. El caso de Carvajal, con 97.500, cuyo cliente
-- en la base es de la ruta 151."
--
-- ESTABA PASANDO, Y LOS NUMEROS COINCIDEN EXACTO
-- Hay 129 gestiones cuya `ruta` no es la del credito. La plata mal atribuida:
--
--   2026-08-24  ruta 1 <- deberia ser 151 :  $762.000
--   2026-08-22  ruta 1 <- deberia ser 151 :  -$19.500
--   2026-08-17  ruta 1 <- deberia ser 151 :     -$500
--
-- Esos 762.000 son los 762.066 del reporte: los 66 restantes son las gestiones
-- que SI son de la ruta 1.
--
-- LA CAUSA
-- Las tres funciones que escriben en `gestiones` guardaban
-- `ruta = p_ruta_id`, o sea LA RUTA SELECCIONADA EN LA SESION de quien
-- registra. Para un cobrador da igual: siempre trabaja su propia ruta. Para
-- SECRETARIA no: tiene una ruta seleccionada pero corrige creditos de todas
-- desde Control de Pagos y Control Total.
--
-- Las 129 desalineadas son TODAS de `origen = 'ajuste'` y TODAS del mismo
-- usuario (el 4, secretaria). Es exactamente ese escenario.
--
-- LA SESION NO ES FUENTE DE VERDAD PARA ESTO. El credito sabe a que ruta
-- pertenece; la pantalla desde la que se toca, no. De ahora en adelante la
-- gestion se escribe con `loans.ruta`, y `p_ruta_id` queda solo como respaldo
-- por si el credito no la tuviera.
--
-- `payment_plan.ruta` se reviso tambien: 0 desalineadas, no hay que tocarla.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Que se va a mover (solo lectura) ──────────────────────────────
-- Deja constancia de como estaba antes de corregir.
SELECT g.fecha_gestion,
       g.ruta                     AS esta_en_ruta,
       l.ruta                     AS deberia_estar_en,
       COUNT(*)                   AS gestiones,
       SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END) AS plata
  FROM public.gestiones g
  JOIN public.loans l ON l.id = g.loan_id
 WHERE g.ruta IS DISTINCT FROM l.ruta
 GROUP BY g.fecha_gestion, g.ruta, l.ruta
 ORDER BY g.fecha_gestion DESC;


-- ── PASO 2) Corregir las que ya estan mal ─────────────────────────────────
-- `gestiones` es un libro inmutable y su trigger bloquea cualquier UPDATE.
-- Esto NO es un evento de negocio: es reparar un dato que el sistema escribio
-- mal. No mueve un peso — la misma plata, en la caja que le corresponde.
--
-- Va TODO en un solo bloque a proposito: apagar el trigger, corregir y volver
-- a encenderlo son transaccionales en PostgreSQL, asi que si algo falla se
-- deshace entero y el trigger NO puede quedarse apagado.
DO $BLOQUE$
DECLARE
  v_filas int;
BEGIN
  ALTER TABLE public.gestiones DISABLE TRIGGER trg_gestiones_inmutables;

  UPDATE public.gestiones g
     SET ruta = l.ruta
    FROM public.loans l
   WHERE l.id = g.loan_id
     AND g.ruta IS DISTINCT FROM l.ruta;
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;

  RAISE NOTICE 'Gestiones corregidas: %', v_filas;
END
$BLOQUE$;


-- ── PASO 3) Que el trigger haya vuelto ────────────────────────────────────
-- `tgenabled` debe decir 'O' (habilitado). Si dice 'D', el libro quedo sin
-- proteccion y hay que volver a encenderlo a mano.
SELECT tgname,
       tgenabled,
       CASE tgenabled WHEN 'O' THEN 'ENCENDIDO' ELSE 'APAGADO — ARREGLAR YA' END AS estado
  FROM pg_trigger
 WHERE tgname = 'trg_gestiones_inmutables';


-- ── PASO 4) Que no quede ninguna desalineada ──────────────────────────────
-- Debe dar 0.
SELECT COUNT(*) AS gestiones_en_la_ruta_equivocada
  FROM public.gestiones g
  JOIN public.loans l ON l.id = g.loan_id
 WHERE g.ruta IS DISTINCT FROM l.ruta;


-- ── PASO 5) registrar_gestion escribe la ruta del credito ─────────────────
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
    IF v_tipo = 'no_pago' THEN
      RAISE EXCEPTION 'No se puede registrar un no pago sin ubicación: activa el GPS e intenta de nuevo';
    ELSIF v_tipo IN ('pago','cancelacion') THEN
      v_estado_g := 'en_revision';
      v_motivo   := 'Registrada sin ubicación GPS';
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


-- ── PASO 6) ajustar_cuota_control_pagos, igual ────────────────────────────
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

  -- `ruta` entra al SELECT para escribir las gestiones en la ruta DEL
  -- CREDITO. Secretaria trabaja con UNA ruta seleccionada en su sesion pero
  -- corrige creditos de todas: usar `p_ruta_id` metia la plata de la 151 en
  -- la caja de la 1 (ver el encabezado del 069).
  SELECT id, estado, client_id, saldo, ruta INTO v_loan
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
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id),
          p_user_id, 'pago', 'aplicada', v_fecha_ajuste, v_delta, v_pp_id, 'ajuste',
          'Ajuste desde Control de Pagos',
          jsonb_build_object('cuota', v_pp.numero_cuota));
      ELSIF v_delta < 0 THEN
        -- `cuota_objetivo` TAMBIEN en la reversa: sin eso, bajar el monto de
        -- una cuota sacaba plata del prestamo pero no de la bolsa dirigida de
        -- esa cuota, y el ajuste quedaba a medias (script 065).
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, cuota_objetivo, origen, observacion, detalle)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id),
          p_user_id, 'reversa', 'aplicada', v_fecha_ajuste, -v_delta, v_pp_id, 'ajuste',
          'Ajuste de dinero desde Control de Pagos',
          jsonb_build_object('cuota', v_pp.numero_cuota));
      END IF;

    ELSIF v_estado_des = 'no_pago' THEN
      IF v_asignado > 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, cuota_objetivo, origen, observacion)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id),
          p_user_id, 'reversa', 'aplicada', v_fecha_ajuste, v_asignado, v_pp_id, 'ajuste',
          'Retiro de plata al marcar no pago desde Control de Pagos');
      END IF;
      INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
        estado, fecha_gestion, monto, cuota_objetivo, origen, observacion)
      VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id),
        p_user_id, 'no_pago', 'aplicada', v_fecha_ajuste, 0, v_pp_id, 'ajuste',
        'Marcada no pago desde Control de Pagos');

    ELSIF v_estado_des = 'pendiente' THEN
      IF v_asignado > 0 THEN
        INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo,
          estado, fecha_gestion, monto, cuota_objetivo, origen, observacion)
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id),
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
        VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id),
          p_user_id, 'reversa', 'aplicada', v_fecha_ajuste, 0, v_g.id, 'ajuste',
          'No pago anulado desde Control de Pagos');
      END LOOP;
    END IF;
  END IF;

  -- 3) Evento de auditoría del ajuste + recálculo
  INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo, estado,
    fecha_gestion, monto, origen, observacion, detalle)
  VALUES (gen_random_uuid(), v_pp.loan_id, v_loan.client_id, COALESCE(v_loan.ruta, p_ruta_id),
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


-- ── PASO 7) anular_venta, igual ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.anular_venta(
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
  v_loan_id   uuid;
  v_idem      uuid;
  v_prev      jsonb;
  v_motivo    text;
  v_nombre    text;
  v_loan      record;
  v_pagado    numeric;
  v_gestiones int;
  v_resultado jsonb;
BEGIN
  -- Solo secretaría y admin. Anular una venta borra un crédito de la cartera:
  -- no es una operación de campo.
  IF lower(COALESCE(p_rol,'')) NOT IN ('secretaria','secretario','admin','administrador') THEN
    RAISE EXCEPTION 'Solo secretaría o admin puede anular una venta (rol: %)', p_rol;
  END IF;

  v_loan_id := NULLIF(p_payload->>'loan_id','')::uuid;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'Falta loan_id';
  END IF;

  v_motivo := NULLIF(trim(p_payload->>'motivo'), '');
  IF v_motivo IS NULL THEN
    RAISE EXCEPTION 'Hay que decir por qué se anula la venta';
  END IF;

  -- Idempotencia: si el botón se toca dos veces o el reintento de la cola
  -- vuelve a llegar, la segunda no hace nada y devuelve lo mismo.
  v_idem := NULLIF(p_payload->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'anular_venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  SELECT id, estado, client_id, ruta, valor, valor_a_pagar, saldo
    INTO v_loan
    FROM loans WHERE id = v_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La venta no existe';
  END IF;
  IF v_loan.estado = 'anulado' THEN
    RETURN jsonb_build_object('ok', true, 'ya_estaba_anulada', true);
  END IF;

  -- Cuánta plata movió: NO se toca, pero se deja escrito en el rastro para
  -- que quien mire después sepa qué quedó colgado en las cajas de esos días.
  SELECT COALESCE(pagado_neto, 0) INTO v_pagado
    FROM v_pagos_netos WHERE loan_id = v_loan_id;
  v_pagado := COALESCE(v_pagado, 0);
  SELECT COUNT(*) INTO v_gestiones FROM gestiones WHERE loan_id = v_loan_id;

  SELECT nombre INTO v_nombre FROM usuarios WHERE id = p_user_id;

  UPDATE loans
     SET estado             = 'anulado',
         anulada_at         = NOW(),
         anulada_por        = p_user_id,
         anulada_por_nombre = v_nombre,
         motivo_anulacion   = v_motivo,
         updated_at         = NOW()
   WHERE id = v_loan_id;

  -- El evento queda en el libro, como cualquier otra cosa que le pasa a un
  -- préstamo. Monto CERO: anular no mueve plata, y ponerle el saldo lo haría
  -- aparecer como un movimiento en los informes del día.
  INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo, estado,
    fecha_gestion, monto, origen, observacion, detalle)
  VALUES (gen_random_uuid(), v_loan_id, v_loan.client_id,
    COALESCE(v_loan.ruta, p_ruta_id), p_user_id,
    'ajuste', 'aplicada', (now() AT TIME ZONE 'America/Bogota')::date, 0,
    'ajuste', 'Venta anulada desde Control Total: ' || v_motivo,
    jsonb_build_object('clase', 'anulacion_venta',
                       'pagado_neto_al_anular', v_pagado,
                       'gestiones_del_prestamo', v_gestiones,
                       'saldo_al_anular', v_loan.saldo));

  -- La bandera del cliente se recalcula sola: `recalcular_prestamo` la deduce
  -- de si le queda algún crédito 'activo', y este ya no lo está. Y con el
  -- PASO 3 puesto, el recálculo respeta el 'anulado' en vez de revivirlo.
  PERFORM public.recalcular_prestamo(v_loan_id);

  -- Una multa pendiente de un crédito anulado no se puede cobrar nunca.
  UPDATE multas
     SET estado = 'cancelada',
         cancelada_at = NOW(),
         cancelada_por = p_user_id,
         cancelada_por_nombre = COALESCE(v_nombre, 'Sistema'),
         motivo_cancelacion = 'La venta fue anulada'
   WHERE loan_id = v_loan_id AND estado = 'pendiente';

  v_resultado := jsonb_build_object(
    'ok', true,
    'loan_id', v_loan_id,
    'pagado_neto', v_pagado,
    'gestiones', v_gestiones,
    'mensaje', 'La venta quedó anulada. Los pagos que ya se habían recibido '
               || 'siguen contando en los días en que entraron.');
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 8) Ejecucion para la app ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.registrar_gestion(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 9) Y las otras dos ───────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.ajustar_cuota_control_pagos(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 10) Y anular_venta ───────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.anular_venta(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 11) Verificar que las tres quedaron con la version nueva ─────────
-- Deben salir TRES filas.
SELECT proname, 'usa la ruta del credito' AS estado
  FROM pg_proc
 WHERE (proname = 'registrar_gestion'            AND prosrc LIKE '%ruta_real%')
    OR (proname = 'ajustar_cuota_control_pagos'  AND prosrc LIKE '%COALESCE(v_loan.ruta, p_ruta_id)%')
    OR (proname = 'anular_venta'                 AND prosrc LIKE '%COALESCE(v_loan.ruta, p_ruta_id)%');


-- ── PASO 12) El recaudo por ruta, ya corregido ────────────────────────────
-- La ruta 1 del 24/08 debe bajar unos 762.000 y la 151 subir lo mismo.
SELECT fecha_pago AS fecha, ruta, valor_pago, cantidad_pagos
  FROM public.resumen_diario_v2
 WHERE fecha_pago >= DATE '2026-08-17'
   AND ruta IN (1, 151, 197)
 ORDER BY fecha_pago DESC, ruta;
