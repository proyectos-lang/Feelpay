-- ============================================================================
-- 111 - El 110 duplico cuotas: hay que deshacerlo
-- ============================================================================
-- ES UN ERROR MIO, Y ES DEL SCRIPT QUE SE ACABA DE CORRER.
--
-- El PASO 5 del 110 le completo el cronograma a 28 creditos. La cuenta de
-- cuanto faltaba estaba MAL: solo miraba lo programado DE HOY EN ADELANTE.
--
--     SELECT COALESCE(SUM(valor_cuota), 0) INTO v_por_delante
--       FROM payment_plan
--      WHERE loan_id = p_loan_id
--        AND fecha_pago >= v_hoy              <-- ACA ESTA EL ERROR
--        AND estado IN ('pendiente','parcial','no_pago');
--
-- Un cliente atrasado tiene cuotas SIN PAGAR con fecha VIEJA. Esas ya cubren
-- su deuda, pero como quedan antes de hoy, el filtro las ignoraba: la funcion
-- concluia que no habia nada programado y volvia a crear el cronograma entero.
--
-- EL CASO QUE LO DESTAPA (jenny condori carvajal, ruta 151)
--   pactado    1.950.000  =  20 cuotas de 97.500
--   pagado     1.170.000
--   saldo        780.000
--   sin pagar    877.500  en 9 cuotas VENCIDAS (24/08 al 10/09)
--
--   Sus 9 cuotas vencidas ya cubrian los 780.000. El 110 igual le creo 8
--   cuotas nuevas -> el cronograma paso a 28 cuotas / 2.730.000.
--
-- MEDIDO EN LOS 28 CREDITOS: en TODOS el cronograma quedo excedido por
-- EXACTAMENTE el saldo. 4.582.534 de cuotas duplicadas.
--
-- LO QUE **NO** PASO (comprobado antes de escribir esto)
--   * El SALDO de los clientes NO se movio: sigue sumando 4.582.534, el mismo
--     de antes. A NADIE SE LE COBRO DE MAS. `v_loan_financiero` deriva el
--     saldo del LIBRO (`gestiones`), no del cronograma, y el libro no se toco.
--   * No se perdio ningun pago: los eventos siguen todos ahi.
--   * `loans.valor_a_pagar` no se altero.
--
-- El daño esta contenido en `payment_plan`: hay cuotas de mas, y por eso el
-- DEBIDO COBRAR de los proximos dias sale inflado.
--
-- QUE HACE ESTE SCRIPT
--   PASO 2  Arregla `completar_cronograma` para que cuente TODO lo que falta
--           por pagar, sin importar la fecha. Asi el error no se repite.
--   PASO 3  Borra las cuotas sobrantes que el 110 creo.
--   PASO 5  Vuelve a completar el cronograma, ahora bien, a los que de
--           verdad lo necesiten.
--
-- POR QUE SE PUEDEN BORRAR CUOTAS QUE FIGURAN "PAGADAS"
-- ------------------------------------------------------
-- Porque `payment_plan.estado` y `monto_pagado` son un CACHE: los escribe
-- solo `recalcular_prestamo`. La plata de verdad vive en `gestiones`, que es
-- inmutable y no se toca aca. Al borrar una cuota el pago NO se borra: queda
-- en el libro y `recalcular_prestamo` lo vuelve a repartir sobre las cuotas
-- que queden, en orden. Por eso el saldo no se mueve ni un peso.
--
-- (A jenny el cobro de hoy se le habia asignado a la cuota #21, que era una
--  de las duplicadas. Al borrarla, esos 97.500 se reasignan a la cuota
--  vencida mas antigua que siga sin cubrir. El cliente pago lo mismo.)
--
-- Corre los pasos EN ORDEN. Los pasos 1, 4, 6 y 7 no escriben nada.
-- ============================================================================


