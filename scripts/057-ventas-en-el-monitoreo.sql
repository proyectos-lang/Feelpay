-- ============================================================================
-- 057 - El Monitoreo de Rutas mostraba solo una parte de las ventas del día
-- ============================================================================
-- EL SÍNTOMA
-- Ruta 933, 18/08/2026: Monitoreo de Rutas dice "Ventas $600", pero la
-- pestaña "Ventas del día" del módulo de pagos dice $1.635. El mismo día, la
-- misma ruta, dos números distintos.
--
-- LA CAUSA — eran DOS diferencias sumadas
--
--   1. `vista_monitoreo_admin` excluía las ventas HOMOLOGADAS. Ese día hubo
--      6 ventas: 5 homologadas y 1 normal. El monitoreo mostraba la normal y
--      nada más. (El script 056 ya había resuelto esto mismo en el Resumen
--      del Día, pero la vista del monitoreo se quedó atrás.)
--
--   2. Sumaba `valor_a_pagar` — el total CON intereses — mientras el resto de
--      la app suma `valor`, que es el capital que de verdad se prestó. De ahí
--      $600 en vez de $500 para esa única venta.
--
--   6 ventas → $1.635 de capital, contra $600 de una sola con intereses.
--
-- LA CORRECCIÓN
-- `total_ventas` pasa a ser el capital prestado del día, homologadas
-- incluidas: el mismo criterio que usan "Ventas del día" (suma de `valor`) y
-- `resumen_diario_v2.valor_ventas`. Los tres dicen ahora el mismo número.
--
-- Se agregan al final `total_ventas_homologadas` y
-- `cantidad_ventas_homologadas` para poder explicar la parte que no salió de
-- la caja de hoy, igual que se hizo en el Resumen.
--
-- POR QUÉ ES SEGURO
-- `total_ventas` de esta vista solo se MUESTRA: se verificó que
-- `admin-route-monitor.tsx` la pinta y nunca la usa en una cuenta. El efectivo
-- no se calcula acá — eso vive en `resumen_diario_v2`, que ya descuenta solo
-- las ventas que sacaron plata de la caja (`valor_ventas_caja`).
--
-- Se cambia además `created_at` por `fecha_creacion`, que es la columna que
-- usa el resto de la app. Se verificó en la base que hoy son idénticas en las
-- 108 filas y que ninguna tiene `fecha_creacion` nula, así que el cambio no
-- mueve ninguna venta de día.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 0) Soltar la versión anterior ────────────────────────────────────
-- `CREATE OR REPLACE VIEW` no sabe reordenar ni renombrar columnas, solo
-- agregarlas al final. Soltarla primero deja este script re-ejecutable.
DROP VIEW IF EXISTS public.vista_monitoreo_admin;


