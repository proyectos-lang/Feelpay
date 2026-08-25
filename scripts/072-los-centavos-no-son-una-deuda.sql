-- ============================================================================
-- 072 - Los centavos no son una deuda
-- ============================================================================
-- LO QUE SE REPORTO
-- "En la ruta 1 el comprobante pasaba de 5 cuotas de 30 a 6 despues de pagar,
--  perfecto. Otro usuario hizo lo mismo en la 196 y NO le aumento la cuota
--  pagada."
--
-- LO QUE SE MIDIO
--   cuota 1 del credito de la 196 ....... 433.333,33
--   lo que se registro como pago ........ 433.333,00
--   faltan .............................. 0,33
--   resultado ....... la cuota quedo 'parcial', cuotas_cubiertas = 0
--
-- El contrato es 1.300.000 en 3 cuotas: 433.333,33 + 433.333,33 + 433.333,34.
-- El cronograma suma exacto — no esta mal — pero PIDE UNA CIFRA QUE NADIE
-- PUEDE ENTREGAR EN EFECTIVO. En la ruta 1 no se ve porque sus cuotas son 6 y
-- 20, numeros redondos.
--
-- POR QUE NO SE ARREGLA REDONDEANDO EL CRONOGRAMA
-- Porque no todos los centavos son ruido. Medido:
--
--   ruta 933  Ecuador    235 cuotas con centavos   $2,50 a $67,50   <- REALES
--   ruta 190  Argentina   13 cuotas                43.076,92        <- ruido
--   ruta 196  Argentina    3 cuotas                433.333,33       <- ruido
--
-- En dolares, 2,50 es una cifra que se paga. En pesos, 33 centavos no.
--
-- LA REGLA NUEVA, EN UNA LINEA
--   Una cuota queda cubierta si lo asignado alcanza el valor de la cuota
--   MENOS un margen de LEAST(1, valor_cuota * 0,005).
--
--   Nunca afloja mas de UNA unidad, ni mas del 0,5% de la cuota. Las dos
--   condiciones a la vez: la primera protege las cuotas grandes, la segunda
--   las chicas.
--
-- PROBADA CONTRA LOS CASOS REALES
--   433.333 de 433.333,33  margen 1,0000  -> CUBIERTA   (lo reportado)
--    43.076 de  43.076,92  margen 1,0000  -> CUBIERTA
--      2,00 de      2,50   margen 0,0125  -> parcial    (Ecuador, falta real)
--      2,50 de      2,50   margen 0,0125  -> CUBIERTA
--     67,00 de     67,50   margen 0,3375  -> parcial    (Ecuador, falta real)
--        19 de        20   margen 0,1000  -> parcial
--   400.000 de 433.333,33  margen 1,0000  -> parcial    (falta de verdad)
--
-- EN TODA LA CARTERA CAMBIA UNA SOLA CUOTA: la del reporte. Ninguna pasa de
-- cubierta a parcial — la regla solo afloja, y por menos de una unidad.
--
-- ADEMAS: EL PRESTAMO TIENE QUE PODER CERRAR
-- Si el cronograma pide 433.333,33 y se entregan 433.333, la cuota queda
-- cubierta pero el saldo se queda en 0,33. Sin tocar nada mas, un prestamo
-- con TODAS sus cuotas pagadas nunca llegaria a 'cancelado' y seguiria
-- saliendo en la ruta por 33 centavos. Por eso `recalcular_prestamo` tambien
-- cierra cuando no queda ninguna cuota abierta. Es la misma regla, no un
-- segundo numero magico.
--
-- Y LOS DOS CREDITOS QUE YA ESTAN VIVOS
-- Se les redondean las cuotas a unidades enteras, manteniendo el total del
-- contrato EXACTO. Son 16 cuotas en 2 creditos (rutas 190 y 196). Ecuador NO
-- se toca. Con esto sus cobros futuros vuelven a ser exactos y no dependen
-- del margen.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Que hay hoy con centavos (solo lectura) ───────────────────────
-- Deja constancia antes de tocar nada. Ecuador debe salir con cifras chicas
-- (dolares) y Argentina con cifras grandes (pesos): esa es la diferencia
-- entre un centavo real y uno de ruido.
SELECT r.id AS ruta, r.pais,
       COUNT(*)              AS cuotas_con_centavos,
       COUNT(DISTINCT pp.loan_id) AS creditos,
       MIN(pp.valor_cuota)   AS menor,
       MAX(pp.valor_cuota)   AS mayor
  FROM public.payment_plan pp
  JOIN public.rutas r ON r.id = pp.ruta
 WHERE pp.valor_cuota <> trunc(pp.valor_cuota)
 GROUP BY r.id, r.pais
 ORDER BY r.id;