-- ── PASO 1) El daño, antes de tocar nada (SOLO LECTURA) ──────────────────
-- Creditos activos cuyo cronograma suma MAS que el total pactado. Deberian
-- salir 28, y en cada uno `exceso` deberia ser igual al saldo.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo)          AS cliente,
       COALESCE(l.valor_a_pagar, l.valor)                       AS total_pactado,
       SUM(pp.valor_cuota)                                      AS suma_cronograma,
       SUM(pp.valor_cuota) - COALESCE(l.valor_a_pagar, l.valor) AS exceso,
       MAX(f.saldo)                                             AS saldo,
       COUNT(*)                                                 AS cuotas
  FROM public.loans l
  JOIN public.clients c            ON c.id = l.client_id
  JOIN public.payment_plan pp      ON pp.loan_id = l.id
  JOIN public.v_loan_financiero f  ON f.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, l.valor_a_pagar, l.valor
HAVING SUM(pp.valor_cuota) - COALESCE(l.valor_a_pagar, l.valor) > 1
 ORDER BY SUM(pp.valor_cuota) - COALESCE(l.valor_a_pagar, l.valor) DESC;


-- ── PASO 2) `completar_cronograma`, ahora con la cuenta bien ─────────────
-- El unico cambio de fondo: `v_por_delante` pasa a contar TODO lo que quedo
-- sin pagar, tenga la fecha que tenga. Una cuota vencida y sin pagar sigue
-- siendo una cuota por cobrar — que este atrasada no la hace desaparecer.
CREATE OR REPLACE FUNCTION public.completar_cronograma(p_loan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_loan        record;
  v_saldo       numeric;
  v_cuota_ref   numeric;
  v_ultima      date;
  v_num_max     int;
  v_sin_cubrir  numeric;
  v_falta       numeric;
  v_fecha       date;
  v_n           int := 0;
  v_valor       numeric;
  v_frec        text;
  v_hoy         date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  SELECT id, estado, frecuencia_pago, ruta, prestamo_empleado
    INTO v_loan
    FROM loans WHERE id = p_loan_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no existe');
  END IF;
  IF v_loan.estado <> 'activo' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no esta activo',
                              'estado', v_loan.estado);
  END IF;

  v_frec := CASE WHEN COALESCE(v_loan.prestamo_empleado, false) THEN 'daily'
                 ELSE v_loan.frecuencia_pago END;

  SELECT saldo INTO v_saldo FROM v_loan_financiero WHERE loan_id = p_loan_id;
  IF COALESCE(v_saldo, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'cuotas_creadas', 0, 'motivo', 'No debe nada');
  END IF;

  SELECT MAX(fecha_pago),
         MAX(numero_cuota),
         COALESCE(MAX(valor_cuota) FILTER (WHERE NOT es_extra), MAX(valor_cuota))
    INTO v_ultima, v_num_max, v_cuota_ref
    FROM payment_plan WHERE loan_id = p_loan_id;

  IF v_ultima IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no tiene cronograma');
  END IF;
  IF COALESCE(v_cuota_ref, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'No se pudo determinar el valor de la cuota');
  END IF;

  -- ── LA CORRECCION ──────────────────────────────────────────────────────
  -- TODO lo que quedo sin cubrir, con o sin fecha vencida. Antes esto tenia
  -- `AND fecha_pago >= v_hoy` y por eso duplicaba el cronograma de todo
  -- cliente atrasado: sus cuotas sin pagar son VIEJAS.
  --
  -- Se descuenta `monto_pagado` porque una cuota 'parcial' ya tiene plata
  -- encima: lo que falta de ella es la diferencia, no su valor entero.
  SELECT COALESCE(SUM(valor_cuota - COALESCE(monto_pagado, 0)), 0)
    INTO v_sin_cubrir
    FROM payment_plan
   WHERE loan_id = p_loan_id
     AND estado IN ('pendiente','parcial','no_pago');

  v_falta := v_saldo - v_sin_cubrir;
  IF v_falta <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'cuotas_creadas', 0,
      'motivo', 'El cronograma ya cubre el saldo',
      'saldo', v_saldo, 'sin_cubrir', v_sin_cubrir);
  END IF;

  -- Las cuotas nuevas arrancan el dia habil siguiente a la ultima del plan.
  -- Si esa fecha ya paso, se avanza hasta HOY: una cuota con fecha vieja
  -- nace vencida y le inventa mora al cliente.
  v_fecha := siguiente_fecha_cobro(v_ultima, v_frec);
  WHILE v_fecha < v_hoy LOOP
    v_fecha := siguiente_fecha_cobro(v_fecha, v_frec);
  END LOOP;

  WHILE v_falta > 0 LOOP
    v_valor   := LEAST(v_cuota_ref, v_falta);
    v_num_max := v_num_max + 1;
    v_n       := v_n + 1;

    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    ) VALUES (
      p_loan_id, v_num_max, v_fecha, v_valor, v_valor, 0,
      0, 'pendiente', v_loan.ruta, true
    );

    v_falta := v_falta - v_valor;
    v_fecha := siguiente_fecha_cobro(v_fecha, v_frec);

    IF v_n > 400 THEN
      RAISE EXCEPTION 'completar_cronograma: mas de 400 cuotas para el prestamo %; revise el valor de la cuota', p_loan_id;
    END IF;
  END LOOP;

  PERFORM recalcular_prestamo(p_loan_id);

  RETURN jsonb_build_object('ok', true, 'cuotas_creadas', v_n,
    'saldo', v_saldo, 'sin_cubrir', v_sin_cubrir, 'desde', v_fecha);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.completar_cronograma(uuid) TO anon, authenticated;


