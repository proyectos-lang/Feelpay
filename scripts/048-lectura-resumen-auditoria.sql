-- ============================================================================
-- 048 - Lectura: resumen_diario_v2 + auditoria_prestamo (Auditoría 360)
-- ============================================================================
-- PARTE DE LA FASE 1. Correr en la ceremonia del corte (ver 049), tras el 047.
--
-- resumen_diario_v2 — el resumen del día sobre el modelo nuevo:
--   · La PLATA se agrupa por gestiones.fecha_gestion → una gestión retro
--     cae al día correcto por construcción, y los días pasados solo cambian
--     si de verdad se les fecha algo.
--   · La META se agrupa por los VENCIMIENTOS del cronograma → ya no se
--     infla con filas sintéticas (el viejo meta_pagos crecía exactamente
--     en lo que se cobraba de más).
--   · Los eventos de HOMOLOGACIÓN no cuentan (esa plata entró en el
--     sistema anterior, no en la caja de esta ruta), y las ventas
--     homologadas tampoco cuentan como venta del día.
--   · `caja_anterior` sale como columna (mueren las dos fórmulas
--     divergentes de daily-summary y cierre-caja).
--   · Mismos nombres de columnas que resumen_pagos_diarios para que el
--     switch en la app sea barato.
--
-- auditoria_prestamo(loan_id) — la película completa de un préstamo, día a
-- día, con LAS MISMAS fórmulas de las vistas vivas: si un vendedor dice
-- "no me cuadra", secretaría ve aquí de dónde sale cada número.
--
-- vista_monitoreo_admin v2 — el monitor del admin agrupaba recaudo y visitas
-- por payment_plan.fecha_pago (que el sistema viejo pisaba con la fecha del
-- cobro). Con el cronograma inmutable esa vista quedaría ciega: se redefine
-- sobre `gestiones` con LAS MISMAS columnas (la definición vieja quedó
-- documentada en scripts/000-tablas-preexistentes.sql).
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) resumen_diario_v2 ─────────────────────────────────────────────
CREATE OR REPLACE VIEW public.resumen_diario_v2 AS
WITH pagos AS (
  SELECT g.fecha_gestion AS fecha, g.ruta,
         SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END)        AS valor_pago,
         COUNT(*) FILTER (WHERE g.tipo IN ('pago','abono_venta')
                            AND g.monto > 0)                               AS cantidad_pagos,
         COUNT(*) FILTER (WHERE g.tipo = 'no_pago')                        AS cantidad_no_pagos,
         COUNT(*) FILTER (WHERE g.tipo = 'cancelacion')                    AS cantidad_canceladas,
         COALESCE(SUM(g.monto) FILTER (WHERE g.tipo = 'cancelacion'), 0)   AS valor_canceladas,
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
       -- Alias con los nombres de la vista vieja: ahí los conteos de caja se
       -- llamaban `recuento_*` mientras los de pagos y ventas se llamaban
       -- `cantidad_*`. Se conservan los dos para que ninguna pantalla quede
       -- colgada, pero los nombres buenos son los `cantidad_*`.
       b.cantidad_ingresos AS recuento_ingresos,
       b.cantidad_gastos   AS recuento_gastos,
       b.cantidad_retiros  AS recuento_retiros,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)   AS efectivo,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)
       - (b.valor_ingresos + b.valor_pago - b.valor_ventas
          - b.valor_gastos - b.valor_retiros)               AS caja_anterior
  FROM base b
 ORDER BY b.fecha_pago DESC, b.ruta;


-- ── PASO 2) Lectura para la app ───────────────────────────────────────────
GRANT SELECT ON public.resumen_diario_v2 TO anon, authenticated;


