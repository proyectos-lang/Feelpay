-- ============================================================================
-- 112 - El atrasado tambien es debido cobrar HOY
-- ============================================================================
-- LO QUE SE REPORTO
-- "Al correr el 111 se volvio a descuadrar la meta, por ejemplo la de la ruta
--  151: antes mostraba el valor correcto con el 110 y ahora se volvio a
--  desconfigurar."
--
-- ES CIERTO, Y EL 111 NO ESTA MAL. Lo que falta es esto.
--
-- LA CUENTA, MEDIDA (ruta 151, hoy 12/09)
--
--   con el 110   1.060.000   <- el numero que se veia bien
--   con el 111     910.500   <- el de ahora
--                  -------
--   diferencia     149.500
--
--   149.500 = 97.500 + 19.500 + 19.500 + 13.000
--
-- Son UNA CUOTA de cada uno de los 4 clientes de la 151 que deben plata pero
-- no tienen ninguna cuota de hoy en adelante:
--
--   jenny condori carvajal   saldo 780.000   cuota 97.500
--   francisca ropa           saldo  95.000   cuota 19.500
--   sonia ropa galeria       saldo  46.500   cuota 19.500
--   veronica cafe            saldo  38.000   cuota 13.000
--
-- O sea: EL NUMERO DEL 110 ERA EL CORRECTO, pero lo conseguia de la peor
-- manera — creandole cuotas falsas al cronograma. Por eso el 111 tuvo que
-- deshacerlo: esas cuotas inflaban la meta de los dias SIGUIENTES y hacian
-- que el cronograma sumara mas que la deuda pactada.
--
-- Este script consigue el MISMO numero sin escribir una sola fila: cambia
-- como se LEE la meta, no lo que hay guardado.
--
-- LA REGLA NUEVA, EN UNA LINEA
--   Un credito que debe plata y NO tiene cuota que venza hoy, pero SI tiene
--   cuotas vencidas sin pagar, aporta UNA cuota a la meta de hoy.
--
-- POR QUE UNA CUOTA Y NO TODO EL SALDO
-- -------------------------------------
-- Porque la meta es lo que se espera recaudar HOY, no lo que el cliente debe.
-- A jenny se le cobra su cuota diaria de 97.500, no los 780.000 de golpe.
-- Sumar el saldo entero daria una meta de 1.870.000 en la 151 — imposible de
-- cumplir y sin relacion con lo que el cobrador sale a hacer.
--
-- POR QUE SOLO PARA HOY
-- ----------------------
-- ESTA ES LA PARTE DELICADA. La meta se calcula para TODAS las fechas, no
-- solo la de hoy. Si el atraso sumara en cualquier dia, los dias YA CERRADOS
-- Y APROBADOS cambiarian de cifra: un cierre que se firmo con meta 975.500
-- pasaria a decir otra cosa, y un dia cerrado no se reescribe.
--
-- Por eso el agregado se aplica UNICAMENTE a la fecha de hoy. Toda la
-- historia queda intacta, byte por byte.
--
-- QUE NO CAMBIA
--   * NO se toca `payment_plan`: ni una fila nueva, ni una borrada.
--   * NO se toca el libro `gestiones` ni ningun saldo.
--   * Los dias pasados conservan EXACTAMENTE la meta que ya tenian.
--   * Los dias futuros tampoco cambian: el atraso no se proyecta.
--   * Solo cambia `meta_pagos` del dia de hoy, y se agrega la columna
--     `meta_atrasados` para que se vea cuanto de la meta viene del atraso.
--
-- Corre los pasos EN ORDEN. Los pasos 1, 4 y 5 no escriben nada.
-- ============================================================================


-- ── PASO 1) La foto de ANTES (SOLO LECTURA, no cambia nada) ───────────────
-- Guarde estos numeros. El PASO 4 compara contra ellos: los dias pasados
-- tienen que salir IDENTICOS y solo el de hoy debe subir.
SELECT ruta, fecha_pago, meta_pagos
  FROM public.resumen_diario_v2
 WHERE fecha_pago BETWEEN (now() AT TIME ZONE 'America/Bogota')::date - 3
                      AND (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY ruta, fecha_pago;


-- ── PASO 2) Soltar la vista (la columna nueva va en medio) ────────────────
-- `CREATE OR REPLACE VIEW` sabe agregar columnas al final pero no reordenar.
DROP VIEW IF EXISTS public.resumen_diario_v2;


