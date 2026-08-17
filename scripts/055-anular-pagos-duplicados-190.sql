-- ============================================================================
-- 055 - Anular los pagos duplicados por doble toque (ruta 190, 17/08/2026)
-- ============================================================================
-- QUÉ PASÓ
-- El cobrador registró un pago, el botón tardó en responder porque estaba
-- esperando al GPS, volvió a tocar, y la app escribió el pago una vez por
-- cada toque. Se ve clarísimo: eventos idénticos con la MISMA marca de
-- tiempo al segundo.
--
--   préstamo 1fec0326  →  4 pagos de $6.500  a las 20:55:54   (sobran 3)
--   préstamo 5be8f5c7  →  2 pagos de $19.500 a las 20:53:00   (sobra 1,
--                          y ese ya fue anulado a mano)
--
-- Resultado: el Resumen del Día contaba 20 pagos donde Gestionados mostraba
-- 17 clientes. La diferencia de 3 son $19.500 de plata que nunca entró.
--
-- La causa en la app ya está corregida (candado contra el doble toque en
-- `register-payment.tsx`). Este script limpia lo que quedó escrito.
--
-- POR QUÉ REVERSAS Y NO UN DELETE
-- `gestiones` es un libro de eventos: un trigger prohíbe borrar, y con razón.
-- Corregir es registrar una reversa que compense — quedan el evento original
-- y su anulación, y cualquiera puede reconstruir qué pasó. Un DELETE dejaría
-- la caja cuadrada pero sin explicación.
--
-- Las reversas se fechan el MISMO día del pago para que el Resumen de ese día
-- descuente conteo y plata a la vez (ver el script 052).
--
-- Correr los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Ver los duplicados (SOLO LECTURA) ─────────────────────────────
-- Agrupa por préstamo, monto y segundo exacto. Todo grupo con más de 1 es
-- un doble toque: un cliente no paga dos veces el mismo monto en el mismo
-- segundo. `sobran` es cuántos hay que anular en cada grupo.
SELECT g.loan_id,
       g.monto,
       date_trunc('second', g.fecha_hora) AS segundo,
       count(*)                           AS veces,
       count(*) - 1                       AS sobran
  FROM public.gestiones g
 WHERE g.ruta = 190
   AND g.fecha_gestion = DATE '2026-08-17'
   AND g.tipo = 'pago'
   AND g.estado = 'aplicada'
   -- Solo los que siguen vivos: si ya se anuló a mano, no hay nada que hacer.
   AND NOT EXISTS (SELECT 1 FROM public.gestiones r
                    WHERE r.referencia_gestion_id = g.id
                      AND r.tipo = 'reversa' AND r.estado = 'aplicada')
 GROUP BY g.loan_id, g.monto, date_trunc('second', g.fecha_hora)
HAVING count(*) > 1
 ORDER BY g.loan_id;


-- ── PASO 2) Anular los sobrantes ──────────────────────────────────────────
-- De cada grupo se CONSERVA el más antiguo (el toque real) y se anulan los
-- demás. `row_number()` ordena por fecha_hora e id para que el resultado sea
-- el mismo si el script se corre dos veces.
--
-- Es idempotente: los que ya tengan reversa quedan fuera por el NOT EXISTS,
-- así que volver a correrlo no anula de más.
INSERT INTO public.gestiones (
  id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion, monto,
  fecha_hora, origen, referencia_gestion_id, observacion
)
SELECT gen_random_uuid(),
       d.loan_id,
       d.client_id,
       d.ruta,
       d.user_id,
       'reversa',
       'aplicada',
       d.fecha_gestion,
       d.monto,
       d.fecha_hora + interval '1 second',
       'ajuste',
       d.id,
       'Duplicado por doble toque en el registro de pago (script 055)'
  FROM (
    SELECT g.*,
           row_number() OVER (
             PARTITION BY g.loan_id, g.monto, date_trunc('second', g.fecha_hora)
             ORDER BY g.fecha_hora, g.id
           ) AS n
      FROM public.gestiones g
     WHERE g.ruta = 190
       AND g.fecha_gestion = DATE '2026-08-17'
       AND g.tipo = 'pago'
       AND g.estado = 'aplicada'
       AND NOT EXISTS (SELECT 1 FROM public.gestiones r
                        WHERE r.referencia_gestion_id = g.id
                          AND r.tipo = 'reversa' AND r.estado = 'aplicada')
  ) d
 WHERE d.n > 1;


-- ── PASO 3) Recalcular los préstamos afectados ────────────────────────────
-- `payment_plan.estado`, `monto_pagado` y `loans.saldo` son un cache que solo
-- escribe `recalcular_prestamo`. Sin este paso el libro quedaría corregido
-- pero las cuotas seguirían marcadas como pagadas de más.
SELECT public.recalcular_prestamo(l.id)
  FROM (SELECT DISTINCT g.loan_id AS id
          FROM public.gestiones g
         WHERE g.origen = 'ajuste'
           AND g.observacion = 'Duplicado por doble toque en el registro de pago (script 055)'
       ) l;


-- ── PASO 4) Verificar ─────────────────────────────────────────────────────
-- El conteo del Resumen tiene que coincidir con los clientes distintos que
-- pagaron. Debe dar `cuadra = true`.
SELECT r.cantidad_pagos                                        AS resumen_dice,
       count(DISTINCT g.loan_id)                               AS clientes_con_pago,
       r.cantidad_pagos = count(DISTINCT g.loan_id)            AS cuadra,
       r.valor_pago
  FROM public.resumen_diario_v2 r
  LEFT JOIN public.gestiones g
         ON g.ruta = r.ruta
        AND g.fecha_gestion = r.fecha_pago
        AND g.tipo = 'pago'
        AND g.estado = 'aplicada'
        AND NOT EXISTS (SELECT 1 FROM public.gestiones rr
                         WHERE rr.referencia_gestion_id = g.id
                           AND rr.tipo = 'reversa' AND rr.estado = 'aplicada')
 WHERE r.ruta = 190
   AND r.fecha_pago = DATE '2026-08-17'
 GROUP BY r.cantidad_pagos, r.valor_pago;
