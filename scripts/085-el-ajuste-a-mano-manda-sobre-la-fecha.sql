-- ============================================================================
-- 085 - El ajuste de secretaría manda sobre la fecha
-- ============================================================================
-- QUÉ PASÓ
-- El script 084 puso la regla de oro: la plata se queda en el día en que se
-- pagó. Se pasó de rosca en un punto — dejó fuera el único caso en que la
-- fecha NO debe mandar: cuando una persona señaló la cuota a mano.
--
-- La secretaría, desde Control de Pagos, corrige "esta plata va en la cuota
-- del jueves". Antes del script 066 esa corrección se guardaba con la fecha
-- del día en que se hacía, no con la de la cuota. Así que hay ajustes viejos
-- donde la fecha dice una cosa y la cuota señalada dice otra.
--
-- Con el 084 esos ajustes se fueron a la cuota de SU FECHA. Medido: 31
-- ajustes, todos del 24/08/2026, se movieron de las cuotas del 21 y el 22 —las
-- que la secretaría estaba arreglando— a la del 24. Es exactamente el
-- fenómeno que se quería eliminar: la plata acomodándose al día en que se
-- escribió en vez de quedarse donde la pusieron.
--
-- LA REGLA, COMPLETA
--   · Manda el DÍA del pago. Siempre.
--   · SALVO que la secretaría haya señalado la cuota a mano desde Control de
--     Pagos (`origen = 'ajuste'` con `cuota_objetivo`). Eso es una decisión de
--     una persona que está mirando el caso, y le gana a la fecha.
--   · El cobro de campo, el abono de la venta y la historia migrada NO
--     señalan nada: para ellos manda el día, y punto.
--
-- Los ajustes hechos DESPUÉS del script 066 no notan la diferencia: ese script
-- ya los registra en el día de la cuota, así que la fecha y la cuota señalada
-- coinciden y las dos reglas dicen lo mismo.
--
-- LO QUE CAMBIA, SIMULADO CONTRA LA BASE ANTES DE ESCRIBIR ESTO
--   cuotas que vuelven a su sitio : 24
--        pendiente -> pagado  14      pagado  -> pendiente  3
--        no_pago   -> pagado   2      pendiente -> parcial  2
--        pagado    -> no_pago  2      no_pago -> parcial    1
--
--   Y lo que NO se desarma: la 190 sigue con CERO cuotas de hoy marcadas
--   'pagado' sin una gestión de hoy. Lo que arregló el 084 sigue arreglado.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Foto del reparto de AHORA ─────────────────────────────────────
DROP TABLE IF EXISTS public.cobertura_antes_085;


-- ── PASO 2) Guardarla ─────────────────────────────────────────────────────
CREATE TABLE public.cobertura_antes_085 AS
SELECT id, loan_id, numero_cuota, fecha_pago, monto_asignado, estado_derivado
  FROM public.v_cobertura_cuotas;


-- ── PASO 3) Foto de la plata de AHORA ─────────────────────────────────────
DROP TABLE IF EXISTS public.financiero_antes_085;


-- ── PASO 4) Guardarla ─────────────────────────────────────────────────────
CREATE TABLE public.financiero_antes_085 AS
SELECT loan_id, total_pagado, saldo, saldo_hoy, saldo_en_mora, cuotas_mora,
       cuotas_cubiertas
  FROM public.v_loan_financiero;


