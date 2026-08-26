-- ============================================================================
-- 076 - Limpiar el enredo de MARTINEZ EMILCE (ruta 197)
-- ============================================================================
-- QUE PASO
-- 1. El 25/08 el cobrador intento corregir un monto y le pego VEINTE veces al
--    boton de anular. Cada intento apuntaba a una gestion que ya estaba
--    anulada (ese bug se corrigio en el commit b89f995), asi que el servidor
--    los mandaba a revision uno tras otro.
-- 2. Alguien deshizo la dilucion del pago de 192.000 a mano, con 20 reversas
--    desde Control de Pagos, una por cuota, del 26/08 al 17/09.
-- 3. Despues se aprobaron POR ACCIDENTE todas las solicitudes de la bandeja,
--    y esos 20 intentos entraron como pagos reales.
--
-- Resultado: 80 eventos en un credito que tuvo CUATRO pagos.
--
-- LO QUE DEBERIA HABER
--   21/08  $19.200
--   22/08  $ 9.600
--   24/08  $ 9.600
--   25/08  $ 9.600     <- UNO solo
--   ---------------
--   total  $48.000  sobre un contrato de $240.000  ->  saldo $192.000
--
-- LO QUE HAY HOY
--   neto pagado $153.600  ->  saldo $86.400
--   el 25/08 tiene TRECE pagos vivos: uno de 192.000 y doce de 9.600
--
-- POR QUE SE BORRA Y NO SE REVERSA
-- ---------------------------------
-- El libro es INSERT-only a proposito: nada se borra, se reversa. Esa regla
-- es para los hechos del negocio — un pago que ocurrio y hay que corregir.
--
-- Esto no son hechos: son 75 eventos que genero un boton roto y una
-- aprobacion por accidente. Ninguno corresponde a plata que alguien haya
-- entregado. Neutralizarlos con reversas pediria TREINTA Y DOS eventos mas
-- —incluidas reversas de reversas— y dejaria el historial de este cliente
-- todavia menos legible que ahora.
--
-- Es la misma decision del script 069: cuando lo que hay que reparar lo
-- escribio el sistema y no una persona, se repara.
--
-- NADA SE PIERDE: el paso 2 guarda los 76 eventos completos en
-- `gestiones_borradas_076` antes de tocar nada. Si algo sale mal, ahi estan.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Que hay hoy (solo lectura) ────────────────────────────────────
-- Debe salir: 80 eventos en total, y 13 pagos vivos el 25/08.
SELECT g.fecha_gestion,
       COUNT(*)                                             AS eventos,
       COUNT(*) FILTER (WHERE g.tipo = 'pago')              AS pagos,
       COUNT(*) FILTER (WHERE g.tipo = 'reversa')           AS reversas,
       SUM(CASE WHEN g.tipo = 'pago' THEN g.monto ELSE 0 END) AS suma_pagos
  FROM public.gestiones g
 WHERE g.loan_id = 'b4973b6c-f84c-4429-9c77-c89ffa9e6464'
   AND g.estado = 'aplicada'
 GROUP BY g.fecha_gestion
 ORDER BY g.fecha_gestion;


-- ── PASO 2) Guardar TODO lo que se va a borrar ────────────────────────────
-- La copia completa de los 76 eventos, con todas sus columnas. Es la red:
-- mientras esta tabla exista, esto se puede reconstruir.
DROP TABLE IF EXISTS public.gestiones_borradas_076;


-- ── PASO 3) La copia ──────────────────────────────────────────────────────
CREATE TABLE public.gestiones_borradas_076 AS
SELECT *, NOW() AS copiado_en
  FROM public.gestiones
 WHERE loan_id = 'b4973b6c-f84c-4429-9c77-c89ffa9e6464'
   AND fecha_gestion >= DATE '2026-08-25';


-- ── PASO 4) Confirmar que la copia quedo ──────────────────────────────────
-- Debe decir 76. Si dice otra cosa, PARA: el paso 5 borra basandose en el
-- mismo criterio y no queres borrar sin respaldo.
SELECT COUNT(*) AS eventos_respaldados FROM public.gestiones_borradas_076;


