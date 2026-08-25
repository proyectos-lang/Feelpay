-- ============================================================================
-- 071 - El recaudo del monitoreo es el del cobrador
-- ============================================================================
-- LO QUE SE REPORTO
-- "En Monitoreo de rutas, la 151 del 24/08 sigue mostrando 1.103.500. Que se
--  vea solo el pago del numero del cobrador y no el de escritorio."
--
-- El 070 arreglo los CONTEOS (42 pagos -> 13). El VALOR quedo igual a
-- proposito, porque la suma ya estaba bien: lo que pasa es que mezcla dos
-- cosas distintas en un solo numero.
--
--   de calle      (origen 'campo') :   341.500  <- lo que respondio el cobrador
--   de escritorio (origen 'ajuste'):   762.000  <- correcciones de secretaria
--                                    ---------
--                                     1.103.500  <- lo que mostraba la tarjeta
--
-- Los 762.000 son plata REAL, pero de cuotas de otros dias, escrita ese dia.
-- Pedirle al cobrador que responda por ella no tiene sentido.
--
-- LO QUE HACE
-- `vista_monitoreo_admin` gana dos columnas: `recaudo_campo` y
-- `recaudo_ajuste`. `total_recaudado` SE CONSERVA — es la suma de las dos y
-- sigue siendo el numero que cuadra contra la caja. Lo que cambia es cual se
-- muestra grande: la pantalla pone arriba el de calle y deja los ajustes
-- debajo, en pequeño. NADA se esconde.
--
-- Van al FINAL del SELECT a proposito: asi `CREATE OR REPLACE VIEW` las
-- agrega sin soltar la vista, y los permisos se conservan solos.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) La vista, con el recaudo partido ──────────────────────────────
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
         bool_or(g.tipo = 'no_pago')                                AS hubo_no_pago,
         -- La plata que entró POR LA CALLE. Lo demás son correcciones que
         -- secretaría escribe ese día sobre cuotas de OTROS días: plata real,
         -- pero que no se recaudó hoy ni la respondió este cobrador.
         SUM(CASE WHEN g.origen = 'campo' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                            AS neto_campo
    FROM public.gestiones g
   WHERE g.estado = 'aplicada' AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
   GROUP BY g.ruta, g.fecha_gestion, g.loan_id
),
pagos_resumen AS (
  SELECT ruta, fecha,
         COALESCE(SUM(neto), 0)                             AS total_recaudado,
         COUNT(*) FILTER (WHERE neto > 0)                   AS pagos_exitosos,
         COUNT(*) FILTER (WHERE neto <= 0 AND hubo_no_pago) AS visitas_sin_pago,
         COALESCE(SUM(neto_campo), 0)                       AS recaudo_campo,
         COALESCE(SUM(neto) - SUM(neto_campo), 0)           AS recaudo_ajuste
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
       COALESCE(cd.cuotas_vencen_hoy, 0::bigint)      AS cuotas_vencen_hoy,
       -- `total_recaudado` sigue siendo el total, para no romper a nadie que ya
       -- lo lea. La pantalla ahora muestra `recaudo_campo` arriba y deja los
       -- ajustes debajo, en pequeño: el número grande vuelve a ser el que el
       -- cobrador puede responder.
       COALESCE(pr.recaudo_campo, 0)                  AS recaudo_campo,
       COALESCE(pr.recaudo_ajuste, 0)                 AS recaudo_ajuste
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

-- ── PASO 2) La respuesta a lo que se reporto ──────────────────────────────
-- La 151 del 24/08: `recaudo_campo` debe decir 341.500 y `recaudo_ajuste`
-- 762.000. Y las dos tienen que sumar `total_recaudado`.
SELECT fecha, ruta_id,
       total_recaudado, recaudo_campo, recaudo_ajuste,
       pagos_exitosos, visitas_sin_pago,
       CASE WHEN total_recaudado = recaudo_campo + recaudo_ajuste
            THEN 'ok' ELSE '*** revisar ***' END AS cuadra
  FROM public.vista_monitoreo_admin
 WHERE fecha >= DATE '2026-08-20'
   AND total_recaudado <> 0
 ORDER BY fecha DESC, ruta_id;


-- ── PASO 3) Que siga cuadrando con el resumen ─────────────────────────────
-- EL INVARIANTE del 070: las dos pantallas miran el mismo hecho. El recaudo
-- de calle del monitoreo tiene que ser el mismo del resumen.
SELECT r.fecha_pago, r.ruta,
       r.valor_pago, v.total_recaudado,
       r.valor_pago_campo, v.recaudo_campo,
       r.cantidad_pagos, v.pagos_exitosos,
       CASE WHEN r.valor_pago = v.total_recaudado
             AND r.valor_pago_campo = v.recaudo_campo
             AND r.cantidad_pagos = v.pagos_exitosos
            THEN 'ok' ELSE '*** revisar ***' END AS cuadra
  FROM public.resumen_diario_v2 r
  JOIN public.vista_monitoreo_admin v
    ON v.ruta_id = r.ruta AND v.fecha = r.fecha_pago
 WHERE r.valor_pago <> 0 OR r.cantidad_pagos > 0
 ORDER BY r.fecha_pago DESC, r.ruta
 LIMIT 40;
