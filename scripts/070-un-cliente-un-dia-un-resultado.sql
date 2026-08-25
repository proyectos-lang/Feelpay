-- ============================================================================
-- 070 - Un cliente, un dia, un resultado
-- ============================================================================
-- LO QUE SE REPORTO
-- "La ruta 151 tiene 13 clientes. El cobrador dice que ayer recaudo 341.500.
--  El sistema muestra 42 pagos, 14 no pagos y 1.103.500. Hay clientes con
--  varios ajustes de secretaria: marcar pago, quitarlo, poner no pago,
--  anularlo, volver a marcar pago."
--
-- Y un segundo caso, de campo, en la ruta 197 el mismo dia:
--   16:10  pago     9.600
--   16:11  reversa -9.600   "Correccion del monto desde el modulo de pagos"
--   16:11  pago    13.000
--   16:12  reversa -13.000  "Correccion del monto"
--   16:12  pago    13.000
-- Eso es UN pago de 13.000. La vista de monitoreo mostraba TRES.
--
-- LO QUE SE MIDIO CONTRA LA BASE (ruta 151, 24/08)
--   de calle    (origen 'campo')  :   14 eventos ->   341.500  <- el cobrador
--   de escritorio (origen 'ajuste'): 129 eventos ->   762.000
--                                                   ---------
--                                                    1.103.500  <- la pantalla
--
-- SON DOS PROBLEMAS DISTINTOS, Y CONVIENE NO CONFUNDIRLOS
--
-- 1) EL CONTEO ESTABA MAL. Se contaba evento por evento. Un pago solo se
--    descartaba si existia una reversa que lo señalara POR ID; las reversas de
--    Control de Pagos no traen ese id (apuntan a la cuota), asi que no
--    descontaban nada. Una cuota corregida tres veces contaba tres pagos.
--    En el monitoreo era peor: ni ese filtro tenia, y contaba TODO.
--    -> Esto es lo que arregla este script.
--
-- 2) EL VALOR NO ESTABA "ACUMULADO". La suma YA neteaba las reversas
--    (898.500 - 136.500 = 762.000). Lo que infla el dia es OTRA cosa: un
--    ajuste cae en el dia en que secretaria lo escribio, no en el dia de la
--    cuota que corrige. El script 066 ya manda los nuevos al dia de su cuota.
--    Los del 24/08 se escribieron antes y se quedan donde estan: re-fecharlos
--    moveria plata a dias YA CERRADOS (18 al 22/08) y dejaria un huerfano de
--    -136.500 en el 24. Se prefiere no tocar historia cerrada.
--    -> Para eso van las columnas nuevas: `valor_pago_campo` y
--       `valor_pago_ajuste` parten el dia en plata de calle y correcciones
--       de escritorio, sin cambiar el total.
--
-- LA REGLA NUEVA, EN UNA LINEA
--   Por cliente y por dia se toma el NETO.
--     neto > 0                      -> cuenta 1 pago, aporta el neto
--     neto <= 0 y hubo un no_pago   -> cuenta 1 no pago
--     neto = 0 sin no_pago          -> no cuenta en ninguna (el pago se anulo)
--
-- QUE PASA CON LOS NUMEROS DE AYER (medido, ruta 151 del 24/08)
--   valor_pago       1.103.500 -> 1.103.500  (identico: la suma ya neteaba)
--   cantidad_pagos          41 -> 13         (= los 13 clientes de la ruta)
--   cantidad_no_pagos       12 -> 0
--   valor_pago_campo         - -> 341.500    (lo que dice el cobrador)
--
-- El libro NO se toca: los eventos siguen todos ahi, con su firma y su hora.
-- Lo que cambia es como se LEEN.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) La prueba, antes de tocar nada (solo lectura) ─────────────────
-- Para cada dia y ruta: eventos contra clientes. Donde las dos columnas se
-- separan, ahi estaba el inflado.
SELECT g.fecha_gestion AS fecha, g.ruta,
       COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta') AND g.monto > 0) AS eventos_de_pago,
       COUNT(DISTINCT g.loan_id)                                                AS clientes_tocados,
       SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END)               AS neto,
       SUM(CASE WHEN g.origen = 'campo' THEN
             CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
           ELSE 0 END)                                                          AS neto_de_calle
  FROM public.gestiones g
 WHERE g.estado = 'aplicada'
   AND g.origen <> 'homologacion'
   AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
 GROUP BY g.fecha_gestion, g.ruta
