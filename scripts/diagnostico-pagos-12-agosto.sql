-- ============================================================================
-- Diagnóstico — pagos del 12/08/2026 que no se ven reflejados
-- ============================================================================
-- SOLO LECTURA. No modifica nada.
--
-- YA SABEMOS:
--   · Los pagos SÍ llegan a la base (no es la cola offline ni el reset).
--   · Las cuotas saldadas por CANCELACIÓN quedan en estado 'cancelada' y el
--     contador solo sumaba 'pagado' — de ahí "no se ven cuotas pagadas".
--     Ya está corregido en la app.
--
-- FALTA: entender por qué los saldos se ven iguales.
--
-- Cada bloque es UNA sola sentencia: selecciónalo con el mouse y dale Run.
-- El editor de Supabase solo muestra el resultado de la última si corres
-- varias juntas.
-- ============================================================================


-- ── BLOQUE A ── ¿Cuánto llegó el 12 de agosto? ────────────────────────────
-- Si "cuotas gestionadas" es mucho menor de lo que se registró ese día,
-- faltan pagos por llegar. Si cuadra, el problema es de visualización.
SELECT 'cuotas gestionadas' AS que,
       count(*)::text AS cuantas
  FROM payment_plan
 WHERE (fecha_pago_real AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12'
UNION ALL
SELECT 'de esas, con plata',
       count(*)::text FROM payment_plan
 WHERE (fecha_pago_real AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12'
   AND COALESCE(monto_pagado, 0) > 0
UNION ALL
SELECT 'total recaudado ese dia',
       COALESCE(sum(monto_pagado), 0)::text FROM payment_plan
 WHERE (fecha_pago_real AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12'
UNION ALL
SELECT 'operaciones procesadas (llaves)',
       count(*)::text FROM operaciones_procesadas
 WHERE (created_at AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12'
UNION ALL
SELECT 'solicitudes de revision creadas',
       count(*)::text FROM solicitudes_revision
 WHERE (created_at AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12'
UNION ALL
SELECT 'movimientos de caja',
       count(*)::text FROM gastosregistros
 WHERE (fechahorasol AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12'
UNION ALL
SELECT 'prestamos tocados',
       count(*)::text FROM loans
 WHERE (updated_at AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12';


-- ── BLOQUE B ── Estado actual del plan de pagos ───────────────────────────
-- Radiografía de todo el plan. Sirve para ver cuánto se ha gestionado en
-- total y desde qué fecha corre el cronograma.
SELECT estado,
       count(*)                                            AS cuotas,
       min(fecha_pago)                                     AS desde,
       max(fecha_pago)                                     AS hasta,
       count(*) FILTER (WHERE fecha_pago_real IS NOT NULL) AS con_gestion,
       count(*) FILTER (WHERE monto_pagado IS NULL)        AS sin_monto,
       COALESCE(sum(monto_pagado), 0)                      AS recaudado
  FROM payment_plan
 GROUP BY estado
 ORDER BY 2 DESC;


-- ── BLOQUE C ── Préstamos cuyo saldo no cuadra ────────────────────────────
-- ESTE ES EL IMPORTANTE para lo de "los saldos están iguales".
--
-- `saldo_guardado` es loans.saldo, que se descuenta por CAPITAL.
-- `saldo_real` es valor_a_pagar menos lo efectivamente pagado.
-- Cuando los dos no coinciden, la pantalla puede mostrar un saldo que no
-- refleja lo que el cliente abonó.
SELECT c.apodo,
       l.tipo_amortizacion,
       l.valor,
       l.valor_a_pagar,
       l.saldo                                    AS saldo_guardado,
       v.total_recaudado,
       v.saldo_pendiente                          AS saldo_real,
       round(l.saldo - COALESCE(v.saldo_pendiente, 0), 2) AS diferencia,
       l.estado,
       count(pp.id) FILTER (WHERE pp.estado = 'pagado')    AS pagadas,
       count(pp.id) FILTER (WHERE pp.estado = 'cancelada') AS canceladas,
       count(pp.id) FILTER (WHERE pp.estado = 'pendiente') AS pendientes
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN saldo_prestamos_clientes v ON v.loan_id = l.id
  LEFT JOIN payment_plan pp ON pp.loan_id = l.id
 GROUP BY c.apodo, l.id, l.tipo_amortizacion, l.valor, l.valor_a_pagar,
          l.saldo, v.total_recaudado, v.saldo_pendiente, l.estado
HAVING abs(l.saldo - COALESCE(v.saldo_pendiente, 0)) > 0.01
 ORDER BY abs(l.saldo - COALESCE(v.saldo_pendiente, 0)) DESC;


-- ── BLOQUE D ── Cliente por cliente: qué se le cobró y cómo quedó ─────────
-- Para los que gestionaste el 12 y el 13. Compara lo abonado esos días
-- contra el saldo que quedó, que es justo lo que revisas en pantalla.
SELECT c.apodo,
       l.valor_a_pagar,
       v.total_recaudado,
       v.saldo_pendiente,
       COALESCE(sum(pp.monto_pagado) FILTER (
         WHERE (pp.fecha_pago_real AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-12'
       ), 0) AS abonado_el_12,
       COALESCE(sum(pp.monto_pagado) FILTER (
         WHERE (pp.fecha_pago_real AT TIME ZONE 'America/Bogota')::date = DATE '2026-08-13'
       ), 0) AS abonado_el_13,
       count(pp.id) FILTER (WHERE pp.estado IN ('pagado','cancelada')) AS cuotas_saldadas,
       count(pp.id) FILTER (WHERE NOT COALESCE(pp.es_extra, false))     AS cuotas_base,
       l.estado
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN saldo_prestamos_clientes v ON v.loan_id = l.id
  LEFT JOIN payment_plan pp ON pp.loan_id = l.id
 WHERE EXISTS (
   SELECT 1 FROM payment_plan x
    WHERE x.loan_id = l.id
      AND (x.fecha_pago_real AT TIME ZONE 'America/Bogota')::date
          IN (DATE '2026-08-12', DATE '2026-08-13')
 )
 GROUP BY c.apodo, l.id, l.valor_a_pagar, v.total_recaudado, v.saldo_pendiente, l.estado
 ORDER BY c.apodo;
