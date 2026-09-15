-- ============================================================================
-- 114 - Una venta anulada no tiene meta
-- ============================================================================
-- LO QUE SE REPORTO
-- "En la unidad 204, la meta de hoy esta tomando en cuenta una venta que se
--  hizo pero que se habia borrado. Aunque no salga en los pagos de la ruta,
--  se esta sumando en la meta."
--
-- ES EXACTAMENTE ESO, Y ESTA MEDIDO
--
--   ruta 204, hoy 14/09        meta que se publica   168.300
--                              lo que de verdad es   145.900
--                                                    -------
--                              de mas                 22.400
--
-- Los 22.400 son la cuota de LIMPIEZA, una venta de 400.000 creada el 12/09 y
-- ANULADA el mismo dia. Su credito quedo con `estado = 'anulado'` y sin un
-- solo pago, pero conservo las 25 cuotas de su cronograma.
--
-- Y no es solo hoy: esas 25 cuotas le suman 22.400 a la meta de 25 FECHAS
-- distintas, hasta el 13/10. 560.000 de cartera que no existe.
--
-- SON DOS FALLAS DISTINTAS Y CONVIENE NO CONFUNDIRLAS
-- ----------------------------------------------------
-- 1) `anular_venta` NO LE BORRA EL CRONOGRAMA a la venta que anula.
--    El script 094 traia ese parche, pero no se corrio: se comprobo contra
--    produccion. Los dos creditos anulados de la ruta 196 (01/09) SI tienen
--    0 cuotas —esos los limpio el script 092 a mano— y LIMPIEZA, anulada
--    despues, conservo las 25. Mientras esto no se arregle, cada venta que
--    se anule vuelve a dejar su cartera fantasma.
--    -> Lo arregla el PASO 3.
--
-- 2) LA META NO SABE QUE 'anulado' EXISTE.
--    Su filtro es `WHERE l.estado <> 'cancelado'`, que deja pasar 'anulado'
--    sin mirarlo. Aunque el punto 1 quede arreglado, una venta anulada que
--    SI tenga pagos conserva su cronograma a proposito (los pagos apuntan a
--    sus cuotas) — y esas cuotas seguirian inflando la meta.
--    -> Lo arregla el PASO 5.
--
-- Se arreglan LAS DOS. Con solo la primera, la meta queda bien hoy pero
-- vuelve a romperse el dia que se anule una venta que ya tenia pagos. Con
-- solo la segunda, la cartera fantasma sigue apareciendo en cualquier otra
-- pantalla que lea `payment_plan`.
--
-- QUE NO SE TOCA
--   * El libro `gestiones`: no se borra ni se edita un solo evento.
--   * Ningun saldo ni `valor_a_pagar`.
--   * Los creditos ACTIVOS y los CANCELADOS: ni se miran.
--   * El cronograma de una venta anulada QUE TENGA PAGOS: se conserva, por la
--     misma razon de siempre —los pagos apuntan a sus cuotas y el reparto de
--     la plata por dia se apoya en `payment_plan.fecha_pago`—. Lo que cambia
--     es que deja de contar para la meta.
--
-- Corre los pasos EN ORDEN. Los pasos 1, 4, 6 y 7 no escriben nada.
-- ============================================================================


