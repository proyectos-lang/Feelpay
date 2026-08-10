-- ============================================================================
-- RESET de la base para empezar pruebas — primera cuota el 10/08/2026
-- ============================================================================
-- ESTE SCRIPT BORRA DATOS DE PRODUCCIÓN Y NO SE PUEDE DESHACER.
--
-- ANTES DE CORRERLO: toma un backup en Supabase
--   Database → Backups → Create backup
-- Si algo sale distinto a lo esperado, ese backup es la única vuelta atrás.
--
-- QUÉ HACE
--   · Borra gastos/ingresos/retiros, multas, solicitudes de revisión,
--     rutas diarias y llaves de idempotencia.
--   · Borra todo el plan de pagos.
--   · Borra los préstamos cancelados y los duplicados del 7 de agosto.
--   · Regenera el plan de pagos de los préstamos activos que quedan, con el
--     mismo valor, plazo, tasa, frecuencia y tipo de amortización, pero con
--     primera cuota el 10/08/2026.
--   · Reinicia saldo y estado de esos préstamos.
--
-- QUÉ NO TOCA
--   · Clientes (incluidas sus coordenadas de geocerca).
--   · Usuarios, rutas, permisos, chat, documentos, reportes.
--
-- CÓMO CORRERLO
-- Un paso a la vez, en orden, seleccionando el bloque con el mouse y dándole
-- Run. Los pasos 0 y 1 solo leen; del 2 en adelante escriben.
-- ============================================================================


-- ── PASO 0) Foto de lo que hay ahora (solo lectura) ───────────────────────
-- Guarda este resultado: es tu punto de comparación al final.
SELECT 'loans activos'          AS que, count(*)::text AS cuantos FROM loans WHERE estado = 'activo'
UNION ALL SELECT 'loans cancelados',      count(*)::text FROM loans WHERE estado <> 'activo'
UNION ALL SELECT 'payment_plan',          count(*)::text FROM payment_plan
UNION ALL SELECT 'gastosregistros',       count(*)::text FROM gastosregistros
UNION ALL SELECT 'multas',                count(*)::text FROM multas
UNION ALL SELECT 'solicitudes_revision',  count(*)::text FROM solicitudes_revision
UNION ALL SELECT 'rutas_diarias',         count(*)::text FROM rutas_diarias
UNION ALL SELECT 'operaciones_procesadas',count(*)::text FROM operaciones_procesadas
UNION ALL SELECT 'clientes',              count(*)::text FROM clients;


-- ── PASO 1) Revisar qué préstamos se van a borrar (solo lectura) ──────────
-- Duplicados: mismo cliente, mismo valor, creados con menos de 2 minutos de
-- diferencia. Se conserva el MÁS ANTIGUO de cada grupo.
-- Revisa esta lista antes de seguir. Si algo no debería borrarse, avísame.
WITH dup AS (
  SELECT l.id, l.client_id, l.valor, l.created_at,
         row_number() OVER (
           PARTITION BY l.client_id, l.valor, date_trunc('minute', l.created_at)
           ORDER BY l.created_at
         ) AS n
    FROM loans l
)
SELECT 'DUPLICADO — se borra' AS motivo, d.id AS loan_id, c.documento,
       c.nombre_completo, d.valor, d.created_at
  FROM dup d JOIN clients c ON c.id = d.client_id
 WHERE d.n > 1
UNION ALL
SELECT 'CANCELADO — se borra', l.id, c.documento, c.nombre_completo, l.valor, l.created_at
  FROM loans l JOIN clients c ON c.id = l.client_id
 WHERE l.estado <> 'activo'
 ORDER BY 1, 6;


-- ── PASO 2) Vaciar las tablas transaccionales ─────────────────────────────
-- Una sentencia por tabla. Córrelas juntas: no dependen entre sí.
DELETE FROM gastosregistros;
DELETE FROM multas;
DELETE FROM solicitudes_revision;
DELETE FROM rutas_diarias;
DELETE FROM operaciones_procesadas;


-- ── PASO 3) Borrar todo el plan de pagos ──────────────────────────────────
-- Va antes de borrar préstamos por si no hay ON DELETE CASCADE.
DELETE FROM payment_plan;


-- ── PASO 4) Borrar duplicados y cancelados ────────────────────────────────
-- Misma regla que mostró el paso 1.
WITH dup AS (
  SELECT l.id,
         row_number() OVER (
           PARTITION BY l.client_id, l.valor, date_trunc('minute', l.created_at)
           ORDER BY l.created_at
         ) AS n
    FROM loans l
)
DELETE FROM loans
 WHERE id IN (SELECT id FROM dup WHERE n > 1)
    OR estado <> 'activo';