-- ── PASO 3) Borrar las cuotas que el 110 creo de mas ─────────────────────
-- Se quitan de la MAS NUEVA hacia atras hasta que el cronograma vuelva a
-- sumar el total pactado. Solo se borran cuotas con fecha DE HOY EN ADELANTE:
-- las vencidas son el historial de lo que se dejo de pagar y no se tocan.
--
-- Que una de ellas figure 'pagado' no importa: es cache. El pago vive en
-- `gestiones`, no se borra, y `recalcular_prestamo` lo reasigna al final.
DO $fix$
DECLARE
  r         record;
  v_exceso  numeric;
  v_borradas int;
  v_tot_c   int := 0;
  v_tot_p   numeric := 0;
  v_valor_borrado numeric;
  v_hoy     date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  FOR r IN
    SELECT l.id,
           l.ruta,
           COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
           SUM(pp.valor_cuota) - COALESCE(l.valor_a_pagar, l.valor) AS exceso
      FROM public.loans l
      JOIN public.clients c       ON c.id = l.client_id
      JOIN public.payment_plan pp ON pp.loan_id = l.id
     WHERE l.estado = 'activo'
     GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, l.valor_a_pagar, l.valor
    HAVING SUM(pp.valor_cuota) - COALESCE(l.valor_a_pagar, l.valor) > 1
  LOOP
    v_exceso := r.exceso;
    v_borradas := 0;

    -- Se van quitando las mas nuevas mientras siga sobrando plata.
    WHILE v_exceso > 1 LOOP
      -- Se borra UNA: la mas nueva de hoy en adelante. El subquery elige el
      -- id y el RETURNING devuelve su valor, que es lo que descuenta del
      -- exceso. Un `DELETE ... USING` con RETURNING sobre el alias del CTE
      -- no es portable; asi es literal y no hay ambiguedad.
      v_valor_borrado := NULL;

      DELETE FROM public.payment_plan
       WHERE id = (
         SELECT id
           FROM public.payment_plan
          WHERE loan_id = r.id
            AND fecha_pago >= v_hoy
          ORDER BY fecha_pago DESC, numero_cuota DESC
          LIMIT 1
       )
      RETURNING valor_cuota INTO v_valor_borrado;

      IF v_valor_borrado IS NULL THEN
        RAISE NOTICE 'ruta % · % · quedaron % sin poder quitar (no hay mas cuotas futuras)',
          r.ruta, r.cliente, v_exceso;
        EXIT;
      END IF;

      v_exceso   := v_exceso - v_valor_borrado;
      v_borradas := v_borradas + 1;
      v_tot_p    := v_tot_p + v_valor_borrado;

      IF v_borradas > 400 THEN
        RAISE EXCEPTION 'Mas de 400 borrados en el prestamo %; pare y revise', r.id;
      END IF;
    END LOOP;

    v_tot_c := v_tot_c + v_borradas;
    PERFORM public.recalcular_prestamo(r.id);
    RAISE NOTICE 'ruta % · % · % cuotas quitadas', r.ruta, r.cliente, v_borradas;
  END LOOP;

  RAISE NOTICE '---';
  RAISE NOTICE 'Cuotas duplicadas eliminadas: %  ·  valor: %', v_tot_c, v_tot_p;