-- ── PASO 2) La regla, en un solo lugar ────────────────────────────────────
-- Se escribe como funcion y no suelta dentro de la vista para que exista UNA
-- definicion de "esta cuota quedo cubierta". Si algun dia el margen cambia,
-- cambia acá y no en tres sitios que pueden quedar en desacuerdo.
CREATE OR REPLACE FUNCTION public.cubre_cuota(
  p_asignado    numeric,
  p_valor_cuota numeric
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_asignado, 0)
         >= COALESCE(p_valor_cuota, 0)
            - LEAST(1::numeric, COALESCE(p_valor_cuota, 0) * 0.005);
$$;


-- ── PASO 3) Ejecucion de la regla para la app ─────────────────────────────
GRANT EXECUTE ON FUNCTION public.cubre_cuota(numeric, numeric) TO anon, authenticated;


-- ── PASO 4) La cascada, con el margen ─────────────────────────────────────
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
         -- `cubre_cuota` en vez de `>=`: es el MISMO umbral, con el margen
         -- de redondeo. Ver el encabezado del 072.
         WHEN public.cubre_cuota(
                c.dirigido
                  + LEAST(c.valor_cuota - c.dirigido,
                          GREATEST(0, c.libre_sin_canc - (c.acum_libre - (c.valor_cuota - c.dirigido)))),
                c.valor_cuota) THEN 'pagado'
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


-- ── PASO 5) Lectura para la app ───────────────────────────────────────────
GRANT SELECT ON public.v_cobertura_cuotas TO anon, authenticated;


-- ── PASO 6) El prestamo cierra cuando no queda cuota abierta ──────────────
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
  v_cuotas_plan     int;
  v_cuotas_abiertas int;
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
  -- ¿QUEDA ALGUNA CUOTA POR COBRAR?
  --
  -- Hace falta porque el saldo y las cuotas ahora pueden discrepar en
  -- centavos: si el cronograma pidio 433.333,33 y el cliente entrego 433.333,
  -- la cuota SI quedo cubierta pero el saldo se queda en 0,33. Sin esto, un
  -- prestamo con todas sus cuotas pagadas nunca llegaria a 'cancelado' y
  -- seguiria saliendo en la ruta por 33 centavos.
  --
  -- Es la MISMA regla de la cobertura, no un segundo numero magico: se
  -- pregunta por lo que la vista ya decidio.
  SELECT COUNT(*), COUNT(*) FILTER (
           WHERE c.estado_derivado NOT IN ('pagado', 'cancelada'))
    INTO v_cuotas_plan, v_cuotas_abiertas
    FROM v_cobertura_cuotas c
   WHERE c.loan_id = p_loan_id;

  v_estado := CASE
                WHEN v_estado_actual = 'anulado' THEN 'anulado'
                WHEN v_saldo <= 0 THEN 'cancelado'
                -- `v_cuotas_plan > 0` es la guarda que importa: un prestamo
                -- sin cronograma tiene cero cuotas abiertas, y sin esto se
                -- daria por cancelado sin haber cobrado nada.
                WHEN v_cuotas_plan > 0 AND v_cuotas_abiertas = 0 THEN 'cancelado'
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


-- ── PASO 7) Redondear los dos creditos vivos (solo lectura primero) ───────
-- ESTO ES LO QUE VA A CAMBIAR. Miralo antes de correr el paso 8.
-- La suma por credito NO cambia: la ultima cuota absorbe la diferencia.
WITH objetivo AS (
  SELECT l.id AS loan_id,
         COALESCE(l.valor_a_pagar, l.valor) AS total,
         COUNT(*)          AS n,
         MAX(pp.numero_cuota) AS ultima
    FROM public.loans l
    JOIN public.payment_plan pp ON pp.loan_id = l.id
    JOIN public.rutas r ON r.id = l.ruta
   WHERE lower(trim(COALESCE(r.pais,''))) IN ('argentina','colombia')
     AND EXISTS (SELECT 1 FROM public.payment_plan p2
                  WHERE p2.loan_id = l.id
                    AND p2.valor_cuota <> trunc(p2.valor_cuota))
   GROUP BY l.id, COALESCE(l.valor_a_pagar, l.valor)
),
redondeo AS (
  SELECT pp.id, pp.loan_id, pp.numero_cuota, pp.valor_cuota AS antes,
         round(pp.valor_cuota) AS redondeada,
         o.total,
         o.ultima,
         SUM(round(pp.valor_cuota)) OVER (PARTITION BY pp.loan_id) AS suma_redondeada
    FROM public.payment_plan pp
    JOIN objetivo o ON o.loan_id = pp.loan_id
)
SELECT loan_id, numero_cuota, antes,
       CASE WHEN numero_cuota = ultima
            THEN redondeada + (total - suma_redondeada)
            ELSE redondeada END AS despues,
       total AS total_del_contrato
  FROM redondeo
 ORDER BY loan_id, numero_cuota;


