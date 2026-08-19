-- ============================================================================
-- 060 - El Monitoreo muestra la cartera real, no solo las cuotas de hoy
-- ============================================================================
-- EL SÍNTOMA
-- "Monitoreo de rutas no está mostrando los clientes pendientes en la unidad
-- 190."
--
-- LO QUE SE VERIFICÓ EN LA BASE
-- La vista SÍ mostraba 5 pendientes ese día, y el 5 era correcto: había
-- exactamente 5 cuotas con vencimiento hoy sin gestionar. El problema es que
-- ese número responde una pregunta distinta de la que hace quien mira el
-- monitoreo.
--
-- `pendientes_por_visitar` contaba SOLO las cuotas que vencen exactamente ese
-- día. Pero el cobrador, en su teléfono, ve otra cosa: todos los créditos con
-- saldo que no ha gestionado hoy — incluyendo mora y los que vencen más
-- adelante. Esa ruta tiene 39 créditos con saldo, y calculando el criterio
-- del cobrador por fuera de la base dan 34 sin gestionar. El monitoreo decía
-- 5 y el teléfono mostraba 34. Los dos números eran ciertos; medían cosas
-- distintas.
--
-- LA CORRECCIÓN
-- `pendientes_por_visitar` pasa a ser LA CARTERA REAL de esa ruta ese día:
-- créditos que ya existían, que todavía debían, y que no tuvieron ninguna
-- gestión. Es el mismo criterio de la lista del cobrador.
--
-- Se agrega `cartera_activa` como denominador: sin él, "48 pendientes" no
-- dice si la ruta va atrasada o si simplemente tiene 300 clientes.
--
-- Y se CONSERVA el número anterior como `cuotas_vencen_hoy`. Sin ese contexto,
-- ver el contador saltar de 5 a decenas se lee como un error nuevo.
--
-- POR QUÉ EL SALDO SE ACUMULA POR FECHA Y NO SE LEE DE `v_loan_financiero`
-- Esa vista calcula el saldo a HOY. Usarla haría que el monitoreo de una
-- fecha pasada mostrara la cartera actual, y un crédito cancelado ayer
-- desaparecería retroactivamente de todos los días anteriores. Sumar lo
-- pagado hasta esa fecha es lo único que hace que el 15 de agosto siga
-- diciendo lo que decía el 15 de agosto.
--
-- POR QUÉ EL CRÉDITO ENTRA POR `fecha_creacion` Y NO POR EL INICIO DEL PLAN
-- Una venta homologada se crea hoy con un cronograma que arranca la semana
-- pasada. Si entrara por el inicio del plan, aparecería como "pendiente por
-- visitar" en días en los que ni siquiera estaba en el sistema, y ahí se
-- quedaría para siempre: sus gestiones retro son `origen = 'homologacion'`,
-- que esta vista no cuenta como visita — igual que ya hacía `pagos_resumen`
-- para no inflar el recaudo del día.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 0) Índice para el recorrido por ruta ─────────────────────────────
-- El cálculo nuevo recorre los créditos de cada ruta por cada día con
-- jornada. Sin este índice serían recorridos completos de la tabla.
CREATE INDEX IF NOT EXISTS idx_loans_ruta_estado ON public.loans (ruta, estado);


-- ── PASO 1) Soltar la vista ───────────────────────────────────────────────
DROP VIEW IF EXISTS public.vista_monitoreo_admin;


-- ── PASO 2) La vista ──────────────────────────────────────────────────────
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
       -- Seguía debiendo ESE día. No se filtra por `loans.estado`: solo tiene
       -- 'activo' y 'cancelado', y un cancelado ya sale por saldo cero — un
       -- filtro por estado sería letra muerta que se lee como si hiciera algo.
       AND COALESCE(l.valor_a_pagar, l.valor) - pag.pagado > 0
  ) cart ON true
  LEFT JOIN transacciones_resumen tr ON rd.ruta_id = tr.ruta AND rd.fecha = tr.fecha_transaccion
  LEFT JOIN ventas_resumen        vr ON rd.ruta_id = vr.ruta AND rd.fecha = vr.fecha_venta;


