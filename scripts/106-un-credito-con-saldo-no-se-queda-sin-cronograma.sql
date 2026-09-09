-- ============================================================================
-- 106 - Un credito con saldo no se queda sin cronograma
-- ============================================================================
-- EL PROBLEMA DE FONDO
-- "Cuando se terminaron las cuotas necesito que si a una cuota se le vencen
--  los dias de pago salga la alerta para extenderle, o que en el monitoreo de
--  la secretaria salga ese aviso para hacer la extension."
--
-- COMO APARECIO. Revisando la meta de la ruta 151: mostraba 853.500 y el
-- usuario esperaba ~907.000. La diferencia son TRES clientes que deben plata
-- pero cuyo cronograma ya se acabo:
--
--   sonia ropa galeria   saldo  86.500   ultima cuota del plan 07/09
--   francisca ropa       saldo 115.000   ultima cuota del plan 02/09
--   veronica cafe        saldo  51.000   ultima cuota del plan 02/09
--
-- A los tres se les sigue cobrando —sonia pago 20.000 el 08, francisca 20.000
-- el 05— pero como la meta solo suma las cuotas que vencen ESE dia, y ellos
-- no tienen ninguna por delante, aportan CERO. El cobrador cobra plata que
-- nunca estuvo en el objetivo.
--
-- MEDIDO EN TODA LA CARTERA: 8 creditos en 3 rutas, 160.081 en cuotas que no
-- entran en ninguna meta.
--
--   ruta 151   3 creditos    52.000
--   ruta 190   4 creditos   108.077
--   ruta 933   1 credito          4
--
-- POR QUE NO SIRVE LA EXTENSION QUE YA EXISTE
-- --------------------------------------------
-- `registrar_gestion` ya sabe extender, pero SOLO para creditos 'americano',
-- y su extension AGREGA INTERES: cada periodo nuevo sube `valor_a_pagar`.
-- Eso es correcto para una prorroga —el cliente pidio mas plazo y lo paga—
-- pero estos tres son 'aleman' y no deben un peso mas: deben exactamente lo
-- que falta del total pactado. Cobrarles interes por ir atrasados seria
-- inventarles una deuda.
--
-- LA FUNCION NUEVA: `completar_cronograma`
-- -----------------------------------------
-- Reparte el SALDO QUE YA EXISTE en cuotas nuevas, del mismo valor que las
-- del plan, a partir del dia siguiente a la ultima. NO toca `valor_a_pagar`,
-- NO agrega interes, NO cambia el total pactado: solo escribe las fechas que
-- faltaban para poder cobrar lo que ya se debe.
--
--   saldo 86.500, cuota 19.500  ->  5 cuotas (la ultima de 8.500)
--
-- Es idempotente: si el credito ya tiene cuotas por delante que cubren el
-- saldo, no hace nada y lo dice.
--
-- QUE NO HACE
--   * No inventa deuda: la suma de las cuotas nuevas es exactamente el saldo.
--   * No toca `loans.valor_a_pagar` ni `valor`.
--   * No escribe en el libro de eventos: no es un movimiento de plata, es el
--     cronograma que estaba incompleto.
--   * No toca creditos cancelados ni los que ya tienen plan por delante.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 2 no escriben nada.
-- ============================================================================


