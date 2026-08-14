-- ============================================================================
-- Aplicar abonos del 13/08/2026 que no quedaron registrados
-- ============================================================================
-- ESTE SCRIPT ESCRIBE PLATA. Toma un backup antes.
--   Supabase → Database → Backups → Create backup
--
-- LOS UUID SON `clients.id`, no `loans.id`. El préstamo se resuelve buscando
-- el crédito ACTIVO de cada cliente.
--
-- QUE HACE
-- Por cada cliente crea una CUOTA EXTRA con fecha 13/08/2026, en estado
-- `pagado` y con el monto abonado. Es lo mismo que hace la app desde el
-- script 040: no consume las cuotas programadas, baja el saldo y la plata
-- queda contabilizada en el día en que el cliente la entregó.
--
-- Dos de los quince vienen en CERO (a60b0bfd… y dc6857ba…). No se incluyen:
-- un abono de cero no es un pago y dejaría una línea vacía que después nadie
-- sabría interpretar. Si ahí lo que hubo fue un NO PAGO, es otro tratamiento.
--
-- SE PUEDE CORRER DOS VECES SIN DUPLICAR: cada inserción verifica que no
-- exista ya una cuota extra de ese préstamo con esa fecha y ese monto.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Revisar antes de escribir ─────────────────────────────────────
-- CORRE ESTE PRIMERO.
--
-- `revisar` debe decir "ok" en los trece. Cualquier otra cosa hay que
-- resolverla antes: si un cliente tiene DOS créditos activos hay que decidir
-- a cuál va el abono, y eso no lo puedo adivinar.
WITH abonos(client_id, monto) AS (VALUES
  ('388879fd-6da7-42db-b38b-9a338289c7f5'::uuid, 135000::numeric),
  ('8e5a4296-647c-4cd2-9d69-55279bc96444', 156000),
  ('8cbfd5b3-a408-4c87-a39c-3162430036dd', 215000),
  ('f6d63fca-5caf-41ac-b0f2-1fd1f8b66f18', 191250),
  ('204b3d19-3e2a-4563-a549-94d1f9dfcfe0',  60000),
  ('3d5b28e2-64c9-430f-b04e-fb1519b1e325', 550000),
  ('476654e5-1dd4-4393-9b4a-2f21f76a41e8', 374400),
  ('5ad8a1a3-f391-4aea-8abf-b6db43e2b7d1',  12800),
  ('0944ff3e-70cb-45d4-9388-9ddc8849ae54', 210000),
  ('214840c6-a045-4381-8001-488fc1e5ca2c',  52500),
  ('7dd973cc-f974-41dd-9b83-93740b58b6a2',  28800),
  ('b7b95bd8-99e4-468e-8714-97e5c6b13471', 180000),
  ('7ce3aa97-d409-4e0f-879f-29c03a037bb0',  38300)
)
SELECT c.apodo,
       a.monto                                   AS abono_a_aplicar,
       count(l.id)                               AS creditos_activos,
       max(l.id::text)::uuid                     AS loan_id,
       max(l.ruta)                               AS ruta,
       max(l.valor_a_pagar)                      AS total_a_pagar,
       max(l.saldo)                              AS saldo_actual,
       -- max() no existe para uuid: se agrega como texto y se devuelve al
       -- tipo. Con un solo credito activo por cliente da lo mismo cual, y si
       -- hay mas de uno la fila queda marcada para revisar de todos modos.
       (SELECT count(*) FROM payment_plan pp
         WHERE pp.loan_id = max(l.id::text)::uuid
           AND pp.fecha_pago = DATE '2026-08-13'
           AND COALESCE(pp.monto_pagado, 0) > 0) AS abonos_ya_cargados_el_13,
       CASE WHEN c.id IS NULL          THEN '*** el cliente no existe ***'
            WHEN count(l.id) = 0       THEN '*** sin credito activo ***'
            WHEN count(l.id) > 1       THEN '*** tiene ' || count(l.id) || ' creditos activos: decidir ***'
            WHEN a.monto > max(l.saldo) THEN '*** el abono supera el saldo ***'
            ELSE 'ok' END                        AS revisar
  FROM abonos a
  LEFT JOIN clients c ON c.id = a.client_id
  LEFT JOIN loans   l ON l.client_id = a.client_id AND l.estado = 'activo'
 GROUP BY c.id, c.apodo, a.client_id, a.monto
 ORDER BY 9 DESC, c.apodo;