-- ── PASO 3) Quiénes son ───────────────────────────────────────────────────
-- El contador sin la lista obliga a creerle. Esta función devuelve la misma
-- cartera que cuenta la vista, con el MISMO predicado copiado al pie de la
-- letra, más una marca de si ya se gestionó ese día. El paso 5 verifica que
-- los dos números coinciden; si alguien toca uno y olvida el otro, ese paso
-- lo delata.
CREATE OR REPLACE FUNCTION public.cartera_del_dia(
  p_ruta_id INTEGER,
  p_fecha   DATE
)
RETURNS TABLE (loan_id UUID, gestionado BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, ges.gestionado
    FROM public.loans l
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(CASE
               WHEN gg.tipo IN ('pago','cancelacion','abono_venta') THEN gg.monto
               WHEN gg.tipo = 'reversa' THEN -gg.monto ELSE 0 END), 0) AS pagado
        FROM public.gestiones gg
       WHERE gg.loan_id = l.id
         AND gg.estado = 'aplicada'
         AND gg.fecha_gestion <= p_fecha
    ) pag
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM public.gestiones g2
         WHERE g2.loan_id = l.id
           AND g2.fecha_gestion = p_fecha
           AND g2.estado = 'aplicada'
           AND g2.origen <> 'homologacion'
           AND g2.tipo IN ('pago','no_pago','cancelacion','abono_venta')
      ) AS gestionado
    ) ges
   WHERE l.ruta = p_ruta_id
     AND (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date <= p_fecha
     AND COALESCE(l.valor_a_pagar, l.valor) - pag.pagado > 0
$$;


-- ── PASO 4a) Lectura de la vista ──────────────────────────────────────────
GRANT SELECT ON public.vista_monitoreo_admin TO anon, authenticated;


-- ── PASO 4b) Ejecución de la función ──────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.cartera_del_dia(INTEGER, DATE) TO anon, authenticated;


-- ── PASO 5) Verificar ─────────────────────────────────────────────────────
-- Las dos definiciones lado a lado. Estos son los valores REALES calculados
-- contra la base el 19/08/2026 aplicando el criterio nuevo por fuera; la
-- vista debe reproducirlos:
--
--   fecha        ruta   cuotas_vencen_hoy   pendientes   cartera_activa
--   2026-08-19    190          5                34             39
--   2026-08-19      1          4                 6              6
--   2026-08-18    190          0                 4             39
--   2026-08-18    933          1                11             48
--
-- La 190 de hoy es exactamente el reclamo del dueño: la vista decía 5 y el
-- cobrador tenía 34 por visitar.
--
-- `cuotas_vencen_hoy` debe coincidir EXACTAMENTE con lo que mostraba la
-- columna vieja en todas las filas: es la misma cuenta, solo renombrada.
--
-- Los días anteriores al corte (script 049) salen en 0: los créditos de
-- entonces se borraron, así que ese día ya no tiene cartera que contar. No es
-- un error de la vista, es que esa historia no existe.
--
-- `gestionados_del_dia` es la resta: cuántos de la cartera ya se atendieron.
SELECT fecha, ruta_id,
       cuotas_vencen_hoy,
       pendientes_por_visitar,
       cartera_activa,
       cartera_activa - pendientes_por_visitar AS gestionados_del_dia,
       pagos_exitosos,
       visitas_sin_pago
  FROM public.vista_monitoreo_admin
 ORDER BY fecha DESC, ruta_id
 LIMIT 40;


-- ── PASO 6) Que la lista y el contador digan lo mismo ─────────────────────
-- Para cada día y ruta, lo que cuenta la vista contra lo que lista la
-- función. `descuadre_*` debe dar 0 en TODAS las filas. Si alguna trae otra
-- cosa, la lista del ojito mostraría gente distinta de la que anuncia el
-- número, y eso es peor que no mostrar nada.
SELECT v.fecha, v.ruta_id,
       v.cartera_activa          - f.cartera          AS descuadre_cartera,
       v.pendientes_por_visitar  - f.pendientes       AS descuadre_pendientes
  FROM public.vista_monitoreo_admin v
  CROSS JOIN LATERAL (
    SELECT COUNT(*)                                   AS cartera,
           COUNT(*) FILTER (WHERE NOT c.gestionado)   AS pendientes
      FROM public.cartera_del_dia(v.ruta_id::int, v.fecha) c
  ) f
 WHERE v.cartera_activa <> f.cartera
    OR v.pendientes_por_visitar <> f.pendientes;


-- ── PASO 7) Cronometrar ───────────────────────────────────────────────────
-- El cálculo nuevo recorre créditos por cada día con jornada. Debe responder
-- en milisegundos; si tarda segundos, avisar para materializarla por fecha.
EXPLAIN ANALYZE SELECT * FROM public.vista_monitoreo_admin;
