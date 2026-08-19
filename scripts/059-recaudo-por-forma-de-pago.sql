-- ============================================================================
-- 059 - El recaudo del día partido por forma de pago
-- ============================================================================
-- PARA QUÉ
-- En el Resumen del Día hay un cuadro que dice "Capital / Intereses". Ese
-- desglose NO es capital contra interés de cada cuota: es el recaudo partido
-- según el método de amortización del préstamo ('aleman' se rotula "Capital",
-- 'americano' se rotula "Intereses").
--
-- En una unidad que trabaja con UN SOLO método —la 190, por ejemplo, tiene
-- solo cuota fija— ese desglose es degenerado por construcción: una de las
-- dos cajas siempre marca $0 y la otra el total. No informa nada.
--
-- El dueño pidió que en esas unidades el cuadro muestre EFECTIVO y
-- TRANSFERENCIA, que es la forma en que la unidad realmente recaudó. El dato
-- ya existe en `gestiones.metodo_pago`; lo que faltaba era exponerlo.
--
-- DOS DECISIONES QUE VALE LA PENA CONOCER
--   · `metodo_pago` en NULL cuenta como EFECTIVO. Así se capturó siempre
--     antes de que el campo se usara: 148 de 259 pagos lo tienen vacío, y
--     `loans.tipo_venta` solo registra 'efectivo'.
--   · Una REVERSA hereda el método del evento que anula. Su propio
--     `metodo_pago` viene vacío, así que sin esto anular una transferencia
--     restaría del efectivo y descuadraría las dos columnas.
--
-- Se conservan `pago_capital` y `pago_intereses`: las unidades que trabajan
-- con los dos métodos siguen viendo ese desglose, que para ellas sí informa.
--
-- Todo lo demás de la vista queda EXACTAMENTE igual que en el script 056.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Soltar la vista ───────────────────────────────────────────────
-- Las dos columnas nuevas van en medio, y `CREATE OR REPLACE VIEW` sabe
-- agregar al final pero no reordenar.
DROP VIEW IF EXISTS public.resumen_diario_v2;


