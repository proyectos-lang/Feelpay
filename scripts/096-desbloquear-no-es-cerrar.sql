-- ============================================================================
-- 096 - Desbloquear no es cerrar
-- ============================================================================
-- LO QUE SE PIDIÓ
-- "Al desbloquear la unidad desde el módulo de la secretaria, la idea es que
--  al cobrador le salga la unidad pero con el día aún anterior y él mismo
--  proceda hacer el cierre y ahí sí se active la unidad para trabajar el día
--  en curso."
--
-- QUÉ HACÍA HASTA AHORA
-- "Descongelar" CERRABA la jornada vieja sin cuadrarla: `estado = 'cerrada'`,
-- `hora_fin` en NULL y `cerrada_sin_cuadre = true`. La ruta quedaba libre, sí,
-- pero ese día se perdía para siempre — nunca iba a tener cierre, y la plata
-- de esa jornada no la cuadró nadie.
--
-- Y estaba al revés de quién sabe: la secretaría desbloquea desde su
-- escritorio, y el que tiene la plata contada en la mano es el cobrador.
--
-- LO QUE HACE AHORA
-- Desbloquear ABRE LA PUERTA, no cierra el día. Se marca la jornada como
-- habilitada, sigue `abierta`, y el cobrador ve la pantalla del día anterior
-- con el botón para hacer SU cierre. Al cerrarlo —con sus números, no sin
-- cuadre— la ruta queda lista para hoy.
--
-- Son dos cosas distintas y ahora se pueden distinguir:
--
--   desbloqueada_at IS NULL   → congelada, el cobrador no puede hacer nada
--   desbloqueada_at con fecha → habilitada, el cobrador cierra ese día
--   estado = 'cerrada'        → resuelta
--
-- LA SALIDA DE EMERGENCIA SIGUE
-- Cerrar sin cuadre no se quita: hace falta para una ruta con quince días
-- viejos encima, o para un día del que ya nadie se acuerda. Queda de segunda,
-- en el botón "Sin cuadre" del aviso, y sigue dejando `cerrada_sin_cuadre` en
-- true para que se sepa cuál día quedó sin cuadrar.
--
-- NO MUEVE UN PESO. Agrega dos columnas vacías. Ninguna jornada cambia de
-- estado, ninguna gestión se toca.
--
-- MIENTRAS ESTE SCRIPT NO CORRA, la app sigue con el comportamiento viejo: si
-- las columnas no existen, PostgREST responde 42703 y `habilitarCierreAtrasado`
-- se cae al "cerrar sin cuadre" de siempre. Nadie queda sin poder desbloquear
-- una ruta por un script pendiente.
--
-- Corre los pasos DE A UNO.
-- ============================================================================


-- ── PASO 1) Qué hay hoy (SOLO LECTURA) ────────────────────────────────────
-- Las columnas actuales de `rutas_diarias`. `desbloqueada_at` NO tiene que
-- estar todavía.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'rutas_diarias'
 ORDER BY ordinal_position;


-- ── PASO 2) Las jornadas congeladas de ahora mismo (SOLO LECTURA) ─────────
-- Guardá este resultado: son las que quedan habilitadas o no según lo que la
-- secretaría haga después. Al 02/09/2026 eran tres, todas del 01/09: la 151,
-- la 190 y la 196.
SELECT id, ruta_id, fecha, estado, cerrada_sin_cuadre
  FROM public.rutas_diarias
 WHERE estado = 'abierta'
   AND fecha < (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY fecha, ruta_id;


-- ── PASO 3) Las dos columnas ──────────────────────────────────────────────
-- `IF NOT EXISTS` en las dos: correr esto de nuevo no hace nada.
ALTER TABLE public.rutas_diarias
  ADD COLUMN IF NOT EXISTS desbloqueada_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS desbloqueada_por_nombre TEXT;


-- ── PASO 4) Que quedaron (SOLO LECTURA) ───────────────────────────────────
-- Tienen que salir las dos, las dos NULL en todas las filas.
SELECT COUNT(*)                                          AS jornadas,
       COUNT(desbloqueada_at)                            AS con_desbloqueo,
       COUNT(desbloqueada_por_nombre)                    AS con_nombre
  FROM public.rutas_diarias;


-- ── PASO 5) Que ninguna jornada se movió (SOLO LECTURA) ───────────────────
-- El mismo conteo de siempre. Agregar columnas no toca una sola fila; esto es
-- para poder decirlo con el número delante.
SELECT estado, COUNT(*) AS jornadas
  FROM public.rutas_diarias
 GROUP BY estado
 ORDER BY jornadas DESC;


-- ── PASO 6) La prueba de fuego, ya en la app ──────────────────────────────
-- Desde el Monitoreo de Rutas, tocá "Habilitar cierre" en una ruta congelada y
-- corré esto. La jornada tiene que seguir ABIERTA y con fecha en
-- `desbloqueada_at` — si saliera 'cerrada', el desbloqueo siguió cerrando el
-- día y el script no está en vigor todavía.
--
-- Después, con el cobrador cerrando esa caja desde su teléfono, la fila pasa a
-- 'cerrada' con `hora_fin` puesto y `cerrada_sin_cuadre = false`: ese día SÍ
-- tuvo cierre.
SELECT id, ruta_id, fecha, estado, hora_fin,
       cerrada_sin_cuadre, desbloqueada_at, desbloqueada_por_nombre, observacion
  FROM public.rutas_diarias
 WHERE fecha < (now() AT TIME ZONE 'America/Bogota')::date
   AND (estado = 'abierta' OR desbloqueada_at IS NOT NULL)
 ORDER BY fecha DESC, ruta_id;
