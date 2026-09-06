-- ============================================================================
-- 100 - La cuota del dia no es mora todavia
-- ============================================================================
-- LO QUE SE PIDIO
-- "Si tengo un cliente que solo debe la cuota del dia actual entonces no
--  deberia marcar como mora, y actualmente me da que tiene 1 dia de mora."
--
-- LO QUE SE MIDIO ANTES DE TOCAR NADA
-- ------------------------------------
-- El corte que habia era `pp.fecha_pago < hoy`, o sea que la cuota de HOY ya
-- estaba excluida. Entonces el caso reportado no podia ser el de hoy... y no
-- lo era: el dia que se reporto era DOMINGO, y ninguna ruta tiene cuotas los
-- domingos. Medido en la cartera:
--
--   2026-09-06  domingo      0 cuotas vencen
--   2026-09-05  sabado     174
--   2026-09-04  viernes    171
--   2026-08-30  domingo      0 cuotas vencen
--
-- Asi que "la cuota del dia actual" era la de AYER: la ultima que se genero,
-- que el cobrador todavia no ha ido a cobrar. Y esa si contaba como mora.
--
-- LA REGLA NUEVA, EN UNA LINEA
-- -----------------------------
--   Una cuota entra en mora al dia SIGUIENTE de su vencimiento.
--
-- Mientras el dia del vencimiento no haya terminado, el cobrador todavia
-- puede pasar. Contar como moroso a quien aun no ha recibido la visita es
-- cobrarle un atraso que no ha tenido tiempo de cometer.
--
-- Es UN dia corrido, no "un dia habil". Se penso lo segundo y complica sin
-- pagar: habria que definir el calendario de cada ruta, y el domingo ya sale
-- gratis solo (si no hay cuota, no hay nada que contar).
--
-- LO QUE VA A CAMBIAR, MEDIDO CONTRA LA BASE
-- -------------------------------------------
--   creditos activos revisados : 174
--   suma de cuotas en mora     : 608 -> 531
--   creditos que cambian       :  77
--        de "Mora: 1" a "Al dia"          20
--        bajan una (2->1, 3->2, ...)      57
--   por ruta: 933:32  190:14  1:11  151:10  197:5  154:4  196:1
--
-- NADIE SUBE DE MORA. La regla solo afloja, y por una cuota.
--
-- LA MULTA VA CON LA MISMA REGLA
-- -------------------------------
-- `debe_generar_multa` contaba las fallas con el mismo `pp.fecha_pago < hoy`.
-- Si se cambiaba solo la vista, un cliente podia verse "Al dia" en la ruta y
-- recibir multa por esa misma cuota. Se mueven las dos juntas: una sola
-- definicion de "vencido" en todo el sistema.
--
-- QUE NO SE TOCA
-- ---------------
--   * `interes_causado` sigue con `<= hoy`: el interes se causa el dia del
--     vencimiento, no un dia despues. Es otra cosa y no cambia.
--   * el reparto de la plata (v_cobertura_cuotas), el saldo y el X/Y.
--   * `payment_plan.estado`: una cuota de ayer sin pagar sigue 'pendiente'.
--     Lo que cambia es si esa cuota CUENTA COMO MORA, no su estado.
--
-- COMO CORRERLO: un paso a la vez, en orden. El PASO 1 no escribe nada.
-- ============================================================================


-- -- PASO 1) Lo que hay hoy (SOLO LECTURA, no cambia nada) -------------------
-- Guarde este resultado: es contra el que se compara al final.
SELECT COUNT(*)                                AS creditos_con_mora,
       SUM(cuotas_mora)                        AS suma_cuotas_mora,
       COUNT(*) FILTER (WHERE cuotas_mora = 1) AS con_una_cuota
  FROM public.v_loan_financiero
 WHERE loan_estado = 'activo' AND cuotas_mora > 0;


