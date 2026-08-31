-- ============================================================================
-- 082 - Devolver a su ruta las ventas que cayeron en la ruta de la sesión
-- ============================================================================
-- QUÉ PASÓ
-- El 31/08, desde Control Total, secretaría registró tres ventas eligiendo la
-- ruta en el selector de la ventana de venta. Las tres quedaron en la ruta que
-- el usuario tenía abierta arriba —la 1, que es la de prueba— y no en la que
-- se eligió abajo.
--
-- LA CAUSA (ya corregida en el código, no en este script)
-- El formulario calculaba `p_ruta_id` con todo cuidado y NO LO ENVIABA.
-- `enviarOEncolar` armaba la identidad de la operación por su cuenta con
-- `getSessionIdentity()` —que lee `localStorage.selectedRuta`— y la RPC usaba
-- esa. En la calle daba igual: la ruta de la sesión ES la ruta de la venta. Con
-- Control Total dejó de serlo, y el error quedó a la vista.
--
-- POR QUÉ CORRE
-- No es cosmético. Hoy:
--
--   · La ruta 1 tiene la caja en −$3.199.840, que es exactamente lo que le
--     sacaron esas tres ventas a una caja que no tenía con qué.
--   · Los dos clientes de la 151 NO LE APARECEN A SU COBRADOR: el módulo de
--     pagos lista por `loans.ruta`, así que $3.000.000 prestados están
--     invisibles para quien tiene que cobrarlos.
--
-- QUÉ MUEVE, MEDIDO
--   cinthya panadera   $1.000.000   contada en el 28/08
--   maribel eulalia    $2.000.000   contada en el 29/08
--   ─────────────────────────────
--   TOTAL              $3.000.000   de la ruta 1 a la 151
--
-- Y LO QUE VA A DESTAPAR — léelo antes de correr
-- La caja de la 151 pasa de −$285.200 a −$3.285.200. Eso NO es un error del
-- script: es la verdad que estaba escondida en la ruta equivocada. Prestó
-- $3.000.000 y esa plata tuvo que salir de algún lado; si la 151 recibió una
-- remesa para financiarlos, ESE INGRESO NO ESTÁ REGISTRADO. Después de correr
-- esto hay que buscarlo y registrarlo, o la caja de la 151 va a seguir
-- diciendo que debe tres millones.
--
-- La ruta 1 queda en −$199.840, que son los $200.000 de la tercera venta
-- (IVANNA). Esa no se mueve acá: es un cliente NUEVO, así que el cliente
-- TAMBIÉN se creó en la ruta 1 y no hay forma de deducir de los datos a qué
-- ruta iba. Está en el PASO 6, comentado, para completarlo a mano.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 0) Cómo están ahora (SOLO LECTURA) ───────────────────────────────
-- Las tres ventas del 31/08 y la ruta de cada pieza. `loans.ruta` y
-- `clients.ruta` deben estar en desacuerdo en las dos primeras: ahí está el
-- error. En la tercera coinciden en 1 porque el cliente se creó ahí mismo.
SELECT l.id,
       c.apodo,
       c.nombre_completo,
       l.valor,
       (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS dia_del_reporte,
       l.ruta                                                 AS ruta_del_prestamo,
       c.ruta                                                 AS ruta_del_cliente,
       (SELECT count(DISTINCT pp.ruta) FROM public.payment_plan pp WHERE pp.loan_id = l.id)
                                                              AS rutas_en_el_plan,
       (SELECT count(*) FROM public.gestiones g WHERE g.loan_id = l.id)
                                                              AS eventos
  FROM public.loans l
  JOIN public.clients c ON c.id = l.client_id
 WHERE l.created_at >= TIMESTAMPTZ '2026-08-31 00:00:00-05'
 ORDER BY l.created_at;


-- ── PASO 1) El préstamo se va a la ruta de su cliente ─────────────────────
-- La condición `ruta = 1` hace el paso repetible: correrlo dos veces no mueve
-- nada la segunda.
UPDATE public.loans
   SET ruta = 151, updated_at = NOW()
 WHERE id IN (
   'aec5c5cd-4b7e-4afb-a351-46d4f9245a56',   -- cinthya panadera  $1.000.000
   '0d5bf042-6250-42a5-84ca-eef476aa815f'    -- maribel eulalia   $2.000.000
 )
   AND ruta = 1;


-- ── PASO 2) Y su cronograma con él ────────────────────────────────────────
-- `payment_plan.ruta` es lo que usan el conteo de cuotas que vencen hoy y el
-- listado de la ruta. Sin esto, el préstamo estaría en la 151 pero sus cuotas
-- seguirían contándose en la 1.
UPDATE public.payment_plan
   SET ruta = 151
 WHERE loan_id IN (
   'aec5c5cd-4b7e-4afb-a351-46d4f9245a56',
   '0d5bf042-6250-42a5-84ca-eef476aa815f'
 )
   AND ruta = 1;