-- ── PASO 5) Regenerar el plan de pagos desde el 10/08/2026 ────────────────
-- Replica exactamente el cálculo de components/views/new-loan.tsx:
--
--   · Días entre pagos: semanal 7, quincenal 15, mensual 30, resto 1.
--   · Diario: no se cobra los domingos. La semana de cobro es lunes a
--     sábado (6 días) y la cuota i cae en el i-ésimo día de cobro, saltando
--     los domingos de corrido.
--
--     El 10/08/2026 es lunes, así que la cuota i cae en
--        10 de agosto + (i-1) + floor((i-1) / 6)
--     Nunca hay dos cuotas el mismo día ni ninguna en domingo.
--   · Empleado: sin interés, valor / número de cuotas.
--   · Americano: cada cuota paga valor × tasa; la última suma el capital.
--   · Alemán (y cualquier otro): cuota fija = (valor + valor × tasa) / cuotas.
WITH base AS (
  SELECT l.id, l.valor, l.numero_cuotas, l.ruta,
         (l.tasa_interes / 100.0) AS tasa,
         CASE WHEN COALESCE(l.prestamo_empleado, false) THEN 1
              WHEN l.frecuencia_pago = 'weekly'   THEN 7
              WHEN l.frecuencia_pago = 'biweekly' THEN 15
              WHEN l.frecuencia_pago = 'monthly'  THEN 30
              ELSE 1 END AS dias,
         CASE WHEN COALESCE(l.prestamo_empleado, false) THEN 'empleado'
              WHEN l.tipo_amortizacion = 'americano'    THEN 'americano'
              ELSE 'aleman' END AS modo
    FROM loans l
   WHERE l.estado = 'activo' AND l.numero_cuotas > 0
),
calc AS (
  SELECT b.*,
         round(b.valor / b.numero_cuotas, 2)                              AS cuota_empleado,
         round(b.valor * b.tasa, 2)                                       AS interes_americano,
         (b.valor + b.valor * b.tasa)                                     AS saldo_total,
         round((b.valor + b.valor * b.tasa) / b.numero_cuotas, 2)         AS cuota_aleman,
         round((b.valor * b.tasa) / b.numero_cuotas, 2)                   AS interes_aleman,
         round(b.valor / b.numero_cuotas, 2)                              AS capital_aleman
    FROM base b
),
cuotas AS (
  SELECT c.*, i AS numero_cuota,
         CASE WHEN c.dias = 1
              -- Diario: se saltan los domingos de corrido. Como el 10/08 es
              -- lunes, cada 6 cuotas se agrega un día para pasar el domingo.
              THEN DATE '2026-08-10' + (i - 1) + ((i - 1) / 6)
              ELSE DATE '2026-08-10' + (c.dias * (i - 1))
         END AS fecha_pago
    FROM calc c
    CROSS JOIN LATERAL generate_series(1, c.numero_cuotas) AS i
)
INSERT INTO payment_plan
  (loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo, estado, ruta, es_extra)
SELECT
  q.id,
  q.numero_cuota,
  q.fecha_pago,
  CASE q.modo
    WHEN 'empleado'  THEN q.cuota_empleado
    WHEN 'americano' THEN round(q.interes_americano
                                + CASE WHEN q.numero_cuota = q.numero_cuotas THEN q.valor ELSE 0 END, 2)
    ELSE q.cuota_aleman
  END,
  CASE q.modo
    WHEN 'empleado'  THEN q.cuota_empleado
    WHEN 'americano' THEN CASE WHEN q.numero_cuota = q.numero_cuotas THEN round(q.valor, 2) ELSE 0 END
    ELSE q.capital_aleman
  END,
  CASE q.modo
    WHEN 'empleado'  THEN 0
    WHEN 'americano' THEN q.interes_americano
    ELSE q.interes_aleman
  END,
  CASE q.modo
    WHEN 'empleado'  THEN round(GREATEST(0, q.valor - q.cuota_empleado * q.numero_cuota), 2)
    WHEN 'americano' THEN CASE WHEN q.numero_cuota = q.numero_cuotas THEN 0
                               ELSE round(q.valor + q.interes_americano * (q.numero_cuotas - q.numero_cuota), 2) END
    ELSE round(GREATEST(0, q.saldo_total - q.cuota_aleman * q.numero_cuota), 2)
  END,
  'pendiente',
  q.ruta,
  false
FROM cuotas q;


-- ── PASO 6) Reiniciar los préstamos ───────────────────────────────────────
-- El saldo vuelve al total con intereses y la fecha del primer pago al 10/08.
UPDATE loans
   SET saldo             = valor_a_pagar,
       estado            = 'activo',
       fecha_primer_pago = DATE '2026-08-10',
       updated_at        = NOW()
 WHERE estado = 'activo';