-- ── PASO 2) Aplicar los abonos ────────────────────────────────────────────
-- Solo después de que el paso 1 diga "ok" en todos.
--
-- Se aplica ÚNICAMENTE a clientes con exactamente UN crédito activo. Si
-- alguno tiene dos, se salta a propósito en vez de elegir por su cuenta.
--
-- La hora es 6 de la tarde del 13 en Colombia: `fecha_pago_real` es lo que
-- usa el historial para agrupar por día.
WITH abonos(client_id, monto) AS (VALUES
  ('388879fd-6da7-42db-b38b-9a338289c7f5'::uuid, 135000::numeric),
  ('8e5a4296-647c-4cd2-9d69-55279bc96444', 156000),
  ('8cbfd5b3-a408-4c87-a39c-3162430036dd', 215000),
  ('f6d63fca-5caf-41ac-b0f2-1fd1f8b66f18', 191250),
  ('204b3d19-3e2a-4563-a549-94d1f9dfcfe0',  60000),
  ('3d5b28e2-64c9-430f-b04e-fb1519b1e325', 550000),
  ('476654e5-1dd4-4393-9b4a-2f21f76a41e8', 374400),
  ('5ad8a1a3-f391-4aea-8abf-b6db43e2b7d1',  12800),
  ('0944ff3e-70cb-45d4-9388-9ddc8849ae54', 210000),
  ('214840c6-a045-4381-8001-488fc1e5ca2c',  52500),
  ('7dd973cc-f974-41dd-9b83-93740b58b6a2',  28800),
  ('b7b95bd8-99e4-468e-8714-97e5c6b13471', 180000),
  ('7ce3aa97-d409-4e0f-879f-29c03a037bb0',  38300)
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
-- Misma fórmula del script 037: total con intereses menos todo lo pagado.
UPDATE loans l
   SET saldo = GREATEST(0, COALESCE(l.valor_a_pagar, 0) - COALESCE(p.pagado, 0)),
       updated_at = NOW()
  FROM (
    SELECT loan_id, COALESCE(sum(monto_pagado), 0) AS pagado
      FROM payment_plan GROUP BY loan_id
  ) p
 WHERE p.loan_id = l.id
   AND l.client_id IN (
     '388879fd-6da7-42db-b38b-9a338289c7f5','8e5a4296-647c-4cd2-9d69-55279bc96444',
     '8cbfd5b3-a408-4c87-a39c-3162430036dd','f6d63fca-5caf-41ac-b0f2-1fd1f8b66f18',
     '204b3d19-3e2a-4563-a549-94d1f9dfcfe0','3d5b28e2-64c9-430f-b04e-fb1519b1e325',
     '476654e5-1dd4-4393-9b4a-2f21f76a41e8','5ad8a1a3-f391-4aea-8abf-b6db43e2b7d1',
     '0944ff3e-70cb-45d4-9388-9ddc8849ae54','214840c6-a045-4381-8001-488fc1e5ca2c',
     '7dd973cc-f974-41dd-9b83-93740b58b6a2','b7b95bd8-99e4-468e-8714-97e5c6b13471',
     '7ce3aa97-d409-4e0f-879f-29c03a037bb0'
   );


-- ── PASO 4) Verificar cómo quedaron ───────────────────────────────────────
-- `abono_del_13` debe coincidir con el monto que pasaste, y `saldo_guardado`
-- con `saldo_en_pantalla`. Si alguna fila no aparece, ese cliente no tenía
-- un único crédito activo y hay que resolverlo aparte.
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
   '388879fd-6da7-42db-b38b-9a338289c7f5','8e5a4296-647c-4cd2-9d69-55279bc96444',
   '8cbfd5b3-a408-4c87-a39c-3162430036dd','f6d63fca-5caf-41ac-b0f2-1fd1f8b66f18',
   '204b3d19-3e2a-4563-a549-94d1f9dfcfe0','3d5b28e2-64c9-430f-b04e-fb1519b1e325',
   '476654e5-1dd4-4393-9b4a-2f21f76a41e8','5ad8a1a3-f391-4aea-8abf-b6db43e2b7d1',
   '0944ff3e-70cb-45d4-9388-9ddc8849ae54','214840c6-a045-4381-8001-488fc1e5ca2c',
   '7dd973cc-f974-41dd-9b83-93740b58b6a2','b7b95bd8-99e4-468e-8714-97e5c6b13471',
   '7ce3aa97-d409-4e0f-879f-29c03a037bb0'
 )
 ORDER BY c.apodo;
