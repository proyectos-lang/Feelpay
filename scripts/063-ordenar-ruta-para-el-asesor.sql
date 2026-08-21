-- ============================================================================
-- 063 - "Ordenar Ruta" tambien para el asesor
-- ============================================================================
-- QUE SE PIDIO
-- Que el modulo "Ordenar Ruta" quede disponible para el asesor. Tiene sentido:
-- es QUIEN recorre la ruta, asi que es quien sabe en que orden le queda mejor.
--
-- POR QUE HACE FALTA UN SCRIPT Y NO ALCANZA CON EL CODIGO
-- El catalogo (`lib/modules-catalog.ts`) solo decide para los usuarios que NO
-- tienen permisos propios. Y resulta que los SIETE vendedores activos SI los
-- tienen, con una fila explicita para este modulo puesta en `false`:
--
--   1 Carlos (Ruta 1) · 24 UNID 933 · 25 UNID 190 · 26 UNID 154
--   27 UNID 196 · 29 UNID-151 · 30 UNID 197
--
-- Esa fila le gana al catalogo. Sin este UPDATE, el cambio de codigo no le
-- habilita el modulo a ninguno de ellos.
--
-- Los otros tres vendedores (2 Luis, 5 Ruta 112 JP, 18 Ruta 168) no tienen
-- filas propias: a ellos les alcanza con el catalogo.
--
-- QUE NO HACE
-- No lo mete en la barra inferior del movil. Son cinco lugares y ya estan
-- ocupados por lo que se usa todo el dia; este queda en el menu.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Ver el estado ANTES ───────────────────────────────────────────
-- Solo lectura. Deja constancia de como estaba, por si hay que volver atras.
SELECT up.user_id, u.nombre, u.rol, up.enabled, up.in_mobile_nav
  FROM public.user_permissions up
  JOIN public.usuarios u ON u.id = up.user_id
 WHERE up.view_id = 'configure-route'
 ORDER BY u.rol, up.user_id;


-- ── PASO 2) Habilitarlo para los asesores ─────────────────────────────────
-- Idempotente: correrlo dos veces no cambia nada la segunda.
-- NO se toca `in_mobile_nav` a proposito (ver el encabezado).
UPDATE public.user_permissions up
   SET enabled = true
  FROM public.usuarios u
 WHERE u.id = up.user_id
   AND up.view_id = 'configure-route'
   AND lower(COALESCE(u.rol, '')) IN ('vendedor', 'asesor');


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
-- Los de rol vendedor/asesor deben quedar todos en `true`. Los demas roles
-- se quedan como estaban — este script no los toca.
SELECT u.rol,
       COUNT(*)                                  AS usuarios,
       COUNT(*) FILTER (WHERE up.enabled)        AS con_acceso,
       COUNT(*) FILTER (WHERE NOT up.enabled)    AS sin_acceso
  FROM public.user_permissions up
  JOIN public.usuarios u ON u.id = up.user_id
 WHERE up.view_id = 'configure-route'
 GROUP BY u.rol
 ORDER BY u.rol;