HAVING COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta') AND g.monto > 0) > COUNT(DISTINCT g.loan_id)
 ORDER BY g.fecha_gestion DESC, g.ruta;


-- ── PASO 2) Soltar el resumen ─────────────────────────────────────────────
-- Las tres columnas nuevas van EN MEDIO, junto a las otras de plata, y
-- `CREATE OR REPLACE VIEW` sabe agregar al final pero no reordenar.
DROP VIEW IF EXISTS public.resumen_diario_v2;


-- ── PASO 3) El resumen, contando clientes ─────────────────────────────────
CREATE VIEW public.resumen_diario_v2 AS
WITH cierres AS (
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
por_cliente AS (
  -- UN CLIENTE, UN DÍA, UN RESULTADO.
  --
  -- Secretaría puede tocar la misma cuota cinco veces en una tarde: marcar el
  -- pago, quitarlo, poner no pago, anular eso y volver a marcar el pago. En el
  -- libro quedan los cinco eventos, y así tiene que ser: el libro no olvida y
  -- cada corrección lleva su firma. Pero el resumen del día NO es el libro. Es
  -- qué pasó con cada cliente, y con un cliente pasó UNA cosa.
  --
  -- Antes se contaba evento por evento, y un pago solo se descartaba si había
  -- una reversa que lo señalara POR ID. Las reversas de Control de Pagos no
  -- traen ese id —apuntan a la cuota, no al evento—, así que no descontaban
  -- nada: una cuota corregida tres veces contaba tres pagos. Por eso la ruta
  -- 151 mostraba 42 pagos el 24/08 teniendo 13 clientes.
  --
  -- El neto de plata ya venía bien (sumar pagos y restar reversas da lo mismo
  -- agrupado que suelto). Lo que cambia es QUIÉN se cuenta: clientes, no
  -- papeles.
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
         -- Igual que antes: `metodo_pago` en NULL cuenta como efectivo, y una
         -- reversa hereda el método del evento que revierte (`ref`).
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
         -- DE DÓNDE VINO LA PLATA: la calle o el escritorio.
         -- Es lo único que explica por qué el cobrador de la 151 dice 341.500
         -- y la pantalla decía 1.103.500. La diferencia no son pagos dobles:
         -- son correcciones de secretaría sobre cuotas de OTROS días, que caen
         -- en el día en que se escribieron. El script 066 ya manda las nuevas
         -- al día de su cuota; esto deja ver las que ya están.
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
         -- Clientes que terminaron el día con plata puesta. No eventos.
         COUNT(*) FILTER (WHERE neto > 0)                             AS cantidad_pagos,
         -- Quedó sin plata Y se registró una visita sin pago. Un cliente cuyo
         -- pago se anuló y no tiene `no_pago` no entra en ninguna de las dos:
         -- no pagó, pero tampoco hubo una visita fallida que contar.
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


-- ── PASO 4) Permisos del resumen (el DROP se los llevo) ───────────────────
GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated;


-- ── PASO 5) El monitoreo, con el mismo criterio ───────────────────────────
-- Sus columnas no cambian, asi que se reemplaza en sitio y conserva permisos.
CREATE OR REPLACE VIEW public.vista_monitoreo_admin AS
WITH neto_por_cliente AS (
  -- El MISMO criterio que `resumen_diario_v2`: un cliente, un día, un
  -- resultado. Las dos pantallas leen el mismo hecho, así que no pueden
  -- discrepar — y hasta ahora discrepaban.
  --
  -- Esta vista era la peor de las dos: contaba TODO evento con monto > 0, sin
  -- descontar siquiera los que tenían una reversa que los señalaba. Un cobrador
  -- que corrige el monto en el módulo de pagos (pago 9.600 → anula → pago
  -- 13.000 → anula → pago 13.000) aparecía acá con TRES pagos. Es uno solo, de
  -- 13.000.
  SELECT g.ruta, g.fecha_gestion AS fecha, g.loan_id,
         SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END) AS neto,
         bool_or(g.tipo = 'no_pago')                                AS hubo_no_pago
    FROM public.gestiones g
   WHERE g.estado = 'aplicada' AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
   GROUP BY g.ruta, g.fecha_gestion, g.loan_id
),
pagos_resumen AS (
  SELECT ruta, fecha,
         COALESCE(SUM(neto), 0)                             AS total_recaudado,
         COUNT(*) FILTER (WHERE neto > 0)                   AS pagos_exitosos,
         COUNT(*) FILTER (WHERE neto <= 0 AND hubo_no_pago) AS visitas_sin_pago
    FROM neto_por_cliente
   GROUP BY ruta, fecha
),
cuotas_del_dia AS (
  -- Cuotas cuyo VENCIMIENTO cae ese día y siguen sin gestionar. Es lo que
  -- esta columna medía antes bajo el nombre `pendientes_por_visitar`; se
  -- conserva porque explica la diferencia con la cartera real.
  SELECT pp.ruta, pp.fecha_pago AS fecha,
         COUNT(*) FILTER (WHERE pp.estado = 'pendiente') AS cuotas_vencen_hoy
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
       COALESCE(cart.pendientes_por_visitar, 0::bigint) AS pendientes_por_visitar,
       rd.aprobacion_admin,
       COALESCE(tr.total_ingresos, 0)                 AS total_ingresos,
       COALESCE(tr.total_gastos, 0)                   AS total_gastos,
       COALESCE(tr.total_retiros, 0)                  AS total_retiros,
       COALESCE(vr.total_ventas, 0)                   AS total_ventas,
       COALESCE(vr.cantidad_ventas, 0::bigint)        AS cantidad_ventas,
       COALESCE(vr.total_ventas_homologadas, 0)       AS total_ventas_homologadas,
       COALESCE(vr.cantidad_ventas_homologadas, 0::bigint) AS cantidad_ventas_homologadas,
       COALESCE(cart.cartera_activa, 0::bigint)       AS cartera_activa,
       COALESCE(cd.cuotas_vencen_hoy, 0::bigint)      AS cuotas_vencen_hoy
  FROM public.rutas_diarias rd
  LEFT JOIN pagos_resumen         pr ON rd.ruta_id = pr.ruta AND rd.fecha = pr.fecha
  LEFT JOIN cuotas_del_dia        cd ON rd.ruta_id = cd.ruta AND rd.fecha = cd.fecha
  -- LA CARTERA REAL de esa ruta ESE día: créditos que ya existían, que
  -- todavía debían, y cuántos de ellos quedaron sin gestionar.
  LEFT JOIN LATERAL (
    SELECT COUNT(*)                                  AS cartera_activa,
           COUNT(*) FILTER (WHERE NOT ges.gestionado) AS pendientes_por_visitar
      FROM public.loans l
      CROSS JOIN LATERAL (
        -- Lo pagado HASTA ESE DÍA, no hasta hoy. Es lo que hace que el 15 de
        -- agosto siga diciendo lo que decía el 15 de agosto: con el saldo
        -- actual, un crédito cancelado la semana pasada desaparecería
        -- retroactivamente de todos los días anteriores.
        SELECT COALESCE(SUM(CASE
                 WHEN gg.tipo IN ('pago','cancelacion','abono_venta') THEN gg.monto
                 WHEN gg.tipo = 'reversa' THEN -gg.monto ELSE 0 END), 0) AS pagado
          FROM public.gestiones gg
         WHERE gg.loan_id = l.id
           AND gg.estado = 'aplicada'
           AND gg.fecha_gestion <= rd.fecha
      ) pag
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM public.gestiones g2
           WHERE g2.loan_id = l.id
             AND g2.fecha_gestion = rd.fecha
             AND g2.estado = 'aplicada'
             AND g2.origen <> 'homologacion'
             AND g2.tipo IN ('pago','no_pago','cancelacion','abono_venta')
        ) AS gestionado
      ) ges
     WHERE l.ruta = rd.ruta_id
       AND (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date <= rd.fecha
       -- Las ANULADAS quedan fuera. Cuando se escribió esta vista, `estado`
       -- solo valía 'activo' o 'cancelado' y el filtro habría sido letra
       -- muerta —un cancelado ya sale por saldo cero—, así que se omitió a
       -- propósito. Con 'anulado' (script 068) dejó de serlo: una venta
       -- anulada puede tener saldo y seguiría contando como cartera por
       -- visitar.
       AND l.estado <> 'anulado'
       -- Seguía debiendo ESE día.
       AND COALESCE(l.valor_a_pagar, l.valor) - pag.pagado > 0
  ) cart ON true
  LEFT JOIN transacciones_resumen tr ON rd.ruta_id = tr.ruta AND rd.fecha = tr.fecha_transaccion
  LEFT JOIN ventas_resumen        vr ON rd.ruta_id = vr.ruta AND rd.fecha = vr.fecha_venta;


