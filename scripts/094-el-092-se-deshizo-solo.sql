-- ============================================================================
-- 094 - El 092 se deshizo solo, y las anuladas siguen contando
-- ============================================================================
-- LO QUE SE MIDIÓ HOY, 02/09/2026
--
-- EL 093 QUEDÓ PERFECTO. Cero eventos fechados después del día en que se
-- escribieron, cero fechados más allá de hoy, y el ajuste de -$33.600 ya no
-- está en el cierre del 01/09 de la ruta 190: se fue al 31/08, que es cuando
-- la secretaría hizo las correcciones. Los ocho cierres de septiembre que iban
-- a amanecer con un descuento que nadie hizo están todos en cero.
--
-- EL 092 NO ENTRÓ. Las dos ventas anuladas de la ruta 196 siguen igual:
--
--   LEONES JORGE LAINO      3 cuotas · vencen 07, 14 y 21/09 ·   $650.000
--   ELMER FRUTERÍA CAYÓ     3 cuotas · vencen 07, 14 y 21/09 · $1.300.000
--
-- Las dos con CERO eventos de plata: exactamente el caso que el PASO 2 del 092
-- tenía que borrar. No borró ninguna.
--
-- POR QUÉ SE DESHIZO
-- Es la trampa del editor de Supabase, la misma del 087: todo lo que se pega
-- corre en UNA sola transacción. El PASO 3 del 092 aborta a propósito si no
-- encuentra esta línea, escrita palabra por palabra, dentro de `anular_venta`:
--
--     PERFORM public.recalcular_prestamo(v_loan_id);
--
-- Si está escrita distinta —sin el `public.`, con otro nombre de variable— ese
-- paso lanza la excepción, y al lanzarla se deshace TAMBIÉN el borrado del
-- paso anterior, que ya había funcionado. El editor muestra el error del
-- último paso y parece que falló solo ese. Fallaron los dos.
--
-- Y HAY ALGO MÁS, QUE EL 092 NO CUBRÍA
-- Las dos ventas anuladas siguen contando como cartera viva en el Monitoreo.
-- Medido: `cartera_del_dia(196, hoy)` devuelve SIETE créditos y dos son las
-- anuladas, las dos marcadas `gestionado = false`. La ruta 196 tiene cinco.
--
-- No es un descuido: el script 060 lo decidió y lo dejó escrito —
--
--     "No se filtra por `loans.estado`: solo tiene 'activo' y 'cancelado', y
--      un cancelado ya sale por saldo cero — un filtro por estado sería letra
--      muerta que se lee como si hiciera algo."
--
-- Era cierto cuando se escribió. Dejó de serlo con el script 091, que agregó
-- 'anulado'. Una venta anulada no tiene pagos, así que `valor_a_pagar` menos
-- lo pagado le da positivo y pasa el filtro. Y como nadie puede gestionarla
-- nunca, `pendientes_por_visitar` de esa ruta no vuelve a llegar a cero.
--
-- Peor todavía en este caso: las dos ventas se rehicieron hoy, así que esos
-- $1.950.000 están contados DOS veces.
--
-- >>> CORRE LOS PASOS DE A UNO. UNO. NO PEGUES EL ARCHIVO ENTERO. <<<
-- Es literalmente lo que hizo que el 092 no quedara.
-- ============================================================================


-- ── PASO 1) La prueba de que el 092 no quedó (SOLO LECTURA) ───────────────
-- `cuotas_del_cronograma` tiene que dar 3 y 3. Si ya diera 0, el 092 sí quedó
-- y podés saltar al PASO 5.
SELECT l.ruta,
       c.nombre_completo,
       l.anulada_at,
       l.anulada_por_nombre,
       l.motivo_anulacion,
       (SELECT COUNT(*) FROM public.payment_plan pp WHERE pp.loan_id = l.id)
                                              AS cuotas_del_cronograma,
       (SELECT COUNT(*) FROM public.gestiones g
         WHERE g.loan_id = l.id AND g.estado = 'aplicada'
           AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta'))
                                              AS eventos_de_plata
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.anulada_at DESC;


-- ── PASO 2) Por qué abortó el 092 (SOLO LECTURA) ──────────────────────────
-- Esto es lo único que no se puede ver desde la app: el cuerpo de la función.
--
-- `tenia_el_ancla_del_092 = false` explica todo. Guardá `definicion` por si el
-- PASO 9 tampoco encuentra dónde meterse.
SELECT p.proname,
       strpos(pg_get_functiondef(p.oid), 'recalcular_prestamo') > 0
                                                  AS llama_al_recalculo,
       strpos(pg_get_functiondef(p.oid), 'PERFORM public.recalcular_prestamo(v_loan_id);') > 0
                                                  AS tenia_el_ancla_del_092,
       strpos(pg_get_functiondef(p.oid), 'DELETE FROM public.payment_plan') > 0
                                                  AS ya_borra_el_cronograma,
       pg_get_functiondef(p.oid)                  AS definicion
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'anular_venta';


