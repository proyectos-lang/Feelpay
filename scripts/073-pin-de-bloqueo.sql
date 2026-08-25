-- ============================================================================
-- 073 - PIN de bloqueo
-- ============================================================================
-- LO QUE SE PIDIO
-- "Que cada persona ademas de su usuario y contraseña tenga un pin. Por
--  defecto 0000. Si minimiza o cierra el sistema, para volver a entrar debe
--  poner su pin de 4 digitos. Asi si alguien toma su celular no puede ver
--  toda la informacion, y de paso no tiene que escribir usuario y contraseña
--  completos cada vez."
--
-- POR QUE EL PIN NO PUEDE SER UNA COLUMNA MAS
-- ---------------------------------------------
-- La llave publica de la app HOY puede leer la tabla `usuarios` entera. Se
-- comprobo contra produccion: 18 usuarios, con sus contraseñas en texto
-- plano. Esa llave viaja en el bundle del navegador, asi que cualquiera que
-- abra el sitio puede sacarla.
--
-- Si el PIN se guardara igual, se leeria igual, y el candado seria un dibujo
-- de un candado. Por eso:
--
--   · se guarda CIFRADO (bcrypt, via pgcrypto),
--   · se le QUITA a la llave publica el permiso de leer esa columna,
--   · se verifica en el SERVIDOR, con una funcion que solo responde si/no.
--
-- El telefono nunca ve el PIN de nadie, ni siquiera el propio.
--
-- OJO — LO QUE ESTE SCRIPT NO ARREGLA
-- Las contraseñas SIGUEN GUARDADAS EN TEXTO PLANO. Ese es el hueco grande: un
-- PIN protege contra alguien que levanta un celular desbloqueado; una
-- contraseña sin cifrar deja entrar a cualquiera que llegue a la base por
-- otro lado. Cambiar como se guardan hay que probarlo con calma — si sale
-- mal, nadie entra — asi que quedo para su propia tanda.
--
-- Lo que si se puede cortar ya, y es la mitad del problema, es que se puedan
-- DESCARGAR desde el navegador: eso es el paso 7, y esta marcado OPCIONAL
-- porque no es lo que se pidio.
--
-- CONTRA LA FUERZA BRUTA
-- Un PIN de 4 digitos son 10.000 combinaciones: un script las prueba todas en
-- minutos. `verificar_pin` lleva la cuenta de los fallos y despues de 10
-- deja de responder que si, aunque el PIN sea correcto, hasta que la persona
-- entre con usuario y contraseña. Sin eso, el PIN seria mas debil que la
-- contraseña que reemplaza.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Quien hay hoy (solo lectura) ──────────────────────────────────
-- Deja constancia de cuantos usuarios van a recibir el PIN por defecto.
SELECT COUNT(*) FILTER (WHERE activo)     AS usuarios_activos,
       COUNT(*) FILTER (WHERE NOT activo) AS inactivos,
       COUNT(*)                           AS total
  FROM public.usuarios;


-- ── PASO 2) El cifrador ───────────────────────────────────────────────────
-- `pgcrypto` trae `crypt()` y `gen_salt()`. En Supabase suele venir ya
-- instalada; el IF NOT EXISTS lo deja idempotente.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── PASO 3) Las columnas del PIN ──────────────────────────────────────────
-- `pin_hash`      el PIN cifrado. NUNCA se lee desde la app.
-- `pin_cambiado`  si la persona ya lo cambio. Esta SI se lee: sirve para
--                 avisarle en pantalla que todavia tiene el 0000.
-- `pin_fallos`    intentos seguidos errados, para frenar la fuerza bruta.
ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS pin_hash     text,
  ADD COLUMN IF NOT EXISTS pin_cambiado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_fallos   int     NOT NULL DEFAULT 0;


-- ── PASO 4) Sembrar el 0000 a quien no tenga ──────────────────────────────
-- `gen_salt('bf')` = bcrypt: dos personas con el mismo 0000 quedan con
-- hashes distintos, asi que ni comparandolos entre si se aprende nada.
UPDATE public.usuarios
   SET pin_hash = crypt('0000', gen_salt('bf'))
 WHERE pin_hash IS NULL;


-- ── PASO 5) Quitarle a la llave publica el permiso sobre la tabla ─────────
-- OJO: un REVOKE POR COLUMNA no sirve de nada si el rol ya tiene SELECT
-- sobre la tabla entera — PostgreSQL lo acepta y no cambia nada. Hay que
-- quitar el permiso de tabla y volver a darlo columna por columna. Este paso
-- lo quita; el 6 lo devuelve. ENTRE UNO Y OTRO LA APP NO PUEDE LEER
-- `usuarios`: corrélos seguidos.
REVOKE SELECT ON public.usuarios FROM anon, authenticated;


