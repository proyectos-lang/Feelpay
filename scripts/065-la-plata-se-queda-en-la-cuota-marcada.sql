-- ============================================================================
-- 065 - La plata de Control de Pagos se queda en la cuota que se marcó
-- ============================================================================
-- LO QUE SE REPORTÓ
-- "Un cliente debía el 20, 21 y 22. Le apliqué 30.000 al 22 y en vez de
-- quedar ahí, se fue a los dos días anteriores."
--
-- POR QUÉ PASABA
-- `v_cobertura_cuotas` reparte TODA la plata del préstamo de la cuota más
-- vieja hacia adelante. Es la cascada, y para un pago de campo está bien: el
-- que debe tres días y paga uno, abona a lo más viejo.
--
-- Pero `ajustar_cuota_control_pagos` calculaba cuánto insertar como si esa
-- plata fuera a caer en LA cuota marcada: veía "esta cuota tiene 0 asignado,
-- faltan 30.000" y metía un pago de 30.000. Después la cascada lo repartía
-- desde la más vieja y la cuota marcada seguía pendiente — y el módulo decía
-- que había guardado bien.
--
-- Peor: al reintentar, metía OTROS 30.000 que volvían a caer en las viejas.
-- En el préstamo del reporte se ve la pelea — un pago de 30.000 y detrás
-- reversas de 19.500 y 11.000 deshaciéndolo.
--
-- LA CORRECCIÓN
-- La plata se parte en dos bolsas:
--
--   DIRIGIDA → los pagos que secretaría clavó en una cuota desde Control de
--              Pagos (`origen = 'ajuste'` con `cuota_objetivo`). Esa plata se
--              queda donde la pusieron.
--
--   LIBRE    → todo lo demás: los pagos de campo, las homologaciones, los
--              abonos de venta. Sigue cayendo en cascada de la cuota más
--              vieja hacia adelante, sobre lo que la plata dirigida no cubrió.
--
-- LO QUE **NO** CAMBIA, Y ES A PROPÓSITO
-- Un pago de campo trae `cuota_objetivo` —la cuota que dijo el cliente— pero
-- sigue siendo una PISTA, no una orden: cascada como siempre. Si se volviera
-- vinculante, un cliente que debe tres días y paga uno dejaría las dos viejas
-- pendientes para siempre, y la mora de toda la cartera cambiaría de un día
-- para el otro. Solo manda la corrección explícita de secretaría.
--
-- CONSECUENCIA QUE HAY QUE TENER PRESENTE
-- Ahora una cuota puede quedar PAGADA con cuotas anteriores pendientes. Es lo
-- que se pidió y refleja la realidad —esos días no se pagaron—, pero implica
-- que esos días siguen contando en la MORA del cliente. Es correcto: se le
-- debe esa plata.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Foto ANTES, para poder comparar ───────────────────────────────
-- Guarda cómo está repartida hoy la plata. El PASO 5 compara contra esto.
-- Es una tabla temporal de trabajo: se puede borrar cuando termines.
CREATE TABLE IF NOT EXISTS public.cobertura_antes_065 AS
SELECT id, loan_id, numero_cuota, monto_asignado, estado_derivado
  FROM public.v_cobertura_cuotas;