-- ── PASO 3) El rastro en el libro ─────────────────────────────────────────
-- Cada una de esas ventas dejó UN evento: el `ajuste` de monto 0 que dice que
-- se registró el 31 y se fechó en el 28 o el 29 (script 078). Ningún informe
-- lo cuenta —todos filtran por tipo y el `ajuste` queda fuera— así que moverlo
-- no cambia una sola cifra. Se mueve por coherencia: un evento cuya ruta
-- contradiga la de su préstamo es una trampa para el próximo que audite.
--
-- HACE FALTA APAGAR EL TRIGGER DE INMUTABILIDAD, y por eso va todo dentro de
-- UN bloque: si el UPDATE fallara, el bloque entero se deshace y el trigger
-- vuelve solo. Partido en tres sentencias, un fallo en la del medio dejaría el
-- libro sin guardián.
DO $$
BEGIN
  ALTER TABLE public.gestiones DISABLE TRIGGER trg_gestiones_inmutables;

  UPDATE public.gestiones
     SET ruta = 151
   WHERE loan_id IN (
     'aec5c5cd-4b7e-4afb-a351-46d4f9245a56',
     '0d5bf042-6250-42a5-84ca-eef476aa815f'
   )
     AND ruta = 1;

  ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;
END $$;


-- ── PASO 4) El trigger volvió a quedar puesto (SOLO LECTURA) ──────────────
-- `tgenabled` tiene que ser 'O' (habilitado). Si dijera 'D', el libro quedó
-- sin guardián y hay que encenderlo a mano:
--   ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;
SELECT t.tgname, t.tgenabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE c.relname = 'gestiones'
   AND NOT t.tgisinternal;


-- ── PASO 5) Ningún préstamo en desacuerdo con su cliente (SOLO LECTURA) ───
-- Debe quedar SOLO la venta de IVANNA si todavía no se resolvió el PASO 6, y
-- ahí los dos están en la 1, así que ni siquiera aparece. Lo ideal es CERO
-- filas.
SELECT l.id, c.apodo, l.valor, l.ruta AS ruta_prestamo, c.ruta AS ruta_cliente
  FROM public.loans l
  JOIN public.clients c ON c.id = l.client_id
 WHERE c.ruta IS NOT NULL
   AND l.ruta IS DISTINCT FROM c.ruta
 ORDER BY l.created_at DESC;


-- ── PASO 6) LA VENTA DE IVANNA — completar a mano ─────────────────────────
-- $200.000, cliente NUEVO, contada en el reporte del 29/08. El cliente se creó
-- en la ruta 1 junto con el préstamo, así que de los datos NO se puede deducir
-- a qué ruta iba: hay que preguntarle a quien la registró.
--
-- Cuando sepas la ruta, cambia los 151 de abajo por la correcta y quítale los
-- comentarios a las cuatro sentencias. Fíjate que acá SÍ se mueve también el
-- CLIENTE, que es lo que no hacía falta en las otras dos.
--
-- UPDATE public.clients SET ruta = 151, updated_at = NOW()
--  WHERE id = (SELECT client_id FROM public.loans WHERE id = 'b6a7b3ef-ae1a-4522-98fa-215cc1f615f2');
--
-- UPDATE public.loans SET ruta = 151, updated_at = NOW()
--  WHERE id = 'b6a7b3ef-ae1a-4522-98fa-215cc1f615f2' AND ruta = 1;
--
-- UPDATE public.payment_plan SET ruta = 151
--  WHERE loan_id = 'b6a7b3ef-ae1a-4522-98fa-215cc1f615f2' AND ruta = 1;
--
-- DO $$
-- BEGIN
--   ALTER TABLE public.gestiones DISABLE TRIGGER trg_gestiones_inmutables;
--   UPDATE public.gestiones SET ruta = 151
--    WHERE loan_id = 'b6a7b3ef-ae1a-4522-98fa-215cc1f615f2' AND ruta = 1;
--   ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;
-- END $$;


-- ── PASO 7) Cómo quedaron las dos cajas (SOLO LECTURA) ────────────────────
-- Lo que debe verse, medido antes de correr nada:
--
--   ruta   1   efectivo  −$3.199.840  →  −$199.840   (los $200.000 de IVANNA)
--   ruta 151   efectivo    −$285.200  →  −$3.285.200
--
-- El −$3.285.200 de la 151 es el número que hay que perseguir: prestó tres
-- millones y no hay un ingreso que los respalde. No lo inventó este script,
-- lo destapó.
SELECT r.ruta,
       r.fecha_pago,
       r.valor_ventas,
       r.valor_ventas_caja,
       r.valor_pago,
       r.caja_anterior,
       r.efectivo
  FROM public.resumen_diario_v2 r
 WHERE r.ruta IN (1, 151)
   AND r.fecha_pago >= DATE '2026-08-27'
   AND r.fecha_pago <= (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY r.ruta, r.fecha_pago;