-- ── PASO 5) Borrar, dejando UN pago de 9.600 ──────────────────────────────
-- El que se conserva es el mas antiguo de los doce que estan vivos ese dia
-- (f2f43be8). Cual de los doce se quede da igual: son identicos, mismo monto
-- y misma cuota marcada. Se elige por id para que esto sea reproducible.
--
-- Va TODO en un solo bloque: apagar el trigger de inmutabilidad, borrar y
-- volver a encenderlo son transaccionales, asi que si algo falla se deshace
-- entero y el trigger NO puede quedarse apagado.
DO $BLOQUE$
DECLARE
  v_filas int;
BEGIN
  ALTER TABLE public.gestiones DISABLE TRIGGER trg_gestiones_inmutables;

  DELETE FROM public.gestiones
   WHERE loan_id = 'b4973b6c-f84c-4429-9c77-c89ffa9e6464'
     AND fecha_gestion >= DATE '2026-08-25'
     AND id <> 'f2f43be8-a192-40c7-863d-c4e638dcebe5';
  GET DIAGNOSTICS v_filas = ROW_COUNT;

  ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;

  RAISE NOTICE 'Eventos borrados: %  (se esperaban 75)', v_filas;
END
$BLOQUE$;


-- ── PASO 6) Que el trigger haya vuelto ────────────────────────────────────
-- `tgenabled` debe decir 'O'. Si dice 'D', el libro quedo sin proteccion.
SELECT tgname, tgenabled,
       CASE tgenabled WHEN 'O' THEN 'ENCENDIDO' ELSE 'APAGADO — ARREGLAR YA' END AS estado
  FROM pg_trigger
 WHERE tgname = 'trg_gestiones_inmutables';


-- ── PASO 7) Rehacer el cache de este prestamo ─────────────────────────────
-- `payment_plan.estado`, `monto_pagado`, `loans.saldo` y `loans.estado` son
-- un cache que solo escribe `recalcular_prestamo`.
SELECT public.recalcular_prestamo('b4973b6c-f84c-4429-9c77-c89ffa9e6464');


-- ── PASO 8) LA COMPROBACION QUE IMPORTA ───────────────────────────────────
-- Deben quedar CUATRO pagos, uno por dia, y el neto en 48.000.
SELECT g.fecha_gestion, g.tipo, g.monto, g.origen, g.observacion
  FROM public.gestiones g
 WHERE g.loan_id = 'b4973b6c-f84c-4429-9c77-c89ffa9e6464'
   AND g.estado = 'aplicada'
 ORDER BY g.fecha_hora;


-- ── PASO 9) El dinero ─────────────────────────────────────────────────────
-- `total_pagado` = 48.000 · `saldo` = 192.000 · `cuotas_cubiertas` = 4/25
SELECT c.nombre_completo,
       f.total_pagado, f.saldo, f.saldo_hoy,
       f.cuotas_cubiertas || '/' || f.cuotas_totales AS cuotas,
       f.cuotas_mora,
       l.estado
  FROM public.loans l
  JOIN public.clients c           ON c.id = l.client_id
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
 WHERE l.id = 'b4973b6c-f84c-4429-9c77-c89ffa9e6464';


-- ── PASO 10) Sus cuotas ───────────────────────────────────────────────────
-- Las cuatro primeras pagadas y el resto pendiente. La del 25/08 debe estar
-- 'pagado' con 9.600 asignados — el pago que se conservo.
SELECT numero_cuota, fecha_pago, valor_cuota, monto_asignado, estado_derivado
  FROM public.v_cobertura_cuotas
 WHERE loan_id = 'b4973b6c-f84c-4429-9c77-c89ffa9e6464'
 ORDER BY numero_cuota
 LIMIT 8;


-- ── PASO 11) Que no haya quedado basura en la bandeja ─────────────────────
-- Las solicitudes de este credito que sigan pendientes. Deberia salir vacio:
-- se aprobaron todas por accidente, y sus gestiones acaban de borrarse.
SELECT s.id, s.estado, s.tipo, s.monto, s.descripcion, s.created_at
  FROM public.solicitudes_revision s
 WHERE s.descripcion ILIKE '%EMILCE%'
 ORDER BY s.created_at DESC;
