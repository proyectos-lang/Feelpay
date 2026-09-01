-- ============================================================================
-- 084 - LA REGLA DE ORO: la plata se queda en el día en que se pagó
-- ============================================================================
-- LO QUE SE PIDIÓ
-- "Si un cliente hoy paga 5.000 y su cuota es de 1.000, esos 5.000 quedan
--  pagos única y exclusivamente el día de hoy. El monto no debe quedar en
--  otras fechas, ni antes ni adelante. Para la cantidad de cuotas pagas
--  simplemente se toma 5.000/1.000 = 5. Pero nunca, bajo ninguna
--  circunstancia, se toca la cuota de los días siguientes."
--
-- POR QUÉ TODAVÍA PASABA
-- El script 075 ya aplicó esta regla, pero solo a los COBROS DE CAMPO. Dejó
-- dos excepciones que seguían cayendo en cascada sobre las cuotas siguientes:
-- el ABONO DE LA VENTA y la HISTORIA MIGRADA. Medido contra la base:
--
--   abono de venta      79 eventos   $5.698.936   en 79 créditos
--   historia migrada   191 eventos   $3.632.797   en 32 créditos
--
-- Eso es lo que hacía que la 190, recién abierta el 01/09/2026 y sin un solo
-- pago registrado, tuviera 19 cuotas de HOY marcadas 'pagado'. Un crédito con
-- un abono de venta de $508.800 llevaba cubiertas las cuotas hasta el 10 de
-- septiembre.
--
-- Este script quita la cascada ENTERA. No queda ni un camino por el que la
-- plata de un día pueda caer sobre la cuota de otro.
--
-- CÓMO SE UBICA CADA PESO, AHORA: MANDA LA FECHA
-- Un evento cae en la cuota cuyo `fecha_pago` es su `fecha_gestion`. El día
-- en que se pagó, y nada más. Si ese día no tiene cuota en el cronograma, no
-- marca ninguna: baja el saldo y ya.
--
-- `cuota_objetivo` DEJA DE DECIDIR dónde cae la plata. Sigue guardándose en el
-- libro como la pista que era, pero no reparte.
--
-- Esto no es un detalle: es la mitad del arreglo, y lo demostró la simulación
-- contra la base ANTES de correr nada. De 560 cobros con puntero:
--
--   328 campo   el puntero es el día del pago      (coinciden, da igual)
--   217 campo   el puntero apunta ADELANTE          <-- LA FUGA
--    15 campo   el puntero apunta atrás
--    30 ajuste  el puntero es el día del pago
--    31 ajuste  el puntero apunta atrás
--
-- Esos 217 son el mismo mecanismo del problema: el cliente iba adelantado, la
-- app le señaló la cuota siguiente, y el pago de AYER quedó clavado en la
-- cuota de HOY. Dejando mandar al puntero, 12 cuotas de la 190 seguían hoy en
-- 'pagado' sin un solo peso cobrado hoy. Con la fecha mandando, quedan CERO.
--
-- No rompe las correcciones de secretaría: el script 066 ya estableció que un
-- ajuste "se registra en el día de LA CUOTA" — la fecha y la cuota coinciden
-- por construcción desde entonces.
--
-- EL ABONO DE LA VENTA se hace el día de la venta y la primera cuota vence al
-- día siguiente, así que no cae en ninguna cuota: 77 abonos por $5.698.915.
-- Su plata sigue contando entera para el saldo —no se pierde un peso— pero
-- deja de adelantar cuotas.
--
-- LO QUE NO SE TOCA, Y ESTÁ COMPROBADO EN LOS PASOS 8 Y 9
--   · El SALDO. Sale de `pagado_neto`, no del reparto.
--   · La MORA. Sale de (lo vencido a la fecha − lo pagado), tampoco del reparto.
--   · La caja, el recaudo y el cierre. Nada de eso mira las cuotas.
-- Los dos pasos de verificación exigen que salga CERO diferencias. Si sale
-- cualquier otra cosa, no sigas: algo se movió que no debía.
--
-- LO QUE SÍ CAMBIA, SIMULADO CONTRA LA BASE ANTES DE CORRER NADA
--   cuotas que cambian de estado : 988
--        pagado  -> pendiente  839      pagado  -> parcial    50
--        parcial -> pendiente   26      pagado  -> no_pago    25
--        parcial -> no_pago     18      pendiente -> pagado   16
--        parcial -> pagado       5      pendiente -> parcial   4
--        no_pago -> pagado       3      cancelada -> pagado    1
--        pagado  -> cancelada    1
--
--   Y LA PRUEBA QUE IMPORTA, sobre la 190 del 01/09/2026:
--        cuotas de HOY marcadas 'pagado' SIN gestión de hoy
--            antes : 19
--            ahora :  0
--
-- Es la consecuencia directa de la regla: el cliente que pagó cinco cuotas de
-- una marca UN día, no cinco. Por eso el contador X/Y deja de contar filas y
-- pasa a ser plata/valor de la cuota, que es exactamente el 5.000/1.000 = 5
-- que se pidió.
--
-- CÓMO SE DESHACE
-- Todo esto es DERIVADO: dos vistas y un cache que reconstruye
-- `recalcular_prestamo`. Para volver atrás se corren otra vez los pasos 3 y 4
-- del script 075 y el paso 3 del 043, y el paso 7 de acá. No hay un solo dato
-- que se borre.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Foto del reparto de AHORA ─────────────────────────────────────
DROP TABLE IF EXISTS public.cobertura_antes_084;


