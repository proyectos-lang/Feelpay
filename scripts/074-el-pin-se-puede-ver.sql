-- ============================================================================
-- 074 - El PIN se puede ver desde Usuarios y Rutas
-- ============================================================================
-- LO QUE SE PIDIO
-- "Que en el modulo de usuarios y rutas se pueda ver el pin de cada persona
--  y se pueda editar, y que al crear un usuario tambien se le ponga el pin
--  deseado."
--
-- LO QUE CAMBIA, Y POR QUE HAY QUE DECIRLO
-- -----------------------------------------
-- El 073 guardo el PIN con bcrypt, que es de UNA SOLA VIA: se puede
-- comprobar si un PIN coincide, pero no recuperarlo. Ni la base lo sabe.
-- Para poder mostrarlo hay que guardarlo tal cual, y eso es un cambio de
-- fondo, no de pantalla.
--
-- QUE SE PIERDE
--   Quien llegue a la base ve los PIN de todos, igual que ya ve las
--   contraseñas. Antes, ni con la base en la mano se sacaban.
--
-- QUE SE CONSERVA
--   La columna sigue SIN PERMISO de lectura para la llave publica de la app.
--   Nadie los descarga desde el navegador. Para verlos hay que pasar por
--   `ver_pines`, que exige el usuario y la contraseña de un admin o
--   secretaria — no basta con decir "soy admin", hay que demostrarlo.
--
-- SEAMOS EXACTOS SOBRE CUANTO PROTEGE ESO
--   La llave publica SI puede ESCRIBIR en `usuarios` (asi es como el modulo
--   crea usuarios y cambia contraseñas). O sea que quien quiera entrar no
--   necesita leer un PIN: puede ponerle otro. La proteccion de lectura es un
--   freno para lo casual —que no se descarguen los 18 de un tiron, como
--   pasaba con las contraseñas— no un candado criptografico.
--
-- NADIE HABIA CAMBIADO SU PIN TODAVIA
-- Medido antes de escribir esto: los 18 usuarios siguen en 0000. Asi que
-- pasar de bcrypt a texto plano no pierde ningun PIN elegido por nadie.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Que nadie haya cambiado su PIN (solo lectura) ─────────────────
-- `ya_lo_cambiaron` DEBE dar 0. Si da otra cosa, PARA: esos PIN estan
-- cifrados y no se pueden recuperar, y este script se los pondria en 0000
-- sin avisarle a la persona. En ese caso hay que avisarles primero.
SELECT COUNT(*)                                  AS total,
       COUNT(*) FILTER (WHERE pin_cambiado)      AS ya_lo_cambiaron,
       COUNT(*) FILTER (WHERE NOT pin_cambiado)  AS siguen_en_0000
  FROM public.usuarios;


-- ── PASO 2) La columna del PIN, ahora legible por quien corresponda ───────
ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS pin text;


-- ── PASO 3) Poner el 0000 a quien no tenga ────────────────────────────────
UPDATE public.usuarios
   SET pin = '0000'
 WHERE pin IS NULL;


-- ── PASO 4) Soltar la bandera vieja ───────────────────────────────────────
-- `pin_cambiado` era una columna suelta que habia que acordarse de
-- actualizar en cada sitio que tocara el PIN. Se vuelve a crear en el paso 5
-- como columna CALCULADA, y ahi ya no puede mentir.
ALTER TABLE public.usuarios DROP COLUMN IF EXISTS pin_cambiado;


-- ── PASO 5) La bandera, calculada por la base ─────────────────────────────
-- Sale del propio PIN, asi que no hay forma de que quede desincronizada.
-- Esta SI se puede leer desde la app: sirve para avisarle a la persona que
-- todavia tiene el 0000, sin decirle a nadie cual es el PIN de nadie.
ALTER TABLE public.usuarios
  ADD COLUMN pin_cambiado boolean
  GENERATED ALWAYS AS (pin IS NOT NULL AND pin <> '0000') STORED;


-- ── PASO 6) El PIN no se lee desde el navegador ───────────────────────────
-- Se vuelve a otorgar la lista de columnas del 073 (los permisos se SUMAN,
-- asi que hay que nombrar la nueva `pin_cambiado`), y `pin` queda fuera.
-- `password` tampoco vuelve: el paso 7 del 073 ya lo saco y asi se queda.
GRANT SELECT (id, usuario, nombre, rol, activo, acceso_modulo_reporte, pin_cambiado)
  ON public.usuarios TO anon, authenticated;


-- ── PASO 7) Y por si acaso, quitarlo explicitamente ───────────────────────
-- `pin` nunca se otorgo, pero esto lo deja escrito: si alguien mañana corre
-- un GRANT de tabla entera sin pensar, este REVOKE es el recordatorio de que
-- esa columna no va.
REVOKE SELECT (pin) ON public.usuarios FROM anon, authenticated;