-- ── PASO 3) auditoria_prestamo — la película día a día ────────────────────
CREATE OR REPLACE FUNCTION public.auditoria_prestamo(p_loan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_loan     record;
  v_fin      record;
  v_hoy      date;
  v_d0       date;
  v_terminos jsonb;
  v_cuotas   jsonb;
  v_dias     jsonb;
BEGIN
  SELECT l.*, c.nombre_completo, c.apodo
    INTO v_loan
    FROM loans l LEFT JOIN clients c ON c.id = l.client_id
   WHERE l.id = p_loan_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El préstamo no existe');
  END IF;

  SELECT * INTO v_fin FROM v_loan_financiero WHERE loan_id = p_loan_id;

  v_hoy := (now() AT TIME ZONE 'America/Bogota')::date;
  SELECT LEAST(
           COALESCE((SELECT MIN(fecha_pago)    FROM payment_plan WHERE loan_id = p_loan_id), v_hoy),
           COALESCE((SELECT MIN(fecha_gestion) FROM gestiones    WHERE loan_id = p_loan_id), v_hoy),
           COALESCE((v_loan.fecha_creacion AT TIME ZONE 'America/Bogota')::date, v_hoy)
         ) INTO v_d0;

  v_terminos := jsonb_build_object(
    'loan_id', v_loan.id,
    'cliente', COALESCE(NULLIF(v_loan.apodo, ''), v_loan.nombre_completo),
    'valor', v_loan.valor,
    'tasa_interes', v_loan.tasa_interes,
    'tipo_amortizacion', v_loan.tipo_amortizacion,
    'frecuencia_pago', v_loan.frecuencia_pago,
    'numero_cuotas', v_loan.numero_cuotas,
    'valor_cuota', v_loan.valor_cuota,
    'total_a_pagar', v_fin.total_a_pagar,
    'saldo_inicial', v_fin.total_a_pagar,
    'origen', COALESCE(v_loan.origen, 'normal'),
    'fecha_creacion', v_loan.fecha_creacion,
    'fecha_primer_pago', v_loan.fecha_primer_pago,
    'estado', v_loan.estado
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'cuota_id', c.id,
           'numero', c.numero_cuota,
           'vence', c.fecha_pago,
           'valor', c.valor_cuota,
           'es_extra', c.es_extra,
           'estado', c.estado_derivado,
           'asignado', c.monto_asignado
         ) ORDER BY c.fecha_pago, c.numero_cuota), '[]'::jsonb)
    INTO v_cuotas
    FROM v_cobertura_cuotas c
   WHERE c.loan_id = p_loan_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'fecha', d.dia,
           'vencia', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'numero', pp.numero_cuota, 'valor', pp.valor_cuota)
                        ORDER BY pp.numero_cuota), '[]'::jsonb)
                        FROM payment_plan pp
                       WHERE pp.loan_id = p_loan_id AND pp.fecha_pago = d.dia),
           'eventos', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                         'id', g.id, 'tipo', g.tipo, 'monto', g.monto,
                         'estado', g.estado, 'origen', g.origen,
                         'usuario', u.nombre,
                         'observacion', g.observacion,
                         'motivo_revision', g.motivo_revision,
                         'referencia', g.referencia_gestion_id,
                         'detalle', g.detalle,
                         'hora', to_char(g.fecha_hora AT TIME ZONE 'America/Bogota', 'HH24:MI'))
                         ORDER BY g.fecha_hora), '[]'::jsonb)
                         FROM gestiones g
                         LEFT JOIN usuarios u ON u.id = g.user_id
                        WHERE g.loan_id = p_loan_id AND g.fecha_gestion = d.dia),
           'pagado_acumulado', pa.pagado,
           'saldo_cierre', GREATEST(0, v_fin.total_a_pagar - pa.pagado),
           'mora_cierre', GREATEST(0, va.vencido - pa.pagado)
         ) ORDER BY d.dia), '[]'::jsonb)
    INTO v_dias
    FROM (SELECT generate_series(v_d0, v_hoy, interval '1 day')::date AS dia) d
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                               WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END), 0) AS pagado
        FROM gestiones g
       WHERE g.loan_id = p_loan_id AND g.estado = 'aplicada'
         AND g.fecha_gestion <= d.dia
    ) pa
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(pp.valor_cuota), 0) AS vencido
        FROM payment_plan pp
       WHERE pp.loan_id = p_loan_id AND pp.fecha_pago <= d.dia
    ) va;

  RETURN jsonb_build_object(
    'ok', true,
    'terminos', v_terminos,
    'cuotas', v_cuotas,
    'dias', v_dias,
    'actual', jsonb_build_object(
      'saldo', v_fin.saldo,
      'saldo_hoy', v_fin.saldo_hoy,
      'total_pagado', v_fin.total_pagado,
      'saldo_en_mora', v_fin.saldo_en_mora,
      'cuotas_mora', v_fin.cuotas_mora,
      'cuotas_cubiertas', v_fin.cuotas_cubiertas,
      'cuotas_totales', v_fin.cuotas_totales
    ),
    'formulas', jsonb_build_object(
      'saldo', 'total_a_pagar (' || v_fin.total_a_pagar || ') − pagos netos aplicados (' ||
               v_fin.total_pagado || ') = ' || v_fin.saldo,
      'mora', 'vencido a hoy − pagos netos = ' || v_fin.saldo_en_mora ||
              ' (' || v_fin.cuotas_mora || ' cuotas)'
    )
  );