END
$fix$;


-- ── PASO 4) Que el cronograma volvio a cuadrar (SOLO LECTURA) ────────────
-- Tiene que salir VACIO (o solo con descuadres que YA existian antes del 110,
-- que son negativos: cronograma MENOR que el pactado).
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo)          AS cliente,
       COALESCE(l.valor_a_pagar, l.valor)                       AS total_pactado,
       SUM(pp.valor_cuota)                                      AS suma_cronograma,
       SUM(pp.valor_cuota) - COALESCE(l.valor_a_pagar, l.valor) AS exceso
  FROM public.loans l
  JOIN public.clients c       ON c.id = l.client_id
  JOIN public.payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, l.valor_a_pagar, l.valor
HAVING SUM(pp.valor_cuota) - COALESCE(l.valor_a_pagar, l.valor) > 1
 ORDER BY 5 DESC;


-- ── PASO 5) Completar, ahora bien, al que de verdad le falte ─────────────
-- Con la funcion corregida. A los 28 de antes NO deberia tocarles nada: se
-- simulo y a los 28 les da CERO cuotas nuevas, porque sus cuotas vencidas ya
-- cubren el saldo. Si a alguno le crea cuotas, es porque de verdad le faltaban.
--
-- LO QUE HAY QUE SABER DESPUES DE CORRER ESTO
-- --------------------------------------------
-- Esos 28 clientes quedan otra vez SIN cuotas de hoy en adelante, y por lo
-- tanto FUERA del debido cobrar de hoy. No es que falten: es que su deuda
-- esta en cuotas VENCIDAS, y la meta del dia D suma las cuotas con
-- `fecha_pago = D`. Una cuota que vencio el 24/08 y sigue sin pagar aporta a
-- la meta del 24/08, no a la de hoy.
--
-- Eso es correcto contablemente —el cliente no debe mas de lo pactado, esta
-- ATRASADO— pero significa que el cobrador lo visita sin que figure en el
-- objetivo del dia. Es una decision aparte, y se dejo tomada asi a
-- proposito: el cronograma dice la verdad, y no se reescribe la historia de
-- la mora para que un numero se vea mejor.
DO $fix2$
DECLARE
  r       record;
  v_res   jsonb;
  v_tot   int := 0;
BEGIN
  FOR r IN
    SELECT l.id, l.ruta, COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente
      FROM public.loans l
      JOIN public.clients c            ON c.id = l.client_id
      JOIN public.v_loan_financiero f  ON f.loan_id = l.id
     WHERE l.estado = 'activo'
       AND f.saldo > 0
     ORDER BY l.ruta
  LOOP
    v_res := public.completar_cronograma(r.id);
    IF COALESCE((v_res->>'cuotas_creadas')::int, 0) > 0 THEN
      v_tot := v_tot + 1;
      RAISE NOTICE 'ruta % · % · % cuotas nuevas desde %',
        r.ruta, r.cliente, v_res->>'cuotas_creadas', v_res->>'desde';
    END IF;
  END LOOP;
  RAISE NOTICE 'Creditos a los que de verdad les faltaba cronograma: %', v_tot;
END
$fix2$;


-- ── PASO 6) Que los saldos NO se movieron (SOLO LECTURA) ─────────────────
-- LA COMPROBACION QUE MAS IMPORTA. La suma de los saldos de los creditos
-- activos tiene que ser la MISMA de antes de todo esto. Si cambia, se perdio
-- o se invento plata y hay que parar.
--
--   Antes del 110 y despues del 110:  4.582.534  (en los 28 tocados)
--
-- Aca se mide la cartera entera, que es lo que de verdad no puede moverse.
SELECT COUNT(*)          AS creditos_activos,
       SUM(f.saldo)      AS saldo_total,
       SUM(f.total_pagado) AS pagado_total
  FROM public.loans l
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
 WHERE l.estado = 'activo';


-- ── PASO 7) El debido cobrar de hoy, ya sin inflar (SOLO LECTURA) ────────
SELECT ruta, fecha_pago, meta_pagos, valor_pago
  FROM public.resumen_diario_v2
 WHERE fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY ruta;
