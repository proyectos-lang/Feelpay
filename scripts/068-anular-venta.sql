-- ============================================================================
-- 068 - Anular una venta desde Control Total
-- ============================================================================
-- QUE SE PIDIO
-- Que secretaria pueda eliminar ventas o prestamos en cualquier momento.
--
-- POR QUE SE ANULA Y NO SE BORRA — la decision fue del dueno
-- De 144 prestamos, 133 ya tienen plata cobrada. Borrar uno de esos haria
-- desaparecer esos pagos de los resumenes de dias ya cerrados y aprobados: el
-- cierre de caja de esos dias dejaria de cuadrar contra lo que se firmo.
--
-- Ademas hay dos candados de arquitectura: `gestiones` es un libro inmutable
-- —un trigger prohibe DELETE, siempre— y tiene llave foranea a `loans`. Un
-- prestamo con gestiones no se puede borrar sin pasar por encima de esa regla.
--
-- Asi que el prestamo se marca ANULADO: desaparece de listas, cartera y mora,
-- pero cada peso sigue contando en el dia en que entro. Las cajas cerradas no
-- se mueven.
--
-- POR QUE ESTO CUESTA CASI NADA
-- Practicamente todo el sistema filtra `estado = 'activo'`, asi que un
-- 'anulado' queda excluido SOLO. Se auditaron los filtros uno por uno y hubo
-- exactamente dos lugares que miraban `= 'cancelado'` en vez de `<> 'activo'`,
-- y por eso habrian dejado pasar un anulado:
--
--   · `recalcular_prestamo` (PASO 3 de este script)
--   · la lista de cobro (arreglado en la app)
--
-- y la cartera del monitoreo, que no filtraba por estado a proposito (PASO 4).
--
-- LO QUE **NO** CAMBIA
-- `resumen_diario_v2.valor_ventas` sigue contando la venta anulada en el dia
-- en que se creo, y sus pagos siguen en los dias en que entraron. Es
-- exactamente lo que se decidio: la plata no se mueve de dia.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Rastro de la anulacion ────────────────────────────────────────
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS anulada_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anulada_por        BIGINT,
  ADD COLUMN IF NOT EXISTS anulada_por_nombre TEXT,
  ADD COLUMN IF NOT EXISTS motivo_anulacion   TEXT;


-- ── PASO 2) Buscar las anuladas sin recorrer toda la tabla ────────────────
CREATE INDEX IF NOT EXISTS idx_loans_estado_anulado
  ON public.loans (ruta, anulada_at DESC) WHERE estado = 'anulado';


