-- ============================================================================
-- 054 - "Canceladas" = lo que se cobró el día que el préstamo quedó en cero
-- ============================================================================
-- EL SÍNTOMA
-- Se salda un préstamo y el Resumen del Día muestra «Canceladas: $0».
--
-- LA CAUSA
-- `valor_canceladas` contaba SOLO los eventos de tipo 'cancelacion', que es
-- lo que se registra al marcar la casilla "Cancelada" en el diálogo de pago.
-- Pero un préstamo también queda saldado con pagos normales: cuando el neto
-- llega al total a pagar, `recalcular_prestamo` lo pasa a 'cancelado' sin
-- que exista ningún evento de ese tipo.
--
-- En esta base eso no es un caso raro, es EL caso: 131 pagos, 19 no pagos y
-- CERO eventos 'cancelacion' en toda la historia. La fila "Canceladas" del
-- Resumen mostraba $0 siempre.
--
-- LA DEFINICIÓN NUEVA
-- Una cancelación es un préstamo que quedó en saldo cero, y su valor es LO
-- QUE SE COBRÓ ESE DÍA — no el total del préstamo.
--
-- Ejemplo real que motivó el cambio: un préstamo de $840.000 con $654.000 de
-- abono inicial ayer y $186.000 cobrados hoy. "Canceladas" muestra $186.000,
-- que es la plata que entró hoy, no $840.000.
--
-- OJO: "Canceladas" es un SUBCONJUNTO de "Recaudado", no un renglón aparte
-- que se sume. Esa plata ya está contada en `valor_pago`. La pantalla ya lo
-- trataba así — la barra de Canceladas se escala contra el total recaudado.
--
-- Correr los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Soltar la vista ───────────────────────────────────────────────
DROP VIEW IF EXISTS public.resumen_diario_v2;


-- ── PASO 2) La vista ──────────────────────────────────────────────────────
CREATE VIEW public.resumen_diario_v2 AS
WITH anuladas AS (
  -- Gestiones sin efecto: existe una reversa aplicada que las referencia.
  -- Se guarda la fecha de la reversa para exigir que sea del mismo día que
  -- el original (ver el encabezado del script 052).
  SELECT DISTINCT r.referencia_gestion_id AS gestion_id,
         r.fecha_gestion                  AS fecha_reversa
    FROM public.gestiones r
   WHERE r.tipo = 'reversa'
     AND r.estado = 'aplicada'
     AND r.referencia_gestion_id IS NOT NULL
),
-- ── Los préstamos que quedaron saldados, y el día en que se saldaron ──────
-- El día de cierre es el ÚLTIMO con movimiento de plata: es el que dejó el
-- saldo en cero. Se excluye 'homologacion' igual que en el resto de la
-- vista — esa plata se recibió en el sistema anterior y no pasó por esta
-- caja, así que no puede aparecer como recaudo de ningún día de acá.
cierres AS (
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
-- Lo cobrado el día del cierre, por ruta. Un préstamo cuenta una sola vez.
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
         (MAX(g.fecha_hora) AT TIME ZONE 'America/Bogota')::time           AS hora_ultimo_movimiento
    FROM public.gestiones g
    LEFT JOIN public.loans l ON l.id = g.loan_id
    LEFT JOIN anuladas a     ON a.gestion_id = g.id
                            AND a.fecha_reversa = g.fecha_gestion
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
  SELECT (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS fecha, l.ruta,
         COUNT(*)                 AS cantidad_ventas,
         COALESCE(SUM(l.valor),0) AS valor_ventas
    FROM public.loans l
   WHERE COALESCE(l.origen, 'normal') <> 'homologado'
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
         p.hora_ultimo_movimiento,
         COALESCE(g.valor_ingresos, 0)      AS valor_ingresos,
         COALESCE(g.cantidad_ingresos, 0)   AS cantidad_ingresos,
         COALESCE(g.valor_gastos, 0)        AS valor_gastos,
         COALESCE(g.cantidad_gastos, 0)     AS cantidad_gastos,
         COALESCE(g.valor_retiros, 0)       AS valor_retiros,
         COALESCE(g.cantidad_retiros, 0)    AS cantidad_retiros,
         COALESCE(v.cantidad_ventas, 0)     AS cantidad_ventas,
         COALESCE(v.valor_ventas, 0)        AS valor_ventas
    FROM pagos p
    FULL JOIN meta   m ON m.fecha = p.fecha AND m.ruta = p.ruta
    FULL JOIN gastos g ON g.fecha = COALESCE(p.fecha, m.fecha)
                      AND g.ruta  = COALESCE(p.ruta,  m.ruta)
    FULL JOIN ventas v ON v.fecha = COALESCE(p.fecha, m.fecha, g.fecha)
                      AND v.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta)
    -- LEFT y no FULL: una cancelación siempre tiene su pago del día en
    -- `pagos`, así que nunca puede aparecer una fecha que no exista ya.
    LEFT JOIN canceladas c ON c.fecha = COALESCE(p.fecha, m.fecha, g.fecha, v.fecha)
                          AND c.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)
)
SELECT b.*,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)   AS efectivo,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)
       - (b.valor_ingresos + b.valor_pago - b.valor_ventas
          - b.valor_gastos - b.valor_retiros)               AS caja_anterior,
       -- Alias con los nombres de la vista vieja. Se conservan para que
       -- ninguna pantalla quede colgada; los nombres buenos son `cantidad_*`.
       b.cantidad_ingresos AS recuento_ingresos,
       b.cantidad_gastos   AS recuento_gastos,
       b.cantidad_retiros  AS recuento_retiros
  FROM base b
 ORDER BY b.fecha_pago DESC, b.ruta;


-- ── PASO 3) Permisos ──────────────────────────────────────────────────────
-- El DROP se lleva los GRANT, hay que volver a darlos o la app deja de leer.
GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated;


-- ── PASO 4) Verificar ─────────────────────────────────────────────────────
-- Los días con préstamos saldados, con lo que se cobró ese día.
-- `valor_canceladas` NUNCA debe superar a `valor_pago`: es un subconjunto.
SELECT fecha_pago, ruta, cantidad_pagos, valor_pago,
       cantidad_canceladas, valor_canceladas,
       valor_canceladas <= valor_pago AS es_subconjunto
  FROM public.resumen_diario_v2
 WHERE cantidad_canceladas > 0
 ORDER BY fecha_pago DESC, ruta
 LIMIT 20;