-- ── PASO 6) Que las dos vistas digan lo mismo ─────────────────────────────
-- EL INVARIANTE: resumen y monitoreo miran el mismo hecho. Si una fila dice
-- "*** revisar ***", una de las dos se quedo con el criterio viejo.
SELECT r.fecha_pago, r.ruta,
       r.valor_pago, v.total_recaudado,
       r.cantidad_pagos, v.pagos_exitosos,
       r.cantidad_no_pagos, v.visitas_sin_pago,
       CASE WHEN r.valor_pago = v.total_recaudado
             AND r.cantidad_pagos = v.pagos_exitosos
             AND r.cantidad_no_pagos = v.visitas_sin_pago
            THEN 'ok' ELSE '*** revisar ***' END AS cuadra
  FROM public.resumen_diario_v2 r
  JOIN public.vista_monitoreo_admin v
    ON v.ruta_id = r.ruta AND v.fecha = r.fecha_pago
 WHERE r.valor_pago <> 0 OR r.cantidad_pagos > 0
 ORDER BY r.fecha_pago DESC, r.ruta
 LIMIT 40;


-- ── PASO 7) Que las formas de pago sigan sumando el recaudo ───────────────
-- El invariante del 059, que no se puede haber roto al reagrupar.
SELECT fecha_pago, ruta, valor_pago, pago_efectivo, pago_transferencia,
       CASE WHEN valor_pago = pago_efectivo + pago_transferencia
            THEN 'ok' ELSE '*** revisar ***' END AS cuadra
  FROM public.resumen_diario_v2
 WHERE valor_pago <> 0
 ORDER BY fecha_pago DESC, ruta
 LIMIT 40;