-- ── PASO 6) Devolverlo, columna por columna ───────────────────────────────
-- Estas son TODAS las columnas de la tabla menos `pin_hash`. Se verificó una
-- por una contra lo que la app consulta hoy: id, usuario, nombre, rol,
-- activo y acceso_modulo_reporte se usan; `password` no lo lee nadie (el
-- login pasa por `login_usuario`, que es SECURITY DEFINER y no depende de
-- estos permisos).
--
-- `password` se mantiene en la lista A PROPOSITO, para no cambiar nada que no
-- se haya pedido. El paso 7 lo saca, y es OPCIONAL.
GRANT SELECT (id, usuario, password, nombre, rol, activo, acceso_modulo_reporte, pin_cambiado)
  ON public.usuarios TO anon, authenticated;


-- ── PASO 7) OPCIONAL — dejar de exponer las contraseñas ───────────────────
-- Hoy cualquiera que abra el sitio puede sacar la llave publica del bundle y
-- descargarse los 18 usuarios con su contraseña en texto plano. Este paso lo
-- corta: es la MISMA linea de arriba sin `password`.
--
-- Es de bajo riesgo — se revisó que ninguna pantalla lea esa columna y el
-- login no depende de ella — pero queda aparte porque no es lo que se pidió.
-- NO reemplaza guardar las contraseñas cifradas: eso sigue pendiente, y es
-- lo que protege si algun dia alguien llega a la base por otro lado.
--
-- Si lo corres, la comprobacion es entrar a la app con usuario y contraseña:
-- tiene que seguir funcionando igual.
--
-- Va como REVOKE y no repitiendo el GRANT sin `password`: los permisos se
-- SUMAN, asi que volver a otorgar una lista mas corta no le quita nada a lo
-- ya otorgado. Y este REVOKE por columna SI funciona, porque despues del
-- paso 5 ya no hay permiso de tabla que lo tape.
REVOKE SELECT (password) ON public.usuarios FROM anon, authenticated;


-- ── PASO 8) Verificar el PIN ──────────────────────────────────────────────
-- Responde `true` o `false` y nada mas. No devuelve el hash, ni dice si el
-- usuario existe, ni cuanto le falta: quien pregunta se entera de una sola
-- cosa por intento, que es justamente el punto.
CREATE OR REPLACE FUNCTION public.verificar_pin(
  p_user_id bigint,
  p_pin     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
-- `extensions` VA EN LA LISTA, y no es opcional: en Supabase `pgcrypto` se
-- instala en ese esquema, no en `public`. Sin el, `crypt()` existe pero esta
-- funcion no la ve y revienta con "function crypt(text, text) does not
-- exist" — aunque el mismo `crypt()` funcione perfecto en el editor, que si
-- tiene `extensions` en su ruta de busqueda.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_hash   text;
  v_fallos int;
  v_ok     boolean;
BEGIN
  SELECT pin_hash, pin_fallos INTO v_hash, v_fallos
    FROM usuarios WHERE id = p_user_id AND activo = true;

  -- Usuario inexistente o inactivo: se responde lo mismo que a un PIN malo.
  -- Distinguirlos le regalaria a quien prueba una lista de usuarios validos.
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'bloqueado', false);
  END IF;

  -- YA SE PASO DE INTENTOS. Ni se compara: aunque acierte, no entra. La
  -- salida es entrar con usuario y contraseña, que es lo que reinicia la
  -- cuenta (paso 9).
  IF v_fallos >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'bloqueado', true);
  END IF;

  v_ok := (v_hash = crypt(COALESCE(p_pin, ''), v_hash));

  UPDATE usuarios
     SET pin_fallos = CASE WHEN v_ok THEN 0 ELSE pin_fallos + 1 END
   WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'ok', v_ok,
    'bloqueado', false,
    -- Cuantos le quedan, para poder avisarle antes de dejarlo afuera.
    'restantes', GREATEST(0, 10 - CASE WHEN v_ok THEN 0 ELSE v_fallos + 1 END));
END;
$$;