-- ── PASO 3) Borrarles el cronograma. ESTE PASO SOLO ───────────────────────
-- Va aparte a propósito: es la parte que tiene que quedar sí o sí, y no puede
-- volver a arrastrarla el error de otro paso.
--
-- Solo borra el cronograma de una venta anulada que NO tenga un solo evento de
-- plata — el caso real, la venta recién hecha que se anuló porque "me
-- equivoqué". Si tuviera movimientos no se toca: los pagos apuntan a cuotas
-- (`gestiones.cuota_objetivo`) y el reparto de la plata por día se apoya en
-- `payment_plan.fecha_pago` para saber a qué cuota pertenece cada peso. Sin
-- cronograma, esa plata deja de tener sitio.
--
-- Es idempotente: correrlo dos veces borra cero la segunda.
DO $limpia094$
DECLARE
  r          record;
  v_borradas int;
  v_total    int := 0;
  v_saltadas int := 0;
  v_creditos int := 0;
BEGIN
  FOR r IN
    SELECT l.id, l.ruta,
           (SELECT COUNT(*) FROM public.gestiones g
             WHERE g.loan_id = l.id AND g.estado = 'aplicada'
               AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta')) AS eventos
      FROM public.loans l
     WHERE l.estado = 'anulado'
  LOOP
    v_creditos := v_creditos + 1;

    IF r.eventos > 0 THEN
      v_saltadas := v_saltadas + 1;
      RAISE NOTICE 'Ruta % — crédito %: NO se le borra, tiene % evento(s) de plata.',
                   r.ruta, r.id, r.eventos;
      CONTINUE;
    END IF;

    DELETE FROM public.payment_plan WHERE loan_id = r.id;
    GET DIAGNOSTICS v_borradas = ROW_COUNT;
    v_total := v_total + v_borradas;
    RAISE NOTICE 'Ruta % — crédito %: % cuota(s) borrada(s).', r.ruta, r.id, v_borradas;
  END LOOP;

  RAISE NOTICE '--------';
  RAISE NOTICE '% venta(s) anulada(s) revisada(s). % cuotas borradas. % conservada(s) por tener movimientos.',
               v_creditos, v_total, v_saltadas;
END
$limpia094$;


-- ── PASO 4) Que el cronograma se fue (SOLO LECTURA) ───────────────────────
-- `cuotas_del_cronograma` tiene que dar 0 en las dos.
--
-- OJO CON `saldo`: NO va a cambiar, y está bien que no cambie. En
-- `v_loan_financiero` el saldo sale de `loans.valor_a_pagar`, no del
-- cronograma:
--
--     GREATEST(0, COALESCE(l.valor_a_pagar, l.valor) - COALESCE(n.pagado_neto, 0))
--
-- así que borrar las cuotas deja `cuotas_totales` en 0 pero el saldo intacto.
-- Eso es lo que arreglan los pasos 6 y 7 por el lado del Monitoreo, que es
-- donde de verdad se ve. Quitarlo también de `v_loan_financiero` es cirugía
-- sobre el corazón del núcleo y no va acá.
SELECT l.ruta,
       c.nombre_completo,
       (SELECT COUNT(*) FROM public.payment_plan pp WHERE pp.loan_id = l.id)
                                              AS cuotas_del_cronograma,
       f.total_a_pagar,
       f.total_pagado,
       f.saldo,
       f.cuotas_totales
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
  LEFT JOIN public.v_loan_financiero f ON f.loan_id = l.id
 WHERE l.estado = 'anulado'
 ORDER BY l.ruta;


-- ── PASO 5) Las anuladas dentro de la cartera (SOLO LECTURA) ──────────────
-- Corré esto ANTES de los pasos 6 y 7 y guardá el resultado.
--
-- La ruta 196 tiene CINCO créditos. `cuantos_cuenta_el_monitoreo` va a decir
-- 7, y `de_esos_anulados` va a decir 2. Después de los pasos 6 y 7 tienen que
-- decir 5 y 0.
SELECT COUNT(*)                                              AS cuantos_cuenta_el_monitoreo,
       COUNT(*) FILTER (WHERE l.estado = 'anulado')          AS de_esos_anulados,
       COUNT(*) FILTER (WHERE NOT cd.gestionado)             AS pendientes_por_visitar
  FROM public.cartera_del_dia(196, (now() AT TIME ZONE 'America/Bogota')::date) cd
  JOIN public.loans l ON l.id = cd.loan_id;


