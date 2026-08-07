-- ============================================================================
-- 029 - Corregir el corte de dia en resumen_pagos_diarios (zona Colombia)
-- ============================================================================
-- PROBLEMA
-- --------
-- La vista agrupaba gastos/ingresos/retiros y ventas casteando el
-- timestamptz directo a date:
--     gastosregistros.fechahorasol::date
--     loans.fecha_creacion::date
-- Ese cast usa la zona horaria de la SESION de Postgres, que en Supabase
-- es UTC. Colombia es UTC-5, asi que todo lo registrado entre las 7:00 pm
-- y la medianoche (hora Colombia) cae en el DIA SIGUIENTE segun UTC.
--
-- Efecto real: un gasto, ingreso, retiro o venta registrado a las 10 pm
-- desaparecia del Resumen del Dia y del Cierre de Caja de HOY y aparecia
-- sumado al dia siguiente. El `efectivo` (saldo acumulado de caja), que se
-- calcula sobre esas mismas sumas, quedaba mal en ambos dias.
--
-- Los PAGOS ya estaban bien: `payment_plan.fecha_pago` es una columna DATE
-- que la app calcula en hora Colombia antes de guardarla, asi que no
-- depende de la zona de la sesion. Por eso el sintoma solo se veia en
-- gastos/ingresos/retiros/ventas y en el efectivo.
--
-- Tambien se corrige `hora_ultimo_movimiento`, que se mostraba 5 horas
-- adelantada en el Dashboard de Administrador por el mismo motivo.
--
-- La vista `vista_monitoreo_admin` ya usaba AT TIME ZONE 'America/Bogota'
-- correctamente — este script deja ambas vistas consistentes entre si.
--
-- Columnas y orden identicos al original (requisito de CREATE OR REPLACE
-- VIEW); solo cambian las expresiones de fecha/hora.
-- ============================================================================