-- ── PASO 9) El login limpia la cuenta de fallos ───────────────────────────
-- Entrar con usuario y contraseña es la salida cuando alguien olvida el PIN
-- o se paso de intentos. Se re-emite `login_usuario` con esa sola linea de
-- mas; lo demas es identico a como estaba.
CREATE OR REPLACE FUNCTION public.login_usuario(p_usuario text, p_password text)
RETURNS TABLE(id bigint, nombre text, rol text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
begin
  -- Quien demuestra saber su contraseña recupera el PIN: se le perdonan los
  -- intentos fallidos. Sin esto, pasarse de intentos dejaria a la persona
  -- fuera para siempre y habria que arreglarlo a mano en la base.
  update public.usuarios u
     set pin_fallos = 0
   where u.usuario = p_usuario and u.password = p_password and u.activo = true;

  return query
  select u.id, u.nombre, u.rol
  from public.usuarios u
  where u.usuario = p_usuario and u.password = p_password and u.activo = true;
end;
$function$;


-- ── PASO 10) Cambiar el PIN ────────────────────────────────────────────────
-- Exige el PIN actual: si no, bastaria con levantar un celular desbloqueado
-- para ponerle otro y quedarse con la sesion.
CREATE OR REPLACE FUNCTION public.cambiar_pin(
  p_user_id   bigint,
  p_pin_actual text,
  p_pin_nuevo  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
-- `extensions` VA EN LA LISTA, y no es opcional: en Supabase `pgcrypto` se
-- instala en ese esquema, no en `public`. Sin el, `crypt()` existe pero esta
-- funcion no la ve y revienta con "function crypt(text, text) does not
-- exist" — aunque el mismo `crypt()` funcione perfecto en el editor, que si
-- tiene `extensions` en su ruta de busqueda.
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_hash text;
BEGIN
  IF p_pin_nuevo IS NULL OR p_pin_nuevo !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El PIN tiene que ser de 4 digitos');
  END IF;

  SELECT pin_hash INTO v_hash FROM usuarios WHERE id = p_user_id AND activo = true;
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Usuario no encontrado');
  END IF;

  IF v_hash <> crypt(COALESCE(p_pin_actual, ''), v_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'El PIN actual no coincide');
  END IF;

  UPDATE usuarios
     SET pin_hash     = crypt(p_pin_nuevo, gen_salt('bf')),
         -- Solo cuenta como cambiado si de verdad dejo de ser 0000. Poner
         -- 0000 otra vez no deberia apagar el aviso de la pantalla.
         pin_cambiado = (p_pin_nuevo <> '0000'),
         pin_fallos   = 0
   WHERE id = p_user_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;


-- ── PASO 11) Ejecucion para la app ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.verificar_pin(bigint, text) TO anon, authenticated;


-- ── PASO 12) Y la de cambiarlo ────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.cambiar_pin(bigint, text, text) TO anon, authenticated;


-- ── PASO 13) Que el PIN NO se pueda leer ──────────────────────────────────
-- LA PRUEBA QUE IMPORTA. Esto tiene que FALLAR con "permission denied for
-- column pin_hash". Si devuelve filas, el paso 5 no quedo y el PIN esta a la
-- vista igual que las contraseñas.
--
-- Corre esto tal cual desde el editor y mira el error; despues confirmalo
-- desde la app, que es quien usa la llave publica de verdad.
SELECT id, pin_hash FROM public.usuarios LIMIT 1;


-- ── PASO 14) Que todos tengan PIN ─────────────────────────────────────────
-- `sin_pin` debe dar 0. `con_0000` deberia ser el total: nadie lo ha
-- cambiado todavia.
SELECT COUNT(*)                                    AS total,
       COUNT(*) FILTER (WHERE pin_hash IS NULL)     AS sin_pin,
       COUNT(*) FILTER (WHERE NOT pin_cambiado)     AS con_0000,
       COUNT(*) FILTER (WHERE pin_fallos > 0)       AS con_fallos
  FROM public.usuarios;


-- ── PASO 15) Que la verificacion funcione ─────────────────────────────────
-- Con el primer usuario activo: el 0000 debe dar ok=true y el 1234 false.
-- El segundo deja un fallo contado, y el tercero lo limpia — asi se ve que
-- la cuenta sube y baja como debe.
SELECT u.usuario,
       public.verificar_pin(u.id, '0000') AS con_el_correcto,
       public.verificar_pin(u.id, '1234') AS con_uno_malo,
       public.verificar_pin(u.id, '0000') AS y_se_limpia
  FROM public.usuarios u
 WHERE u.activo = true
 ORDER BY u.id
 LIMIT 1;


-- ── PASO 16) Donde vive pgcrypto (diagnostico) ────────────────────────────
-- Si el paso 15 falla con "function crypt(text, text) does not exist", la
-- causa es esta: `crypt()` esta en un esquema que la funcion no tiene en su
-- ruta de busqueda. En Supabase suele ser `extensions`, y por eso los pasos
-- 8 y 10 lo declaran.
--
-- Esta consulta dice en que esquema quedo de verdad. Si sale algo distinto
-- de `public` o `extensions`, agrega ese esquema al `SET search_path` de las
-- dos funciones y vuelve a correr los pasos 8 y 10.
SELECT n.nspname AS esquema_de_pgcrypto,
       CASE WHEN n.nspname IN ('public', 'extensions')
            THEN 'ok — ya esta en el search_path de las funciones'
            ELSE '*** agregalo al SET search_path de los pasos 8 y 10 ***'
       END AS que_hacer
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname = 'pgcrypto';