-- ── PASO 8) Aplicarlo ─────────────────────────────────────────────────────
-- `fecha_pago` NO se toca: es el vencimiento pactado y no se pisa nunca.
-- Solo cambia el valor, y el total del contrato queda igual.
WITH objetivo AS (
  SELECT l.id AS loan_id,
         COALESCE(l.valor_a_pagar, l.valor) AS total,
         MAX(pp.numero_cuota) AS ultima
    FROM public.loans l
    JOIN public.payment_plan pp ON pp.loan_id = l.id
    JOIN public.rutas r ON r.id = l.ruta
   WHERE lower(trim(COALESCE(r.pais,''))) IN ('argentina','colombia')
     AND EXISTS (SELECT 1 FROM public.payment_plan p2
                  WHERE p2.loan_id = l.id
                    AND p2.valor_cuota <> trunc(p2.valor_cuota))
   GROUP BY l.id, COALESCE(l.valor_a_pagar, l.valor)
),
redondeo AS (
  SELECT pp.id, pp.numero_cuota, o.total, o.ultima,
         round(pp.valor_cuota) AS redondeada,
         SUM(round(pp.valor_cuota)) OVER (PARTITION BY pp.loan_id) AS suma_redondeada
    FROM public.payment_plan pp
    JOIN objetivo o ON o.loan_id = pp.loan_id
)
UPDATE public.payment_plan pp
   SET valor_cuota = CASE WHEN r.numero_cuota = r.ultima
                          THEN r.redondeada + (r.total - r.suma_redondeada)
                          ELSE r.redondeada END,
       updated_at  = NOW()
  FROM redondeo r
 WHERE pp.id = r.id
   AND pp.valor_cuota IS DISTINCT FROM (CASE WHEN r.numero_cuota = r.ultima
                                             THEN r.redondeada + (r.total - r.suma_redondeada)
                                             ELSE r.redondeada END);


-- ── PASO 9) Rehacer el cache de todos los prestamos ───────────────────────
-- `payment_plan.estado`, `payment_plan.monto_pagado`, `loans.saldo` y
-- `loans.estado` son un CACHE que solo escribe `recalcular_prestamo`. La
-- vista y las cuotas ya cambiaron; sin esto las tablas seguirian con lo viejo.
SELECT public.recalcular_prestamo(id) FROM public.loans;


-- ── PASO 10) LA RESPUESTA A LO QUE SE REPORTO ─────────────────────────────
-- El credito de la ruta 196. `cuotas_cubiertas` debe decir 1, no 0.
SELECT c.nombre_completo,
       f.total_a_pagar, f.total_pagado, f.saldo_hoy,
       f.cuotas_cubiertas, f.cuotas_totales
  FROM public.loans l
  JOIN public.clients c ON c.id = l.client_id
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
 WHERE l.ruta = 196;


-- ── PASO 11) Sus cuotas, una por una ──────────────────────────────────────
-- La cuota 1 debe valer 433.333 (entera) y estar 'pagado'.
SELECT numero_cuota, valor_cuota, monto_asignado, estado_derivado
  FROM public.v_cobertura_cuotas
 WHERE loan_id IN (SELECT id FROM public.loans WHERE ruta = 196)
 ORDER BY numero_cuota;


-- ── PASO 12) Que no se haya perdido ni aparecido plata ────────────────────
-- Por credito: la suma de las cuotas tiene que seguir siendo el contrato.
-- `descuadre` debe dar 0 en TODAS las filas.
SELECT l.ruta, l.id AS loan_id,
       COALESCE(l.valor_a_pagar, l.valor) AS contrato,
       SUM(pp.valor_cuota)                AS suma_cuotas,
       COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota) AS descuadre
  FROM public.loans l
  JOIN public.payment_plan pp ON pp.loan_id = l.id
 GROUP BY l.ruta, l.id, COALESCE(l.valor_a_pagar, l.valor)
HAVING abs(COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota)) > 0.004
 ORDER BY l.ruta;


-- ── PASO 13) Que Ecuador siga intacto ─────────────────────────────────────
-- Sus 235 cuotas con centavos son DOLARES y siguen ahi. Si esta lista sale
-- vacia, el redondeo se comio algo que no debia.
SELECT r.id AS ruta, r.pais, COUNT(*) AS cuotas_con_centavos
  FROM public.payment_plan pp
  JOIN public.rutas r ON r.id = pp.ruta
 WHERE pp.valor_cuota <> trunc(pp.valor_cuota)
 GROUP BY r.id, r.pais
 ORDER BY r.id;