-- ── PASO 2) La vista ──────────────────────────────────────────────────────
CREATE VIEW public.resumen_diario_v2 AS
WITH anuladas AS (
  -- Gestiones sin efecto: existe una reversa aplicada que las referencia.
  -- Del mismo día que el original (ver script 052).
  SELECT DISTINCT r.referencia_gestion_id AS gestion_id,
         r.fecha_gestion                  AS fecha_reversa
    FROM public.gestiones r
   WHERE r.tipo = 'reversa'
     AND r.estado = 'aplicada'
     AND r.referencia_gestion_id IS NOT NULL
),
cierres AS (
  -- El último día con movimiento de plata de cada préstamo: el que lo dejó
  -- en cero, si es que llegó a cero (ver script 054).
  SELECT g.loan_id,
         MAX(g.fecha_gestion) AS fecha_cierre
    FROM public.gestiones g
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','cancelacion','abono_venta','reversa')
   GROUP BY g.loan_id
),
saldados AS (
  SELECT c.loan_id, c.fecha_cierre
    FROM cierres c
    JOIN public.v_loan_financiero f ON f.loan_id = c.loan_id
   WHERE COALESCE(f.saldo, 0) <= 0
),
canceladas AS (
  SELECT g.fecha_gestion AS fecha, g.ruta,
         COUNT(DISTINCT g.loan_id) AS cantidad_canceladas,
         COALESCE(SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                           WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END), 0) AS valor_canceladas
    FROM public.gestiones g
    JOIN saldados s ON s.loan_id = g.loan_id
                   AND s.fecha_cierre = g.fecha_gestion
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','cancelacion','abono_venta','reversa')
   GROUP BY g.fecha_gestion, g.ruta
),
pagos AS (
  SELECT g.fecha_gestion AS fecha, g.ruta,
         SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END)        AS valor_pago,
         COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta')
                            AND g.monto > 0
                            AND a.gestion_id IS NULL)                      AS cantidad_pagos,
         COUNT(*) FILTER (WHERE g.tipo = 'no_pago'
                            AND a.gestion_id IS NULL)                      AS cantidad_no_pagos,
         SUM(CASE WHEN l.tipo_amortizacion = 'aleman' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS pago_capital,
         SUM(CASE WHEN l.tipo_amortizacion = 'americano' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS pago_intereses,
         -- Recaudo partido por FORMA DE PAGO. Dos decisiones:
         --  · `metodo_pago` en NULL cuenta como efectivo: así se capturó
         --    siempre antes de que el campo se usara (148 de 259 pagos).
         --  · Una REVERSA hereda el método del evento que revierte (`ref`):
         --    su propio `metodo_pago` viene vacío, y sin esto revertir una
         --    transferencia restaría del efectivo.
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) = 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS pago_efectivo,
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) <> 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS pago_transferencia,
         (MAX(g.fecha_hora) AT TIME ZONE 'America/Bogota')::time           AS hora_ultimo_movimiento
    FROM public.gestiones g
    LEFT JOIN public.loans l ON l.id = g.loan_id
    LEFT JOIN anuladas a     ON a.gestion_id = g.id
                            AND a.fecha_reversa = g.fecha_gestion
    LEFT JOIN public.gestiones ref ON ref.id = g.referencia_gestion_id
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
   GROUP BY g.fecha_gestion, g.ruta
),
meta AS (
  SELECT pp.fecha_pago AS fecha, pp.ruta,
         SUM(pp.valor_cuota) AS meta_pagos
    FROM public.payment_plan pp
   GROUP BY pp.fecha_pago, pp.ruta
),
gastos AS (
  SELECT (g.fechahorasol AT TIME ZONE 'America/Bogota')::date AS fecha, g.ruta,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Ingreso'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_ingresos,
         COUNT(*) FILTER (WHERE g.tipo = 'Ingreso'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_ingresos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Gasto'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_gastos,
         COUNT(*) FILTER (WHERE g.tipo = 'Gasto'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_gastos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Retiro'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_retiros,
         COUNT(*) FILTER (WHERE g.tipo = 'Retiro'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_retiros
    FROM public.gastosregistros g
   GROUP BY (g.fechahorasol AT TIME ZONE 'America/Bogota')::date, g.ruta
),
ventas AS (
  -- YA NO se filtran las homologadas: entran en el conteo y en el valor que
  -- muestra el Resumen. Lo que se aparta es `valor_ventas_caja`, que es lo
  -- único que puede restar del efectivo.
  SELECT (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS fecha, l.ruta,
         COUNT(*)                                                          AS cantidad_ventas,
         COALESCE(SUM(l.valor), 0)                                         AS valor_ventas,
         COUNT(*) FILTER (WHERE COALESCE(l.origen,'normal') = 'homologado') AS cantidad_ventas_homologadas,
         COALESCE(SUM(l.valor) FILTER (
           WHERE COALESCE(l.origen,'normal') = 'homologado'), 0)           AS valor_ventas_homologadas,
         -- Solo las ventas que de verdad sacaron plata de la caja de hoy.
         COALESCE(SUM(l.valor) FILTER (
           WHERE COALESCE(l.origen,'normal') <> 'homologado'), 0)          AS valor_ventas_caja
    FROM public.loans l
   GROUP BY (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date, l.ruta
),
base AS (
  SELECT COALESCE(p.fecha, m.fecha, g.fecha, v.fecha) AS fecha_pago,
         COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)  AS ruta,
         COALESCE(m.meta_pagos, 0)          AS meta_pagos,
         COALESCE(p.valor_pago, 0)          AS valor_pago,
         COALESCE(p.cantidad_pagos, 0)      AS cantidad_pagos,
         COALESCE(p.cantidad_no_pagos, 0)   AS cantidad_no_pagos,
         COALESCE(c.cantidad_canceladas, 0) AS cantidad_canceladas,
         COALESCE(c.valor_canceladas, 0)    AS valor_canceladas,
         COALESCE(p.pago_capital, 0)        AS pago_capital,
         COALESCE(p.pago_intereses, 0)      AS pago_intereses,
         COALESCE(p.pago_efectivo, 0)       AS pago_efectivo,
         COALESCE(p.pago_transferencia, 0)  AS pago_transferencia,
         p.hora_ultimo_movimiento,
         COALESCE(g.valor_ingresos, 0)      AS valor_ingresos,
         COALESCE(g.cantidad_ingresos, 0)   AS cantidad_ingresos,
         COALESCE(g.valor_gastos, 0)        AS valor_gastos,
         COALESCE(g.cantidad_gastos, 0)     AS cantidad_gastos,
         COALESCE(g.valor_retiros, 0)       AS valor_retiros,
         COALESCE(g.cantidad_retiros, 0)    AS cantidad_retiros,
         COALESCE(v.cantidad_ventas, 0)     AS cantidad_ventas,
         COALESCE(v.valor_ventas, 0)        AS valor_ventas,
         COALESCE(v.cantidad_ventas_homologadas, 0) AS cantidad_ventas_homologadas,
         COALESCE(v.valor_ventas_homologadas, 0)    AS valor_ventas_homologadas,
         COALESCE(v.valor_ventas_caja, 0)           AS valor_ventas_caja
    FROM pagos p
    FULL JOIN meta   m ON m.fecha = p.fecha AND m.ruta = p.ruta
    FULL JOIN gastos g ON g.fecha = COALESCE(p.fecha, m.fecha)
                      AND g.ruta  = COALESCE(p.ruta,  m.ruta)
    FULL JOIN ventas v ON v.fecha = COALESCE(p.fecha, m.fecha, g.fecha)
                      AND v.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta)
    LEFT JOIN canceladas c ON c.fecha = COALESCE(p.fecha, m.fecha, g.fecha, v.fecha)
                          AND c.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)
)
SELECT b.*,
       -- OJO: acá va `valor_ventas_caja`, NO `valor_ventas`. Es la diferencia
       -- entre mostrar una homologada y descontarla de una plata que nunca
       -- salió de la caja.
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)   AS efectivo,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)
       - (b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
          - b.valor_gastos - b.valor_retiros)               AS caja_anterior,
       -- Alias con los nombres de la vista vieja.
       b.cantidad_ingresos AS recuento_ingresos,
       b.cantidad_gastos   AS recuento_gastos,
       b.cantidad_retiros  AS recuento_retiros
  FROM base b
 ORDER BY b.fecha_pago DESC, b.ruta;


-- ── PASO 3) Permisos ──────────────────────────────────────────────────────
GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated;


-- ── PASO 4) Verificar ─────────────────────────────────────────────────────
-- EL INVARIANTE: las dos formas de pago tienen que sumar exactamente el
-- recaudo del día. Si alguna fila dice "*** revisar ***", hay un método de
-- pago con un valor que no se está clasificando.
SELECT fecha_pago, ruta,
       valor_pago,
       pago_efectivo,
       pago_transferencia,
       CASE WHEN valor_pago = pago_efectivo + pago_transferencia
            THEN 'ok' ELSE '*** revisar ***' END AS cuadra
  FROM public.resumen_diario_v2
 WHERE valor_pago <> 0
 ORDER BY fecha_pago DESC, ruta
 LIMIT 40;
