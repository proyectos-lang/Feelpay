-- ============================================================================
-- 099 - Monitoreo de Recaudos
-- ============================================================================
-- QUÉ ES
-- La tabla día por día que pidió el dueño para secretaría: una fila por ruta y
-- fecha, con diecinueve columnas, para poder filtrar una ruta y un rango y ver
-- cómo viene el recaudo.
--
-- DE DÓNDE SALE CADA COLUMNA
-- Quince ya existían y NO se recalculan acá: se leen de `resumen_diario_v2` y
-- de `vista_monitoreo_admin`, que son las que ya alimentan el Resumen del Día,
-- el Cierre de Caja y el Monitoreo de Rutas. Es a propósito — si esta tabla
-- calculara el recaudo por su cuenta, tarde o temprano diría algo distinto del
-- cierre que el cobrador firmó.
--
--   UNID · Date                  ruta · fecha_pago
--   Total Recaudo                valor_pago
--   Recaudo sin canceladas       valor_pago − valor_canceladas
--   Valor canceladas             valor_canceladas
--   % Recaudo                    valor_pago / meta_pagos
--   % Clientes pagos             cantidad_pagos / cartera_activa
--   Pagos · No pagos             cantidad_pagos · cantidad_no_pagos
--   Total clientes               cartera_activa (script 060)
--   Clientes cancelados          cantidad_canceladas
--   Cantidad · Valor ventas      cantidad_ventas · valor_ventas
--   # de Gastos · Valor gastos   cantidad_gastos · valor_gastos
--
-- LAS CUATRO QUE HAY QUE RECONSTRUIR
-- No existían por día en ningún lado, y las cuatro se calculan igual que la
-- `cartera_activa` del script 060: acumulando el libro HASTA esa fecha, no
-- leyendo el estado de hoy.
--
--   Cartera final          suma de lo que se debía ESE día
--   Clientes en mora > 7   cuántos arrastraban más de 7 cuotas vencidas
--   Renovaciones           ventas de ese día a un cliente que ya tenía otro
--   Frecuencia no diaria   créditos vivos ese día con frecuencia distinta de
--                          diaria
--
-- POR QUÉ ACUMULANDO Y NO CON `v_loan_financiero`
-- Esa vista calcula el saldo a HOY. Usarla haría que el 15 de agosto mostrara
-- la cartera de hoy, y un crédito cancelado la semana pasada desaparecería
-- retroactivamente de todos los días anteriores. Es la misma decisión que dejó
-- escrita el script 060 y por el mismo motivo.
--
-- LA MORA DE ESE DÍA, dicha con precisión: cuotas que ya habían VENCIDO a esa
-- fecha y que la plata acumulada hasta esa fecha no alcanzaba a cubrir,
-- divididas por el valor de la cuota. Es la misma cuenta de
-- `v_loan_financiero.cuotas_mora`, con la fecha movida.
--
-- ES UNA VISTA, NO UNA TABLA. No guarda nada: se calcula al consultarla. Por
-- eso el PASO 4 la cronometra sobre el rango completo antes de darla por
-- buena — si no rinde con meses de historia, hay que materializarla y es mejor
-- saberlo ahora.
--
-- NO MUEVE UN PESO. Solo lee.
--
-- Corre los pasos DE A UNO.
-- ============================================================================


-- ── PASO 1) Qué hay para leer (SOLO LECTURA) ──────────────────────────────
-- Cuántos días de historia hay y de qué rutas. Es el tamaño contra el que se
-- va a cronometrar la vista en el PASO 4.
SELECT COUNT(*)                       AS filas_de_resumen,
       COUNT(DISTINCT ruta)           AS rutas,
       MIN(fecha_pago)                AS desde,
       MAX(fecha_pago)                AS hasta
  FROM public.resumen_diario_v2;


-- ── PASO 2) La vista ──────────────────────────────────────────────────────
-- `DROP` antes de crear: `CREATE OR REPLACE VIEW` no deja reordenar ni quitar
-- columnas, así que una segunda versión fallaría con un error confuso.
DROP VIEW IF EXISTS public.vista_monitoreo_recaudos;

