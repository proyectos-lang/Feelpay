-- ============================================================================
-- 092 - Anular una venta le borra el cronograma
-- ============================================================================
-- DÓNDE ESTAMOS
-- Anular ya funciona: el 01/09/2026 se anularon dos ventas de la ruta 196 y
-- quedaron con `estado = 'anulado'`, su fecha, quién y el motivo. Y el cliente
-- quedó liberado — `clients.tiene_prestamo_activo` está en false en los dos.
-- Eso ya lo hacía `recalcular_prestamo`.
--
-- LO QUE FALTABA, Y NO ERA LO QUE PARECÍA
-- El cobrador seguía viendo las dos ventas. No era que la anulación no hubiera
-- funcionado: el módulo de pagos carga los créditos con esta regla —
--
--     estado = 'activo'  ·  o sin estado  ·  o tocado desde ayer
--
-- y `anular_venta` deja un evento de tipo 'ajuste' con la fecha de hoy, que es
-- el rastro de quién anuló y por qué. Ese evento metía el crédito en "tocado".
-- El propio acto de anular la venta era lo que la mantenía en la ruta.
--
-- Eso se arregló en la app (`lib/dashboard-data.ts`): una venta anulada no
-- vuelve a la lista, la toque quien la toque. No hace falta correr nada para
-- eso — ya está publicado.
--
-- LO QUE HACE ESTE SCRIPT
-- Borrar el cronograma de las ventas anuladas, que era lo otro que se pidió:
-- "que se tome como si se eliminara completamente".
--
-- SOLO SI NO PASÓ NADA EN ESE CRÉDITO
-- Y esta es la parte que importa. El cronograma se borra únicamente cuando el
-- crédito NO tiene ni un pago, ni un no pago, ni un abono — o sea, cuando se
-- anuló una venta recién hecha, que es el caso real ("me equivoqué").
--
-- Si tuviera eventos, borrarlo haría dos daños: los pagos apuntan a cuotas
-- (`gestiones.cuota_objetivo`) y se quedarían apuntando al vacío, y el reparto
-- de la plata por día —la regla de oro de los scripts 084 y 085— se apoya en
-- `payment_plan.fecha_pago` para saber a qué cuota pertenece cada peso. Sin
-- cronograma, esa plata deja de tener sitio.
--
-- En ese caso el crédito igual queda anulado y fuera de todas las listas: lo
-- único que conserva es su cronograma, y el script lo dice por consola.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Qué hay hoy (SOLO LECTURA) ────────────────────────────────────
-- Las ventas anuladas, con lo que les queda colgando. `eventos_de_plata` es lo
-- que decide si se les puede borrar el cronograma.
SELECT l.id,
       l.ruta,
       c.nombre_completo,
       l.anulada_at,
       l.motivo_anulacion,
       cl.tiene_prestamo_activo             AS cliente_liberado_debe_ser_false,
       (SELECT COUNT(*) FROM payment_plan pp WHERE pp.loan_id = l.id) AS cuotas_del_cronograma,
       (SELECT COUNT(*) FROM gestiones g
         WHERE g.loan_id = l.id AND g.estado = 'aplicada'
           AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta'))
                                            AS eventos_de_plata
  FROM public.loans l
  LEFT JOIN public.clients c  ON c.id = l.client_id
  LEFT JOIN public.clients cl ON cl.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.anulada_at DESC;


-- ── PASO 2) Borrarles el cronograma a las que no tienen nada ──────────────
-- Solo las que no tienen un solo evento de plata. Avisa una por una.
DO $limpia092$
DECLARE
  r        record;
  v_borradas int;
  v_total  int := 0;
  v_saltadas int := 0;