-- ── PASO 3) recalcular_prestamo NO revive una venta anulada ───────────────
CREATE OR REPLACE FUNCTION public.recalcular_prestamo(p_loan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_client_id  uuid;
  v_total      numeric;
  v_pagado     numeric;
  v_saldo      numeric;
  v_estado     text;
  v_estado_actual text;
  v_cubiertas  int;
  v_totales    int;
BEGIN
  SELECT client_id, COALESCE(valor_a_pagar, valor)
    INTO v_client_id, v_total
    FROM loans WHERE id = p_loan_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'prestamo no existe');
  END IF;

  -- 1) Cache de cuotas desde la cascada
  UPDATE payment_plan pp
    SET estado = c.estado_derivado,
        monto_pagado = CASE WHEN c.estado_derivado = 'pendiente' THEN NULL
                            WHEN c.estado_derivado = 'no_pago'  THEN 0
                            ELSE c.monto_asignado END,
        updated_at = NOW()
    FROM v_cobertura_cuotas c
  WHERE c.id = pp.id
    AND pp.loan_id = p_loan_id
    AND (pp.estado IS DISTINCT FROM c.estado_derivado
          OR pp.monto_pagado IS DISTINCT FROM
            CASE WHEN c.estado_derivado = 'pendiente' THEN NULL
                  WHEN c.estado_derivado = 'no_pago'  THEN 0
                  ELSE c.monto_asignado END);

  -- 2) Saldo y estado del préstamo (cancelado ⇔ saldo llegó a 0)
  SELECT COALESCE(pagado_neto, 0) INTO v_pagado
    FROM v_pagos_netos WHERE loan_id = p_loan_id;
  v_pagado := COALESCE(v_pagado, 0);
  v_saldo  := GREATEST(0, v_total - v_pagado);
  -- UNA VENTA ANULADA SE QUEDA ANULADA.
  --
  -- Sin esto, la proxima vez que algo tocara este prestamo —un pago tardio, un
  -- ajuste de secretaria, cualquier recalculo— esta linea lo devolveria a
  -- 'activo' y la venta anulada reaparecia en la ruta como si nada.
  --
  -- El saldo SI se sigue actualizando: la plata es la plata, y el historial
  -- del cliente tiene que seguir cuadrando.
  SELECT estado INTO v_estado_actual FROM loans WHERE id = p_loan_id;
  v_estado := CASE
                WHEN v_estado_actual = 'anulado' THEN 'anulado'
                WHEN v_saldo <= 0 THEN 'cancelado'
                ELSE 'activo'
              END;

  UPDATE loans
    SET saldo = v_saldo, estado = v_estado, updated_at = NOW()
  WHERE id = p_loan_id
    AND (saldo IS DISTINCT FROM v_saldo OR estado IS DISTINCT FROM v_estado);

  -- 3) Bandera del cliente (única fórmula: existe algún crédito activo)
  IF v_client_id IS NOT NULL THEN
    UPDATE clients c
      SET tiene_prestamo_activo = EXISTS (
            SELECT 1 FROM loans WHERE client_id = c.id AND estado = 'activo'),
          updated_at = NOW()
    WHERE c.id = v_client_id
      AND c.tiene_prestamo_activo IS DISTINCT FROM EXISTS (
            SELECT 1 FROM loans WHERE client_id = c.id AND estado = 'activo');
  END IF;

  SELECT COUNT(*) FILTER (WHERE estado IN ('pagado','cancelada') AND NOT es_extra),
        COUNT(*) FILTER (WHERE NOT es_extra)
    INTO v_cubiertas, v_totales
    FROM payment_plan WHERE loan_id = p_loan_id;

  RETURN jsonb_build_object(
    'ok', true,
    'nuevo_saldo', v_saldo,
    'total_pagado', v_pagado,
    'loan_estado_final', v_estado,
    'cuotas_cubiertas', v_cubiertas,
    'cuotas_totales', v_totales
  );
END;
$$;


-- ── PASO 4) La cartera del monitoreo excluye las anuladas ─────────────────
DROP VIEW IF EXISTS public.vista_monitoreo_admin;


-- ── PASO 5) La vista, ya sin anuladas ─────────────────────────────────────
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


-- ── PASO 6) Lectura de la vista ───────────────────────────────────────────
GRANT SELECT ON public.vista_monitoreo_admin TO anon, authenticated;


