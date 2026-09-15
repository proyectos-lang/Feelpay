-- ============================================================================
-- 116 - Un gerente tiene administradores
-- ============================================================================
-- LO QUE SE PIDIO
-- "En usuarios vamos a crear el concepto de gerente: un gerente va a tener
--  asignados administradores. Y otro reporte llamado Reporte Gerencial, donde
--  en vez de pais va un administrador, y las columnas de porcentaje significan
--  cuantas unidades cerraron el dia (o el rango) con ese porcentaje de
--  recaudo."
--
-- EL ROL YA EXISTE. Hay un usuario con rol 'gerencia' (Gerencia OPAD) y dos
-- con rol 'admin' (Eliecer, Juan) — comprobado contra produccion. Lo que NO
-- existe es la relacion entre ellos: nada dice que administradores tiene a
-- cargo un gerente.
--
-- LO QUE SE AGREGA
--   `gerente_admins (gerente_id, admin_id)` — una fila por cada
--   administrador que un gerente tiene a cargo.
--
-- POR QUE UNA TABLA Y NO UNA COLUMNA EN `usuarios`
-- -------------------------------------------------
-- Con una columna `usuarios.gerente_id`, un administrador podria pertenecer a
-- UN solo gerente. La tabla deja que, si manana hay un gerente de zona y uno
-- de pais, los dos vean al mismo administrador sin pelearse la columna. Es la
-- misma forma de `usuario_rutas`, que ya resuelve lo mismo entre cobradores y
-- rutas.
--
-- DE DONDE SALE EL ADMINISTRADOR DE CADA RUTA
-- --------------------------------------------
-- De `usuario_rutas`, la tabla de Asignaciones que ya existe: el
-- administrador de una ruta es el usuario con rol 'admin' o 'administrador'
-- que la tenga asignada. No hace falta columna nueva ni migrar nada, y se
-- administra desde la pantalla que ya se usa.
--
-- OJO: `rutas.idadmin` NO sirve para esto. Se reviso: esta en NULL en 5 de
-- las 12 rutas y en las otras 7 apunta al id 1, que es un VENDEDOR (Carlos),
-- no un administrador. Es una columna vieja que quedo a medio llenar.
--
-- QUE NO CAMBIA
--   * `usuarios` no se toca: el rol 'gerencia' ya existia.
--   * `usuario_rutas` no se toca.
--   * Nada de plata, ningun saldo, ninguna vista.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 5 no escriben nada.
-- ============================================================================


-- ── PASO 1) Quien es quien hoy (SOLO LECTURA) ────────────────────────────
-- Los gerentes y los administradores que hay, y cuantas rutas tiene asignada
-- cada administrador. Eso ultimo es lo que va a agrupar el reporte.
SELECT u.id,
       u.nombre,
       u.rol,
       u.activo,
       (SELECT COUNT(*) FROM public.usuario_rutas ur WHERE ur.usuario_id = u.id)
         AS rutas_asignadas
  FROM public.usuarios u
 WHERE lower(u.rol) IN ('gerencia', 'gerente', 'admin', 'administrador')
 ORDER BY u.rol, u.nombre;


-- ── PASO 2) La tabla ─────────────────────────────────────────────────────
-- La llave primaria es la pareja: un administrador no puede estar dos veces
-- bajo el mismo gerente, pero si bajo dos gerentes distintos.
--
-- `ON DELETE CASCADE` en los dos lados: si se borra un usuario, sus filas de
-- aca se van con el. Sin eso quedarian apuntando a un id que ya no existe.
CREATE TABLE IF NOT EXISTS public.gerente_admins (
  gerente_id BIGINT NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  admin_id   BIGINT NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gerente_id, admin_id)
);


-- ── PASO 3) Un indice para buscar al reves ───────────────────────────────
-- La llave primaria ya resuelve "que administradores tiene este gerente".
-- Este indice resuelve la pregunta contraria —"de que gerentes depende este
-- administrador"— sin recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS idx_gerente_admins_admin
  ON public.gerente_admins (admin_id);


-- ── PASO 4) Permisos ─────────────────────────────────────────────────────
-- La app lee y escribe con la llave anon, igual que con `usuario_rutas`. No
-- hay RLS en esta base: el filtrado es a nivel aplicacion.
GRANT SELECT, INSERT, DELETE ON public.gerente_admins TO anon, authenticated;


-- ── PASO 5) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- La tabla tiene que existir y estar VACIA: las asignaciones se hacen desde
-- la pestaña "Gerentes" de Usuarios y Rutas, no a mano.
SELECT COUNT(*) AS asignaciones_gerente_admin
  FROM public.gerente_admins;


-- ── PASO 6) Como asignar a mano, si hiciera falta (NO SE CORRE SOLO) ─────
-- Queda de referencia. Lo normal es hacerlo desde la app.
--
--   INSERT INTO public.gerente_admins (gerente_id, admin_id)
--   VALUES (13, 3), (13, 31)      -- Gerencia OPAD -> Eliecer y Juan
--   ON CONFLICT DO NOTHING;
--
-- Y para quitar uno:
--
--   DELETE FROM public.gerente_admins
--    WHERE gerente_id = 13 AND admin_id = 31;