-- ── PASO 1) El daño, antes de tocar nada (SOLO LECTURA) ──────────────────
-- Cada venta anulada, cuantas cuotas conserva y cuanto le suma a las metas.
-- `eventos_de_plata` es lo que decide si se le puede borrar el cronograma.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo)  AS cliente,
       l.valor,
       (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS creada,
       COUNT(pp.id)                                     AS cuotas_que_conserva,
       COALESCE(SUM(pp.valor_cuota), 0)                 AS suma_de_esas_cuotas,
       (SELECT COUNT(*) FROM public.gestiones g
         WHERE g.loan_id = l.id AND g.estado = 'aplicada'
           AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta'))
                                                        AS eventos_de_plata
  FROM public.loans l
  JOIN public.clients c            ON c.id = l.client_id
  LEFT JOIN public.payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'anulado'
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, l.valor, l.fecha_creacion
 ORDER BY l.ruta;


-- ── PASO 2) Las metas que hoy salen infladas (SOLO LECTURA) ──────────────
-- Guarde estos numeros. El PASO 7 compara contra ellos.
SELECT pp.ruta,
       pp.fecha_pago,
       SUM(pp.valor_cuota) AS de_ventas_anuladas
  FROM public.payment_plan pp
  JOIN public.loans l ON l.id = pp.loan_id
 WHERE l.estado = 'anulado'
 GROUP BY pp.ruta, pp.fecha_pago
 ORDER BY pp.ruta, pp.fecha_pago;


-- ── PASO 3) Que `anular_venta` borre el cronograma (el parche del 094) ───
-- Se parchea la funcion VIVA: tiene varias versiones (scripts 068, 069, 088)
-- y redefinirla desde cualquiera de ellas borraria lo que las otras
-- agregaron. El bloque entra justo despues del `recalcular_prestamo`.
DO $patch$
DECLARE
  v_src    text;
  v_nuevo  text;
  v_bloque text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'anular_venta';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.anular_venta: corra antes el script 068';
  END IF;

  IF strpos(v_src, 'DELETE FROM public.payment_plan') > 0 THEN
    RAISE NOTICE 'anular_venta ya borraba el cronograma. Nada que cambiar.';
    RETURN;
  END IF;

  IF v_src !~* 'PERFORM\s+(public\.)?recalcular_prestamo\s*\(' THEN
    RAISE EXCEPTION
      'anular_venta no llama a recalcular_prestamo de una forma que reconozca. No toco nada.';
  END IF;

  -- Las comillas van dobladas porque esto es un literal dentro de otro.
  v_bloque :=
'
  -- Una venta anulada sin un solo movimiento nunca debio existir: se le borra
  -- el cronograma para que no quede cartera colgando de ella —ni en la meta,
  -- ni en ninguna otra pantalla que lea `payment_plan`.
  --
  -- Si TIENE movimientos NO se toca: los pagos apuntan a sus cuotas
  -- (`gestiones.cuota_objetivo`) y el reparto de la plata por dia se apoya en
  -- `payment_plan.fecha_pago`. Sin cronograma, esa plata se queda sin sitio.
  -- Para ese caso, lo que la saca de la meta es el filtro del script 114.
  IF NOT EXISTS (SELECT 1 FROM public.gestiones g
                  WHERE g.loan_id = v_loan_id AND g.estado = ''aplicada''
                    AND g.tipo IN (''pago'',''no_pago'',''cancelacion'',''abono_venta'')) THEN
    DELETE FROM public.payment_plan WHERE loan_id = v_loan_id;
  END IF;
';

  -- Sin la bandera 'g': si el recalculo se llamara dos veces, el bloque entra
  -- una sola vez, despues del primero.
  v_nuevo := regexp_replace(
    v_src,
    '(PERFORM\s+(?:public\.)?recalcular_prestamo\s*\([^;]*;)',
    '\1' || v_bloque,
    'i');

  IF v_nuevo = v_src THEN
    RAISE EXCEPTION 'Encontre la llamada pero no pude insertar el bloque. No toco nada.';
  END IF;

  EXECUTE v_nuevo;
  RAISE NOTICE 'anular_venta ahora le borra el cronograma a la venta que anula.';
END
$patch$;


-- ── PASO 4) Que el parche quedo puesto (SOLO LECTURA) ────────────────────
-- Tiene que decir `t` en las dos columnas.
SELECT strpos(pg_get_functiondef(p.oid), 'DELETE FROM public.payment_plan') > 0
         AS borra_el_cronograma,
       strpos(pg_get_functiondef(p.oid), 'recalcular_prestamo') > 0
         AS conserva_el_recalculo
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'anular_venta';


-- ── PASO 5) Limpiar las que YA quedaron con cronograma ───────────────────
-- Solo las anuladas SIN un peso de movimiento. Si alguna tiene pagos, se deja
-- y se avisa: esa sale de la meta por el filtro del PASO 6, no borrandola.
DO $fix$
DECLARE
  r       record;
  v_tot   int := 0;
  v_cuot  int := 0;
