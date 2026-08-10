-- ============================================================================
-- DIAGNOSTICO - Ventas duplicadas entre el 7 y el 9 de agosto de 2026
-- ============================================================================
-- NO BORRA NADA. Solo lista para revisar.
--
-- Entre el commit 34081ea (7 ago) y su correccion, cada venta registrada CON
-- conexion creaba DOS prestamos identicos: uno por la cola offline (que en
-- realidad envia) y otro por una llamada directa que quedo por error.
--
-- Los duplicados se reconocen porque son del MISMO cliente, con el MISMO
-- valor, creados con segundos de diferencia.
-- ============================================================================

-- 1) Grupos de prestamos duplicados (mismo cliente, mismo valor, mismo minuto)
SELECT
  l.client_id,
  c.nombre_completo,
  c.documento,
  l.valor,
  l.ruta,
  count(*)                          AS veces,
  min(l.fecha_creacion)             AS primera,
  max(l.fecha_creacion)             AS ultima,
  array_agg(l.id ORDER BY l.fecha_creacion) AS loan_ids,
  array_agg(l.estado ORDER BY l.fecha_creacion) AS estados
FROM loans l
JOIN clients c ON c.id = l.client_id
WHERE l.fecha_creacion >= '2026-08-07'
GROUP BY l.client_id, c.nombre_completo, c.documento, l.valor, l.ruta,
         date_trunc('minute', l.fecha_creacion)
HAVING count(*) > 1
ORDER BY max(l.fecha_creacion) DESC;

-- 2) Detalle de cada prestamo de esos grupos, para decidir cual conservar.
--    Conviene conservar el que YA TENGA pagos registrados (si alguno los
--    tiene) y eliminar el que este intacto.
WITH duplicados AS (
  SELECT l.id
  FROM loans l
  WHERE l.fecha_creacion >= '2026-08-07'
    AND EXISTS (
      SELECT 1 FROM loans l2
      WHERE l2.client_id = l.client_id
        AND l2.valor     = l.valor
        AND l2.id       <> l.id
        AND l2.fecha_creacion >= '2026-08-07'
        AND abs(extract(epoch FROM (l2.fecha_creacion - l.fecha_creacion))) < 120
    )
)
SELECT
  l.id AS loan_id,
  c.nombre_completo,
  l.valor,
  l.saldo,
  l.estado,
  l.fecha_creacion,
  count(pp.id)                                        AS cuotas_totales,
  count(pp.id) FILTER (WHERE pp.estado <> 'pendiente') AS cuotas_gestionadas,
  COALESCE(sum(pp.monto_pagado), 0)                   AS total_recaudado
FROM loans l
JOIN duplicados d ON d.id = l.id
JOIN clients c    ON c.id = l.client_id
LEFT JOIN payment_plan pp ON pp.loan_id = l.id
GROUP BY l.id, c.nombre_completo, l.valor, l.saldo, l.estado, l.fecha_creacion
ORDER BY c.nombre_completo, l.fecha_creacion;

-- ============================================================================
-- PARA ELIMINAR (revisar primero los resultados de arriba)
-- ============================================================================
-- Ejecutar UNO POR UNO, reemplazando el id, y solo sobre prestamos SIN pagos
-- registrados (cuotas_gestionadas = 0 y total_recaudado = 0 en la consulta 2).
-- El borrado del prestamo arrastra su plan de pagos por ON DELETE CASCADE.
--
--   DELETE FROM loans WHERE id = '<loan_id>';
--
-- Si el cliente quedo marcado con prestamo activo y ya no deberia estarlo:
--   UPDATE clients SET tiene_prestamo_activo = false WHERE id = '<client_id>';
-- ============================================================================