-- ── PASO 3) El resumen, con el atraso contando en la meta de hoy ──────────
CREATE VIEW public.resumen_diario_v2 AS
WITH cierres AS (
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
por_cliente AS (
  -- UN CLIENTE, UN DIA, UN RESULTADO. (script 070, sin cambios)
  SELECT g.fecha_gestion AS fecha, g.ruta, g.loan_id,
         SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END)        AS neto,
         bool_or(g.tipo = 'no_pago')                                       AS hubo_no_pago,
         SUM(CASE WHEN l.tipo_amortizacion = 'aleman' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS capital,
         SUM(CASE WHEN l.tipo_amortizacion = 'americano' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS intereses,
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) = 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS efectivo,
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) <> 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS transferencia,
         SUM(CASE WHEN g.origen = 'campo' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS neto_campo,
         MAX(g.fecha_hora)                                                 AS ultimo_movimiento
    FROM public.gestiones g
    LEFT JOIN public.loans l       ON l.id   = g.loan_id
    LEFT JOIN public.gestiones ref ON ref.id = g.referencia_gestion_id
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
   GROUP BY g.fecha_gestion, g.ruta, g.loan_id
),
pagos AS (
  SELECT fecha, ruta,
         SUM(neto)                                                    AS valor_pago,
         COUNT(*) FILTER (WHERE neto > 0)                             AS cantidad_pagos,
         COUNT(*) FILTER (WHERE neto <= 0 AND hubo_no_pago)           AS cantidad_no_pagos,
         SUM(capital)                                                 AS pago_capital,
         SUM(intereses)                                               AS pago_intereses,
         SUM(efectivo)                                                AS pago_efectivo,
         SUM(transferencia)                                           AS pago_transferencia,
         SUM(neto_campo)                                              AS valor_pago_campo,
         SUM(neto) - SUM(neto_campo)                                  AS valor_pago_ajuste,
         COUNT(*) FILTER (WHERE neto_campo > 0)                       AS cantidad_pagos_campo,
         (MAX(ultimo_movimiento) AT TIME ZONE 'America/Bogota')::time AS hora_ultimo_movimiento
    FROM por_cliente
   GROUP BY fecha, ruta
),
meta_plan AS (
  -- La meta de siempre: las cuotas que VENCEN ese dia. (script 104)
  -- Un credito cancelado deja de sumar el dia despues de cancelarse.
  SELECT pp.fecha_pago AS fecha, pp.ruta,
         SUM(pp.valor_cuota) AS meta_pagos
    FROM public.payment_plan pp
    JOIN public.loans l ON l.id = pp.loan_id
    LEFT JOIN LATERAL (
      SELECT MAX(g.fecha_gestion) AS dia_cierre
        FROM public.gestiones g
       WHERE g.loan_id = pp.loan_id
         AND g.estado = 'aplicada'
    ) fin ON true
   WHERE l.estado <> 'cancelado'
      OR pp.fecha_pago <= fin.dia_cierre
   GROUP BY pp.fecha_pago, pp.ruta
),
atrasados AS (
  -- ── LO NUEVO ───────────────────────────────────────────────────────────
  -- EL CLIENTE ATRASADO TAMBIEN SE COBRA HOY.
  --
  -- Un credito que debe plata y hoy no tiene ninguna cuota que venza, pero SI
  -- arrastra cuotas vencidas sin pagar, aporta UNA cuota a la meta de hoy. Es
  -- lo que el cobrador sale a cobrarle: su cuota, no su saldo entero.
  --
  -- SOLO PARA HOY. Si esto aplicara a cualquier fecha, cada dia ya cerrado y
  -- aprobado cambiaria de cifra al recalcularse. La historia no se reescribe.
  --
  -- El aporte se topa con el saldo (`LEAST`): a quien le quedan 8.000 de
  -- deuda no se le pone una meta de 19.500.
  SELECT (now() AT TIME ZONE 'America/Bogota')::date AS fecha,
         l.ruta,
         SUM(LEAST(ref.cuota_ref, f.saldo)) AS meta_atrasados
    FROM public.loans l
    JOIN public.v_loan_financiero f ON f.loan_id = l.id
    -- La cuota de referencia del credito: la del plan original, no una extra.
    JOIN LATERAL (
      SELECT COALESCE(
               MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra),
               MAX(pp.valor_cuota)
             ) AS cuota_ref
        FROM public.payment_plan pp
       WHERE pp.loan_id = l.id
    ) ref ON ref.cuota_ref > 0
   WHERE l.estado = 'activo'
     AND COALESCE(f.saldo, 0) > 0
     -- No tiene NINGUNA cuota que venza hoy: si la tiene, ya esta en la meta
     -- por la via normal y contarlo aca seria contarlo dos veces.
     AND NOT EXISTS (
       SELECT 1 FROM public.payment_plan pp
        WHERE pp.loan_id = l.id
          AND pp.fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date)
     -- Pero SI arrastra cuotas vencidas sin pagar: eso es lo que lo hace un
     -- atrasado y no un credito que simplemente todavia no empieza.
     AND EXISTS (
       SELECT 1 FROM public.payment_plan pp
        WHERE pp.loan_id = l.id
          AND pp.fecha_pago < (now() AT TIME ZONE 'America/Bogota')::date
          AND pp.estado IN ('pendiente','parcial','no_pago'))
   GROUP BY l.ruta
),
meta AS (
  SELECT COALESCE(p.fecha, a.fecha) AS fecha,
         COALESCE(p.ruta,  a.ruta)  AS ruta,
         COALESCE(p.meta_pagos, 0) + COALESCE(a.meta_atrasados, 0) AS meta_pagos,
         COALESCE(a.meta_atrasados, 0)                             AS meta_atrasados
    FROM meta_plan p
    FULL JOIN atrasados a ON a.fecha = p.fecha AND a.ruta = p.ruta
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
         COUNT(*)                                                          AS cantidad_ventas,
         COALESCE(SUM(l.valor), 0)                                         AS valor_ventas,
         COUNT(*) FILTER (WHERE COALESCE(l.origen,'normal') = 'homologado') AS cantidad_ventas_homologadas,
         COALESCE(SUM(l.valor) FILTER (
           WHERE COALESCE(l.origen,'normal') = 'homologado'), 0)           AS valor_ventas_homologadas,
         COALESCE(SUM(l.valor) FILTER (
           WHERE COALESCE(l.origen,'normal') <> 'homologado'), 0)          AS valor_ventas_caja
    FROM public.loans l
   GROUP BY (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date, l.ruta
),
base AS (
  SELECT COALESCE(p.fecha, m.fecha, g.fecha, v.fecha) AS fecha_pago,
         COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)  AS ruta,
         COALESCE(m.meta_pagos, 0)          AS meta_pagos,
         COALESCE(m.meta_atrasados, 0)      AS meta_atrasados,
         COALESCE(p.valor_pago, 0)          AS valor_pago,
         COALESCE(p.cantidad_pagos, 0)      AS cantidad_pagos,
         COALESCE(p.cantidad_no_pagos, 0)   AS cantidad_no_pagos,
         COALESCE(c.cantidad_canceladas, 0) AS cantidad_canceladas,
         COALESCE(c.valor_canceladas, 0)    AS valor_canceladas,
         COALESCE(p.pago_capital, 0)        AS pago_capital,
         COALESCE(p.pago_intereses, 0)      AS pago_intereses,
         COALESCE(p.pago_efectivo, 0)       AS pago_efectivo,
         COALESCE(p.pago_transferencia, 0)  AS pago_transferencia,
         COALESCE(p.valor_pago_campo, 0)     AS valor_pago_campo,
         COALESCE(p.valor_pago_ajuste, 0)    AS valor_pago_ajuste,
         COALESCE(p.cantidad_pagos_campo, 0) AS cantidad_pagos_campo,
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
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)   AS efectivo,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)
       - (b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
          - b.valor_gastos - b.valor_retiros)               AS caja_anterior,
       b.cantidad_ingresos AS recuento_ingresos,
       b.cantidad_gastos   AS recuento_gastos,
       b.cantidad_retiros  AS recuento_retiros
  FROM base b
 ORDER BY b.fecha_pago DESC, b.ruta;

GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated;


-- ── PASO 4) Que la historia NO se movio (SOLO LECTURA) ────────────────────
-- LA COMPROBACION QUE MAS IMPORTA. Compare contra el PASO 1:
--   * los dias ANTERIORES a hoy tienen que dar la MISMA meta que antes
--   * solo el de HOY debe subir, y `meta_atrasados` dice cuanto
SELECT ruta, fecha_pago, meta_pagos, meta_atrasados,
       meta_pagos - meta_atrasados AS meta_por_cronograma
  FROM public.resumen_diario_v2
 WHERE fecha_pago BETWEEN (now() AT TIME ZONE 'America/Bogota')::date - 3
                      AND (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY ruta, fecha_pago;


-- ── PASO 5) Quien esta aportando por atraso (SOLO LECTURA) ───────────────
-- El detalle de la meta de hoy: cada cliente atrasado y la cuota que aporta.
-- En la ruta 151 tienen que salir los 4, sumando 149.500.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       f.saldo,
       LEAST(ref.cuota_ref, f.saldo)                   AS aporta_a_la_meta,
       (SELECT MAX(pp.fecha_pago) FROM public.payment_plan pp
         WHERE pp.loan_id = l.id)                      AS ultima_cuota_del_plan
  FROM public.loans l
  JOIN public.clients c           ON c.id = l.client_id
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
  JOIN LATERAL (
    SELECT COALESCE(MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra),
                    MAX(pp.valor_cuota)) AS cuota_ref
      FROM public.payment_plan pp WHERE pp.loan_id = l.id
  ) ref ON ref.cuota_ref > 0
 WHERE l.estado = 'activo'
   AND COALESCE(f.saldo, 0) > 0
   AND NOT EXISTS (
     SELECT 1 FROM public.payment_plan pp
      WHERE pp.loan_id = l.id
        AND pp.fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date)
   AND EXISTS (
     SELECT 1 FROM public.payment_plan pp
      WHERE pp.loan_id = l.id
        AND pp.fecha_pago < (now() AT TIME ZONE 'America/Bogota')::date
        AND pp.estado IN ('pendiente','parcial','no_pago'))
 ORDER BY l.ruta, f.saldo DESC;