-- ── PASO 2) Guardarla ─────────────────────────────────────────────────────
CREATE TABLE public.cobertura_antes_084 AS
SELECT id, loan_id, numero_cuota, fecha_pago, monto_asignado, estado_derivado
  FROM public.v_cobertura_cuotas;


-- ── PASO 3) Foto de la plata de AHORA ─────────────────────────────────────
-- Es la que prueba, en los pasos 8 y 9, que no se movió un peso.
DROP TABLE IF EXISTS public.financiero_antes_084;


-- ── PASO 4) Guardarla ─────────────────────────────────────────────────────
CREATE TABLE public.financiero_antes_084 AS
SELECT loan_id, total_pagado, saldo, saldo_hoy, saldo_en_mora, cuotas_mora,
       cuotas_cubiertas
  FROM public.v_loan_financiero;


-- ── PASO 5) EL REPARTO NUEVO: sin cascada, en ningún caso ─────────────────
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
  -- CADA PESO, EN EL DÍA EN QUE SE PAGÓ. Sin excepciones y sin punteros.
  --
  -- La reversa que trae `referencia_gestion_id` NO resta acá: ya sacó a su
  -- evento de `vivos`, y restar otra vez descontaría dos veces la misma plata.
  -- Las otras —las que genera el ajuste de secretaría— sí restan, en su propio
  -- día. Comprobado contra la base: de 196 reversas aplicadas, 155 traen
  -- referencia, 28 traen cuota, 13 no traen ninguna, y NINGUNA trae las dos.
  SELECT v.loan_id,
         v.tipo,
         v.monto,
         d.id AS cuota_id
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


-- ── PASO 6) EL CONTADOR X/Y: plata dividida por el valor de la cuota ──────
-- Es la definición del 043 con UNA línea cambiada, la de `cuotas_cubiertas`.
-- El resto va letra por letra como estaba.
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
      -- CUOTAS PAGADAS = PLATA / VALOR DE LA CUOTA.
      -- Ya no se cuentan las filas marcadas: con la regla de oro, el que paga
      -- cinco cuotas de una marca UN día del cronograma, y contar filas diría
      -- que pagó una. Se topa en el total para que nunca diga 27/25.
      LEAST(COALESCE(cob.totales, 0),
            FLOOR(COALESCE(n.pagado_neto, 0)
                  / NULLIF(cref.valor_ref, 0)))::bigint                     AS cuotas_cubiertas,
      COALESCE(cob.totales, 0)                                            AS cuotas_totales,
      COALESCE(cob.extras, 0)                                             AS cuotas_extra
  FROM public.loans l
  LEFT JOIN public.v_pagos_netos n ON n.loan_id = l.id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pp.valor_cuota), 0) AS total_vencido
      FROM public.payment_plan pp
    WHERE pp.loan_id = l.id
      AND pp.fecha_pago < (now() AT TIME ZONE 'America/Bogota')::date
  ) venc ON true
  LEFT JOIN LATERAL (
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

-- ── PASO 7) Rehacer el cache de todos los préstamos ───────────────────────
-- `payment_plan.estado`, `payment_plan.monto_pagado`, `loans.saldo` y
-- `loans.estado` son un CACHE que solo escribe `recalcular_prestamo`. Las
-- vistas ya cambiaron; sin esto las tablas seguirían con el reparto viejo.
SELECT public.recalcular_prestamo(id) FROM public.loans;