BEGIN
  FOR r IN
    SELECT l.id, l.ruta,
           COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
           (SELECT COUNT(*) FROM public.payment_plan pp WHERE pp.loan_id = l.id) AS cuotas,
           (SELECT COUNT(*) FROM public.gestiones g
             WHERE g.loan_id = l.id AND g.estado = 'aplicada'
               AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta'))     AS eventos
      FROM public.loans l
      JOIN public.clients c ON c.id = l.client_id
     WHERE l.estado = 'anulado'
  LOOP
    IF r.cuotas = 0 THEN
      CONTINUE;
    END IF;

    IF r.eventos > 0 THEN
      RAISE NOTICE 'ruta % · % · tiene % eventos de plata: se le CONSERVA el cronograma (sale de la meta por el filtro)',
        r.ruta, r.cliente, r.eventos;
      CONTINUE;
    END IF;

    DELETE FROM public.payment_plan WHERE loan_id = r.id;
    v_tot  := v_tot + 1;
    v_cuot := v_cuot + r.cuotas;
    RAISE NOTICE 'ruta % · % · % cuotas borradas', r.ruta, r.cliente, r.cuotas;
  END LOOP;

  RAISE NOTICE '---';
  RAISE NOTICE 'Ventas anuladas limpiadas: %  ·  cuotas borradas: %', v_tot, v_cuot;
END
$fix$;


-- ── PASO 6) Que la meta ignore lo anulado ────────────────────────────────
-- El cinturon, ademas de los tirantes. Aunque el PASO 5 limpie lo que hay
-- hoy, una venta anulada CON pagos conserva su cronograma a proposito, y esas
-- cuotas no pueden seguir contando como algo por cobrar.
--
-- POR QUE ESTO NO BUSCA UN TEXTO EXACTO
-- --------------------------------------
-- El primer intento anclaba en `l.estado <> 'cancelado'` y fallo con
-- "aparece 0 veces". No es que el filtro no este: es que `pg_get_viewdef` NO
-- devuelve el SQL como se escribio, lo devuelve NORMALIZADO — pone los tipos
-- (`::text`), cambia el espaciado y reacomoda los parentesis. Asi que
-- `l.estado <> 'cancelado'` en la fuente se lee como algo del estilo
-- `l.estado::text <> 'cancelado'::text` en la definicion viva.
--
-- Por eso ahora se busca con una EXPRESION REGULAR que tolera esas variantes,
-- y el script dice exactamente que encontro antes de tocar nada.
--
-- OJO CON EL `OR`. El filtro entero es:
--
--     WHERE l.estado <> 'cancelado' OR pp.fecha_pago <= fin.dia_cierre
--
-- Ese `OR` existe para que un CANCELADO siga contando hasta el dia en que
-- termino de pagar: la meta del 1 no se reescribe porque el credito cerro el
-- 3. Para una cancelacion es correcto.
--
-- Para una ANULACION no. Una venta anulada nunca debio existir, asi que sus
-- cuotas no fueron cobrables NINGUN dia. Y el `OR` las dejaria pasar igual,
-- porque `dia_cierre` sale del ultimo evento aplicado y el propio ajuste de
-- anular ES un evento: a LIMPIEZA le daria 12/09, y su cuota del 12/09
-- seguiria contando. Por eso el `OR` se acota a 'cancelado'.
--
-- `vista_monitoreo_recaudos` cuelga del resumen, asi que se guarda antes del
-- CASCADE y se recrea igual, con su GRANT.
DO $vista$
DECLARE
  v_src    text;
  v_nuevo  text;
  v_dep    text;
  v_est    text;
  v_fec    text;
  v_alias  text;
