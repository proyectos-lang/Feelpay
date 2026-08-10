-- ============================================================================
-- Limpiar la venta duplicada del 7 de agosto de 2026
-- ============================================================================
-- Entre el commit 34081ea y su corrección (fa85584), cada venta registrada
-- CON conexión creaba DOS préstamos idénticos: uno lo enviaba la cola offline
-- y otro una llamada directa que quedó por error. Se reconocen porque son del
-- mismo cliente, mismo valor, creados con segundos de diferencia.
--
-- El diagnóstico encontró UN caso: documento 401537527, dos préstamos con
-- 505 milésimas de diferencia.
--
-- CORRE LOS PASOS EN ORDEN. El paso 3 es el único que borra, y hay que
-- editarlo a mano con el id que salga del paso 2. Cada paso es una sola
-- sentencia: selecciónalo con el mouse y dale Run.
-- ============================================================================


-- ── PASO 1) Ver los dos préstamos y decidir cuál se conserva ──────────────
-- Se conserva el que TENGA pagos. Si ninguno tiene, se conserva el primero
-- (el más antiguo) y se borra el segundo.
--
-- Cambia el documento si quieres revisar otro caso.
SELECT l.id AS loan_id,
       c.documento,
       c.nombre_completo,
       l.valor,
       l.saldo,
       l.estado,
       l.created_at,
       count(pp.id)                                         AS cuotas_totales,
       count(pp.id) FILTER (WHERE pp.estado <> 'pendiente') AS cuotas_gestionadas,
       COALESCE(sum(pp.monto_pagado), 0)                    AS total_recaudado,
       CASE WHEN COALESCE(sum(pp.monto_pagado), 0) > 0
             OR count(pp.id) FILTER (WHERE pp.estado <> 'pendiente') > 0
            THEN 'CONSERVAR (tiene gestión)'
            ELSE 'candidato a borrar (intacto)'
       END AS recomendacion
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN payment_plan pp ON pp.loan_id = l.id
 WHERE c.documento = '401537527'
 GROUP BY l.id, c.documento, c.nombre_completo, l.valor, l.saldo, l.estado, l.created_at
 ORDER BY l.created_at;


-- ── PASO 2) Confirmar que el que vas a borrar está realmente intacto ──────
-- Reemplaza el id por el que el paso 1 marcó como "candidato a borrar".
-- Tiene que devolver total_recaudado = 0 y gestionadas = 0. Si devuelve algo
-- distinto, NO lo borres: ese préstamo ya tiene plata asociada.
SELECT pp.id, pp.numero_cuota, pp.fecha_pago, pp.estado,
       pp.monto_pagado, pp.fecha_pago_real
  FROM payment_plan pp
 WHERE pp.loan_id = '<PEGA_AQUI_EL_LOAN_ID>'
 ORDER BY pp.numero_cuota;


-- ── PASO 3) Borrar ────────────────────────────────────────────────────────
-- Está comentado a propósito. Descoméntalo y pon el id solo después de que
-- el paso 2 haya confirmado que el préstamo está intacto.
--
-- El WHERE lleva las tres guardas: que no tenga ninguna cuota gestionada,
-- que no tenga plata recaudada, y el id exacto. Si algo de eso no se cumple,
-- no borra nada en vez de borrar de más.
--
-- DELETE FROM loans l
--  WHERE l.id = '<PEGA_AQUI_EL_LOAN_ID>'
--    AND NOT EXISTS (
--      SELECT 1 FROM payment_plan pp
--       WHERE pp.loan_id = l.id
--         AND (pp.estado <> 'pendiente' OR COALESCE(pp.monto_pagado, 0) > 0)
--    );
--
-- Si `payment_plan` no tiene ON DELETE CASCADE hacia `loans`, borra primero
-- el plan (con la misma guarda) y después el préstamo:
--
-- DELETE FROM payment_plan
--  WHERE loan_id = '<PEGA_AQUI_EL_LOAN_ID>'
--    AND estado = 'pendiente' AND COALESCE(monto_pagado, 0) = 0;


-- ── PASO 4) Verificar cómo quedó el cliente ───────────────────────────────
-- Después de borrar, el cliente debe quedar con UN solo préstamo activo.
-- Si quedó en cero préstamos activos pero `tiene_prestamo_activo` sigue en
-- true, la última columna te lo dice.
SELECT c.documento, c.nombre_completo, c.tiene_prestamo_activo,
       count(l.id) FILTER (WHERE l.estado = 'activo') AS prestamos_activos,
       count(l.id)                                    AS prestamos_totales,
       CASE WHEN c.tiene_prestamo_activo
             AND count(l.id) FILTER (WHERE l.estado = 'activo') = 0
            THEN 'CORREGIR: marcar tiene_prestamo_activo = false'
            ELSE 'ok'
       END AS revisar
  FROM clients c
  LEFT JOIN loans l ON l.client_id = c.id
 WHERE c.documento = '401537527'
 GROUP BY c.id, c.documento, c.nombre_completo, c.tiene_prestamo_activo;

-- Si el paso 4 pide corregir:
-- UPDATE clients SET tiene_prestamo_activo = false, updated_at = NOW()
--  WHERE documento = '401537527';