-- ── PASO 2) La cascada nueva ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cobertura_cuotas AS
WITH dirigido AS (
  -- Plata clavada en una cuota concreta desde Control de Pagos.
  --
  -- Se netea pago menos reversa por cuota: si secretaría baja el monto, la
  -- reversa que genera `ajustar_cuota_control_pagos` viene con la misma
  -- `cuota_objetivo` (script 066) y descuenta de la misma bolsa.
  --
  -- `GREATEST(0, ...)` porque una reversa vieja podría dejar la suma en
  -- negativo, y una bolsa negativa no significa nada.
  SELECT g.cuota_objetivo AS cuota_id,
         GREATEST(0, SUM(CASE WHEN g.tipo = 'pago'    THEN  g.monto
                              WHEN g.tipo = 'reversa' THEN -g.monto
                              ELSE 0 END)) AS monto
    FROM public.gestiones g
   WHERE g.estado  = 'aplicada'
     AND g.origen  = 'ajuste'
     AND g.cuota_objetivo IS NOT NULL
     AND g.tipo IN ('pago', 'reversa')
   GROUP BY g.cuota_objetivo
),
base AS (
  SELECT pp.id, pp.loan_id, pp.numero_cuota, pp.fecha_pago, pp.valor_cuota,
         pp.es_extra,
         -- Lo dirigido nunca puede pasarse del valor de la cuota: el sobrante
         -- vuelve a la bolsa libre y cae en cascada como cualquier otra plata.
         LEAST(pp.valor_cuota, COALESCE(d.monto, 0)) AS dirigido
    FROM public.payment_plan pp
    LEFT JOIN dirigido d ON d.cuota_id = pp.id
),
plan AS (
  SELECT b.*,
         -- El acumulado de SIEMPRE, que otras vistas siguen leyendo.
         SUM(b.valor_cuota) OVER (
           PARTITION BY b.loan_id ORDER BY b.fecha_pago, b.numero_cuota, b.id
         ) AS acumulado,
         -- Lo que le falta a cada cuota DESPUÉS de lo dirigido: es sobre esto
         -- que corre la cascada de la plata libre.
         SUM(b.valor_cuota - b.dirigido) OVER (
           PARTITION BY b.loan_id ORDER BY b.fecha_pago, b.numero_cuota, b.id
         ) AS acum_libre,
         SUM(b.dirigido) OVER (PARTITION BY b.loan_id) AS dirigido_total
    FROM base b
),
calc AS (
  SELECT p.*,
         COALESCE(n.pagado_neto, 0)             AS neto,
         COALESCE(n.pagado_sin_cancelacion, 0)  AS neto_sin_canc,
         COALESCE(n.tiene_cancelacion, false)   AS tiene_cancelacion,
         -- La bolsa libre es el total menos lo que ya está clavado.
         GREATEST(0, COALESCE(n.pagado_neto, 0)            - p.dirigido_total) AS libre,
         GREATEST(0, COALESCE(n.pagado_sin_cancelacion, 0) - p.dirigido_total) AS libre_sin_canc
    FROM plan p
    LEFT JOIN public.v_pagos_netos n ON n.loan_id = p.loan_id
)
SELECT c.id, c.loan_id, c.numero_cuota, c.fecha_pago, c.valor_cuota,
       c.es_extra, c.acumulado,
       -- Lo dirigido + lo que le toque de la cascada libre.
       c.dirigido
         + LEAST(c.valor_cuota - c.dirigido,
                 GREATEST(0, c.libre - (c.acum_libre - (c.valor_cuota - c.dirigido))))
         AS monto_asignado,
       CASE
         -- 'pagado' se mide sin la plata de cancelación, igual que antes: una
         -- cancelación no debe pintar todas las cuotas como pagadas.
         WHEN c.dirigido
                + LEAST(c.valor_cuota - c.dirigido,
                        GREATEST(0, c.libre_sin_canc - (c.acum_libre - (c.valor_cuota - c.dirigido))))
              >= c.valor_cuota THEN 'pagado'
         WHEN c.tiene_cancelacion THEN 'cancelada'
         WHEN c.dirigido
                + LEAST(c.valor_cuota - c.dirigido,
                        GREATEST(0, c.libre - (c.acum_libre - (c.valor_cuota - c.dirigido))))
              > 0 THEN 'parcial'
         WHEN EXISTS (
           SELECT 1 FROM public.gestiones g
            WHERE g.cuota_objetivo = c.id AND g.tipo = 'no_pago'
              AND g.estado = 'aplicada'
              AND NOT EXISTS (
                SELECT 1 FROM public.gestiones r
                 WHERE r.referencia_gestion_id = g.id
                   AND r.tipo = 'reversa' AND r.estado = 'aplicada')
         ) THEN 'no_pago'
         ELSE 'pendiente'
       END AS estado_derivado
  FROM calc c;


-- ── PASO 3) Lectura para la app ───────────────────────────────────────────
GRANT SELECT ON public.v_cobertura_cuotas TO anon, authenticated;


-- ── PASO 4) Rehacer el cache de todos los préstamos ───────────────────────
-- `payment_plan.estado`, `payment_plan.monto_pagado`, `loans.saldo` y
-- `loans.estado` son un CACHE que solo escribe `recalcular_prestamo`. La
-- vista ya cambió; sin esto, las tablas seguirían con el reparto viejo.
SELECT public.recalcular_prestamo(id) FROM public.loans;


-- ── PASO 5) QUÉ CAMBIÓ, cuota por cuota ───────────────────────────────────
-- Solo deberían aparecer cuotas de préstamos tocados por Control de Pagos.
-- Si sale algo de un préstamo que nadie ajustó, PARA y avisa: significa que
-- la cascada libre no quedó igual que antes.
SELECT a.loan_id,
       a.numero_cuota,
       a.monto_asignado  AS antes,
       n.monto_asignado  AS ahora,
       a.estado_derivado AS estado_antes,
       n.estado_derivado AS estado_ahora
  FROM public.cobertura_antes_065 a
  JOIN public.v_cobertura_cuotas  n ON n.id = a.id
 WHERE a.monto_asignado IS DISTINCT FROM n.monto_asignado
    OR a.estado_derivado IS DISTINCT FROM n.estado_derivado
 ORDER BY a.loan_id, a.numero_cuota;


-- ── PASO 6) Que no se haya perdido ni aparecido plata ─────────────────────
-- Por préstamo: lo repartido tiene que seguir siendo lo mismo que el neto
-- pagado (o el total del contrato, si la plata alcanzó para todo).
-- `descuadre` debe dar 0 en TODAS las filas.
SELECT c.loan_id,
       SUM(c.monto_asignado)                      AS repartido,
       COALESCE(MAX(n.pagado_neto), 0)            AS neto_pagado,
       LEAST(COALESCE(MAX(n.pagado_neto), 0),
             SUM(c.valor_cuota))                  AS esperado,
       SUM(c.monto_asignado)
         - LEAST(COALESCE(MAX(n.pagado_neto), 0),
                 SUM(c.valor_cuota))              AS descuadre
  FROM public.v_cobertura_cuotas c
  LEFT JOIN public.v_pagos_netos n ON n.loan_id = c.loan_id
 GROUP BY c.loan_id
HAVING SUM(c.monto_asignado)
       <> LEAST(COALESCE(MAX(n.pagado_neto), 0), SUM(c.valor_cuota));


-- ── PASO 7) Limpiar la foto ───────────────────────────────────────────────
-- Solo cuando los pasos 5 y 6 hayan quedado revisados.
-- DROP TABLE IF EXISTS public.cobertura_antes_065;