CREATE VIEW public.vista_monitoreo_recaudos AS
SELECT
  r.ruta                                                        AS unidad,
  r.fecha_pago                                                  AS fecha,

  -- ── Las cuatro reconstruidas ────────────────────────────────────────────
  COALESCE(c.cartera_final, 0)                                  AS cartera_final,
  COALESCE(c.clientes_mora_mayor_7, 0::bigint)                  AS clientes_mora_mayor_7,
  COALESCE(c.frecuencia_no_diaria, 0::bigint)                   AS frecuencia_no_diaria,
  COALESCE(ren.renovaciones, 0::bigint)                         AS renovaciones,

  -- ── Recaudo ─────────────────────────────────────────────────────────────
  r.valor_pago                                                  AS total_recaudo,
  r.valor_pago - r.valor_canceladas                             AS recaudo_sin_canceladas,
  r.valor_canceladas                                            AS valor_canceladas,
  -- Sin meta no hay porcentaje: 0 dice "no se midió", y dividir por cero
  -- reventaría la consulta entera.
  CASE WHEN r.meta_pagos > 0
       THEN round(r.valor_pago * 100.0 / r.meta_pagos)
       ELSE 0 END                                               AS pct_recaudo,

  -- ── Clientes ────────────────────────────────────────────────────────────
  CASE WHEN COALESCE(m.cartera_activa, 0) > 0
       THEN round(r.cantidad_pagos * 100.0 / m.cartera_activa)
       ELSE 0 END                                               AS pct_clientes_pagos,
  r.cantidad_pagos                                              AS pagos,
  r.cantidad_no_pagos                                           AS no_pagos,
  COALESCE(m.cartera_activa, 0::bigint)                         AS total_clientes,
  r.cantidad_canceladas                                         AS clientes_cancelados,

  -- ── Ventas y gastos ─────────────────────────────────────────────────────
  r.cantidad_ventas                                             AS cantidad_ventas,
  r.valor_ventas                                                AS valor_ventas,
  r.cantidad_gastos                                             AS numero_gastos,
  r.valor_gastos                                                AS valor_gastos

FROM public.resumen_diario_v2 r

-- `cartera_activa` sale de donde ya salía: la vista del monitoreo. No se
-- recalcula acá para que las dos pantallas no puedan discrepar.
LEFT JOIN public.vista_monitoreo_admin m
       ON m.ruta_id = r.ruta AND m.fecha = r.fecha_pago

-- ── LA CARTERA DE ESE DÍA, acumulando el libro hasta esa fecha ────────────
LEFT JOIN LATERAL (
  SELECT
    SUM(COALESCE(l.valor_a_pagar, l.valor) - pag.pagado)        AS cartera_final,
    COUNT(*) FILTER (WHERE venc.en_mora > 7)                    AS clientes_mora_mayor_7,
    COUNT(*) FILTER (WHERE COALESCE(l.frecuencia_pago, 'daily') <> 'daily')
                                                                AS frecuencia_no_diaria
    FROM public.loans l
    CROSS JOIN LATERAL (
      -- Lo pagado HASTA ESE DÍA. Ver el encabezado: con el saldo de hoy, el
      -- 15 de agosto mostraría la cartera de hoy.
      SELECT COALESCE(SUM(CASE
               WHEN gg.tipo IN ('pago','cancelacion','abono_venta') THEN gg.monto
               WHEN gg.tipo = 'reversa' THEN -gg.monto ELSE 0 END), 0) AS pagado
        FROM public.gestiones gg
       WHERE gg.loan_id = l.id
         AND gg.estado = 'aplicada'
         AND gg.fecha_gestion <= r.fecha_pago
    ) pag
    CROSS JOIN LATERAL (
      -- CUÁNTAS CUOTAS DEBÍA ESE DÍA. Lo vencido a esa fecha menos lo pagado
      -- a esa fecha, dividido por el valor de la cuota. Es la misma cuenta de
      -- `v_loan_financiero.cuotas_mora`, con la fecha movida.
      SELECT CASE
               WHEN COALESCE(v.total_vencido, 0) - pag.pagado > 0
                    AND COALESCE(v.valor_ref, 0) > 0
               THEN CEIL((v.total_vencido - pag.pagado) / v.valor_ref)
               ELSE 0
             END AS en_mora
        FROM (
          SELECT COALESCE(SUM(pp.valor_cuota) FILTER (WHERE pp.fecha_pago < r.fecha_pago), 0) AS total_vencido,
                 COALESCE(MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra),
                          MAX(pp.valor_cuota))                                                AS valor_ref
            FROM public.payment_plan pp
           WHERE pp.loan_id = l.id
        ) v
    ) venc
   WHERE l.ruta = r.ruta
     AND l.estado IS DISTINCT FROM 'anulado'
     AND (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date <= r.fecha_pago
     -- Seguía debiendo ESE día. Mismo predicado del script 060.
     AND COALESCE(l.valor_a_pagar, l.valor) - pag.pagado > 0
) c ON true