-- ── PASO 6) Que el Monitoreo deje de contar las anuladas ──────────────────
-- No se reescribe la vista a mano — son 80 líneas y transcribirlas es cómo el
-- script 081 se comió cinco columnas de un INSERT. Se lee la definición VIVA y
-- se le agrega una condición al filtro de la cartera.
--
-- El ancla es `l.ruta = rd.ruta_id`, que aparece UNA sola vez en toda la
-- vista: los demás cruces van al revés (`rd.ruta_id = pr.ruta`). El script
-- cuenta las apariciones y aborta si no es exactamente una.
--
-- `IS DISTINCT FROM` y no `<>` porque hay créditos con `estado` en NULL, y
-- `NULL <> 'anulado'` da NULL, o sea que los sacaría a todos.
DO $mon094$
DECLARE
  v_src   text;
  v_nuevo text;
  v_veces int;
  v_ancla constant text := 'l.ruta = rd.ruta_id';
BEGIN
  SELECT pg_get_viewdef('public.vista_monitoreo_admin'::regclass, true) INTO v_src;

  IF strpos(v_src, 'l.estado IS DISTINCT FROM ''anulado''') > 0 THEN
    RAISE NOTICE 'La vista ya excluía las anuladas. Nada que cambiar.';
    RETURN;
  END IF;

  v_veces := (length(v_src) - length(replace(v_src, v_ancla, ''))) / length(v_ancla);
  IF v_veces <> 1 THEN
    RAISE EXCEPTION 'Esperaba `%` una sola vez en la vista y aparece % veces. No la toco.',
                    v_ancla, v_veces;
  END IF;

  v_nuevo := replace(v_src, v_ancla,
                     'l.estado IS DISTINCT FROM ''anulado''::text AND ' || v_ancla);

  EXECUTE 'CREATE OR REPLACE VIEW public.vista_monitoreo_admin AS ' || v_nuevo;
  RAISE NOTICE 'vista_monitoreo_admin: una venta anulada ya no cuenta como cartera.';
END
$mon094$;


-- ── PASO 7) Lo mismo en la lista de quiénes son ───────────────────────────
-- `cartera_del_dia` es la función que devuelve la LISTA que hay detrás de ese
-- número. El script 060 la escribió con el mismo predicado copiado al pie de
-- la letra justamente para que no pudieran divergir: si se corrige la vista y
-- no la función, el contador dice 5 y la lista sigue mostrando 7.
DO $cart094$
DECLARE
  v_src   text;
  v_nuevo text;
  v_veces int;
  v_ancla constant text := 'l.ruta = p_ruta_id';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cartera_del_dia';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe cartera_del_dia. ¿Corriste el script 060?';
  END IF;

  IF strpos(v_src, 'l.estado IS DISTINCT FROM ''anulado''') > 0 THEN
    RAISE NOTICE 'cartera_del_dia ya excluía las anuladas. Nada que cambiar.';
    RETURN;
  END IF;

  v_veces := (length(v_src) - length(replace(v_src, v_ancla, ''))) / length(v_ancla);
  IF v_veces <> 1 THEN
    RAISE EXCEPTION 'Esperaba `%` una sola vez en cartera_del_dia y aparece % veces. No la toco.',
                    v_ancla, v_veces;
  END IF;

  v_nuevo := replace(v_src, v_ancla,
                     'l.estado IS DISTINCT FROM ''anulado''::text AND ' || v_ancla);

  EXECUTE v_nuevo;
  RAISE NOTICE 'cartera_del_dia: una venta anulada ya no sale en la lista.';
END
$cart094$;


-- ── PASO 8) Que el Monitoreo ya dice la verdad (SOLO LECTURA) ─────────────
-- El MISMO conteo del PASO 5. Ahora tiene que decir 5, 0 y los pendientes de
-- verdad. Compará las dos filas.
SELECT COUNT(*)                                              AS cuantos_cuenta_el_monitoreo,
       COUNT(*) FILTER (WHERE l.estado = 'anulado')          AS de_esos_anulados,
       COUNT(*) FILTER (WHERE NOT cd.gestionado)             AS pendientes_por_visitar
  FROM public.cartera_del_dia(196, (now() AT TIME ZONE 'America/Bogota')::date) cd
  JOIN public.loans l ON l.id = cd.loan_id;