BEGIN
  SELECT pg_get_viewdef('public.resumen_diario_v2'::regclass, true) INTO v_src;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.resumen_diario_v2';
  END IF;

  IF v_src ~ '''anulado''' THEN
    RAISE NOTICE 'La meta ya ignoraba lo anulado. Nada que cambiar.';
    RETURN;
  END IF;

  -- 1) El trozo que compara el estado contra 'cancelado', sea como sea que
  --    Postgres lo haya normalizado (con o sin `::text`, con o sin espacios).
  -- El alias tambien puede cambiar: Postgres a veces renombra `l` a `l_1`
  -- cuando hay varios JOIN al mismo tabla. Se acepta cualquier alias y se
  -- informa cual salio, para que quede constancia de sobre que se actuo.
  SELECT (regexp_match(v_src, '([A-Za-z_][A-Za-z0-9_]*\.estado(?:::text)?\s*<>\s*''cancelado''(?:::text)?)'))[1]
    INTO v_est;

  IF v_est IS NULL THEN
    RAISE EXCEPTION
      'No encuentro el filtro de cancelado en la vista. Corra el PASO 6-BIS de abajo y mandeme lo que salga.';
  END IF;

  -- 2) El trozo del OR que lo acompaña.
  SELECT (regexp_match(v_src, '([A-Za-z_][A-Za-z0-9_]*\.fecha_pago\s*<=\s*[A-Za-z_][A-Za-z0-9_]*\.dia_cierre)'))[1]
    INTO v_fec;

  IF v_fec IS NULL THEN
    RAISE EXCEPTION
      'Encontre el filtro de cancelado pero no el OR de dia_cierre. Corra el PASO 6-BIS y mandeme lo que salga.';
  END IF;

  RAISE NOTICE 'Filtro encontrado: "%" ... OR ... "%"', v_est, v_fec;

  -- 3) Los dos reemplazos, sobre el texto REAL que se encontro.
  -- Se reconstruye con EL MISMO alias que traia: si la vista usa `l_1`,
  -- escribir `l` dejaria la vista sin compilar.
  v_alias := split_part(v_est, '.', 1);

  v_nuevo := replace(v_src, v_est,
    v_alias || '.estado NOT IN (''cancelado'', ''anulado'')');
  v_nuevo := replace(v_nuevo, v_fec,
    '(' || v_alias || '.estado = ''cancelado'' AND ' || v_fec || ')');

  IF v_nuevo = v_src THEN
    RAISE EXCEPTION 'No se pudo cambiar el filtro de la meta. No toco nada.';
  END IF;

  -- Se guarda la vista dependiente ANTES del CASCADE para recrearla igual.
  SELECT pg_get_viewdef('public.vista_monitoreo_recaudos'::regclass, true) INTO v_dep;

  EXECUTE 'DROP VIEW IF EXISTS public.resumen_diario_v2 CASCADE';
  EXECUTE 'CREATE VIEW public.resumen_diario_v2 AS ' || v_nuevo;
  EXECUTE 'GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated';

  IF v_dep IS NOT NULL THEN
    EXECUTE 'CREATE VIEW public.vista_monitoreo_recaudos AS ' || v_dep;
    EXECUTE 'GRANT SELECT ON public.vista_monitoreo_recaudos TO anon, authenticated';
    RAISE NOTICE 'vista_monitoreo_recaudos recreada.';
  ELSE
    RAISE WARNING 'No se encontro vista_monitoreo_recaudos para recrear. Corra el script 099.';
  END IF;

  RAISE NOTICE 'La meta ya no cuenta las cuotas de ventas anuladas.';
END
$vista$;


-- ── PASO 6-BIS) SOLO SI EL PASO 6 FALLA (SOLO LECTURA) ───────────────────
-- Si el PASO 6 dijo que no encuentra el filtro, corra esto y mandeme el
-- resultado: es el trozo de la vista donde vive la meta, tal como Postgres lo
-- tiene guardado. Con eso ajusto el ancla sin adivinar.
--
-- (Si el PASO 6 funciono, esta consulta no hace falta.)
SELECT substring(pg_get_viewdef('public.resumen_diario_v2'::regclass, true)
                 FROM position('dia_cierre' IN
                      pg_get_viewdef('public.resumen_diario_v2'::regclass, true)) - 400
                 FOR 900) AS el_trozo_de_la_meta;


-- ── PASO 7) Que quedo bien (SOLO LECTURA) ────────────────────────────────
-- La meta de la 204 de hoy tiene que bajar de 168.300 a 145.900, y el
-- monitoreo tiene que seguir devolviendo filas.
SELECT ruta, fecha_pago, meta_pagos, meta_atrasados, valor_pago
  FROM public.resumen_diario_v2
 WHERE fecha_pago BETWEEN (now() AT TIME ZONE 'America/Bogota')::date
                      AND (now() AT TIME ZONE 'America/Bogota')::date + 2
 ORDER BY ruta, fecha_pago;


-- ── PASO 8) Que el monitoreo sigue vivo (SOLO LECTURA) ───────────────────
-- Si esto da 0 o error, el PASO 6 no recreo la vista dependiente.
SELECT count(*) AS filas_en_el_monitoreo
  FROM public.vista_monitoreo_recaudos;


-- ── PASO 9) Que no quedo cartera fantasma (SOLO LECTURA) ─────────────────
-- Tiene que salir VACIO, o solo con ventas anuladas que TENGAN pagos — esas
-- conservan su cronograma a proposito y ya no cuentan para la meta.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       COUNT(pp.id)                                    AS cuotas_que_conserva,
       (SELECT COUNT(*) FROM public.gestiones g
         WHERE g.loan_id = l.id AND g.estado = 'aplicada'
           AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta'))
                                                       AS eventos_de_plata
  FROM public.loans l
  JOIN public.clients c       ON c.id = l.client_id
  JOIN public.payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'anulado'
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo
 ORDER BY l.ruta;
