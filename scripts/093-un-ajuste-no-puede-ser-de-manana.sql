-- ============================================================================
-- 093 - Un ajuste no puede pertenecer a mañana
-- ============================================================================
-- LO QUE SE REPORTÓ
-- "En la ruta 190, el 01/09/2026 sale un ajuste de -$33.600 y los usuarios
--  dicen que no han hecho ajustes."
--
-- Y tienen razón: hoy nadie hizo un ajuste en esa ruta.
--
-- QUÉ PASÓ DE VERDAD
-- El 31 de agosto, la secretaría entró a Control de Pagos del crédito de
-- `jorge ricardo herrera bazar` (ruta 190) y devolvió a pendiente sus cuotas
-- 14 a 22 — las que el abono de venta tenía cubiertas con la cascada vieja.
--
-- Cada una de esas correcciones generó una reversa, y el script 066 las fecha
-- EN EL DÍA DE LA CUOTA. Como esas cuotas vencen del 1 al 11 de septiembre,
-- las reversas quedaron fechadas en días que todavía no habían llegado.
--
-- Medido: 26 eventos por $286.400, todos escritos el 31/08.
--
--   01/09  -$ 33.600   <- el que se reportó, ya está en el cierre de hoy
--   03/09  -$ 34.000       05/09  -$ 34.000       09/09  -$ 34.000
--   04/09  -$ 34.000       07/09  -$ 34.000       10/09  -$ 34.000
--   08/09  -$ 34.400       11/09  -$ 14.400
--
-- O sea que esto no es un caso de hoy: los próximos OCHO cierres iban a
-- amanecer con un descuento de ~$34.000 que nadie hizo ese día.
--
-- LA PLATA NO ESTÁ MAL CONTADA
-- Se comprobó crédito por crédito. En el de jorge entraron $2.489.600, el
-- cobrador anuló $1.128.000 y la secretaría quitó $546.800: neto $814.800,
-- que es exactamente lo que dice la vista, con saldo $25.200. Las
-- correcciones de la secretaría son deliberadas y quedan como están. Lo único
-- que cambia acá es EN QUÉ DÍA se cuentan.
--
-- POR QUÉ EL 066 LO HACÍA ASÍ, Y DÓNDE SE PASÓ
-- Ese script decidió registrar el ajuste en el día de la cuota, y para
-- corregir el PASADO es lo correcto: la plata pertenece a ese día y el resumen
-- de ese día tiene que reflejarlo. Para el FUTURO no tiene sentido — no hay
-- caja que corregir en un día que no ha ocurrido, y el descuento aparece en el
-- cierre de una jornada donde nadie tocó nada.
--
-- LA REGLA QUE FALTABA: un ajuste puede pertenecer a ayer, nunca a mañana.
--
-- Corre los pasos DE A UNO. El editor de Supabase mete todo lo que se le pega
-- en una sola transacción, y si el último paso falla se deshacen los primeros.
-- ============================================================================


-- ── PASO 1) Los que están fechados en el futuro (SOLO LECTURA) ────────────
-- Corre esto PRIMERO y guarda el resultado: es la lista de lo que se va a
-- mover, y la prueba de que el problema existe.
--
-- El criterio no es "posterior a hoy" sino "posterior al día en que se
-- escribió". Así también salen los que ya se pasaron de fecha aunque el
-- calendario ya los haya alcanzado.
SELECT g.ruta,
       c.nombre_completo,
       g.tipo,
       g.origen,
       g.monto,
       g.fecha_gestion                            AS fechado_el,
       (g.fecha_hora AT TIME ZONE 'America/Bogota')::date AS escrito_el,
       g.observacion
  FROM public.gestiones g
  JOIN public.loans   l ON l.id = g.loan_id
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE g.estado = 'aplicada'
   AND g.fecha_gestion > (g.fecha_hora AT TIME ZONE 'America/Bogota')::date
 ORDER BY g.ruta, g.fecha_gestion, g.fecha_hora;


-- ── PASO 2) Cuánto se le quita a cada día (SOLO LECTURA) ──────────────────
-- Lo que cada cierre futuro iba a llevar de menos.
SELECT g.ruta,
       g.fecha_gestion AS ese_dia_iba_a_perder,
       COUNT(*)        AS eventos,
       SUM(CASE WHEN g.tipo = 'reversa' THEN g.monto ELSE 0 END) AS monto
  FROM public.gestiones g
 WHERE g.estado = 'aplicada'
   AND g.fecha_gestion > (g.fecha_hora AT TIME ZONE 'America/Bogota')::date
 GROUP BY g.ruta, g.fecha_gestion
 ORDER BY g.ruta, g.fecha_gestion;


-- ── PASO 3) Traerlos al día en que se hicieron ────────────────────────────
-- Se les pone la fecha del día en que se escribieron, que es cuando la
-- corrección ocurrió de verdad.
--
-- OJO CON LO QUE ESTO SIGNIFICA: esos $286.400 dejan de repartirse entre ocho
-- cierres futuros y se juntan en el del 31/08/2026, que es el día en que la
-- secretaría hizo las correcciones. Ese día ya está cerrado sin cuadre por el
-- script 086, así que no hay ninguna firma que se rompa — pero su resumen
-- cambia, y conviene saberlo antes de mirarlo.
--
-- `gestiones` es INSERT-only y un trigger lo vigila. Se abre la rendija dentro
-- de un bloque atómico, igual que hizo el script 082: si algo falla en medio,
-- el trigger vuelve a su sitio con el resto de la transacción.
DO $mueve093$
DECLARE
  v_n int;
