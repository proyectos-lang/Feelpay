-- ============================================================================
-- 121 - El Resumen Semanal, habilitable por ruta
-- ============================================================================
-- LO QUE SE PIDIO
-- "Vamos a agregar una nueva configuracion a las rutas en donde puedan tener
--  un check para habilitarles si o no el 'Resumen semanal' y en las que se
--  les habilite entonces en su modulo de resumen en la parte de abajo les
--  aparecera este cuadro informativo que llevara el resumen de la semana
--  comenzando desde lunes."
--
-- DONDE VA
-- Una columna en `ruta_config_umbrales`, al lado de la geocerca, la cedula y
-- la moto: es donde ya vive todo lo que se configura de una unidad.
--
-- POR QUE NACE EN FALSE
-- Se pidio "habilitarles si o no": es una opcion que se ENCIENDE ruta por
-- ruta. Con DEFAULT false ninguna unidad ve el cuadro hasta que alguien lo
-- prenda en Gestion de Usuarios y Rutas. Nada cambia al correr el script.
--
-- DE DONDE SALEN LOS NUMEROS (no hay nada que calcular aca)
-- El cuadro suma, en la app, las filas de `resumen_diario_v2` de la ruta
-- desde el LUNES de la semana hasta el dia del resumen. Es la misma fuente
-- del Resumen del Dia, asi que la semana es exactamente la suma de sus dias.
--
-- QUE NO CAMBIA
--   * Ningun monto, ningun saldo, ninguna vista, ninguna funcion.
--   * Ninguna ruta ve el cuadro hasta que se le encienda.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 3 no escriben nada.
-- ============================================================================


-- ── PASO 1) Como esta la tabla hoy (SOLO LECTURA) ────────────────────────
-- Para ver que la columna todavia no esta.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'ruta_config_umbrales'
 ORDER BY ordinal_position;


-- ── PASO 2) La columna ───────────────────────────────────────────────────
-- NOT NULL con default: una ruta tiene el cuadro o no lo tiene, no hay un
-- tercer estado "no se sabe".
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS resumen_semanal BOOLEAN NOT NULL DEFAULT false;


-- ── PASO 3) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- Debe salir la columna y TODAS las rutas en false.
SELECT ruta_id, resumen_semanal
  FROM public.ruta_config_umbrales
 ORDER BY ruta_id;
