-- ============================================================================
-- 081 - Cambiar el interés de una venta que ya tiene pagos
-- ============================================================================
-- EL SÍNTOMA
-- En Control Total se cambia la tasa de interés de una venta, se toca
-- «Regenerar el plan» y sale:
--
--   «La gestión ... ya está en estado aplicada y no se puede modificar; usa
--    una reversa»
--
-- No es que falte una reversa. Es que la edición no puede ni empezar.
--
-- LA CAUSA, QUE NO ES LA QUE PARECE
-- `editar_venta_atomica` regenera el cronograma con un DELETE del plan y un
-- INSERT del nuevo. Ese DELETE dispara el `ON DELETE SET NULL` del FK
-- `gestiones.cuota_objetivo → payment_plan(id)`: la base intenta poner en NULL
-- el puntero de cada evento que apuntaba a una cuota borrada.
--
-- Y eso es un UPDATE sobre `gestiones`. El trigger de inmutabilidad del script
-- 042 lo ve, comprueba que el evento está 'aplicada' y lo rechaza — con el
-- mensaje de la reversa, que en este caso despista: no hay ninguna reversa que
-- hacer, el evento no se está tocando, solo se le está soltando un puntero.
--
-- CUÁNTO PESA
-- Medido contra la base: de 152 préstamos activos, 131 NO se pueden editar.
-- Solo 21 pasan, y son justamente los que todavía no tienen ni un cobro
-- apuntado a una cuota. La función existe desde el script 045 y en la
-- práctica no ha servido para casi nada.
--
-- LO QUE SE ARREGLÓ MAL Y AQUÍ SE HACE BIEN
-- El comentario original decía «los eventos apuntados quedan con la
-- referencia en NULL; la plata no se toca». Eso era cierto en el 045 y dejó de
-- serlo en el 075: desde entonces un cobro de campo queda CLAVADO a su cuota
-- (`v_cobertura_cuotas`), y perder el puntero saca esa plata de donde estaba y
-- la manda a la cascada. El saldo total no cambia —eso sale de `gestiones`,
-- no del puntero— pero sí cambia QUÉ CUOTAS figuran cubiertas y, con ellas, la
-- mora y el X/Y del cliente. Hoy hay 129 préstamos con plata clavada.
--
-- Así que no basta con dejar pasar el SET NULL. Hay que VOLVER A COLGAR cada
-- puntero sobre la cuota del mismo número en el plan nuevo.
--
-- QUÉ QUEDA HACIENDO
-- Exactamente lo que se pidió: la cuota que ya tenía un pago se recalcula con
-- el interés nuevo —cambia lo que vale— y el pago de ese día se queda donde
-- estaba. De ahí en adelante, todas las cuotas salen con el valor nuevo. Si el
-- pago ya no alcanza a cubrir la cuota recalculada, la cuota queda parcial,
-- que es la verdad: se pactó otro interés.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) El trigger deja pasar el puntero de cuota ─────────────────────
-- Es el trigger del script 042 tal cual, con UNA rendija añadida. El porqué
-- está escrito adentro, donde se lee al mantenerlo.
CREATE OR REPLACE FUNCTION public.gestiones_inmutables()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gestiones es un libro inmutable: no se borra, se registra una reversa (id: %)', OLD.id;
  END IF;

  -- ── LA RENDIJA ──────────────────────────────────────────────────────────
  -- Se permite el UPDATE sobre una gestión aplicada cuando lo ÚNICO que
  -- cambia es `cuota_objetivo`. Cualquier otra diferencia —el monto, la fecha,
  -- el tipo, el estado— sigue rebotando igual que siempre.
  --
  -- La comparación es de la fila ENTERA menos esa columna, y no una lista de
  -- campos escrita a mano: una lista se queda corta el día que alguien agregue
  -- una columna, y la rendija se ensancharía sola sin que nadie se entere.
  --
  -- POR QUÉ ES ACEPTABLE
  -- El puntero no es plata. `v_pagos_netos` —de donde salen el saldo y el
  -- total pagado— no lo mira: suma `gestiones.monto` y ya. Lo que el puntero
  -- decide es a qué CUOTA se le imputa ese dinero, y eso es justo lo que hay
  -- que poder mover cuando el cronograma se regenera. La alternativa era dejar
  -- que el FK lo pusiera en NULL, que es peor: manda la plata a la cascada en
  -- silencio.
  IF NEW.cuota_objetivo IS DISTINCT FROM OLD.cuota_objetivo
     AND (to_jsonb(NEW) - 'cuota_objetivo') = (to_jsonb(OLD) - 'cuota_objetivo') THEN
    RETURN NEW;
  END IF;

  -- UPDATE: solo la transición de revisión.
  IF OLD.estado <> 'en_revision' THEN
    RAISE EXCEPTION 'La gestión % ya está en estado % y no se puede modificar; usa una reversa', OLD.id, OLD.estado;
  END IF;
  IF NEW.estado NOT IN ('aplicada','rechazada') THEN
    RAISE EXCEPTION 'Desde en_revision solo se puede pasar a aplicada o rechazada';
  END IF;

  -- Nada del contenido del evento puede cambiar en esa transición.
  IF NEW.id                    IS DISTINCT FROM OLD.id
     OR NEW.loan_id            IS DISTINCT FROM OLD.loan_id
     OR NEW.client_id          IS DISTINCT FROM OLD.client_id
     OR NEW.ruta               IS DISTINCT FROM OLD.ruta
     OR NEW.user_id            IS DISTINCT FROM OLD.user_id
     OR NEW.tipo               IS DISTINCT FROM OLD.tipo
     OR NEW.fecha_gestion      IS DISTINCT FROM OLD.fecha_gestion
     OR NEW.monto              IS DISTINCT FROM OLD.monto
     OR NEW.cuota_objetivo     IS DISTINCT FROM OLD.cuota_objetivo
     OR NEW.num_cuotas         IS DISTINCT FROM OLD.num_cuotas
     OR NEW.fecha_hora         IS DISTINCT FROM OLD.fecha_hora
     OR NEW.metodo_pago        IS DISTINCT FROM OLD.metodo_pago
     OR NEW.multa_id           IS DISTINCT FROM OLD.multa_id
     OR NEW.latitud            IS DISTINCT FROM OLD.latitud
     OR NEW.longitud           IS DISTINCT FROM OLD.longitud
     OR NEW.origen             IS DISTINCT FROM OLD.origen
     OR NEW.referencia_gestion_id IS DISTINCT FROM OLD.referencia_gestion_id
     OR NEW.created_at         IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Al revisar una gestión solo cambia su estado y la metadata de revisión';
  END IF;

  RETURN NEW;
