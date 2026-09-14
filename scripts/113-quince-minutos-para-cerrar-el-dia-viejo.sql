-- ============================================================================
-- 113 - Quince minutos para cerrar el dia viejo
-- ============================================================================
-- LO QUE SE PIDIO
-- "Una regla configurable para cada ruta: que cuando se descongele una ruta,
--  si lo tiene habilitado tenga solo 15 minutos para procesar y cerrar; y
--  cuando este deshabilitado tenga cualquier tiempo para terminar."
--
-- COMO FUNCIONA HOY EL DESCONGELAMIENTO
-- --------------------------------------
-- Una ruta amanece CONGELADA si dejo un dia sin cerrar. Secretaria la
-- desbloquea y eso escribe `rutas_diarias.desbloqueada_at` (script 096). A
-- partir de ahi el cobrador ve el dia viejo y hace SU cierre.
--
-- Hoy ese permiso no caduca: una vez desbloqueada, la ruta se queda asi para
-- siempre. Esta es la regla que le pone reloj.
--
-- LO QUE SE AGREGA
--   `ruta_config_umbrales.cierre_atrasado_minutos`
--
--     NULL o 0  ->  SIN LIMITE. Es el comportamiento de hoy y el que queda
--                   por defecto en todas las rutas: nadie cambia de conducta
--                   por correr este script.
--     15        ->  quince minutos desde `desbloqueada_at`. Al vencerse, la
--                   ruta VUELVE A CONGELARSE y secretaria tiene que
--                   desbloquearla otra vez.
--
-- Se guarda el NUMERO DE MINUTOS y no un booleano `limite_habilitado` a
-- proposito: con un booleano, cambiar los 15 minutos a 20 obligaria a otro
-- script. Asi el dueño lo mueve desde la configuracion de la ruta.
--
-- POR QUE EL DEFECTO ES "SIN LIMITE"
-- -----------------------------------
-- Porque es lo que rige hoy. Una columna nueva con 15 por defecto le pondria
-- reloj a las 8 rutas de golpe sin que nadie lo hubiera decidido, y un
-- cobrador a media cuadra se quedaria bloqueado sin entender por que. La
-- regla se enciende ruta por ruta.
--
-- LO QUE **NO** HACE ESTE SCRIPT
--   * NO congela nada al correrlo: solo agrega la columna, en NULL.
--   * NO toca `rutas_diarias` ni ninguna jornada existente.
--   * NO borra ni reversa lo que el cobrador alcanzo a registrar. Si se le
--     vence el tiempo, lo que ya quedo escrito SE QUEDA: la plata registrada
--     es plata registrada. Lo unico que pasa es que no puede seguir hasta que
--     lo vuelvan a habilitar.
--
-- QUIEN HACE CUMPLIR EL LIMITE
-- -----------------------------
-- La app (`lib/jornada-pendiente.ts`): al leer la jornada pendiente compara
-- `desbloqueada_at + minutos` contra la hora actual, y si ya paso la trata
-- como congelada. El servidor ya tiene su propia red: `registrar_gestion`
-- (script 101) solo deja pasar una gestion vieja sin revision si la jornada
-- esta `abierta` y `desbloqueada_at IS NOT NULL` — al vencerse el tiempo, la
-- app deja de dejar registrar, y si algo se colara igual quedaria firmado
-- con su hora en el libro, que es donde se puede auditar.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 4 no escriben nada.
-- ============================================================================


-- ── PASO 1) Como esta la configuracion hoy (SOLO LECTURA) ────────────────
SELECT ruta_id,
       geocerca_habilitada,
       multiples_prestamos,
       cedula_obligatoria
  FROM public.ruta_config_umbrales
 ORDER BY ruta_id;


-- ── PASO 2) La columna nueva ─────────────────────────────────────────────
-- NULL = sin limite. Es idempotente: correrlo dos veces no hace nada.
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS cierre_atrasado_minutos INTEGER;


-- ── PASO 3) Que no se pueda guardar un disparate ─────────────────────────
-- Un numero negativo dejaria la ruta vencida desde el segundo cero, y uno
-- gigante seria lo mismo que no tener limite pero disfrazado. Se acota a un
-- dia: mas alla de eso, la respuesta correcta es NULL.
ALTER TABLE public.ruta_config_umbrales
  DROP CONSTRAINT IF EXISTS ruta_config_umbrales_cierre_atrasado_minutos_check;

ALTER TABLE public.ruta_config_umbrales
  ADD CONSTRAINT ruta_config_umbrales_cierre_atrasado_minutos_check
  CHECK (cierre_atrasado_minutos IS NULL
         OR (cierre_atrasado_minutos >= 0 AND cierre_atrasado_minutos <= 1440));


-- ── PASO 4) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- `cierre_atrasado_minutos` tiene que existir y estar en NULL en TODAS las
-- rutas: nadie cambia de conducta por correr este script.
SELECT ruta_id,
       cierre_atrasado_minutos,
       CASE
         WHEN COALESCE(cierre_atrasado_minutos, 0) = 0 THEN 'sin limite (como hoy)'
         ELSE cierre_atrasado_minutos || ' minutos'
       END AS regla
  FROM public.ruta_config_umbrales
 ORDER BY ruta_id;


-- ── PASO 5) Como encender la regla en una ruta (NO SE CORRE SOLO) ────────
-- Esto queda aca como referencia. El dueño lo hace desde la configuracion de
-- la ruta en la app, no a mano; pero si hace falta encenderlo desde el
-- editor, es esto — cambiando el 151 por la ruta que sea.
--
--   UPDATE public.ruta_config_umbrales
--      SET cierre_atrasado_minutos = 15
--    WHERE ruta_id = 151;
--
-- Y para apagarlo:
--
--   UPDATE public.ruta_config_umbrales
--      SET cierre_atrasado_minutos = NULL
--    WHERE ruta_id = 151;