-- ── RENOVACIONES: ventas de ese día a alguien que ya tenía otro crédito ───
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS renovaciones
    FROM public.loans nueva
   WHERE nueva.ruta = r.ruta
     AND nueva.estado IS DISTINCT FROM 'anulado'
     AND (nueva.fecha_creacion AT TIME ZONE 'America/Bogota')::date = r.fecha_pago
     AND EXISTS (
       SELECT 1 FROM public.loans previa
        WHERE previa.client_id = nueva.client_id
          AND previa.id <> nueva.id
          AND previa.estado IS DISTINCT FROM 'anulado'
          AND previa.fecha_creacion < nueva.fecha_creacion
     )
) ren ON true;


-- ── PASO 3) Que la app la pueda leer ──────────────────────────────────────
GRANT SELECT ON public.vista_monitoreo_recaudos TO anon, authenticated;


-- ── PASO 4) CUÁNTO TARDA (SOLO LECTURA) ───────────────────────────────────
-- Esto es lo que decide si la vista sirve tal cual o hay que materializarla.
-- Corre el rango COMPLETO, que es el peor caso.
--
-- Si `Execution Time` pasa de unos pocos segundos, PARÁ y avisá: se puede
-- materializar por fecha, pero es otra decisión y conviene tomarla con el
-- número delante.
EXPLAIN ANALYZE
SELECT * FROM public.vista_monitoreo_recaudos;


-- ── PASO 5) Un mes de una ruta, como lo va a pedir la pantalla ────────────
-- El caso real: una ruta y un rango. Tiene que ser rápido.
EXPLAIN ANALYZE
SELECT * FROM public.vista_monitoreo_recaudos
 WHERE unidad = 1
   AND fecha BETWEEN '2026-08-01' AND '2026-08-31';


-- ── PASO 6) Que los números cuadran con lo que ya se ve (SOLO LECTURA) ────
-- `dif_recaudo` y `dif_pagos` tienen que dar CERO en todas las filas: esta
-- vista no recalcula el recaudo, lo lee. Si alguna diera distinto, es que se
-- coló un cálculo propio y hay que quitarlo.
SELECT v.unidad, v.fecha,
       v.total_recaudo, r.valor_pago,
       v.total_recaudo - r.valor_pago      AS dif_recaudo,
       v.pagos, r.cantidad_pagos,
       v.pagos - r.cantidad_pagos          AS dif_pagos
  FROM public.vista_monitoreo_recaudos v
  JOIN public.resumen_diario_v2 r
    ON r.ruta = v.unidad AND r.fecha_pago = v.fecha
 WHERE v.total_recaudo <> r.valor_pago
    OR v.pagos <> r.cantidad_pagos;


-- ── PASO 7) La foto de una ruta (SOLO LECTURA) ────────────────────────────
-- Para mirarla con los ojos antes de abrir la pantalla. `cartera_final` tiene
-- que ir bajando cuando entra plata y subiendo cuando hay ventas.
SELECT unidad, fecha, cartera_final, total_recaudo, recaudo_sin_canceladas,
       valor_canceladas, pct_recaudo, pct_clientes_pagos, pagos, no_pagos,
       total_clientes, clientes_mora_mayor_7, clientes_cancelados,
       renovaciones, cantidad_ventas, valor_ventas, numero_gastos,
       valor_gastos, frecuencia_no_diaria
  FROM public.vista_monitoreo_recaudos
 WHERE unidad = 1
 ORDER BY fecha DESC
 LIMIT 15;