END;
$$;


-- ── PASO 4) vista_monitoreo_admin v2 — el monitor sobre el ledger ─────────
-- Mismas columnas y mismo orden que la vista vieja (requisito de OR REPLACE):
-- el componente admin-route-monitor.tsx sigue funcionando sin cambios.
--   total_recaudado     → plata neta de gestiones del día (sin homologación)
--   pagos_exitosos      → eventos con plata del día
--   visitas_sin_pago    → eventos no_pago del día
--   pendientes_por_visitar → cuotas del cronograma que vencen ese día y
--                            siguen pendientes
--   total_ventas        → suma de valor_a_pagar de ventas del día (misma
--                         semántica vieja), excluyendo homologadas
CREATE OR REPLACE VIEW public.vista_monitoreo_admin AS
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
  SELECT l.ruta,
         (l.created_at AT TIME ZONE 'America/Bogota')::date AS fecha_venta,
         COALESCE(SUM(l.valor_a_pagar), 0) AS total_ventas,
         COUNT(l.id)                       AS cantidad_ventas
    FROM public.loans l
   WHERE COALESCE(l.origen, 'normal') <> 'homologado'
   GROUP BY l.ruta, (l.created_at AT TIME ZONE 'America/Bogota')::date
)
SELECT rd.id     AS registro_id,
       rd.fecha,
       rd.ruta_id,
       rd.estado AS estado_ruta,
       rd.hora_inicio,
       rd.hora_fin,
       COALESCE(pr.total_recaudado, 0)            AS total_recaudado,
       COALESCE(pr.pagos_exitosos, 0::bigint)     AS pagos_exitosos,
       COALESCE(pr.visitas_sin_pago, 0::bigint)   AS visitas_sin_pago,
       COALESCE(pd.pendientes_por_visitar, 0::bigint) AS pendientes_por_visitar,
       rd.aprobacion_admin,
       COALESCE(tr.total_ingresos, 0)             AS total_ingresos,
       COALESCE(tr.total_gastos, 0)               AS total_gastos,
       COALESCE(tr.total_retiros, 0)              AS total_retiros,
       COALESCE(vr.total_ventas, 0)               AS total_ventas,
       COALESCE(vr.cantidad_ventas, 0::bigint)    AS cantidad_ventas
  FROM public.rutas_diarias rd
  LEFT JOIN pagos_resumen         pr ON rd.ruta_id = pr.ruta AND rd.fecha = pr.fecha
  LEFT JOIN pendientes_resumen    pd ON rd.ruta_id = pd.ruta AND rd.fecha = pd.fecha
  LEFT JOIN transacciones_resumen tr ON rd.ruta_id = tr.ruta AND rd.fecha = tr.fecha_transaccion
  LEFT JOIN ventas_resumen        vr ON rd.ruta_id = vr.ruta AND rd.fecha = vr.fecha_venta;


-- ── PASO 5) Verificar ─────────────────────────────────────────────────────
SELECT 'vista' AS objeto, v.viewname::text AS nombre
  FROM pg_views v
 WHERE v.schemaname = 'public'
   AND v.viewname IN ('resumen_diario_v2','vista_monitoreo_admin')
UNION ALL
SELECT 'funcion', p.proname::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'auditoria_prestamo';
