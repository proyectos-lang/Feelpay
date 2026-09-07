-- ============================================================================
-- 101 - Cerrar un dia atrasado no es una anomalia
-- ============================================================================
-- LO QUE SE REPORTO
-- "Estamos haciendo el cierre atrasado del 5 en la ruta 196 y al registrar los
--  no pagos aparece que se envio a revision. Deberia simplemente registrar el
--  no pago con la fecha atrasada para poder cerrar ese dia."
--
-- POR QUE PASABA
-- ---------------
-- `registrar_gestion` clasifica como anomalia cualquier gestion con fecha de
-- hace mas de un dia:
--
--   ELSIF v_fecha < v_hoy - 1 AND NOT v_rol_priv THEN
--     v_estado_g := 'en_revision';
--     v_motivo   := 'Gestion con fecha de hace mas de 1 dia (...)';
--
-- La regla es buena para lo que fue escrita: un cobrador no anda registrando
-- visitas de la semana pasada. Pero se escribio ANTES del descongelamiento, y
-- no conoce el unico caso en que retroceder varios dias es legitimo: una
-- jornada vieja que secretaria DESBLOQUEO justamente para que se termine de
-- gestionar y se cierre.
--
-- Hoy es 7 y la jornada es del 5: 5 < 7-1 se cumple, y los cuatro no pagos
-- entraron `en_revision`. Como el cierre solo cuenta las gestiones
-- `aplicada`, la ruta quedaba trancada: no puede cerrar el dia porque le
-- faltan clientes, y no puede gestionarlos porque cada intento se va a
-- revision. Un punto muerto.
--
-- MEDIDO EN LA 196 ANTES DE TOCAR NADA
--   4 no_pago  en_revision  fecha_gestion 2026-09-05
--   motivo: "Gestion con fecha de hace mas de 1 dia (2026-09-05)"
--   son 3 creditos distintos (uno se registro dos veces)
--   el cierre de ese dia pide exactamente esos 3
--
-- LA REGLA NUEVA
-- ---------------
--   La fecha vieja deja de ser anomalia SI esa ruta tiene, para ESE dia, una
--   jornada abierta y desbloqueada.
--
-- No se afloja para todo el mundo: se afloja para el dia exacto que
-- secretaria habilito, en la ruta exacta, y solo mientras siga abierta. Un
-- cobrador NO puede darse el permiso solo — el desbloqueo lo hace secretaria
-- y queda firmado en `rutas_diarias.desbloqueada_por_nombre`.
--
-- Y NO SE MIRA EL PAYLOAD, SE MIRA LA TABLA. Habria sido mas facil que el
-- telefono mandara un "esto es un cierre atrasado, dejame pasar", pero eso es
-- justo lo que no se puede creer: el payload lo arma el cliente. La condicion
-- se resuelve en el servidor contra `rutas_diarias`, que solo escribe
-- secretaria.
--
-- LO QUE NO CAMBIA
-- -----------------
--   * La fecha FUTURA sigue siendo anomalia, siempre.
--   * Sin jornada desbloqueada, una gestion vieja sigue yendo a revision.
--   * Las demas causas de revision (prestamo ya cancelado, umbral de abono,
--     reversa invalida, sin coordenadas) quedan intactas.
--   * Los roles privilegiados siguen exentos como antes.
--
-- LO QUE HAY QUE HACER DESPUES DE CORRER ESTO
-- --------------------------------------------
-- Los 4 no pagos que YA quedaron en revision no se arreglan solos: hay que
-- aprobarlos desde "Movimientos en Revision". El PASO 4 los lista. Se dejan
-- ahi a proposito — este script cambia la regla, no toca el libro.
--
-- COMO CORRERLO: un paso a la vez, en orden. El PASO 1 no escribe nada.
-- ============================================================================


-- -- PASO 1) Lo que hay hoy (SOLO LECTURA, no cambia nada) -------------------
-- Las gestiones atascadas por esta causa, en toda la base.
SELECT g.ruta,
       g.fecha_gestion,
       g.tipo,
       COUNT(*) AS cuantas
  FROM public.gestiones g
 WHERE g.estado = 'en_revision'
   AND g.motivo_revision LIKE 'Gesti%n con fecha de hace m%s de 1 d%a%'
 GROUP BY g.ruta, g.fecha_gestion, g.tipo
 ORDER BY g.fecha_gestion DESC, g.ruta;


-- -- PASO 2) La regla nueva ---------------------------------------------------
-- Se parchea la definicion VIVA de `registrar_gestion`: es una funcion larga
-- y este script no tiene por que repetirla entera para cambiar una condicion.
--
-- El ancla se busca por lo que HACE (la comparacion de la fecha contra ayer),
-- no por un texto literal con espacios — la leccion del script 090. Y se
-- comprueba que enganche EXACTAMENTE una vez antes de aplicar nada.
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

  -- Cuantas veces aparece la condicion que se va a cambiar.
  SELECT count(*) INTO v_veces
    FROM regexp_matches(v_src, 'v_fecha\s*<\s*v_hoy\s*-\s*1\s+AND\s+NOT\s+v_rol_priv', 'g');

  IF v_veces = 0 THEN
    RAISE EXCEPTION 'No se encontro la condicion de fecha vieja en registrar_gestion: revise a mano antes de seguir';
  ELSIF v_veces > 1 THEN
    RAISE EXCEPTION 'La condicion de fecha vieja aparece % veces; se esperaba 1. Revise a mano.', v_veces;
  END IF;

  -- La condicion nueva: sigue siendo anomalia, SALVO que esa ruta tenga ese
  -- dia abierto y desbloqueado por secretaria.
  v_new := regexp_replace(
             v_src,
             'v_fecha\s*<\s*v_hoy\s*-\s*1\s+AND\s+NOT\s+v_rol_priv',
             'v_fecha < v_hoy - 1 AND NOT v_rol_priv '
             || 'AND NOT EXISTS (SELECT 1 FROM public.rutas_diarias rd '
             || 'WHERE rd.ruta_id = p_ruta_id AND rd.fecha = v_fecha '
             || 'AND rd.estado = ''abierta'' AND rd.desbloqueada_at IS NOT NULL)',
             'g');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'El reemplazo no cambio nada: revise a mano antes de seguir';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'registrar_gestion: una jornada desbloqueada ya no manda sus gestiones a revision';
END $$;


-- -- PASO 3) Que la regla quedo puesta (SOLO LECTURA) ------------------------
-- Tiene que devolver `true`.
SELECT pg_get_functiondef(p.oid) LIKE '%rd.desbloqueada_at IS NOT NULL%' AS regla_puesta
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion';


-- -- PASO 4) Lo que quedo atascado ANTES de este cambio (SOLO LECTURA) -------
-- Estas gestiones ya estan escritas en revision y este script NO las mueve.
-- Hay que aprobarlas desde "Movimientos en Revision" para que cuenten en el
-- cierre. Si la lista sale vacia, no quedo nada pendiente.
SELECT g.id,
       g.ruta,
       g.fecha_gestion,
       g.tipo,
       g.monto,
       g.motivo_revision
  FROM public.gestiones g
  JOIN public.rutas_diarias rd
    ON rd.ruta_id = g.ruta AND rd.fecha = g.fecha_gestion
 WHERE g.estado = 'en_revision'
   AND g.motivo_revision LIKE 'Gesti%n con fecha de hace m%s de 1 d%a%'
   AND rd.desbloqueada_at IS NOT NULL
 ORDER BY g.fecha_gestion DESC, g.ruta, g.fecha_hora;
