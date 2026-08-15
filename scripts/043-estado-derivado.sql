  -- ============================================================================
  -- 043 - Estado derivado: las vistas de verdad + recalcular_prestamo
  -- ============================================================================
  -- PARTE DE LA FASE 1. Correr en la ceremonia del corte (ver 049), tras el 042.
  --
  -- EL PRINCIPIO
  -- Ya nada de plata se guarda "porque sí": todo se DERIVA de dos fuentes —
  -- el cronograma (payment_plan, inmutable) y el libro de eventos (gestiones).
  --
  --   v_pagos_netos       cuánta plata neta ha entrado por préstamo
  --   v_cobertura_cuotas  la CASCADA: qué cuota queda cubierta con esa plata
  --                       (esta vista ES la definición de estado de una cuota)
  --   v_loan_financiero   saldo / saldo de hoy / mora por préstamo — LA fórmula
  --
  -- `payment_plan.estado` y `monto_pagado` pasan a ser un CACHE de
  -- v_cobertura_cuotas, escrito por UNA sola función: recalcular_prestamo().
  -- Así la UI vieja sigue leyendo lo mismo de siempre, pero ya no puede
  -- divergir: si alguna vez difiere del derivado, es un bug detectable con la
  -- query de paridad del PASO 6 — y se repara volviendo a llamar la función.
  --
  -- LA CASCADA (waterfall)
  -- La plata neta se asigna a las cuotas en orden de vencimiento. Una cuota
  -- está `pagado` si la plata acumulada la cubre completa, `parcial` si la
  -- cubre a medias (y el siguiente abono completa ESA MISMA cuota — se acabó
  -- el parcial invisible), `no_pago` si hubo visita sin pago anclada a ella,
  -- `cancelada` para lo que queda cuando el crédito se canceló.
  --
  -- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
  -- ============================================================================


  -- ── PASO 1) v_pagos_netos ─────────────────────────────────────────────────
  -- Una reversa resta en el "balde" del evento al que apunta (si un pago se
  -- reversa, resta de pagos; si una cancelación se reversa, resta de
  -- cancelaciones). Una reversa SIN referencia es un ajuste de dinero de
  -- secretaría y resta del total general.
  CREATE OR REPLACE VIEW public.v_pagos_netos AS
  WITH ev AS (
    SELECT g.loan_id,
          CASE WHEN g.tipo = 'reversa' THEN COALESCE(ref.tipo, 'pago') ELSE g.tipo END AS balde,
          CASE WHEN g.tipo = 'reversa' THEN -g.monto ELSE g.monto END AS monto_efectivo,
          g.tipo, g.fecha_gestion, g.monto
      FROM public.gestiones g
      LEFT JOIN public.gestiones ref ON ref.id = g.referencia_gestion_id
    WHERE g.estado = 'aplicada'
      AND g.tipo IN ('pago','cancelacion','abono_venta','reversa')
  )
  SELECT loan_id,
        GREATEST(0, COALESCE(SUM(monto_efectivo), 0))                       AS pagado_neto,
        GREATEST(0, COALESCE(SUM(monto_efectivo)
                      FILTER (WHERE balde <> 'cancelacion'), 0))            AS pagado_sin_cancelacion,
        (COUNT(*) FILTER (WHERE tipo = 'cancelacion')
          > COUNT(*) FILTER (WHERE tipo = 'reversa' AND balde = 'cancelacion')) AS tiene_cancelacion,
        MAX(fecha_gestion) FILTER (WHERE tipo IN ('pago','cancelacion','abono_venta')
                                      AND monto > 0)                         AS fecha_ultimo_pago
    FROM ev
  GROUP BY loan_id;


  -- ── PASO 2) v_cobertura_cuotas — la cascada ───────────────────────────────
  CREATE OR REPLACE VIEW public.v_cobertura_cuotas AS
  WITH plan AS (
    SELECT pp.id, pp.loan_id, pp.numero_cuota, pp.fecha_pago, pp.valor_cuota,
          pp.es_extra,
          SUM(pp.valor_cuota) OVER (
            PARTITION BY pp.loan_id
            ORDER BY pp.fecha_pago, pp.numero_cuota, pp.id
          ) AS acumulado
      FROM public.payment_plan pp
  )
  SELECT p.id, p.loan_id, p.numero_cuota, p.fecha_pago, p.valor_cuota,
        p.es_extra, p.acumulado,
        LEAST(p.valor_cuota,
              GREATEST(0, COALESCE(n.pagado_neto, 0) - (p.acumulado - p.valor_cuota)))
          AS monto_asignado,
        CASE
          WHEN COALESCE(n.pagado_sin_cancelacion, 0) >= p.acumulado THEN 'pagado'
          WHEN COALESCE(n.tiene_cancelacion, false)                 THEN 'cancelada'
          WHEN COALESCE(n.pagado_neto, 0) > p.acumulado - p.valor_cuota THEN 'parcial'
          WHEN EXISTS (
            SELECT 1 FROM public.gestiones g
              WHERE g.cuota_objetivo = p.id AND g.tipo = 'no_pago'
                AND g.estado = 'aplicada'
                AND NOT EXISTS (
                  SELECT 1 FROM public.gestiones r
                  WHERE r.referencia_gestion_id = g.id
                    AND r.tipo = 'reversa' AND r.estado = 'aplicada')
          ) THEN 'no_pago'
          ELSE 'pendiente'
        END AS estado_derivado
    FROM plan p
    LEFT JOIN public.v_pagos_netos n ON n.loan_id = p.loan_id;


  -- ── PASO 3) v_loan_financiero — saldo y mora, LA definición ───────────────
  -- saldo        = total del contrato − plata neta (para cancelar y cerrar)
  -- saldo_hoy    = lo que el cliente debe HOY (americano: capital + interés
  --                causado hasta hoy − pagado; siempre con piso en 0 — fix de
  --                la vista 036 que podía dar negativo)
  -- saldo_en_mora / cuotas_mora = lo vencido no cubierto, sobre el cronograma
  --                INTACTO (la mora ya no se subestima tras cada gestión)
  CREATE OR REPLACE VIEW public.v_loan_financiero AS
  SELECT l.id  AS loan_id,
        l.client_id,
        l.ruta,
        l.estado AS loan_estado,
        l.tipo_amortizacion,
        COALESCE(l.valor_a_pagar, l.valor)                                  AS total_a_pagar,
        COALESCE(n.pagado_neto, 0)                                          AS total_pagado,
        GREATEST(0, COALESCE(l.valor_a_pagar, l.valor)
                    - COALESCE(n.pagado_neto, 0))                           AS saldo,
        GREATEST(0, CASE WHEN l.tipo_amortizacion = 'americano'
                          THEN l.valor + COALESCE(ints.interes_causado, 0)
                              - COALESCE(n.pagado_neto, 0)
                          ELSE COALESCE(l.valor_a_pagar, l.valor)
                              - COALESCE(n.pagado_neto, 0) END)             AS saldo_hoy,
        GREATEST(0, COALESCE(venc.total_vencido, 0)
                    - COALESCE(n.pagado_neto, 0))                           AS saldo_en_mora,
        CASE WHEN COALESCE(venc.total_vencido, 0) - COALESCE(n.pagado_neto, 0) > 0
              THEN CEIL((venc.total_vencido - COALESCE(n.pagado_neto, 0))
                        / NULLIF(cref.valor_ref, 0))
              ELSE 0 END                                                     AS cuotas_mora,
        n.fecha_ultimo_pago,
        COALESCE(cob.cubiertas, 0)                                          AS cuotas_cubiertas,
        COALESCE(cob.totales, 0)                                            AS cuotas_totales,
        COALESCE(cob.extras, 0)                                             AS cuotas_extra
    FROM public.loans l
    LEFT JOIN public.v_pagos_netos n ON n.loan_id = l.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pp.valor_cuota), 0) AS total_vencido
        FROM public.payment_plan pp
      WHERE pp.loan_id = l.id
        AND pp.fecha_pago < (now() AT TIME ZONE 'America/Bogota')::date
    ) venc ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pp.interes), 0) AS interes_causado
        FROM public.payment_plan pp
      WHERE pp.loan_id = l.id
        AND pp.fecha_pago <= (now() AT TIME ZONE 'America/Bogota')::date
    ) ints ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra),
                      MAX(pp.valor_cuota)) AS valor_ref
        FROM public.payment_plan pp
      WHERE pp.loan_id = l.id
    ) cref ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE c.estado_derivado IN ('pagado','cancelada')
                                AND NOT c.es_extra)          AS cubiertas,
            COUNT(*) FILTER (WHERE NOT c.es_extra)          AS totales,
            COUNT(*) FILTER (WHERE c.es_extra)              AS extras
        FROM public.v_cobertura_cuotas c
      WHERE c.loan_id = l.id
    ) cob ON true;


  -- ── PASO 4) recalcular_prestamo — el ÚNICO escritor del estado derivado ───
  -- Materializa v_cobertura_cuotas en payment_plan (cache), y escribe
  -- loans.saldo/estado + clients.tiene_prestamo_activo con UNA sola fórmula.
  -- Es determinística e idempotente: se puede llamar mil veces.
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
    v_estado := CASE WHEN v_saldo <= 0 THEN 'cancelado' ELSE 'activo' END;

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


  -- ── PASO 5) Lectura de las vistas para la app ─────────────────────────────
  GRANT SELECT ON public.v_pagos_netos, public.v_cobertura_cuotas,
                  public.v_loan_financiero TO anon, authenticated;


  -- ── PASO 6) Verificación de paridad cache == vista ────────────────────────
  -- SOLO LECTURA. Debe devolver CERO filas cuando el sistema esté en marcha.
  -- (Antes del corte devolverá filas: los datos viejos no vienen de la
  -- cascada — es lo esperado y se van con el reset.)
  SELECT pp.loan_id, pp.id AS cuota, pp.estado AS cache, c.estado_derivado AS vista,
        pp.monto_pagado AS monto_cache, c.monto_asignado AS monto_vista
    FROM public.payment_plan pp
    JOIN public.v_cobertura_cuotas c ON c.id = pp.id
  WHERE pp.estado IS DISTINCT FROM c.estado_derivado
      OR (pp.estado IN ('pagado','parcial','cancelada')
          AND pp.monto_pagado IS DISTINCT FROM c.monto_asignado)
  LIMIT 50;