-- -- PASO 2) La vista, con el dia de gracia ----------------------------------
-- Es la definicion del 084 con UNA linea cambiada: el corte de
-- `total_vencido` pasa de "hoy" a "ayer". El resto va letra por letra.
CREATE OR REPLACE VIEW public.v_loan_financiero AS
SELECT l.id  AS loan_id,
      l.client_id,
      l.ruta,
      l.estado AS loan_estado,
      l.tipo_amortizacion,
      COALESCE(l.valor_a_pagar, l.valor)                                  AS total_a_pagar,
      COALESCE(n.pagado_neto, 0)                                          AS total_pagado,
      GREATEST(0, COALESCE(l.valor_a_pagar, l.valor)
                  - COALESCE(n.pagado_neto, 0))                           AS saldo,
      GREATEST(0, CASE WHEN l.tipo_amortizacion = 'americano'
                        THEN l.valor + COALESCE(ints.interes_causado, 0)
                            - COALESCE(n.pagado_neto, 0)
                        ELSE COALESCE(l.valor_a_pagar, l.valor)
                            - COALESCE(n.pagado_neto, 0) END)             AS saldo_hoy,
      GREATEST(0, COALESCE(venc.total_vencido, 0)
                  - COALESCE(n.pagado_neto, 0))                           AS saldo_en_mora,
      CASE WHEN COALESCE(venc.total_vencido, 0) - COALESCE(n.pagado_neto, 0) > 0
            THEN CEIL((venc.total_vencido - COALESCE(n.pagado_neto, 0))
                      / NULLIF(cref.valor_ref, 0))
            ELSE 0 END                                                     AS cuotas_mora,
      n.fecha_ultimo_pago,
      LEAST(COALESCE(cob.totales, 0),
            FLOOR(COALESCE(n.pagado_neto, 0)
                  / NULLIF(cref.valor_ref, 0)))::bigint                     AS cuotas_cubiertas,
      COALESCE(cob.totales, 0)                                            AS cuotas_totales,
      COALESCE(cob.extras, 0)                                             AS cuotas_extra
  FROM public.loans l
  LEFT JOIN public.v_pagos_netos n ON n.loan_id = l.id
  LEFT JOIN LATERAL (
    -- EL DIA DE GRACIA VIVE ACA, Y SOLO ACA.
    -- Antes: `pp.fecha_pago < hoy` - la cuota de ayer ya era mora.
    -- Ahora: `< hoy - 1` - entra en mora pasado su dia de vencimiento.
    SELECT COALESCE(SUM(pp.valor_cuota), 0) AS total_vencido
      FROM public.payment_plan pp
    WHERE pp.loan_id = l.id
      AND pp.fecha_pago < ((now() AT TIME ZONE 'America/Bogota')::date - 1)
  ) venc ON true
  LEFT JOIN LATERAL (
    -- El interes NO lleva gracia: se causa el dia del vencimiento. Queda con
    -- su `<=` de siempre.
    SELECT COALESCE(SUM(pp.interes), 0) AS interes_causado
      FROM public.payment_plan pp
    WHERE pp.loan_id = l.id
      AND pp.fecha_pago <= (now() AT TIME ZONE 'America/Bogota')::date
  ) ints ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra),
                    MAX(pp.valor_cuota)) AS valor_ref
      FROM public.payment_plan pp
    WHERE pp.loan_id = l.id
  ) cref ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE c.estado_derivado IN ('pagado','cancelada')
                              AND NOT c.es_extra)          AS cubiertas,
          COUNT(*) FILTER (WHERE NOT c.es_extra)          AS totales,
          COUNT(*) FILTER (WHERE c.es_extra)              AS extras
      FROM public.v_cobertura_cuotas c
    WHERE c.loan_id = l.id
  ) cob ON true;


-- -- PASO 3) La multa, con el mismo corte ------------------------------------
-- Se parchea la definicion VIVA en vez de reescribir la funcion entera: asi
-- lo que no es la mora se queda exactamente como esta, sin que este script
-- tenga que repetir 80 lineas que no le corresponden.
--
-- El ancla se busca por lo que HACE (el corte de las cuotas pendientes) y no
-- por un texto literal con espacios, que es como se rompio el script 090.
DO $$
DECLARE
  v_src  text;
  v_new  text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'debe_generar_multa';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.debe_generar_multa: corra antes el script 047';
  END IF;

  -- La linea a cambiar es la del conteo de cuotas pendientes vencidas.
  v_new := regexp_replace(v_src,
             'pp\.fecha_pago\s*<\s*v_hoy',
             'pp.fecha_pago < (v_hoy - 1)',
             'g');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'No se encontro el corte de cuotas vencidas en debe_generar_multa: revise a mano antes de seguir';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'debe_generar_multa: el corte de cuotas vencidas ahora lleva un dia de gracia';
END $$;


-- -- PASO 4) Verificacion (SOLO LECTURA) -------------------------------------
-- Compare con el PASO 1: la suma tiene que BAJAR y ningun credito subir.
SELECT COUNT(*)                                AS creditos_con_mora,
       SUM(cuotas_mora)                        AS suma_cuotas_mora,
       COUNT(*) FILTER (WHERE cuotas_mora = 1) AS con_una_cuota
  FROM public.v_loan_financiero
 WHERE loan_estado = 'activo' AND cuotas_mora > 0;


-- -- PASO 5) Que la multa quedo con el dia de gracia (SOLO LECTURA) ----------
-- Tiene que devolver `true`.
SELECT pg_get_functiondef(p.oid) LIKE '%fecha_pago < (v_hoy - 1)%' AS multa_con_gracia
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'debe_generar_multa';


-- -- PASO 6) Quien sigue en mora, y desde cuando (SOLO LECTURA) --------------
-- `primera_impaga` no puede ser ni hoy ni ayer en ninguna fila: si aparece
-- una, la gracia no quedo aplicada.
SELECT l.ruta,
       f.loan_id,
       f.cuotas_mora,
       f.saldo_en_mora,
       (SELECT MIN(pp.fecha_pago) FROM public.payment_plan pp
         WHERE pp.loan_id = l.id AND pp.estado = 'pendiente') AS primera_impaga
  FROM public.loans l
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
 WHERE l.estado = 'activo'
   AND f.cuotas_mora > 0
 ORDER BY f.cuotas_mora DESC, l.ruta
 LIMIT 30;
