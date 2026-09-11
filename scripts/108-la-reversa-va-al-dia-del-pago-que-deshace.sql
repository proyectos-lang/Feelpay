-- ============================================================================
-- 108 - Dos reversas quedaron en el dia equivocado (ruta 151)
-- ============================================================================
-- LO QUE SE REPORTO
-- "La ruta 151 hoy da un recaudo de -136.500. Hoy se hizo una reversa de un
--  abono de ayer pero al parecer esta haciendo la reversa para el dia de hoy."
--
-- EXACTAMENTE ESO. El 11/09 se deshicieron dos pagos del 10/09 y las reversas
-- quedaron fechadas HOY:
--
--   reversa $65.000  (11/09)  ->  deshace un pago de Jenny bodega       del 10/09
--   reversa $97.500  (11/09)  ->  deshace un pago de jenny condori      del 10/09
--
-- Una reversa no es plata nueva: es la MISMA plata saliendo de donde entro.
-- Fechandola hoy, el 10 se queda contando un cobro que ya no existe y el 11
-- amanece en negativo. La cuenta cuadra al peso:
--
--   -65.000 -97.500 +500 -500 +13.000 +13.000 = -136.500
--
-- LA CAUSA YA ESTA ARREGLADA EN LA APP: `register-payment` fechaba la reversa
-- —y el evento que la reemplaza— con el dia de trabajo en vez del dia de la
-- gestion que deshacen. De aqui en adelante caen solas en el dia correcto.
-- Este script arregla lo que YA quedo escrito.
--
-- POR QUE NO SE EDITAN LAS DOS FILAS
-- -----------------------------------
-- Porque el libro es INMUTABLE a proposito: `trg_gestiones_inmutables` (script
-- 042) prohibe cambiar `fecha_gestion`, y con razon — si las fechas del libro
-- se pudieran mover, ningun dia cerrado significaria nada.
--
-- Asi que se corrige como manda la casa: con eventos NUEVOS que compensan.
-- Por cada reversa mal fechada se escriben dos:
--
--   un `pago`    de +$X el 11/09  -> le devuelve al 11 la plata que le quitaron
--   una `reversa` de -$X el 10/09 -> se la quita al 10, que es de donde salio
--
-- El neto de los dos es CERO: no se crea ni se destruye un peso. Lo unico que
-- cambia es en que dia aparece cada uno.
--
-- COMO QUEDA, medido antes de escribir nada:
--
--   dia      antes         despues
--   10/09    1.045.700     883.200
--   11/09     -136.500      26.000
--
--   Jenny bodega            10/09 130.000 -> 65.000   11/09 -65.000 -> 0
--   jenny condori carvajal  10/09  97.500 ->      0   11/09 -97.500 -> 0
--
-- OJO: EL 10 YA ESTA CERRADO. Su recaudo baja 162.500, que es justo lo que
-- sobraba: esos dos pagos se deshicieron y el dia los seguia contando. El
-- cierre del 10 va a mostrar otra cifra que cuando se firmo, y esa cifra es
-- la correcta.
--
-- QUE NO CAMBIA
--   * El SALDO de los dos clientes: la plata ya se les habia descontado bien.
--     Estos eventos se anulan entre si, asi que el saldo no se mueve un peso.
--   * Las gestiones viejas: no se borra ni se edita ninguna.
--   * El conteo de visitas: los eventos nuevos son correcciones de plata, no
--     visitas. `cantidad_pagos` cuenta CLIENTES con neto positivo en el dia, y
--     eso se recalcula solo.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 2 no escriben nada.
-- ============================================================================


-- -- PASO 1) Lo que hay hoy (SOLO LECTURA, no cambia nada) -------------------
-- Guarde estos dos numeros: son contra los que se compara al final.
SELECT fecha_pago, valor_pago, cantidad_pagos, efectivo
  FROM public.resumen_diario_v2
 WHERE ruta = 151 AND fecha_pago IN (DATE '2026-09-10', DATE '2026-09-11')
 ORDER BY fecha_pago;


-- -- PASO 2) Las reversas mal fechadas (SOLO LECTURA) ------------------------
-- Tienen que salir DOS filas: $65.000 y $97.500, las dos con la reversa el 11
-- y el original el 10. Si sale otra cosa, PARE y revise antes de seguir.
SELECT r.id            AS reversa_id,
       r.monto,
       r.fecha_gestion AS dia_de_la_reversa,
       o.fecha_gestion AS dia_del_original,
       o.tipo          AS tipo_original,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente
  FROM public.gestiones r
  JOIN public.gestiones o ON o.id = r.referencia_gestion_id
  JOIN public.loans l     ON l.id = r.loan_id
  JOIN public.clients c   ON c.id = l.client_id
 WHERE r.ruta = 151
   AND r.tipo = 'reversa'
   AND r.estado = 'aplicada'
   AND r.fecha_gestion = DATE '2026-09-11'
   AND o.fecha_gestion < r.fecha_gestion
 ORDER BY r.monto DESC;