-- ── PASO 1) La vista ──────────────────────────────────────────────────────
CREATE VIEW public.vista_monitoreo_admin AS
WITH pagos_resumen AS (
  SELECT g.ruta, g.fecha_gestion AS fecha,
         COALESCE(SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                           WHEN g.tipo = 'reversa' THEN -g.monto
                           ELSE 0 END), 0)                                  AS total_recaudado,
         COUNT(*) FILTER (WHERE g.tipo IN ('pago','cancelacion','abono_venta')
                            AND g.monto > 0)                                AS pagos_exitosos,
         COUNT(*) FILTER (WHERE g.tipo = 'no_pago')                         AS visitas_sin_pago
    FROM public.gestiones g
   WHERE g.estado = 'aplicada' AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
   GROUP BY g.ruta, g.fecha_gestion
),
pendientes_resumen AS (
  SELECT pp.ruta, pp.fecha_pago AS fecha,
         COUNT(*) FILTER (WHERE pp.estado = 'pendiente') AS pendientes_por_visitar
    FROM public.payment_plan pp
   GROUP BY pp.ruta, pp.fecha_pago
),
transacciones_resumen AS (
  SELECT g.ruta,
         (g.fechahorasol AT TIME ZONE 'America/Bogota')::date AS fecha_transaccion,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Ingreso'), 0) AS total_ingresos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Gasto'),   0) AS total_gastos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Retiro'),  0) AS total_retiros
    FROM public.gastosregistros g
   GROUP BY g.ruta, (g.fechahorasol AT TIME ZONE 'America/Bogota')::date
),
ventas_resumen AS (
  -- CAPITAL PRESTADO del día, homologadas incluidas: el mismo criterio de
  -- "Ventas del día" y de `resumen_diario_v2.valor_ventas`.
  SELECT l.ruta,
         (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS fecha_venta,
         COALESCE(SUM(l.valor), 0)  AS total_ventas,
         COUNT(l.id)                AS cantidad_ventas,
         COALESCE(SUM(l.valor) FILTER (WHERE COALESCE(l.origen,'normal') = 'homologado'), 0)
                                    AS total_ventas_homologadas,
         COUNT(l.id) FILTER (WHERE COALESCE(l.origen,'normal') = 'homologado')
                                    AS cantidad_ventas_homologadas
    FROM public.loans l
   GROUP BY l.ruta, (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date
)
SELECT rd.id     AS registro_id,
       rd.fecha,
       rd.ruta_id,
       rd.estado AS estado_ruta,
       rd.hora_inicio,
       rd.hora_fin,
       COALESCE(pr.total_recaudado, 0)                AS total_recaudado,
       COALESCE(pr.pagos_exitosos, 0::bigint)         AS pagos_exitosos,
       COALESCE(pr.visitas_sin_pago, 0::bigint)       AS visitas_sin_pago,
       COALESCE(pd.pendientes_por_visitar, 0::bigint) AS pendientes_por_visitar,
       rd.aprobacion_admin,
       COALESCE(tr.total_ingresos, 0)                 AS total_ingresos,
       COALESCE(tr.total_gastos, 0)                   AS total_gastos,
       COALESCE(tr.total_retiros, 0)                  AS total_retiros,
       COALESCE(vr.total_ventas, 0)                   AS total_ventas,
       COALESCE(vr.cantidad_ventas, 0::bigint)        AS cantidad_ventas,
       COALESCE(vr.total_ventas_homologadas, 0)       AS total_ventas_homologadas,
       COALESCE(vr.cantidad_ventas_homologadas, 0::bigint) AS cantidad_ventas_homologadas
  FROM public.rutas_diarias rd
  LEFT JOIN pagos_resumen         pr ON rd.ruta_id = pr.ruta AND rd.fecha = pr.fecha
  LEFT JOIN pendientes_resumen    pd ON rd.ruta_id = pd.ruta AND rd.fecha = pd.fecha
  LEFT JOIN transacciones_resumen tr ON rd.ruta_id = tr.ruta AND rd.fecha = tr.fecha_transaccion
  LEFT JOIN ventas_resumen        vr ON rd.ruta_id = vr.ruta AND rd.fecha = vr.fecha_venta;


-- ── PASO 2) Lectura para la app ───────────────────────────────────────────
GRANT SELECT ON public.vista_monitoreo_admin TO anon, authenticated;


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
-- Las dos columnas deben coincidir. Antes, la ruta 933 del 18/08 daba
-- monitoreo=600 contra resumen=1635.
SELECT m.ruta_id, m.fecha,
       m.total_ventas          AS monitoreo,
       r.valor_ventas          AS resumen_del_dia,
       m.cantidad_ventas       AS cant_monitoreo,
       r.cantidad_ventas       AS cant_resumen,
       CASE WHEN COALESCE(m.total_ventas,0) = COALESCE(r.valor_ventas,0)
             AND COALESCE(m.cantidad_ventas,0) = COALESCE(r.cantidad_ventas,0)
            THEN 'ok' ELSE '*** revisar ***' END AS estado
  FROM public.vista_monitoreo_admin m
  LEFT JOIN public.resumen_diario_v2 r
         ON r.ruta = m.ruta_id AND r.fecha_pago = m.fecha
 WHERE m.total_ventas > 0 OR r.valor_ventas > 0
 ORDER BY m.fecha DESC, m.ruta_id;