CREATE OR REPLACE VIEW public.resumen_pagos_diarios AS
WITH pagos_agrupados AS (
  SELECT p.fecha_pago,
    p.ruta,
    sum(p.valor_cuota) AS meta_pagos,
    sum(p.monto_pagado) AS valor_pago,
    count(*) FILTER (WHERE p.estado::text = 'pagado'::text) AS cantidad_pagos,
    count(*) FILTER (WHERE p.estado::text = 'no_pago'::text) AS cantidad_no_pagos,
    count(*) FILTER (WHERE p.estado::text = 'cancelada'::text) AS cantidad_canceladas,
    sum(p.monto_pagado) FILTER (WHERE p.estado::text = 'cancelada'::text) AS valor_canceladas,
    sum(
      CASE
        WHEN l.tipo_amortizacion::text = 'aleman'::text THEN p.monto_pagado
        ELSE 0::numeric
      END) AS pago_capital,
    sum(
      CASE
        WHEN l.tipo_amortizacion::text = 'americano'::text THEN p.monto_pagado
        ELSE 0::numeric
      END) AS pago_interes,
    -- Hora del ultimo movimiento en hora Colombia (antes salia en UTC,
    -- 5 horas adelantada).
    (max(p.fecha_pago_real) AT TIME ZONE 'America/Bogota')::time without time zone AS hora_ultimo_movimiento
  FROM payment_plan p
    LEFT JOIN loans l ON p.loan_id = l.id
  GROUP BY p.fecha_pago, p.ruta
), gastos_agrupados AS (
  -- AT TIME ZONE 'America/Bogota': el dia corta a la medianoche de
  -- Colombia, no a la de UTC.
  SELECT (gastosregistros.fechahorasol AT TIME ZONE 'America/Bogota')::date AS fecha,
    gastosregistros.ruta,
    sum(gastosregistros.valor) FILTER (WHERE gastosregistros.tipo = 'Ingreso'::text AND (gastosregistros.estadosecre = 'aprobado'::text OR gastosregistros.estadoadmin = 'NA'::text)) AS valor_ingresos,
    count(*) FILTER (WHERE gastosregistros.tipo = 'Ingreso'::text AND (gastosregistros.estadosecre = 'aprobado'::text OR gastosregistros.estadoadmin = 'NA'::text)) AS recuento_ingresos,
    sum(gastosregistros.valor) FILTER (WHERE gastosregistros.tipo = 'Gasto'::text AND (gastosregistros.estadosecre = 'aprobado'::text OR gastosregistros.estadoadmin = 'NA'::text)) AS valor_gastos,
    count(*) FILTER (WHERE gastosregistros.tipo = 'Gasto'::text AND (gastosregistros.estadosecre = 'aprobado'::text OR gastosregistros.estadoadmin = 'NA'::text)) AS recuento_gastos,
    sum(gastosregistros.valor) FILTER (WHERE gastosregistros.tipo = 'Retiro'::text AND (gastosregistros.estadosecre = 'aprobado'::text OR gastosregistros.estadoadmin = 'NA'::text)) AS valor_retiros,
    count(*) FILTER (WHERE gastosregistros.tipo = 'Retiro'::text AND (gastosregistros.estadosecre = 'aprobado'::text OR gastosregistros.estadoadmin = 'NA'::text)) AS recuento_retiros
  FROM gastosregistros
  GROUP BY ((gastosregistros.fechahorasol AT TIME ZONE 'America/Bogota')::date), gastosregistros.ruta
), ventas_agrupadas AS (
  SELECT (loans.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS fecha,
    loans.ruta,
    count(*) AS cantidad_ventas,
    sum(loans.valor) AS valor_ventas
  FROM loans
  GROUP BY ((loans.fecha_creacion AT TIME ZONE 'America/Bogota')::date), loans.ruta
), resumen_base AS (
  SELECT COALESCE(p.fecha_pago, g.fecha, v.fecha) AS fecha_pago,
    COALESCE(p.ruta, g.ruta, v.ruta) AS ruta,
    COALESCE(v.cantidad_ventas, 0::bigint) AS cantidad_ventas,
    COALESCE(v.valor_ventas, 0::numeric) AS valor_ventas,
    COALESCE(p.meta_pagos, 0::numeric) AS meta_pagos,
    COALESCE(p.valor_pago, 0::numeric) AS valor_pago,
    COALESCE(p.cantidad_pagos, 0::bigint) AS cantidad_pagos,
    COALESCE(p.cantidad_no_pagos, 0::bigint) AS cantidad_no_pagos,
    COALESCE(p.cantidad_canceladas, 0::bigint) AS cantidad_canceladas,
    COALESCE(p.valor_canceladas, 0::numeric) AS valor_canceladas,
    COALESCE(p.pago_capital, 0::numeric) AS pago_capital,
    COALESCE(p.pago_interes, 0::numeric) AS pago_intereses,
    COALESCE(g.valor_ingresos, 0::numeric) AS valor_ingresos,
    COALESCE(g.recuento_ingresos, 0::bigint) AS recuento_ingresos,
    COALESCE(g.valor_gastos, 0::numeric) AS valor_gastos,
    COALESCE(g.recuento_gastos, 0::bigint) AS recuento_gastos,
    COALESCE(g.valor_retiros, 0::numeric) AS valor_retiros,
    COALESCE(g.recuento_retiros, 0::bigint) AS recuento_retiros,
    p.hora_ultimo_movimiento
  FROM pagos_agrupados p
    FULL JOIN gastos_agrupados g ON p.fecha_pago = g.fecha AND p.ruta = g.ruta
    FULL JOIN ventas_agrupadas v ON COALESCE(p.fecha_pago, g.fecha) = v.fecha AND COALESCE(p.ruta, g.ruta) = v.ruta
)
SELECT fecha_pago,
  ruta,
  cantidad_ventas,
  valor_ventas,
  meta_pagos,
  valor_pago,
  cantidad_pagos,
  cantidad_no_pagos,
  cantidad_canceladas,
  valor_canceladas,
  pago_capital,
  pago_intereses,
  valor_ingresos,
  recuento_ingresos,
  valor_gastos,
  recuento_gastos,
  valor_retiros,
  recuento_retiros,
  hora_ultimo_movimiento,
  sum(valor_ingresos + valor_pago - valor_ventas - valor_gastos - valor_retiros) OVER (PARTITION BY ruta ORDER BY fecha_pago) AS efectivo
FROM resumen_base
ORDER BY fecha_pago DESC, ruta;