-- -- PASO 3) Mover la plata al dia que le corresponde -------------------------
-- Por cada reversa mal fechada: un pago que le devuelve al 11 lo que le
-- quitaron, y una reversa que se lo quita al 10. Netean CERO.
--
-- `origen = 'ajuste'` los marca como lo que son —una correccion de escritorio,
-- no una visita— y los deja fuera de `neto_de_calle`, que solo mira 'campo'.
DO $$
DECLARE
  r        record;
  v_n      int := 0;
  v_total  numeric := 0;
BEGIN
  FOR r IN
    SELECT rev.id, rev.loan_id, rev.client_id, rev.ruta, rev.user_id, rev.monto,
           rev.fecha_gestion AS dia_malo,
           ori.fecha_gestion AS dia_bueno
      FROM public.gestiones rev
      JOIN public.gestiones ori ON ori.id = rev.referencia_gestion_id
     WHERE rev.ruta = 151
       AND rev.tipo = 'reversa'
       AND rev.estado = 'aplicada'
       AND rev.fecha_gestion = DATE '2026-09-11'
       AND ori.fecha_gestion < rev.fecha_gestion
  LOOP
    -- 1) Al 11 se le DEVUELVE la plata que no era suya.
    INSERT INTO public.gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, fecha_hora, origen, observacion
    ) VALUES (
      gen_random_uuid(), r.loan_id, r.client_id, r.ruta, r.user_id,
      'pago', 'aplicada', r.dia_malo, r.monto, NOW(), 'ajuste',
      'Ajuste 108: la reversa de $' || r.monto || ' era del ' || r.dia_bueno ||
      ', no de este dia. Se devuelve aca y se descuenta alla.'
    );

    -- 2) Y al 10 se le QUITA, que es de donde habia salido.
    INSERT INTO public.gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, fecha_hora, origen, observacion
    ) VALUES (
      gen_random_uuid(), r.loan_id, r.client_id, r.ruta, r.user_id,
      'reversa', 'aplicada', r.dia_bueno, r.monto, NOW(), 'ajuste',
      'Ajuste 108: traslado de la reversa ' || r.id || ' que quedo fechada el ' ||
      r.dia_malo || '. El pago original era de este dia.'
    );

    v_n := v_n + 1;
    v_total := v_total + r.monto;
    RAISE NOTICE 'Movido $% del % al %', r.monto, r.dia_malo, r.dia_bueno;
  END LOOP;

  IF v_n = 0 THEN
    RAISE NOTICE 'No habia nada que mover: puede que el script ya se haya corrido.';
  ELSE
    RAISE NOTICE 'Reversas trasladadas: % · total movido: $%', v_n, v_total;
  END IF;
END $$;


-- -- PASO 4) Verificacion (SOLO LECTURA) --------------------------------------
-- Compare con el PASO 1. Tiene que dar:
--
--   10/09    883.200
--   11/09     26.000
--
-- Y `efectivo` del 11 NO se mueve: la plata sigue siendo la misma, solo
-- cambio de dia. Lo que cambia es la caja del 10.
SELECT fecha_pago, valor_pago, cantidad_pagos, efectivo
  FROM public.resumen_diario_v2
 WHERE ruta = 151 AND fecha_pago IN (DATE '2026-09-10', DATE '2026-09-11')
 ORDER BY fecha_pago;


-- -- PASO 5) Que no se creo ni se destruyo plata (SOLO LECTURA) --------------
-- La suma de los dos dias tiene que ser la MISMA de antes: 909.200.
-- Si cambia, el traslado no neteo y hay que revisar.
SELECT SUM(valor_pago) AS suma_de_los_dos_dias
  FROM public.resumen_diario_v2
 WHERE ruta = 151 AND fecha_pago IN (DATE '2026-09-10', DATE '2026-09-11');


-- -- PASO 6) Que el saldo de los clientes NO se movio (SOLO LECTURA) ---------
-- Los dos eventos nuevos se anulan entre si, asi que cada cliente debe seguir
-- debiendo exactamente lo mismo. `saldo` sale de `v_loan_financiero`, que suma
-- TODO el libro sin mirar fechas.
SELECT COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       f.total_pagado,
       f.saldo
  FROM public.gestiones g
  JOIN public.loans l              ON l.id = g.loan_id
  JOIN public.clients c            ON c.id = l.client_id
  JOIN public.v_loan_financiero f  ON f.loan_id = l.id
 WHERE g.origen = 'ajuste'
   AND g.observacion LIKE 'Ajuste 108:%'
 GROUP BY c.apodo, c.nombre_completo, f.total_pagado, f.saldo;
