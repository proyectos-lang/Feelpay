-- ============================================================================
-- 102 - Eliminar un registro errado del dia que se cierra no va a revision
-- ============================================================================
-- LO QUE SE REPORTO
-- "Se esta tratando de eliminar un registro errado pero tambien esta mandando
--  a revision, quitemos esto por favor."
--
-- POR QUE PASABA
-- ---------------
-- "Eliminar" no borra: registra una REVERSA, y `registrar_gestion` limita
-- quien puede reversar que:
--
--   IF NOT v_rol_priv
--      AND NOT (v_ref.fecha_gestion = v_hoy
--               AND v_ref.user_id IS NOT DISTINCT FROM p_user_id) THEN
--     v_estado_g := 'en_revision';
--     v_motivo   := 'Solo secretaria reversa gestiones de otros dias u otros usuarios';
--
-- O sea: un cobrador solo puede reversar lo SUYO y de HOY. La regla es
-- correcta para el dia normal — nadie deberia poder deshacer la visita de
-- otro, ni una de la semana pasada.
--
-- Pero es la misma historia del script 101: se escribio ANTES del
-- descongelamiento y no conoce el caso legitimo. Cerrando el 5 un dia 7, la
-- gestion que se quiere corregir es del 5, y `v_ref.fecha_gestion = v_hoy`
-- no se cumple nunca.
--
-- MEDIDO EN LA 196 ANTES DE TOCAR NADA
--   5 reversas con motivo "Solo secretaria reversa gestiones de otros dias"
--   fecha_gestion 2026-09-05, todas del propio cobrador de la ruta
--   y 5 solicitudes de revision que alguien tuvo que aprobar a mano
--
-- LA REGLA NUEVA
-- ---------------
--   El dia de la gestion reversada puede ser HOY, o un dia que esa ruta tenga
--   abierto y desbloqueado.
--
-- Lo demas NO se toca: sigue teniendo que ser una gestion SUYA (misma
-- condicion de `user_id`), sigue sin poder reversar lo de otro cobrador, y
-- una reversa sin referencia sigue necesitando secretaria.
--
-- Y como en el 101, la condicion se resuelve contra `rutas_diarias`, que solo
-- escribe secretaria — no contra algo que mande el telefono.
--
-- LO QUE HAY QUE HACER DESPUES
-- -----------------------------
-- Las 5 reversas que ya pasaron por revision NO se tocan: ya fueron aprobadas
-- y estan aplicadas. Este script solo evita que vuelva a pasar.
--
-- COMO CORRERLO: un paso a la vez, en orden. El PASO 1 no escribe nada.
-- ============================================================================


-- -- PASO 1) Lo que hay hoy (SOLO LECTURA, no cambia nada) -------------------
SELECT g.ruta,
       g.fecha_gestion,
       COUNT(*) AS reversas_frenadas
  FROM public.gestiones g
 WHERE g.tipo = 'reversa'
   AND g.motivo_revision LIKE 'Solo secretar%a reversa gestiones%'
 GROUP BY g.ruta, g.fecha_gestion
 ORDER BY g.fecha_gestion DESC, g.ruta;


-- -- PASO 2) La regla nueva ---------------------------------------------------
-- Se parchea la definicion VIVA, igual que en el 101, y se comprueba que el
-- ancla enganche EXACTAMENTE una vez antes de aplicar nada.
DO $$
DECLARE
  v_src   text;
  v_new   text;
  v_veces int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.registrar_gestion: corra antes los scripts 044 y 077';
  END IF;

  SELECT count(*) INTO v_veces
    FROM regexp_matches(v_src, 'v_ref\.fecha_gestion\s*=\s*v_hoy', 'g');

  IF v_veces = 0 THEN
    RAISE EXCEPTION 'No se encontro la condicion de fecha de la reversa: revise a mano antes de seguir';
  ELSIF v_veces > 1 THEN
    RAISE EXCEPTION 'La condicion aparece % veces; se esperaba 1. Revise a mano.', v_veces;
  END IF;

  -- El dia de la gestion reversada: hoy, O un dia desbloqueado de esa ruta.
  v_new := regexp_replace(
             v_src,
             'v_ref\.fecha_gestion\s*=\s*v_hoy',
             '(v_ref.fecha_gestion = v_hoy OR EXISTS ('
             || 'SELECT 1 FROM public.rutas_diarias rd '
             || 'WHERE rd.ruta_id = p_ruta_id AND rd.fecha = v_ref.fecha_gestion '
             || 'AND rd.estado = ''abierta'' AND rd.desbloqueada_at IS NOT NULL))',
             'g');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'El reemplazo no cambio nada: revise a mano antes de seguir';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'registrar_gestion: se puede reversar lo propio del dia que se esta cerrando';
END $$;


-- -- PASO 3) Que la regla quedo puesta (SOLO LECTURA) ------------------------
-- Tiene que devolver `true`.
SELECT pg_get_functiondef(p.oid) LIKE '%rd.fecha = v_ref.fecha_gestion%' AS regla_puesta
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion';


-- -- PASO 4) Que NO se aflojo de mas (SOLO LECTURA) --------------------------
-- Las tres condiciones que siguen vivas. Las tres tienen que dar `true`:
--   * la reversa sigue teniendo que ser del MISMO usuario
--   * una reversa sin referencia sigue pidiendo secretaria
--   * la del script 101 sigue puesta
SELECT pg_get_functiondef(p.oid) LIKE '%v_ref.user_id IS NOT DISTINCT FROM p_user_id%' AS sigue_pidiendo_mismo_usuario,
       pg_get_functiondef(p.oid) LIKE '%ajuste de dinero%'                             AS sigue_pidiendo_secretaria_sin_ref,
       pg_get_functiondef(p.oid) LIKE '%rd.desbloqueada_at IS NOT NULL%'               AS regla_del_101_intacta
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion';
