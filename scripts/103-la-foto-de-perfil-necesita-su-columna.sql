-- ============================================================================
-- 103 - La foto de perfil no se podia guardar: faltaba la columna
-- ============================================================================
-- LO QUE SE REPORTO
-- "En la foto de perfil de cada unidad, al subir da un error que dice
--  'Error no se pudo subir la foto'."
--
-- LO QUE PASABA DE VERDAD
-- ------------------------
-- La foto SI se subia. Probado contra el endpoint real, con una imagen de
-- verdad:
--
--   POST /api/upload-photo  ->  {"success":true,"url":"https://...blob...png"}
--
-- Lo que fallaba era el paso siguiente: guardar esa direccion en el usuario.
--
--   UPDATE usuarios SET foto_url = ...
--   -> PGRST204: Could not find the 'foto_url' column of 'usuarios'
--
-- La columna NO EXISTE. El script 022 la agregaba y nunca se corrio — esta
-- anotado en el encabezado del propio 000-tablas-preexistentes:
-- "foto_url (022) NO existe: ese script nunca se corrio".
--
-- El mensaje que veia el usuario decia "no se pudo subir la foto" porque el
-- `catch` de la pantalla es uno solo para los dos pasos. La foto ya estaba
-- arriba; lo que no habia era donde anotarla.
--
-- ESTE SCRIPT ES EL 022, CON SU VERIFICACION
-- -------------------------------------------
-- Se renumera porque el 022 quedo sin correr y el numero mas alto es el que
-- manda. Es `ADD COLUMN IF NOT EXISTS`, asi que correrlo dos veces no hace
-- dano.
--
-- NO HACE FALTA TOCAR NADA MAS: la app ya lee `usuarios.foto_url` en el
-- encabezado, el menu lateral, la pantalla de perfil y el bloqueo por PIN.
-- Todos usan `foto_url && ...`, asi que con la columna en NULL simplemente
-- muestran la inicial, que es lo que se ha estado viendo.
--
-- COMO CORRERLO: un paso a la vez. El PASO 1 no escribe nada.
-- ============================================================================


-- -- PASO 1) Que hay hoy (SOLO LECTURA, no cambia nada) ----------------------
-- Si devuelve 0 filas, la columna falta y por eso el error.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'usuarios'
   AND column_name  = 'foto_url';


-- -- PASO 2) La columna --------------------------------------------------------
ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS foto_url TEXT;


-- -- PASO 3) Verificacion (SOLO LECTURA) -------------------------------------
-- Ahora tiene que devolver UNA fila: foto_url / text.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'usuarios'
   AND column_name  = 'foto_url';


-- -- PASO 4) Cuantos usuarios tienen foto (SOLO LECTURA) ---------------------
-- Recien corrido esto da 0 con foto: las que se intentaron subir antes se
-- perdieron porque no habia donde guardarlas. Hay que volver a subirlas.
SELECT COUNT(*)                                   AS usuarios,
       COUNT(foto_url)                            AS con_foto,
       COUNT(*) FILTER (WHERE foto_url IS NULL)   AS sin_foto
  FROM public.usuarios;