-- ── PASO 8) Verificar el PIN, ahora sin cifrado ───────────────────────────
-- Misma firma y misma respuesta que en el 073: la app no cambia. Lo unico
-- distinto es que compara texto contra texto, asi que ya no necesita
-- `pgcrypto` ni el `extensions` en el search_path.
CREATE OR REPLACE FUNCTION public.verificar_pin(
  p_user_id bigint,
  p_pin     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pin    text;
  v_fallos int;
  v_ok     boolean;
BEGIN
  SELECT pin, pin_fallos INTO v_pin, v_fallos
    FROM usuarios WHERE id = p_user_id AND activo = true;

  -- Usuario inexistente o inactivo: se responde lo mismo que a un PIN malo.
  IF v_pin IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'bloqueado', false);
  END IF;

  IF v_fallos >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'bloqueado', true);
  END IF;

  v_ok := (v_pin = COALESCE(p_pin, ''));

  UPDATE usuarios
     SET pin_fallos = CASE WHEN v_ok THEN 0 ELSE pin_fallos + 1 END
   WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'ok', v_ok,
    'bloqueado', false,
    'restantes', GREATEST(0, 10 - CASE WHEN v_ok THEN 0 ELSE v_fallos + 1 END));
END;
$$;


-- ── PASO 9) Cambiar el propio PIN, sin cifrado ────────────────────────────
-- Sigue exigiendo el PIN actual: es lo que impide que quien levanta un
-- celular desbloqueado le ponga otro y se quede con la sesion.
CREATE OR REPLACE FUNCTION public.cambiar_pin(
  p_user_id    bigint,
  p_pin_actual text,
  p_pin_nuevo  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pin text;
BEGIN
  IF p_pin_nuevo IS NULL OR p_pin_nuevo !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El PIN tiene que ser de 4 digitos');
  END IF;

  SELECT pin INTO v_pin FROM usuarios WHERE id = p_user_id AND activo = true;
  IF v_pin IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Usuario no encontrado');
  END IF;

  IF v_pin <> COALESCE(p_pin_actual, '') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El PIN actual no coincide');
  END IF;

  -- `pin_cambiado` ya no se toca: la calcula la base sola (paso 5).
  UPDATE usuarios
     SET pin = p_pin_nuevo, pin_fallos = 0
   WHERE id = p_user_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;


-- ── PASO 10) Ver los PIN, demostrando quien eres ──────────────────────────
-- No alcanza con decir "soy secretaria": la app manda usuario y contraseña,
-- y esta funcion los comprueba contra la tabla. Es la unica autorizacion
-- real posible mientras no haya sesion de servidor — el rol que viaje en el
-- telefono se puede escribir a mano, una contraseña no.
CREATE OR REPLACE FUNCTION public.ver_pines(
  p_usuario  text,
  p_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rol text;
BEGIN
  SELECT lower(rol) INTO v_rol
    FROM usuarios
   WHERE usuario = p_usuario AND password = p_password AND activo = true;

  IF v_rol IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Usuario o contraseña incorrectos');
  END IF;

  IF v_rol NOT IN ('admin', 'administrador', 'secretaria', 'secretario') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Tu rol no puede ver los PIN');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'pines', COALESCE(
      (SELECT jsonb_object_agg(u.id::text, u.pin) FROM usuarios u WHERE u.pin IS NOT NULL),
      '{}'::jsonb));
END;
$$;


-- ── PASO 11) Ejecucion para la app ────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.ver_pines(text, text) TO anon, authenticated;


-- ── PASO 12) El hash viejo ya no hace falta ───────────────────────────────
-- Se borra para que no queden DOS fuentes de verdad sobre el mismo PIN. Una
-- de las dos se desactualizaria tarde o temprano, y nadie sabria cual manda.
ALTER TABLE public.usuarios DROP COLUMN IF EXISTS pin_hash;


-- ── PASO 13) Que el PIN NO se lea desde el navegador ──────────────────────
-- Tiene que FALLAR con "permission denied for column pin". Si devuelve
-- filas, el paso 7 no quedo.
SELECT id, pin FROM public.usuarios LIMIT 1;


-- ── PASO 14) Que todos tengan PIN ─────────────────────────────────────────
-- `sin_pin` debe dar 0 y `con_0000` deberia ser el total.
SELECT COUNT(*)                                 AS total,
       COUNT(*) FILTER (WHERE pin IS NULL)      AS sin_pin,
       COUNT(*) FILTER (WHERE NOT pin_cambiado) AS con_0000,
       COUNT(*) FILTER (WHERE pin_fallos > 0)   AS con_fallos
  FROM public.usuarios;


-- ── PASO 15) Que la verificacion siga funcionando ─────────────────────────
-- El 0000 debe dar ok=true y el 1234 false; el tercero limpia la cuenta.
SELECT u.usuario,
       public.verificar_pin(u.id, '0000') AS con_el_correcto,
       public.verificar_pin(u.id, '1234') AS con_uno_malo,
       public.verificar_pin(u.id, '0000') AS y_se_limpia
  FROM public.usuarios u
 WHERE u.activo = true
 ORDER BY u.id
 LIMIT 1;


-- ── PASO 16) Que ver_pines exija de verdad ────────────────────────────────
-- La primera fila debe decir "Usuario o contraseña incorrectos". Si devuelve
-- los PIN con una contraseña inventada, la autorizacion no quedo.
SELECT public.ver_pines('admin', 'esta-no-es-la-contraseña') AS con_clave_falsa;