BEGIN
  FOR r IN
    SELECT l.id, l.ruta,
           (SELECT COUNT(*) FROM gestiones g
             WHERE g.loan_id = l.id AND g.estado = 'aplicada'
               AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta')) AS eventos
      FROM public.loans l
     WHERE l.estado = 'anulado'
  LOOP
    IF r.eventos > 0 THEN
      v_saltadas := v_saltadas + 1;
      RAISE NOTICE 'Ruta % — crédito %: NO se le borra el cronograma, tiene % evento(s) de plata.',
                   r.ruta, r.id, r.eventos;
      CONTINUE;
    END IF;

    DELETE FROM public.payment_plan WHERE loan_id = r.id;
    GET DIAGNOSTICS v_borradas = ROW_COUNT;
    v_total := v_total + v_borradas;
    RAISE NOTICE 'Ruta % — crédito %: % cuota(s) borrada(s).', r.ruta, r.id, v_borradas;
  END LOOP;

  RAISE NOTICE 'Total: % cuotas borradas, % crédito(s) conservado(s) por tener movimientos.',
               v_total, v_saltadas;
END
$limpia092$;


-- ── PASO 3) Que de ahora en adelante lo haga sola ─────────────────────────
-- Se le agrega el borrado a `anular_venta`, con la misma condición. No se
-- reescribe la función a mano: se lee la que está viva y se le mete el bloque
-- justo después del recálculo, igual que en los scripts 083, 087 y 089.
--
-- Va DESPUÉS de `recalcular_prestamo` a propósito: esa función lee el
-- cronograma, y dejarla sin él antes de que corra sería pedirle que calcule
-- sobre una tabla a medio vaciar.
DO $fix092$
DECLARE
  v_cuantas int;
  v_src     text;
  v_nuevo   text;
BEGIN
  SELECT count(*) INTO v_cuantas
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'anular_venta';

  IF v_cuantas <> 1 THEN
    RAISE EXCEPTION 'Esperaba una sola anular_venta y encontré %. Revisa a mano.', v_cuantas;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'anular_venta';

  IF strpos(v_src, 'PERFORM public.recalcular_prestamo(v_loan_id);') = 0 THEN
    RAISE EXCEPTION 'No encontré el recálculo dentro de anular_venta. No toco nada.';
  END IF;

  IF strpos(v_src, 'DELETE FROM payment_plan WHERE loan_id = v_loan_id') > 0 THEN
    RAISE NOTICE 'anular_venta ya borraba el cronograma. Nada que cambiar.';
    RETURN;
  END IF;

  v_nuevo := replace(
    v_src,
    'PERFORM public.recalcular_prestamo(v_loan_id);',
    'PERFORM public.recalcular_prestamo(v_loan_id);

  -- Una venta anulada sin un solo movimiento nunca debió existir: se le borra
  -- el cronograma para que no quede cartera colgando de ella. Si TIENE
  -- movimientos no se toca — los pagos apuntan a sus cuotas y el reparto de la
  -- plata por día se apoya en `payment_plan.fecha_pago`. Ver el script 092.
  IF NOT EXISTS (SELECT 1 FROM gestiones g
                  WHERE g.loan_id = v_loan_id AND g.estado = ''aplicada''
                    AND g.tipo IN (''pago'',''no_pago'',''cancelacion'',''abono_venta'')) THEN
    DELETE FROM payment_plan WHERE loan_id = v_loan_id;
  END IF;');

  EXECUTE v_nuevo;
  RAISE NOTICE 'anular_venta actualizada: ahora borra el cronograma de las ventas sin movimientos.';
END
$fix092$;


-- ── PASO 4) Que el cambio quedó (SOLO LECTURA) ────────────────────────────
-- `borra_el_cronograma` = true.
SELECT strpos(pg_get_functiondef(p.oid), 'DELETE FROM payment_plan WHERE loan_id = v_loan_id') > 0
         AS borra_el_cronograma
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'anular_venta';


-- ── PASO 5) Cómo quedaron las anuladas (SOLO LECTURA) ─────────────────────
-- `cuotas_del_cronograma` en 0 para las que no tenían movimientos, y
-- `cliente_liberado` en false para todas.
SELECT l.ruta,
       c.nombre_completo,
       l.estado,
       c.tiene_prestamo_activo                                        AS cliente_liberado,
       (SELECT COUNT(*) FROM payment_plan pp WHERE pp.loan_id = l.id) AS cuotas_del_cronograma,
       (SELECT COUNT(*) FROM gestiones g
         WHERE g.loan_id = l.id AND g.estado = 'aplicada'
           AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta')) AS eventos_de_plata
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.ruta;


-- ── PASO 6) Que ningún cliente quedó marcado de más (SOLO LECTURA) ────────
-- Clientes con `tiene_prestamo_activo = true` a los que NO les queda ningún
-- crédito activo. Tiene que salir VACÍO: si sale alguno, quedó marcado como si
-- debiera y no deja hacerle una venta nueva.
SELECT c.id, c.nombre_completo, c.tiene_prestamo_activo
  FROM public.clients c
 WHERE c.tiene_prestamo_activo = true
   AND NOT EXISTS (SELECT 1 FROM public.loans l
                    WHERE l.client_id = c.id AND l.estado = 'activo');
