-- ============================================================================
-- Aplicar abonos del 13/08/2026 — SEGUNDO LOTE (6 clientes)
-- ============================================================================
-- ESTE SCRIPT ESCRIBE PLATA. Toma un backup antes.
--   Supabase → Database → Backups → Create backup
--
-- Mismo tratamiento que scripts/aplicar-abonos-13-agosto.sql: los UUID son
-- `clients.id` y el préstamo se resuelve buscando el crédito ACTIVO de cada
-- cliente. Se crea una CUOTA EXTRA del 13/08 en estado `pagado`, que no
-- consume las cuotas programadas, baja el saldo y deja la plata contabilizada
-- en el día en que el cliente la entregó.
--
-- SE PUEDE CORRER DOS VECES SIN DUPLICAR: cada inserción verifica que no
-- exista ya una cuota extra de ese préstamo con esa fecha y ese monto.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Revisar antes de escribir ─────────────────────────────────────
-- CORRE ESTE PRIMERO. `revisar` debe decir "ok" en los seis.
WITH abonos(client_id, monto) AS (VALUES
  ('0f13966c-36bf-438a-bc09-385591ee1972'::uuid, 150.00::numeric),
  ('ae65d42d-624a-483a-ab8b-0f070b239fa3', 235.00),
  ('62ddf631-e098-4501-ada9-38ad8122e535', 142.00),
  ('ff52281d-9fb9-4324-8828-0d07a3446fdb',  66.00),
  ('62099b82-2825-4962-baa5-d46bbb565e4d',  68.00),
  ('7c2ddfe3-3b3f-49f3-b32b-47bb6686304f',  73.00)
)
SELECT c.apodo,
       a.monto                                   AS abono_a_aplicar,
       count(l.id)                               AS creditos_activos,
       max(l.id::text)::uuid                     AS loan_id,
       max(l.ruta)                               AS ruta,
       max(l.valor_a_pagar)                      AS total_a_pagar,
       max(l.saldo)                              AS saldo_actual,
       (SELECT count(*) FROM payment_plan pp
         WHERE pp.loan_id = max(l.id::text)::uuid
           AND pp.fecha_pago = DATE '2026-08-13'
           AND COALESCE(pp.monto_pagado, 0) > 0) AS abonos_ya_cargados_el_13,
       CASE WHEN c.id IS NULL           THEN '*** el cliente no existe ***'
            WHEN count(l.id) = 0        THEN '*** sin credito activo ***'
            WHEN count(l.id) > 1        THEN '*** tiene ' || count(l.id) || ' creditos activos: decidir ***'
            WHEN a.monto > max(l.saldo) THEN '*** el abono supera el saldo ***'
            ELSE 'ok' END                        AS revisar
  FROM abonos a
  LEFT JOIN clients c ON c.id = a.client_id
  LEFT JOIN loans   l ON l.client_id = a.client_id AND l.estado = 'activo'
 GROUP BY c.id, c.apodo, a.client_id, a.monto
 ORDER BY 9 DESC, c.apodo;


-- ── PASO 2) Aplicar los abonos ────────────────────────────────────────────
-- Solo después de que el paso 1 diga "ok" en todos.
-- Se aplica ÚNICAMENTE a clientes con exactamente UN crédito activo.
WITH abonos(client_id, monto) AS (VALUES
  ('0f13966c-36bf-438a-bc09-385591ee1972'::uuid, 150.00::numeric),
  ('ae65d42d-624a-483a-ab8b-0f070b239fa3', 235.00),
  ('62ddf631-e098-4501-ada9-38ad8122e535', 142.00),
  ('ff52281d-9fb9-4324-8828-0d07a3446fdb',  66.00),
  ('62099b82-2825-4962-baa5-d46bbb565e4d',  68.00),
  ('7c2ddfe3-3b3f-49f3-b32b-47bb6686304f',  73.00)
),
destino AS (
  SELECT a.monto,
         l.id AS loan_id,
         l.ruta,
         l.valor_a_pagar,
         count(*) OVER (PARTITION BY a.client_id) AS activos_del_cliente
    FROM abonos a
    JOIN loans l ON l.client_id = a.client_id AND l.estado = 'activo'
)
INSERT INTO payment_plan (
  loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo,
  estado, monto_pagado, fecha_pago_real, ruta, es_extra
)
SELECT d.loan_id,
       COALESCE((SELECT max(pp.numero_cuota) FROM payment_plan pp WHERE pp.loan_id = d.loan_id), 0) + 1,
       DATE '2026-08-13',
       d.monto,
       d.monto,
       0,
       GREATEST(0, COALESCE(d.valor_a_pagar, 0)
                   - COALESCE((SELECT sum(pp.monto_pagado) FROM payment_plan pp WHERE pp.loan_id = d.loan_id), 0)
                   - d.monto),
       'pagado',
       d.monto,
       TIMESTAMPTZ '2026-08-13 18:00:00-05:00',
       d.ruta,
       true
  FROM destino d
 WHERE d.activos_del_cliente = 1
   AND NOT EXISTS (
     SELECT 1 FROM payment_plan pp
      WHERE pp.loan_id = d.loan_id
        AND pp.fecha_pago = DATE '2026-08-13'
        AND pp.es_extra
        AND pp.monto_pagado = d.monto
   );


-- ── PASO 3) Recalcular el saldo ───────────────────────────────────────────
UPDATE loans l
   SET saldo = GREATEST(0, COALESCE(l.valor_a_pagar, 0) - COALESCE(p.pagado, 0)),
       updated_at = NOW()
  FROM (
    SELECT loan_id, COALESCE(sum(monto_pagado), 0) AS pagado
      FROM payment_plan GROUP BY loan_id
  ) p
 WHERE p.loan_id = l.id
   AND l.client_id IN (
     '0f13966c-36bf-438a-bc09-385591ee1972','ae65d42d-624a-483a-ab8b-0f070b239fa3',
     '62ddf631-e098-4501-ada9-38ad8122e535','ff52281d-9fb9-4324-8828-0d07a3446fdb',
     '62099b82-2825-4962-baa5-d46bbb565e4d','7c2ddfe3-3b3f-49f3-b32b-47bb6686304f'
   );


-- ── PASO 4) Verificar cómo quedaron ───────────────────────────────────────
-- Deben salir las seis filas, con `abono_del_13` igual al monto que pasaste.
-- Si falta alguna, ese cliente no tenía un único crédito activo.
SELECT c.apodo,
       l.id AS loan_id,
       l.valor_a_pagar,
       (SELECT COALESCE(sum(pp.monto_pagado), 0) FROM payment_plan pp
         WHERE pp.loan_id = l.id AND pp.fecha_pago = DATE '2026-08-13') AS abono_del_13,
       (SELECT COALESCE(sum(pp.monto_pagado), 0) FROM payment_plan pp
         WHERE pp.loan_id = l.id)                                       AS recaudado_total,
       l.saldo            AS saldo_guardado,
       v.saldo_pendiente  AS saldo_en_pantalla,
       l.estado
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN saldo_prestamos_clientes v ON v.loan_id = l.id
 WHERE l.client_id IN (
   '0f13966c-36bf-438a-bc09-385591ee1972','ae65d42d-624a-483a-ab8b-0f070b239fa3',
   '62ddf631-e098-4501-ada9-38ad8122e535','ff52281d-9fb9-4324-8828-0d07a3446fdb',
   '62099b82-2825-4962-baa5-d46bbb565e4d','7c2ddfe3-3b3f-49f3-b32b-47bb6686304f'
 )
 ORDER BY c.apodo;