-- -- PASO 1) Quien esta asi hoy (SOLO LECTURA) --------------------------------
-- Creditos activos, con saldo, cuya ultima cuota del plan ya paso.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       f.saldo,
       MAX(pp.fecha_pago)                              AS ultima_cuota,
       MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra) AS cuota_ref,
       CEIL(f.saldo / NULLIF(MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra), 0)) AS cuotas_faltantes
  FROM public.loans l
  JOIN public.clients c            ON c.id = l.client_id
  JOIN public.v_loan_financiero f  ON f.loan_id = l.id
  JOIN public.payment_plan pp      ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
   AND f.saldo > 0
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, f.saldo
HAVING MAX(pp.fecha_pago) < (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY l.ruta, f.saldo DESC;


-- -- PASO 2) La funcion ------------------------------------------------------
-- Completa el cronograma de UN credito repartiendo su saldo actual. Devuelve
-- cuantas cuotas escribio (0 si no hacia falta).
CREATE OR REPLACE FUNCTION public.completar_cronograma(p_loan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_loan        record;
  v_saldo       numeric;
  v_cuota_ref   numeric;
  v_ultima      date;
  v_num_max     int;
  v_por_delante numeric;
  v_falta       numeric;
  v_fecha       date;
  v_n           int := 0;
  v_valor       numeric;
BEGIN
  SELECT id, estado, frecuencia_pago, ruta
    INTO v_loan
    FROM loans WHERE id = p_loan_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no existe');
  END IF;
  IF v_loan.estado <> 'activo' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no esta activo', 'estado', v_loan.estado);
  END IF;

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

  -- Lo que YA esta programado de hoy en adelante. Si eso cubre el saldo, el
  -- cronograma esta completo y no hay nada que hacer: la funcion es
  -- idempotente y correrla dos veces no duplica cuotas.
  SELECT COALESCE(SUM(valor_cuota), 0) INTO v_por_delante
    FROM payment_plan
   WHERE loan_id = p_loan_id
     AND fecha_pago >= (now() AT TIME ZONE 'America/Bogota')::date
     AND estado IN ('pendiente','parcial','no_pago');

  v_falta := v_saldo - v_por_delante;
  IF v_falta <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'cuotas_creadas', 0,
      'motivo', 'El cronograma ya cubre el saldo', 'saldo', v_saldo, 'programado', v_por_delante);
  END IF;

  -- Las cuotas nuevas arrancan el dia habil siguiente a la ultima del plan.
  -- Si esa fecha ya paso, se sigue avanzando hasta HOY: las cuotas se ponen
  -- de hoy en adelante, no en el pasado — una cuota con fecha vieja nace
  -- vencida y le inventa mora al cliente.
  v_fecha := siguiente_fecha_cobro(v_ultima, v_loan.frecuencia_pago);
  WHILE v_fecha < (now() AT TIME ZONE 'America/Bogota')::date LOOP
    v_fecha := siguiente_fecha_cobro(v_fecha, v_loan.frecuencia_pago);
  END LOOP;

  WHILE v_falta > 0 LOOP
    -- La ultima cuota lleva el resto exacto: la suma de lo que se crea es
    -- IGUAL al saldo, ni un peso mas.
    v_valor  := LEAST(v_cuota_ref, v_falta);
    v_num_max := v_num_max + 1;
    v_n := v_n + 1;

    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    ) VALUES (
      p_loan_id, v_num_max, v_fecha, v_valor, v_valor, 0,
      0, 'pendiente', v_loan.ruta, false
    );

    v_falta := v_falta - v_valor;
    v_fecha := siguiente_fecha_cobro(v_fecha, v_loan.frecuencia_pago);

    IF v_n > 400 THEN
      RAISE EXCEPTION 'completar_cronograma: mas de 400 cuotas para el prestamo %; revise el valor de la cuota', p_loan_id;
    END IF;
  END LOOP;

  -- El cache derivado se rehace: `payment_plan.estado`/`monto_pagado` y
  -- `loans.saldo` los escribe SOLO esta funcion, nunca la app.
  PERFORM recalcular_prestamo(p_loan_id);

  RETURN jsonb_build_object('ok', true, 'cuotas_creadas', v_n,
    'saldo', v_saldo, 'cuota_ref', v_cuota_ref, 'desde', v_fecha);
END;
$$;

GRANT EXECUTE ON FUNCTION public.completar_cronograma(uuid) TO anon, authenticated;


-- -- PASO 3) Arreglar los que estan asi HOY -----------------------------------
-- Le completa el cronograma a todo credito activo con saldo cuya ultima cuota
-- ya paso. Es el arreglo puntual que se pidio ("hagamosle las extensiones
-- hasta el dia de hoy"); de aqui en adelante la app avisa antes de que pase.
DO $$
DECLARE
  r        record;
  v_res    jsonb;
  v_total  int := 0;
BEGIN
  FOR r IN
    SELECT l.id, l.ruta
      FROM public.loans l
      JOIN public.v_loan_financiero f ON f.loan_id = l.id
     WHERE l.estado = 'activo'
       AND f.saldo > 0
       AND (SELECT MAX(pp.fecha_pago) FROM public.payment_plan pp WHERE pp.loan_id = l.id)
           < (now() AT TIME ZONE 'America/Bogota')::date
  LOOP
    v_res := public.completar_cronograma(r.id);
    IF (v_res->>'cuotas_creadas')::int > 0 THEN
      v_total := v_total + 1;
      RAISE NOTICE 'ruta % · prestamo % · % cuotas nuevas', r.ruta, r.id, v_res->>'cuotas_creadas';
    END IF;
  END LOOP;
  RAISE NOTICE 'Cronogramas completados: %', v_total;
END $$;


-- -- PASO 4) Verificacion (SOLO LECTURA) --------------------------------------
-- El PASO 1 tiene que salir VACIO ahora: ningun credito activo con saldo
-- deberia quedar sin cuotas por delante.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       f.saldo,
       MAX(pp.fecha_pago) AS ultima_cuota
  FROM public.loans l
  JOIN public.clients c            ON c.id = l.client_id
  JOIN public.v_loan_financiero f  ON f.loan_id = l.id
  JOIN public.payment_plan pp      ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
   AND f.saldo > 0
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, f.saldo
HAVING MAX(pp.fecha_pago) < (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY l.ruta;


-- -- PASO 5) Que no se invento deuda (SOLO LECTURA) --------------------------
-- Para cada credito tocado, la suma del cronograma tiene que seguir siendo
-- igual a `valor_a_pagar`. Si alguna fila sale con diferencia, algo se rompio.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo)  AS cliente,
       COALESCE(l.valor_a_pagar, l.valor)               AS total_pactado,
       SUM(pp.valor_cuota)                              AS suma_cronograma,
       COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota) AS diferencia
  FROM public.loans l
  JOIN public.clients c       ON c.id = l.client_id
  JOIN public.payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, l.valor_a_pagar, l.valor
HAVING ABS(COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota)) > 1
 ORDER BY ABS(COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota)) DESC
 LIMIT 20;