END;
$$;


-- ── PASO 2) editar_venta_atomica, recolgando los punteros ─────────────────
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
  v_punteros      jsonb;
  v_recolgados    int := 0;
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

  -- ── A QUÉ CUOTA APUNTABA CADA EVENTO ────────────────────────────────────
  -- Se guarda el NÚMERO de cuota, no el id: los ids se van con el plan viejo.
  --
  -- Esto no estaba, y el comentario que había —«los eventos apuntados quedan
  -- con la referencia en NULL; la plata no se toca»— dejó de ser cierto en el
  -- script 075. Desde entonces un cobro de campo queda CLAVADO a su cuota, y
  -- perder el puntero saca esa plata de donde estaba y la manda a la cascada:
  -- el saldo no cambia, pero SÍ cambia qué cuotas figuran cubiertas y, con
  -- ellas, la mora. Hoy hay 129 préstamos con plata clavada.
  --
  -- Las cuotas EXTRA no se recuelgan: el cronograma nuevo no las tiene, así
  -- que su puntero se queda en NULL y esa plata vuelve a la cascada. Es lo
  -- único que se puede hacer cuando la cuota a la que apuntaba deja de
  -- existir.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('g', g.id, 'n', pp.numero_cuota)), '[]'::jsonb)
    INTO v_punteros
    FROM gestiones g
    JOIN payment_plan pp ON pp.id = g.cuota_objetivo
   WHERE g.loan_id = v_loan_id
     AND pp.es_extra = false;

  -- Regenerar el cronograma. El DELETE dispara el `ON DELETE SET NULL` del FK
  -- sobre `gestiones.cuota_objetivo`; el trigger de inmutabilidad lo permite
  -- porque lo único que cambia es ese puntero (ver PASO 1).
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

  -- ── VOLVER A COLGAR LOS PUNTEROS ────────────────────────────────────────
  -- Cada evento vuelve a la cuota con SU MISMO NÚMERO en el plan nuevo. Es lo
  -- que hace que cambiar el interés se comporte como se espera: la cuota 5
  -- cambia de valor, pero lo que el cliente pagó ese día sigue aplicado a la
  -- cuota 5. Sin esto, ese pago caía en cascada sobre las más viejas.
  --
  -- Si el plan nuevo tiene MENOS cuotas —se bajó el número de cuotas— los
  -- eventos que apuntaban más allá no encuentran a dónde volver y se quedan en
  -- NULL: esa plata pasa a la cascada, que es lo correcto cuando la cuota que
  -- señalaban ya no existe.
  IF jsonb_array_length(v_punteros) > 0 THEN
    WITH recolgados AS (
      UPDATE gestiones g
         SET cuota_objetivo = pp.id
        FROM jsonb_array_elements(v_punteros) e
        JOIN payment_plan pp
          ON pp.loan_id = v_loan_id
         AND pp.es_extra = false
         AND pp.numero_cuota = (e->>'n')::int
       WHERE g.id = (e->>'g')::uuid
      RETURNING 1
    )
    SELECT count(*) INTO v_recolgados FROM recolgados;
  END IF;

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
    'cuotas_totales', (v_recalc->>'cuotas_totales')::int,
    -- Cuántos pagos se quedaron en su cuota. Sirve para verificar desde la app
    -- que la edición no movió plata de sitio.
    'punteros_recolgados', v_recolgados,
    'punteros_previos', jsonb_array_length(v_punteros)
  );
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;