-- ── PASO 7) Cuadrar la marca de préstamo activo en los clientes ───────────
-- Los clientes cuyo único préstamo se borró quedaban marcados como activos.
UPDATE clients c
   SET tiene_prestamo_activo = EXISTS (
         SELECT 1 FROM loans l WHERE l.client_id = c.id AND l.estado = 'activo'
       ),
       updated_at = NOW()
 WHERE c.tiene_prestamo_activo IS DISTINCT FROM EXISTS (
         SELECT 1 FROM loans l WHERE l.client_id = c.id AND l.estado = 'activo'
       );


-- ── PASO 8) Verificar cómo quedó ──────────────────────────────────────────
-- Todo debe dar en cero salvo loans, payment_plan y clientes.
-- `cuotas_10_ago` debe ser igual a la cantidad de préstamos activos.
SELECT 'loans activos'           AS que, count(*)::text AS cuantos FROM loans WHERE estado = 'activo'
UNION ALL SELECT 'loans no activos (debe ser 0)', count(*)::text FROM loans WHERE estado <> 'activo'
UNION ALL SELECT 'payment_plan',           count(*)::text FROM payment_plan
UNION ALL SELECT 'cuotas del 10 ago',      count(*)::text FROM payment_plan WHERE fecha_pago = DATE '2026-08-10'
UNION ALL SELECT 'cuotas antes del 10 ago (debe ser 0)', count(*)::text FROM payment_plan WHERE fecha_pago < DATE '2026-08-10'
UNION ALL SELECT 'cuotas gestionadas (debe ser 0)', count(*)::text FROM payment_plan WHERE estado <> 'pendiente'
UNION ALL SELECT 'cuotas con ruta nula (debe ser 0)', count(*)::text FROM payment_plan WHERE ruta IS NULL
UNION ALL SELECT 'cuotas en domingo (debe ser 0)', count(*)::text
     FROM payment_plan pp JOIN loans l ON l.id = pp.loan_id
    WHERE EXTRACT(DOW FROM pp.fecha_pago) = 0
      AND (COALESCE(l.prestamo_empleado, false)
           OR l.frecuencia_pago NOT IN ('weekly','biweekly','monthly'))
UNION ALL SELECT 'prestamos con 2 cuotas el mismo dia (debe ser 0)', count(*)::text
     FROM (SELECT loan_id, fecha_pago FROM payment_plan
            GROUP BY loan_id, fecha_pago HAVING count(*) > 1) AS x
UNION ALL SELECT 'gastosregistros (debe ser 0)', count(*)::text FROM gastosregistros
UNION ALL SELECT 'multas (debe ser 0)',      count(*)::text FROM multas
UNION ALL SELECT 'solicitudes (debe ser 0)', count(*)::text FROM solicitudes_revision
UNION ALL SELECT 'clientes',                 count(*)::text FROM clients;


-- ── PASO 9) Revisar que el plan cuadre con el préstamo ────────────────────
-- La suma de las cuotas debe coincidir con `valor_a_pagar`. Diferencias de
-- centavos son normales (el redondeo por cuota no reparte el residuo); una
-- diferencia grande significa que el préstamo tiene datos raros.
SELECT l.id AS loan_id, c.apodo, l.tipo_amortizacion, l.frecuencia_pago,
       l.valor, l.valor_a_pagar, l.numero_cuotas,
       count(pp.id)                     AS cuotas_generadas,
       round(sum(pp.valor_cuota), 2)    AS suma_cuotas,
       round(sum(pp.valor_cuota) - l.valor_a_pagar, 2) AS diferencia,
       min(pp.fecha_pago)               AS primera,
       max(pp.fecha_pago)               AS ultima
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY l.id, c.apodo, l.tipo_amortizacion, l.frecuencia_pago,
          l.valor, l.valor_a_pagar, l.numero_cuotas
 ORDER BY abs(COALESCE(sum(pp.valor_cuota), 0) - l.valor_a_pagar) DESC;


-- ── PASO 10 (OPCIONAL) Alinear la fecha de las ventas al 09/08/2026 ───────
-- Solo si quieres que el Resumen del Día muestre todas estas ventas como
-- hechas el día anterior al inicio de pruebas.
--
-- Por qué puede interesarte: la vista resumen_pagos_diarios calcula el
-- efectivo como (ingresos + pagos − ventas − gastos − retiros) acumulado
-- desde siempre. Si dejas las fechas viejas, la caja arranca en negativo
-- repartido por los días en que se hicieron esas ventas. Moviéndolas todas
-- al 09/08 el arranque queda en un solo día y es más fácil de leer.
--
-- Cambia historia: solo córrelo si es lo que quieres.
--
-- UPDATE loans
--    SET fecha_creacion = TIMESTAMPTZ '2026-08-09 09:00:00-05:00',
--        created_at     = TIMESTAMPTZ '2026-08-09 09:00:00-05:00'
--  WHERE estado = 'activo';