-- ── PASO 9) Que anular haga solo el borrado, de ahora en adelante ─────────
-- LA DIFERENCIA CON EL 092: ya no busca una línea escrita palabra por palabra.
-- Busca la LLAMADA al recálculo con una expresión regular, así que le da igual
-- si dice `public.recalcular_prestamo` o `recalcular_prestamo`, y le da igual
-- cómo se llame la variable del crédito.
--
-- El bloque va DESPUÉS del recálculo a propósito: esa función lee el
-- cronograma, y dejarla sin él antes de que corra sería pedirle que calcule
-- sobre una tabla a medio vaciar.
--
-- Si aun así no encuentra dónde meterse, aborta sin tocar nada y lo dice. En
-- ese caso, mandame la columna `definicion` del PASO 2.
DO $fix094$
DECLARE
  v_cuantas int;
  v_src     text;
  v_nuevo   text;
  v_bloque  text;
BEGIN
  SELECT count(*) INTO v_cuantas
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'anular_venta';

  IF v_cuantas <> 1 THEN
    RAISE EXCEPTION 'Esperaba una sola anular_venta y encontré %. Mirá el PASO 2.', v_cuantas;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'anular_venta';

  IF strpos(v_src, 'DELETE FROM public.payment_plan') > 0 THEN
    RAISE NOTICE 'anular_venta ya borraba el cronograma. Nada que cambiar.';
    RETURN;
  END IF;

  IF v_src !~* 'PERFORM\s+(public\.)?recalcular_prestamo\s*\(' THEN
    RAISE EXCEPTION
      'anular_venta no llama a recalcular_prestamo de una forma que reconozca. No toco nada. Mandame la columna `definicion` del PASO 2.';
  END IF;

  -- Las comillas van dobladas porque esto es un literal dentro de otro.
  v_bloque :=
'
  -- Una venta anulada sin un solo movimiento nunca debió existir: se le borra
  -- el cronograma para que no quede cartera colgando de ella. Si TIENE
  -- movimientos no se toca — los pagos apuntan a sus cuotas y el reparto de la
  -- plata por día se apoya en `payment_plan.fecha_pago`. Ver el script 094.
  IF NOT EXISTS (SELECT 1 FROM public.gestiones g
                  WHERE g.loan_id = v_loan_id AND g.estado = ''aplicada''
                    AND g.tipo IN (''pago'',''no_pago'',''cancelacion'',''abono_venta'')) THEN
    DELETE FROM public.payment_plan WHERE loan_id = v_loan_id;
  END IF;
';

  -- Sin la bandera 'g': si el recálculo se llamara dos veces, el bloque entra
  -- una sola vez, después del primero.
  v_nuevo := regexp_replace(
    v_src,
    '(PERFORM\s+(?:public\.)?recalcular_prestamo\s*\([^;]*;)',
    '\1' || v_bloque,
    'i');

  IF v_nuevo = v_src THEN
    RAISE EXCEPTION 'Encontré la llamada pero no pude insertar el bloque. No toco nada.';
  END IF;

  -- Si la variable del crédito no se llamara `v_loan_id`, el bloque insertado
  -- no compila y esto lanza acá mismo, sin dejar la función a medias.
  EXECUTE v_nuevo;
  RAISE NOTICE 'anular_venta actualizada: ahora borra el cronograma de las ventas sin movimientos.';
END
$fix094$;


-- ── PASO 10) Que el parche quedó (SOLO LECTURA) ───────────────────────────
-- `borra_el_cronograma` = true.
SELECT p.proname,
       strpos(pg_get_functiondef(p.oid), 'DELETE FROM public.payment_plan') > 0
         AS borra_el_cronograma
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'anular_venta';


-- ── PASO 11) La prueba de fuego, ya en la app ─────────────────────────────
-- Anulá una venta recién hecha desde Control Total y corré esto: tiene que
-- salir con `cuotas_del_cronograma = 0` sin que nadie corra nada a mano.
--
-- Y volvé a correr el PASO 8 cambiando el 196 por la ruta de esa venta: no
-- puede aparecer en su cartera.
SELECT l.ruta,
       c.nombre_completo,
       l.anulada_at,
       l.motivo_anulacion,
       (SELECT COUNT(*) FROM public.payment_plan pp WHERE pp.loan_id = l.id)
         AS cuotas_del_cronograma
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.anulada_at DESC;