-- ── PASO 8) Que calle + escritorio sumen el dia ───────────────────────────
-- Y de paso, LA RESPUESTA A LO QUE SE REPORTO: mirar la 151 del 24/08.
-- `valor_pago_campo` debe decir 341.500.
SELECT fecha_pago, ruta,
       valor_pago, valor_pago_campo, valor_pago_ajuste,
       cantidad_pagos, cantidad_pagos_campo, cantidad_no_pagos,
       CASE WHEN valor_pago = valor_pago_campo + valor_pago_ajuste
            THEN 'ok' ELSE '*** revisar ***' END AS cuadra
  FROM public.resumen_diario_v2
 WHERE fecha_pago >= DATE '2026-08-20' AND valor_pago <> 0
 ORDER BY fecha_pago DESC, ruta;


-- ── PASO 9) El caso de campo de la 197 ────────────────────────────────────
-- El cobrador corrigio el monto dos veces: 9.600 -> 13.000 -> 13.000.
-- Tienen que salir 5 eventos en el libro y UN solo pago de 13.000 en el dia.
SELECT g.fecha_hora AT TIME ZONE 'America/Bogota' AS hora,
       g.tipo, g.monto, g.observacion
  FROM public.gestiones g
 WHERE g.ruta = 197
   AND g.fecha_gestion = DATE '2026-08-24'
   AND g.loan_id IN (
     SELECT loan_id FROM public.gestiones
      WHERE ruta = 197 AND fecha_gestion = DATE '2026-08-24' AND tipo = 'reversa')
 ORDER BY g.loan_id, g.fecha_hora;