-- ── PASO 5) La vista, con la excepción del ajuste a mano ──────────────────
-- Es la vista del 084 con UN bloque cambiado: el que decide en qué cuota cae
-- cada peso. El resto va letra por letra.
CREATE OR REPLACE VIEW public.v_cobertura_cuotas AS
WITH vivos AS (
  -- Los eventos que siguen en pie: los que tienen una reversa APLICADA
  -- apuntándoles quedan fuera.
  SELECT g.*
    FROM public.gestiones g
   WHERE g.estado = 'aplicada'
     AND NOT EXISTS (
       SELECT 1 FROM public.gestiones r
        WHERE r.referencia_gestion_id = g.id
          AND r.tipo = 'reversa'
          AND r.estado = 'aplicada')
),
ubicado AS (
  -- CADA PESO, EN EL DÍA EN QUE SE PAGÓ — SALVO QUE ALGUIEN LO HAYA PUESTO
  -- A MANO.
  --
  -- La secretaría, desde Control de Pagos, señala una cuota concreta: "esta
  -- plata va en la del jueves". Eso es un acto explícito de una persona que
  -- está mirando el caso, no un automatismo. Manda sobre la fecha.
  --
  -- Para todo lo demás —el cobro de campo, el abono de la venta, la historia
  -- migrada— manda el día, y `cuota_objetivo` no reparte nada.
  --
  -- La reversa que trae `referencia_gestion_id` NO resta acá: ya sacó a su
  -- evento de `vivos`, y restar otra vez descontaría dos veces la misma plata.
  -- Las otras —las que genera el ajuste de secretaría— sí restan, y lo hacen
  -- sobre la MISMA cuota que señaló el ajuste, así que se netean solas.
  SELECT v.loan_id,
         v.tipo,
         v.monto,
         CASE WHEN v.origen = 'ajuste' AND v.cuota_objetivo IS NOT NULL
              THEN v.cuota_objetivo
              ELSE d.id END AS cuota_id
    FROM vivos v
    LEFT JOIN LATERAL (
      -- La cuota del DÍA del evento. Comprobado que no hay un solo crédito
      -- con dos cuotas en la misma fecha, así que el LIMIT 1 nunca elige.
      SELECT pp.id
        FROM public.payment_plan pp
       WHERE pp.loan_id = v.loan_id
         AND pp.fecha_pago = v.fecha_gestion
       ORDER BY pp.numero_cuota
       LIMIT 1
    ) d ON true
   WHERE v.tipo IN ('pago', 'cancelacion', 'abono_venta', 'reversa')
     AND NOT (v.tipo = 'reversa' AND v.referencia_gestion_id IS NOT NULL)
),
pegado AS (
  SELECT u.cuota_id,
         SUM(CASE WHEN u.tipo IN ('pago','cancelacion','abono_venta') THEN  u.monto
                  WHEN u.tipo = 'reversa'                             THEN -u.monto
                  ELSE 0 END) AS monto,
         -- Sin la plata de cancelación: una cancelación no debe pintar la
         -- cuota como pagada por el cobrador. Se marca 'cancelada' aparte.
         SUM(CASE WHEN u.tipo IN ('pago','abono_venta') THEN  u.monto
                  WHEN u.tipo = 'reversa'               THEN -u.monto
                  ELSE 0 END) AS monto_sin_canc
    FROM ubicado u
   WHERE u.cuota_id IS NOT NULL
   GROUP BY u.cuota_id
),
base AS (
  SELECT pp.id, pp.loan_id, pp.numero_cuota, pp.fecha_pago, pp.valor_cuota,
         pp.es_extra,
         -- Se topa en el valor de la cuota porque es lo que SE VE en la cuota.
         -- El sobrante no va a ningún lado: baja el saldo, que sale de la
         -- plata y no de acá. Lo que el cliente pagó ese día se lee entero en
         -- el libro de eventos, que es donde vive.
         LEAST(pp.valor_cuota, GREATEST(0, COALESCE(p.monto, 0)))          AS cobrado,
         LEAST(pp.valor_cuota, GREATEST(0, COALESCE(p.monto_sin_canc, 0))) AS cobrado_sin_canc
    FROM public.payment_plan pp
    LEFT JOIN pegado p ON p.cuota_id = pp.id
)
SELECT b.id, b.loan_id, b.numero_cuota, b.fecha_pago, b.valor_cuota, b.es_extra,
       -- El acumulado de SIEMPRE, que otras vistas siguen leyendo.
       SUM(b.valor_cuota) OVER (
         PARTITION BY b.loan_id ORDER BY b.fecha_pago, b.numero_cuota, b.id
       ) AS acumulado,
       b.cobrado AS monto_asignado,
       CASE
         -- `cubre_cuota` y no `>=`: es el mismo umbral con el margen de
         -- redondeo del script 072.
         WHEN public.cubre_cuota(b.cobrado_sin_canc, b.valor_cuota) THEN 'pagado'
         WHEN COALESCE(n.tiene_cancelacion, false)                  THEN 'cancelada'
         WHEN b.cobrado > 0                                         THEN 'parcial'
         WHEN EXISTS (
           SELECT 1 FROM public.gestiones g
            WHERE g.cuota_objetivo = b.id AND g.tipo = 'no_pago'
              AND g.estado = 'aplicada'
              AND NOT EXISTS (
                SELECT 1 FROM public.gestiones r
                 WHERE r.referencia_gestion_id = g.id
                   AND r.tipo = 'reversa' AND r.estado = 'aplicada')
         ) THEN 'no_pago'
         ELSE 'pendiente'
       END AS estado_derivado
  FROM base b
  LEFT JOIN public.v_pagos_netos n ON n.loan_id = b.loan_id;


-- ── PASO 6) Rehacer el cache de todos los préstamos ───────────────────────
SELECT public.recalcular_prestamo(id) FROM public.loans;


