-- ============================================================================
-- 052 - El Resumen del Día no puede contar gestiones anuladas
-- ============================================================================
-- EL SÍNTOMA
-- El cobrador anula un pago desde el módulo de pagos y el Resumen del Día
-- sigue diciendo que hubo 3 pagos cuando en la calle hubo 2.
--
-- LA CAUSA
-- En `resumen_diario_v2` (script 048) la PLATA y el CONTEO no se calculaban
-- con la misma regla:
--
--   valor_pago      → pago suma, reversa RESTA        ✓ correcto
--   cantidad_pagos  → COUNT de las filas tipo 'pago'  ✗ nunca miraba la reversa
--
-- Anular no borra nada: registra un evento `reversa` que apunta al original
-- con `referencia_gestion_id`. Como el COUNT solo filtraba por `tipo`, el pago
-- anulado seguía contando. Se veía clarísimo en producción: una ruta con 3
-- pagos y 3 reversas mostraba `cantidad_pagos = 3` junto a `valor_pago = 0`.
--
-- El mismo defecto afectaba a `cantidad_no_pagos`, `cantidad_canceladas` y
-- `valor_canceladas` — este último ni siquiera restaba las reversas, así que
-- una cancelación anulada inflaba el total de canceladas.
--
-- LA REGLA QUE SE APLICA, Y POR QUÉ ES "DEL MISMO DÍA"
-- Una gestión se descuenta de los conteos cuando existe una reversa aplicada
-- que la referencia Y que cae en el MISMO `fecha_gestion`.
--
-- El "mismo día" no es un detalle menor: la plata de una reversa se registra
-- el día en que se anuló, no el día del pago original. Si se descontara el
-- conteo de un día pasado dejando su plata intacta, ese día quedaría diciendo
-- "2 pagos" con la suma de 3 — que es el mismo desajuste que este script
-- viene a arreglar, solo que al revés. Con la regla del mismo día, conteo y
-- plata siempre cuentan la misma historia:
--
--   Pago y anulación el mismo día → el día no registra ni el pago ni la plata.
--   Pago ayer, anulación hoy      → ayer conserva su pago y su plata (era real
--                                   cuando se cerró), y hoy aparece el ajuste
--                                   en negativo. Ningún día cerrado se
--                                   reescribe hacia atrás.
--
-- `valor_pago` NO se toca: ya neteaba bien, y además maneja las reversas sin
-- referencia (ajustes de dinero de secretaría), que no anulan a nadie.
--
-- Correr los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Soltar la vista ───────────────────────────────────────────────
-- `CREATE OR REPLACE VIEW` no permite reordenar ni renombrar columnas, y esta
-- vista tiene alias de compatibilidad al final. Soltarla primero hace que el
-- script se pueda volver a correr siempre. Es seguro: ninguna otra vista ni
-- función depende de ella, la app la consulta en caliente.
DROP VIEW IF EXISTS public.resumen_diario_v2;


-- ── PASO 2) La vista, con los conteos corregidos ──────────────────────────
CREATE VIEW public.resumen_diario_v2 AS
WITH anuladas AS (
  -- Gestiones que quedaron sin efecto: existe una reversa aplicada que las
  -- referencia. Se guarda también la fecha de la reversa para poder exigir
  -- que sea del mismo día que el original.
  SELECT DISTINCT r.referencia_gestion_id AS gestion_id,
         r.fecha_gestion                  AS fecha_reversa
    FROM public.gestiones r
   WHERE r.tipo = 'reversa'
     AND r.estado = 'aplicada'
     AND r.referencia_gestion_id IS NOT NULL
),
pagos AS (
  SELECT g.fecha_gestion AS fecha, g.ruta,
         SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END)        AS valor_pago,
         -- `a.gestion_id IS NULL` = esta gestión no fue anulada en su día.
         COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta')
                            AND g.monto > 0
                            AND a.gestion_id IS NULL)                      AS cantidad_pagos,
         COUNT(*) FILTER (WHERE g.tipo = 'no_pago'
                            AND a.gestion_id IS NULL)                      AS cantidad_no_pagos,
         COUNT(*) FILTER (WHERE g.tipo = 'cancelacion'
                            AND a.gestion_id IS NULL)                      AS cantidad_canceladas,
         COALESCE(SUM(g.monto) FILTER (WHERE g.tipo = 'cancelacion'
                            AND a.gestion_id IS NULL), 0)                  AS valor_canceladas,
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
         COALESCE(p.cantidad_canceladas, 0) AS cantidad_canceladas,
         COALESCE(p.valor_canceladas, 0)    AS valor_canceladas,
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
-- Compara, día por día, lo que cuenta la vista contra los pagos que quedaron
-- vivos. `pagos_anulados` es cuántos dejó de contar el arreglo: donde sea > 0,
-- antes de este script `cantidad_pagos` estaba inflado en esa cantidad.
--
-- Debe dar `cuadra = true` en TODAS las filas.
SELECT r.fecha_pago,
       r.ruta,
       r.cantidad_pagos,
       r.valor_pago,
       COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta') AND g.monto > 0
                          AND a.gestion_id IS NOT NULL)            AS pagos_anulados,
       COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta') AND g.monto > 0
                          AND a.gestion_id IS NULL)                AS pagos_vivos,
       r.cantidad_pagos = COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta')
                          AND g.monto > 0 AND a.gestion_id IS NULL) AS cuadra
  FROM public.resumen_diario_v2 r
  LEFT JOIN public.gestiones g
         ON g.fecha_gestion = r.fecha_pago
        AND g.ruta = r.ruta
        AND g.estado = 'aplicada'
        AND g.origen <> 'homologacion'
  LEFT JOIN (
        SELECT DISTINCT r2.referencia_gestion_id AS gestion_id, r2.fecha_gestion AS fecha_reversa
          FROM public.gestiones r2
         WHERE r2.tipo = 'reversa' AND r2.estado = 'aplicada'
           AND r2.referencia_gestion_id IS NOT NULL
       ) a ON a.gestion_id = g.id AND a.fecha_reversa = g.fecha_gestion
 WHERE r.fecha_pago >= (now() AT TIME ZONE 'America/Bogota')::date - 7
 GROUP BY r.fecha_pago, r.ruta, r.cantidad_pagos, r.valor_pago
 ORDER BY r.fecha_pago DESC, r.ruta;