-- ── PASO 8) QUE NO SE MOVIÓ UN PESO (SOLO LECTURA) ────────────────────────
-- TIENE QUE SALIR VACÍO. Si sale una sola fila, no sigas: el reparto cambió
-- el saldo de alguien, y eso no puede pasar — el saldo sale de la plata.
SELECT a.loan_id,
       a.total_pagado AS pagado_antes, n.total_pagado AS pagado_ahora,
       a.saldo        AS saldo_antes,  n.saldo        AS saldo_ahora,
       a.saldo_hoy    AS hoy_antes,    n.saldo_hoy    AS hoy_ahora
  FROM public.financiero_antes_084 a
  JOIN public.v_loan_financiero    n ON n.loan_id = a.loan_id
 WHERE a.total_pagado IS DISTINCT FROM n.total_pagado
    OR a.saldo        IS DISTINCT FROM n.saldo
    OR a.saldo_hoy    IS DISTINCT FROM n.saldo_hoy;


-- ── PASO 9) QUE LA MORA NO SE MOVIÓ (SOLO LECTURA) ────────────────────────
-- TAMBIÉN TIENE QUE SALIR VACÍO, por la misma razón.
SELECT a.loan_id,
       a.cuotas_mora   AS mora_antes,   n.cuotas_mora   AS mora_ahora,
       a.saldo_en_mora AS enmora_antes, n.saldo_en_mora AS enmora_ahora
  FROM public.financiero_antes_084 a
  JOIN public.v_loan_financiero    n ON n.loan_id = a.loan_id
 WHERE a.cuotas_mora   IS DISTINCT FROM n.cuotas_mora
    OR a.saldo_en_mora IS DISTINCT FROM n.saldo_en_mora;


-- ── PASO 10) Ninguna cuota puede tener más de lo que vale (SOLO LECTURA) ──
-- Vacío también.
SELECT id, loan_id, numero_cuota, valor_cuota, monto_asignado
  FROM public.v_cobertura_cuotas
 WHERE monto_asignado > valor_cuota + 1;


-- ── PASO 11) LA PRUEBA DE FUEGO: hoy, cuota por cuota (SOLO LECTURA) ──────
-- Para cada crédito de la 190 cuya cuota vence HOY: si la cuota está 'pagado'
-- tiene que haber un pago de HOY, y al revés.
--
-- `veredicto` tiene que decir 'ok' en TODAS las filas.
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


-- ── PASO 12) Qué cuotas cambiaron, en una línea (SOLO LECTURA) ────────────
-- Deberían salir 988 filas en total, 839 de ellas 'pagado -> pendiente'.
-- Si sale MUCHO más, para: algo se movió que la simulación no previó.
SELECT a.estado_derivado AS antes,
       n.estado_derivado AS ahora,
       COUNT(*)          AS cuantas
  FROM public.cobertura_antes_084 a
  JOIN public.v_cobertura_cuotas  n ON n.id = a.id
 WHERE a.estado_derivado IS DISTINCT FROM n.estado_derivado
 GROUP BY 1, 2
 ORDER BY cuantas DESC;


-- ── PASO 13) Y el contador X/Y, que ahora sale de la plata (SOLO LECTURA) ─
-- `cubiertas_ahora` debe ser lo pagado dividido por el valor de la cuota. Es
-- lo que se pidió: 5.000 sobre una cuota de 1.000 son 5 cuotas.
SELECT l.ruta,
       c.nombre_completo,
       a.cuotas_cubiertas AS cubiertas_antes,
       n.cuotas_cubiertas AS cubiertas_ahora,
       n.cuotas_totales,
       n.total_pagado,
       n.saldo
  FROM public.financiero_antes_084 a
  JOIN public.v_loan_financiero    n ON n.loan_id = a.loan_id
  JOIN public.loans   l ON l.id = a.loan_id
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'activo'
   AND a.cuotas_cubiertas IS DISTINCT FROM n.cuotas_cubiertas
 ORDER BY l.ruta, c.nombre_completo;