BEGIN
  ALTER TABLE public.gestiones DISABLE TRIGGER trg_gestiones_inmutables;

  UPDATE public.gestiones g
     SET fecha_gestion = (g.fecha_hora AT TIME ZONE 'America/Bogota')::date
   WHERE g.estado = 'aplicada'
     AND g.fecha_gestion > (g.fecha_hora AT TIME ZONE 'America/Bogota')::date;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;

  RAISE NOTICE '% evento(s) traído(s) al día en que se escribieron.', v_n;
END
$mueve093$;


-- ── PASO 4) Que no quedó ninguno en el futuro (SOLO LECTURA) ──────────────
-- TIENE QUE DAR 0.
SELECT COUNT(*) AS eventos_fechados_en_el_futuro
  FROM public.gestiones
 WHERE estado = 'aplicada'
   AND fecha_gestion > (fecha_hora AT TIME ZONE 'America/Bogota')::date;


-- ── PASO 5) Que el trigger volvió a su sitio (SOLO LECTURA) ───────────────
-- `tgenabled` tiene que ser 'O' (habilitado). Si quedó en 'D', el libro está
-- sin vigilancia y hay que habilitarlo a mano:
--   ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;
SELECT t.tgname, t.tgenabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
 WHERE c.relname = 'gestiones' AND NOT t.tgisinternal;


-- ── PASO 6) Que la plata del cliente NO se movió (SOLO LECTURA) ───────────
-- El crédito de jorge tiene que seguir con pagado $814.800 y saldo $25.200.
-- Mover un evento de día no cambia cuánto pagó: solo a qué caja pertenece.
SELECT c.nombre_completo, f.total_pagado, f.saldo, f.cuotas_cubiertas, f.cuotas_totales
  FROM public.v_loan_financiero f
  JOIN public.loans   l ON l.id = f.loan_id
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE f.loan_id = '374affe3-f483-4c5f-b041-1e13096f2157';


-- ── PASO 7) Que un ajuste no pueda volver a fecharse mañana ───────────────
-- Se le pone un techo a la fecha del ajuste: el día de la cuota, pero nunca
-- más allá de hoy. Corregir hacia atrás sigue funcionando igual — es lo que
-- el 066 quería y sigue siendo correcto.
--
-- No se reescribe la función a mano: se lee la definición viva y se le cambia
-- esa línea, como en los scripts 083, 087 y 089.
DO $fix093$
DECLARE
  v_cuantas int;
  v_src     text;
  v_nuevo   text;
BEGIN
  SELECT count(*) INTO v_cuantas
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ajustar_cuota_control_pagos';

  IF v_cuantas <> 1 THEN
    RAISE EXCEPTION 'Esperaba una sola ajustar_cuota_control_pagos y encontré %.', v_cuantas;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ajustar_cuota_control_pagos';

  IF strpos(v_src, 'LEAST(COALESCE(v_fecha_nueva, v_pp.fecha_pago, v_hoy), v_hoy)') > 0 THEN
    RAISE NOTICE 'La función ya tenía el techo. Nada que cambiar.';
    RETURN;
  END IF;

  IF strpos(v_src, 'v_fecha_ajuste := COALESCE(v_fecha_nueva, v_pp.fecha_pago, v_hoy);') = 0 THEN
    RAISE EXCEPTION 'No encontré el cálculo de la fecha del ajuste. No toco nada.';
  END IF;

  v_nuevo := replace(
    v_src,
    'v_fecha_ajuste := COALESCE(v_fecha_nueva, v_pp.fecha_pago, v_hoy);',
    -- Un ajuste puede pertenecer a ayer, nunca a mañana: no hay caja que
    -- corregir en un día que no ha ocurrido. Ver el script 093.
    'v_fecha_ajuste := LEAST(COALESCE(v_fecha_nueva, v_pp.fecha_pago, v_hoy), v_hoy);');

  EXECUTE v_nuevo;
  RAISE NOTICE 'ajustar_cuota_control_pagos: la fecha del ajuste ya no puede pasar de hoy.';
END
$fix093$;


-- ── PASO 8) Que el techo quedó (SOLO LECTURA) ─────────────────────────────
-- `tiene_el_techo` = true.
SELECT strpos(pg_get_functiondef(p.oid),
              'LEAST(COALESCE(v_fecha_nueva, v_pp.fecha_pago, v_hoy), v_hoy)') > 0 AS tiene_el_techo
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'ajustar_cuota_control_pagos';


-- ── PASO 9) Cómo quedaron los cierres afectados (SOLO LECTURA) ────────────
-- El 01/09 ya no debe llevar el ajuste de -$33.600, y el 31/08 pasa a
-- llevarse las correcciones que la secretaría hizo ese día.
SELECT fecha_pago, valor_pago, valor_pago_campo, valor_pago_ajuste, cantidad_pagos
  FROM public.resumen_diario_v2
 WHERE ruta = 190
   AND fecha_pago BETWEEN '2026-08-29' AND '2026-09-12'
 ORDER BY fecha_pago;