-- ── PASO 7) anular_venta ──────────────────────────────────────────────────
-- La ÚNICA puerta para anular. Firma estándar del núcleo
-- (p_user_id, p_ruta_id, p_rol, p_payload), como el resto de las RPC.
CREATE OR REPLACE FUNCTION public.anular_venta(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol     text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_loan_id   uuid;
  v_idem      uuid;
  v_prev      jsonb;
  v_motivo    text;
  v_nombre    text;
  v_loan      record;
  v_pagado    numeric;
  v_gestiones int;
  v_resultado jsonb;
BEGIN
  -- Solo secretaría y admin. Anular una venta borra un crédito de la cartera:
  -- no es una operación de campo.
  IF lower(COALESCE(p_rol,'')) NOT IN ('secretaria','secretario','admin','administrador') THEN
    RAISE EXCEPTION 'Solo secretaría o admin puede anular una venta (rol: %)', p_rol;
  END IF;

  v_loan_id := NULLIF(p_payload->>'loan_id','')::uuid;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'Falta loan_id';
  END IF;

  v_motivo := NULLIF(trim(p_payload->>'motivo'), '');
  IF v_motivo IS NULL THEN
    RAISE EXCEPTION 'Hay que decir por qué se anula la venta';
  END IF;

  -- Idempotencia: si el botón se toca dos veces o el reintento de la cola
  -- vuelve a llegar, la segunda no hace nada y devuelve lo mismo.
  v_idem := NULLIF(p_payload->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'anular_venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  SELECT id, estado, client_id, ruta, valor, valor_a_pagar, saldo
    INTO v_loan
    FROM loans WHERE id = v_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La venta no existe';
  END IF;
  IF v_loan.estado = 'anulado' THEN
    RETURN jsonb_build_object('ok', true, 'ya_estaba_anulada', true);
  END IF;

  -- Cuánta plata movió: NO se toca, pero se deja escrito en el rastro para
  -- que quien mire después sepa qué quedó colgado en las cajas de esos días.
  SELECT COALESCE(pagado_neto, 0) INTO v_pagado
    FROM v_pagos_netos WHERE loan_id = v_loan_id;
  v_pagado := COALESCE(v_pagado, 0);
  SELECT COUNT(*) INTO v_gestiones FROM gestiones WHERE loan_id = v_loan_id;

  SELECT nombre INTO v_nombre FROM usuarios WHERE id = p_user_id;

  UPDATE loans
     SET estado             = 'anulado',
         anulada_at         = NOW(),
         anulada_por        = p_user_id,
         anulada_por_nombre = v_nombre,
         motivo_anulacion   = v_motivo,
         updated_at         = NOW()
   WHERE id = v_loan_id;

  -- El evento queda en el libro, como cualquier otra cosa que le pasa a un
  -- préstamo. Monto CERO: anular no mueve plata, y ponerle el saldo lo haría
  -- aparecer como un movimiento en los informes del día.
  INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo, estado,
    fecha_gestion, monto, origen, observacion, detalle)
  VALUES (gen_random_uuid(), v_loan_id, v_loan.client_id, p_ruta_id, p_user_id,
    'ajuste', 'aplicada', (now() AT TIME ZONE 'America/Bogota')::date, 0,
    'ajuste', 'Venta anulada desde Control Total: ' || v_motivo,
    jsonb_build_object('clase', 'anulacion_venta',
                       'pagado_neto_al_anular', v_pagado,
                       'gestiones_del_prestamo', v_gestiones,
                       'saldo_al_anular', v_loan.saldo));

  -- La bandera del cliente se recalcula sola: `recalcular_prestamo` la deduce
  -- de si le queda algún crédito 'activo', y este ya no lo está. Y con el
  -- PASO 3 puesto, el recálculo respeta el 'anulado' en vez de revivirlo.
  PERFORM public.recalcular_prestamo(v_loan_id);

  -- Una multa pendiente de un crédito anulado no se puede cobrar nunca.
  UPDATE multas
     SET estado = 'cancelada',
         cancelada_at = NOW(),
         cancelada_por = p_user_id,
         cancelada_por_nombre = COALESCE(v_nombre, 'Sistema'),
         motivo_cancelacion = 'La venta fue anulada'
   WHERE loan_id = v_loan_id AND estado = 'pendiente';

  v_resultado := jsonb_build_object(
    'ok', true,
    'loan_id', v_loan_id,
    'pagado_neto', v_pagado,
    'gestiones', v_gestiones,
    'mensaje', 'La venta quedó anulada. Los pagos que ya se habían recibido '
               || 'siguen contando en los días en que entraron.');
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 8) Ejecución para la app ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.anular_venta(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 9) Verificar que las piezas quedaron ─────────────────────────────
-- Deben salir DOS filas: la función nueva y el recálculo blindado.
SELECT proname, 'ok' AS estado
  FROM pg_proc
 WHERE (proname = 'anular_venta')
    OR (proname = 'recalcular_prestamo' AND prosrc LIKE '%v_estado_actual%');


-- ── PASO 10) Ventas anuladas ──────────────────────────────────────────────
-- Recién corrido sale vacío. Después de anular una, acá queda el rastro.
SELECT l.id, l.ruta, c.nombre_completo, l.valor, l.saldo,
       l.anulada_at, l.anulada_por_nombre, l.motivo_anulacion
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.anulada_at DESC;


-- ── PASO 11) Que ninguna anulada se cuele en la cartera ───────────────────
-- Debe dar 0. Si da otra cosa, hay un filtro que mira `= 'cancelado'` en vez
-- de `<> 'activo'` y deja pasar los anulados.
SELECT COUNT(*) AS anuladas_contadas_como_cartera
  FROM public.loans l
 WHERE l.estado = 'anulado'
   AND COALESCE(l.valor_a_pagar, l.valor) - COALESCE(
         (SELECT pagado_neto FROM public.v_pagos_netos n WHERE n.loan_id = l.id), 0) > 0
   AND EXISTS (SELECT 1 FROM public.vista_monitoreo_admin v
                WHERE v.ruta_id = l.ruta AND v.cartera_activa > 0
                  AND v.fecha >= (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date);
