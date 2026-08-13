-- ============================================================================
-- 036 - El saldo y la mora se calculan con la fecha de Colombia
-- ============================================================================
-- PROBLEMA
-- Las vistas `saldo_prestamos_clientes` y `v_loan_mora_status` deciden que
-- cuotas estan vencidas comparando contra `CURRENT_DATE`, que es la fecha
-- del SERVIDOR. Supabase corre en UTC y Colombia esta cinco horas atras.
--
-- Consecuencia: todos los dias, entre las 7 de la noche y la medianoche
-- hora Colombia, el servidor ya esta en el dia siguiente. En esa franja una
-- cuota que vence MAÑANA se cuenta como vencida hoy, asi que:
--
--   · el saldo del cliente sube de golpe una cuota, y
--   · la mora suma un dia que todavia no existe.
--
-- Justo la franja en la que los cobradores cierran la jornada. Es el mismo
-- error de zona horaria que ya se corrigio para el Resumen del Dia en el
-- script 029; estas dos vistas quedaron sin arreglar.
--
-- QUE NO CAMBIA
-- La definicion del saldo se mantiene igual. En los prestamos americanos
-- sigue siendo "lo que el cliente debe HOY" — capital mas los intereses ya
-- vencidos — que es como se decidio que debe verse. Lo unico que cambia es
-- CUAL es el dia de hoy.
-- ============================================================================


-- ── Antes de correr: confirmar el desfase ────────────────────────────────
-- Si `fecha_servidor` y `fecha_colombia` salen distintas, estas en la franja
-- en la que el error se manifiesta.
SELECT current_setting('TimeZone')                     AS zona_del_servidor,
       CURRENT_DATE                                    AS fecha_servidor,
       (now() AT TIME ZONE 'America/Bogota')::date     AS fecha_colombia,
       now()                                           AS ahora;


-- ── Saldo por cliente ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.saldo_prestamos_clientes AS
 SELECT l.id AS loan_id,
    l.client_id,
    l.valor AS monto_original,
    l.valor_a_pagar AS total_con_intereses,
    COALESCE(p.total_pagado, (0)::numeric) AS total_recaudado,
    CASE
        WHEN (l.tipo_amortizacion)::text = 'americano'::text
        THEN ((l.valor + COALESCE(p.cuotas_pendientes_hasta_hoy, (0)::numeric)) - COALESCE(p.total_pagado, (0)::numeric))
        ELSE (l.valor_a_pagar - COALESCE(p.total_pagado, (0)::numeric))
    END AS saldo_pendiente,
    l.estado,
    l.ruta,
    l.fecha_creacion,
    p.fechaultimopago
   FROM loans l
   LEFT JOIN (
     SELECT payment_plan.loan_id,
        sum(payment_plan.monto_pagado) AS total_pagado,
        sum(CASE
              -- CAMBIO: la fecha de hoy es la de Colombia, no la del servidor.
              WHEN payment_plan.fecha_pago <= (now() AT TIME ZONE 'America/Bogota')::date
               AND (payment_plan.estado)::text <> 'pagado'::text
               AND (payment_plan.estado)::text <> 'cancelada'::text
              THEN payment_plan.valor_cuota - COALESCE(payment_plan.capital, (0)::numeric)
              ELSE (0)::numeric
            END) AS cuotas_pendientes_hasta_hoy,
        max(CASE
              WHEN (payment_plan.estado)::text = 'pagado'::text
              THEN payment_plan.fecha_pago
              ELSE NULL::date
            END) AS fechaultimopago
       FROM payment_plan
      GROUP BY payment_plan.loan_id
   ) p ON l.id = p.loan_id;


-- ── Mora por prestamo ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_loan_mora_status AS
 WITH summary AS (
   SELECT payment_plan.loan_id,
      sum(CASE
            -- CAMBIO: idem, la fecha de hoy es la de Colombia.
            WHEN payment_plan.fecha_pago < (now() AT TIME ZONE 'America/Bogota')::date
            THEN payment_plan.valor_cuota
            ELSE (0)::numeric
          END) AS total_debido_a_hoy,
      sum(payment_plan.monto_pagado) AS total_pagado_real,
      COALESCE(
        max(payment_plan.valor_cuota) FILTER (WHERE NOT payment_plan.es_extra),
        max(payment_plan.valor_cuota)
      ) AS valor_cuota_referencia
     FROM payment_plan
    GROUP BY payment_plan.loan_id
 )
 SELECT loan_id,
    total_debido_a_hoy,
    total_pagado_real,
    GREATEST(total_debido_a_hoy - total_pagado_real, (0)::numeric) AS saldo_en_mora,
    CASE
      WHEN (total_debido_a_hoy - total_pagado_real) > (0)::numeric
      THEN ceil((total_debido_a_hoy - total_pagado_real) / NULLIF(valor_cuota_referencia, (0)::numeric))
      ELSE (0)::numeric
    END AS dias_mora_calculada
   FROM summary;

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- DIAGNÓSTICO APARTE — préstamos cuyo plan no cuadra con `valor_a_pagar`
-- ============================================================================
-- Esto NO lo arregla el script: es un problema del dato, no de las vistas.
--
-- Si la suma de las cuotas no coincide con `valor_a_pagar`, el saldo que se
-- muestra puede salirse de rango — es el caso de "rosa aguas", que aparece
-- debiendo 140 sobre un préstamo cuyo total dice 120.
--
-- Diferencias de centavos son normales (el redondeo por cuota no reparte el
-- residuo). Una diferencia grande es un dato malo.
SELECT c.apodo,
       l.tipo_amortizacion,
       l.valor,
       l.tasa_interes,
       l.numero_cuotas,
       l.valor_a_pagar,
       round(sum(pp.valor_cuota), 2)                     AS suma_del_plan,
       round(sum(pp.valor_cuota) - l.valor_a_pagar, 2)   AS diferencia,
       count(pp.id)                                      AS cuotas_en_el_plan
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  JOIN payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY c.apodo, l.id, l.tipo_amortizacion, l.valor, l.tasa_interes,
          l.numero_cuotas, l.valor_a_pagar
HAVING abs(sum(pp.valor_cuota) - l.valor_a_pagar) > 1
 ORDER BY abs(sum(pp.valor_cuota) - l.valor_a_pagar) DESC;