-- ── PASO 7) QUE NO SE MOVIÓ UN PESO (SOLO LECTURA) ────────────────────────
-- TIENE QUE SALIR VACÍO. El reparto no puede cambiar el saldo de nadie.
SELECT a.loan_id,
       a.total_pagado AS pagado_antes, n.total_pagado AS pagado_ahora,
       a.saldo        AS saldo_antes,  n.saldo        AS saldo_ahora
  FROM public.financiero_antes_085 a
  JOIN public.v_loan_financiero    n ON n.loan_id = a.loan_id
 WHERE a.total_pagado IS DISTINCT FROM n.total_pagado
    OR a.saldo        IS DISTINCT FROM n.saldo;


-- ── PASO 8) QUE LA MORA NO SE MOVIÓ (SOLO LECTURA) ────────────────────────
-- Vacío también.
SELECT a.loan_id,
       a.cuotas_mora AS mora_antes, n.cuotas_mora AS mora_ahora
  FROM public.financiero_antes_085 a
  JOIN public.v_loan_financiero    n ON n.loan_id = a.loan_id
 WHERE a.cuotas_mora IS DISTINCT FROM n.cuotas_mora;


-- ── PASO 9) LOS AJUSTES VOLVIERON A SU CUOTA (SOLO LECTURA) ───────────────
-- Cada ajuste de secretaría con cuota señalada, y el estado de ESA cuota.
-- La columna `dia_del_ajuste` es la fecha con que quedó grabado; `dia_cuota`
-- es el día al que pertenece la cuota que la secretaría señaló. Donde no
-- coincidan es donde el 084 se la había llevado, y ahora ya no.
SELECT l.ruta,
       c.nombre_completo,
       g.fecha_gestion  AS dia_del_ajuste,
       pp.fecha_pago    AS dia_cuota,
       pp.numero_cuota,
       g.monto,
       pp.estado        AS estado_de_la_cuota
  FROM public.gestiones g
  JOIN public.payment_plan pp ON pp.id = g.cuota_objetivo
  JOIN public.loans   l ON l.id = g.loan_id
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE g.origen = 'ajuste'
   AND g.estado = 'aplicada'
   AND g.tipo IN ('pago', 'cancelacion')
   AND g.monto > 0
   AND g.fecha_gestion IS DISTINCT FROM pp.fecha_pago
 ORDER BY l.ruta, c.nombre_completo, pp.numero_cuota;


-- ── PASO 10) Qué cuotas cambiaron (SOLO LECTURA) ──────────────────────────
-- Deberían salir 24 filas en total.
SELECT a.estado_derivado AS antes,
       n.estado_derivado AS ahora,
       COUNT(*)          AS cuantas
  FROM public.cobertura_antes_085 a
  JOIN public.v_cobertura_cuotas  n ON n.id = a.id
 WHERE a.estado_derivado IS DISTINCT FROM n.estado_derivado
 GROUP BY 1, 2
 ORDER BY cuantas DESC;


-- ── PASO 11) LO DEL 084 SIGUE ARREGLADO (SOLO LECTURA) ────────────────────
-- La 190, hoy: `veredicto` tiene que decir 'ok' en TODAS las filas.
SELECT c.nombre_completo,
       pp.numero_cuota,
       pp.estado,
       COALESCE(hoy.cobrado_hoy, 0) AS cobrado_hoy,
       CASE
         WHEN pp.estado = 'pagado'  AND COALESCE(hoy.cobrado_hoy, 0) > 0 THEN 'ok'
         WHEN pp.estado <> 'pagado' AND COALESCE(hoy.cobrado_hoy, 0) = 0 THEN 'ok'
         WHEN pp.estado <> 'pagado' AND COALESCE(hoy.cobrado_hoy, 0) > 0 THEN 'ok (pago parcial)'
         ELSE 'MAL: pagado sin gestion de hoy'
       END AS veredicto
  FROM public.payment_plan pp
  JOIN public.loans   l ON l.id = pp.loan_id
  LEFT JOIN public.clients c ON c.id = l.client_id
  LEFT JOIN LATERAL (
    SELECT SUM(g.monto) AS cobrado_hoy
      FROM public.gestiones g
     WHERE g.loan_id = pp.loan_id
       AND g.fecha_gestion = (now() AT TIME ZONE 'America/Bogota')::date
       AND g.estado = 'aplicada'
       AND g.tipo IN ('pago', 'cancelacion', 'abono_venta')
  ) hoy ON true
 WHERE l.ruta = 190
   AND pp.fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY c.nombre_completo;
