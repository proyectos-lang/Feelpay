-- ============================================================================
-- Corregir `valor_a_pagar` de los préstamos descuadrados
-- ============================================================================
-- ESTE SCRIPT MODIFICA DATOS. Toma un backup antes.
--   Supabase → Database → Backups → Create backup
--
-- PROBLEMA
-- Nueve préstamos tienen `valor_a_pagar` que no coincide con la suma de su
-- propio plan de pagos. El patrón más grave es la tasa usada SIN dividir
-- entre 100:
--
--   deguis colegio:  500 + 500 × 20   = 10.500   (debería ser 500 + 500 × 0,20 = 600)
--   cecilia peluquería: 400 + 400 × 20 = 8.400   (debería ser 480)
--   fernanda semanal: 1.000 + 1.000 × 10 × 10 = 101.000 (debería ser 2.000)
--
-- Como el saldo de un préstamo alemán se calcula `valor_a_pagar − pagado`,
-- esos clientes aparecen debiendo hasta DIECISIETE VECES lo que deben. Luis
-- carnicería figura con saldo 1.090 sobre un plan que suma 110.
--
-- Los americanos tienen el problema inverso y menor: el `valor_a_pagar`
-- quedó calculado con menos cuotas de las que tiene el plan.
--
-- POR QUÉ SE CORRIGE HACIA EL PLAN
-- La suma del plan es lo que la app calcula hoy con la fórmula correcta, y
-- es sobre lo que el cobrador está cobrando cuota a cuota. El plan manda;
-- `valor_a_pagar` es el que quedó mal.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Ver qué se va a cambiar (solo lectura) ────────────────────────
-- Revisa esta lista antes de tocar nada. `valor_a_pagar_nuevo` es lo que
-- quedará, y `saldo_nuevo` lo que pasará a deber cada cliente.
SELECT c.apodo,
       c.documento,
       l.tipo_amortizacion,
       l.valor,
       l.tasa_interes,
       l.numero_cuotas,
       l.valor_a_pagar                                    AS valor_a_pagar_actual,
       round(sum(pp.valor_cuota), 2)                      AS valor_a_pagar_nuevo,
       l.saldo                                            AS saldo_actual,
       round(sum(pp.valor_cuota)
             - COALESCE(sum(pp.monto_pagado), 0), 2)      AS saldo_nuevo,
       COALESCE(sum(pp.monto_pagado), 0)                  AS ya_pagado
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  JOIN payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY c.apodo, c.documento, l.id, l.tipo_amortizacion, l.valor,
          l.tasa_interes, l.numero_cuotas, l.valor_a_pagar, l.saldo
HAVING abs(sum(pp.valor_cuota) - l.valor_a_pagar) > 1
 ORDER BY abs(sum(pp.valor_cuota) - l.valor_a_pagar) DESC;


-- ── PASO 2) Corregir ──────────────────────────────────────────────────────
-- Deja `valor_a_pagar` igual a la suma del plan y recalcula el saldo con la
-- misma fórmula que usa la app desde el script 037: total menos lo pagado.
--
-- Solo toca los que están descuadrados por más de un peso — las diferencias
-- de centavos son el redondeo normal de las cuotas y no hay que tocarlas.
UPDATE loans l
   SET valor_a_pagar = p.suma_plan,
       saldo         = GREATEST(0, p.suma_plan - p.pagado),
       updated_at    = NOW()
  FROM (
    SELECT loan_id,
           round(sum(valor_cuota), 2)              AS suma_plan,
           COALESCE(sum(monto_pagado), 0)          AS pagado
      FROM payment_plan
     GROUP BY loan_id
  ) p
 WHERE p.loan_id = l.id
   AND l.estado = 'activo'
   AND abs(p.suma_plan - l.valor_a_pagar) > 1;


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
-- No debería devolver ninguna fila. Si devuelve alguna, avísame antes de
-- seguir: significa que ese préstamo tiene algo distinto a lo previsto.
SELECT c.apodo,
       l.valor_a_pagar,
       round(sum(pp.valor_cuota), 2) AS suma_del_plan,
       round(sum(pp.valor_cuota) - l.valor_a_pagar, 2) AS diferencia
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  JOIN payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY c.apodo, l.id, l.valor_a_pagar
HAVING abs(sum(pp.valor_cuota) - l.valor_a_pagar) > 1;


-- ── PASO 4) Cómo quedaron esos clientes ───────────────────────────────────
-- El saldo que verá el cobrador. Compáralo contra el paso 1.
SELECT c.apodo,
       l.valor,
       l.valor_a_pagar,
       l.saldo          AS saldo_guardado,
       v.total_recaudado,
       v.saldo_pendiente AS saldo_en_pantalla,
       l.estado
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN saldo_prestamos_clientes v ON v.loan_id = l.id
 WHERE c.apodo IN (
   'deguis colegio tulcan  portilla',
   'david fernanda  rodríguez',
   'cecilia peluquería  lopez',
   'luis carnicería  lozada',
   'fernanda semanal  albail',
   'rosa aguas elena pinta',
   'luis ropa de portiba alfredo alcocer',
   'laura chancho  granizo',
   'mercedes coca'
 )
 ORDER BY c.apodo;


-- ── PASO 5) Realinear el saldo del RESTO de préstamos ─────────────────────
-- Corre esto DESPUÉS del script 037.
--
-- Todos los préstamos arrastran el desfase que corrige el 037: `loans.saldo`
-- se venía descontando por capital y no por dinero. Don fausto, por ejemplo,
-- tiene 215,01 guardado cuando debe 210.
--
-- Con el 037 cada préstamo se corrige solo en su próximo cobro. Esto los
-- pone al día de una vez, incluidos los que no vuelvan a recibir un pago.
-- Primero mira cuántos y de cuánto es el desfase:
SELECT count(*)                                    AS prestamos_desfasados,
       round(sum(abs(l.saldo - (l.valor_a_pagar - COALESCE(p.pagado, 0)))), 2) AS desfase_total,
       round(max(abs(l.saldo - (l.valor_a_pagar - COALESCE(p.pagado, 0)))), 2) AS desfase_mayor
  FROM loans l
  LEFT JOIN (
    SELECT loan_id, COALESCE(sum(monto_pagado), 0) AS pagado
      FROM payment_plan GROUP BY loan_id
  ) p ON p.loan_id = l.id
 WHERE l.estado = 'activo'
   AND abs(l.saldo - GREATEST(0, l.valor_a_pagar - COALESCE(p.pagado, 0))) > 0.01;

-- Y después aplícalo:
--
-- UPDATE loans l
--    SET saldo = GREATEST(0, l.valor_a_pagar - COALESCE(p.pagado, 0)),
--        updated_at = NOW()
--   FROM (
--     SELECT loan_id, COALESCE(sum(monto_pagado), 0) AS pagado
--       FROM payment_plan GROUP BY loan_id
--   ) p
--  WHERE p.loan_id = l.id
--    AND l.estado = 'activo'
--    AND abs(l.saldo - GREATEST(0, l.valor_a_pagar - COALESCE(p.pagado, 0))) > 0.01;