-- ── PASO 3) Permisos ──────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.editar_venta_atomica(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 4) La rendija es del ancho que se dijo (SOLO LECTURA) ────────────
-- Prueba en seco sobre una gestión aplicada de verdad. La primera fila simula
-- mover SOLO el puntero —tiene que dar `pasa = true`— y la segunda simula
-- mover el puntero Y el monto, que tiene que dar `pasa = false`.
--
-- No escribe nada: compara los jsonb igual que lo hace el trigger.
WITH una AS (
  SELECT to_jsonb(g) AS fila
    FROM public.gestiones g
   WHERE g.estado = 'aplicada' AND g.cuota_objetivo IS NOT NULL
   LIMIT 1
)
SELECT 'solo el puntero'                       AS caso,
       ((fila || '{"cuota_objetivo": null}'::jsonb) - 'cuota_objetivo')
         = (fila - 'cuota_objetivo')            AS pasa
  FROM una
UNION ALL
SELECT 'el puntero y el monto',
       ((fila || '{"cuota_objetivo": null, "monto": 1}'::jsonb) - 'cuota_objetivo')
         = (fila - 'cuota_objetivo')
  FROM una;


-- ── PASO 5) Cuántos préstamos estaban bloqueados (SOLO LECTURA) ───────────
-- Los que tienen al menos un evento aplicado apuntando a una cuota: son los
-- que hasta ahora rebotaban al regenerar el plan. Medido antes de este script:
-- 131 de 152 activos.
SELECT count(*) FILTER (WHERE l.estado = 'activo')  AS activos_bloqueados,
       count(*)                                     AS total_bloqueados
  FROM public.loans l
 WHERE EXISTS (
   SELECT 1 FROM public.gestiones g
    WHERE g.loan_id = l.id AND g.estado = 'aplicada' AND g.cuota_objetivo IS NOT NULL);


-- ── PASO 6) Ningún puntero quedó colgando (SOLO LECTURA) ──────────────────
-- Después de editar una venta, esta consulta tiene que seguir dando CERO: un
-- `cuota_objetivo` que no exista en `payment_plan` sería un puntero roto.
-- (El FK lo impide, pero comprobarlo cuesta nada y es la red de la red.)
SELECT count(*) AS punteros_rotos
  FROM public.gestiones g
 WHERE g.cuota_objetivo IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.payment_plan pp WHERE pp.id = g.cuota_objetivo);


-- ── PASO 7) La plata no se movió (SOLO LECTURA) ───────────────────────────
-- Correr ANTES y DESPUÉS de editar una venta, con su `loan_id`. `total_pagado`
-- tiene que dar EXACTAMENTE lo mismo: la edición cambia el cronograma, nunca
-- el dinero. Lo que sí puede cambiar es `cuotas_cubiertas`, y debe hacerlo
-- solo si el interés nuevo cambió el valor de las cuotas.
--
-- Reemplaza el id por el de la venta que vayas a editar.
SELECT f.loan_id, f.total_a_pagar, f.total_pagado, f.saldo,
       f.cuotas_cubiertas, f.cuotas_totales, f.cuotas_mora
  FROM public.v_loan_financiero f
 WHERE f.loan_id = '00000000-0000-0000-0000-000000000000';
