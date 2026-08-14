-- ============================================================================
-- Diagnóstico — `gastosregistros.adminid` apunta a la tabla equivocada
-- ============================================================================
-- SOLO LECTURA. No modifica nada.
--
-- SÍNTOMA
--   insert or update on table "gastosregistros" violates foreign key
--   constraint "gastosregistros_adminid_fkey"
--
-- QUÉ PASA
-- La columna `adminid` tiene una llave foránea hacia `admin`, pero la app
-- guarda ahí el id de la sesión, que sale de `usuarios`. Funciona de
-- casualidad cuando el id del usuario también existe en `admin`; cuando no,
-- el registro se bloquea.
--
-- La app está partida en dos sobre el significado de esa columna:
--   · Autorizaciones (admin y secretaría) la leen como `admin.id` para
--     mostrar quién pidió el movimiento.
--   · Registrar Gasto/Ingreso escribe `usuarios.id` (antes estaba fijo en 1,
--     así que todo quedaba atribuido al usuario 1).
--   · El aviso de "te aprobaron el gasto" la compara contra `usuarios.id`.
--
-- Cada bloque es una sola sentencia: selecciónalo y dale Run.
-- ============================================================================


-- ── BLOQUE 1) A dónde apunta la llave foránea ─────────────────────────────
SELECT con.conname                        AS restriccion,
       origen.relname                     AS tabla,
       destino.relname                    AS apunta_a,
       pg_get_constraintdef(con.oid)      AS definicion
  FROM pg_constraint con
  JOIN pg_class origen  ON origen.oid  = con.conrelid
  JOIN pg_class destino ON destino.oid = con.confrelid
 WHERE con.contype = 'f'
   AND origen.relname = 'gastosregistros';


-- ── BLOQUE 2) Quiénes están bloqueados hoy ────────────────────────────────
-- Usuarios que NO existen en `admin`. Ninguno de ellos puede registrar un
-- gasto, ingreso ni retiro: a todos les sale el mismo error.
SELECT u.id, u.nombre, u.rol
  FROM usuarios u
 WHERE NOT EXISTS (SELECT 1 FROM admin a WHERE a.id = u.id)
 ORDER BY u.id;


-- ── BLOQUE 3) Cuánto se solapan las dos tablas ────────────────────────────
SELECT (SELECT count(*) FROM usuarios)  AS usuarios,
       (SELECT count(*) FROM admin)     AS admins,
       (SELECT count(*) FROM usuarios u
         WHERE EXISTS (SELECT 1 FROM admin a WHERE a.id = u.id)) AS ids_en_ambas,
       (SELECT count(*) FROM admin a
         WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = a.id)) AS solo_en_admin;


-- ── BLOQUE 4) Qué hay en `admin` ──────────────────────────────────────────
SELECT * FROM admin ORDER BY id;


-- ── BLOQUE 5) A quién apuntan los movimientos ya registrados ──────────────
-- Muestra si los `adminid` que ya están guardados corresponden a personas de
-- `usuarios`, de `admin`, o de las dos. Esto decide hacia dónde conviene
-- apuntar la llave sin romper el histórico.
SELECT g.adminid,
       count(*)                                                   AS movimientos,
       (SELECT nombre FROM usuarios u WHERE u.id = g.adminid)     AS nombre_en_usuarios,
       (SELECT nombre FROM admin a WHERE a.id = g.adminid)        AS nombre_en_admin
  FROM gastosregistros g
 GROUP BY g.adminid
 ORDER BY count(*) DESC;


-- ============================================================================
-- DESBLOQUEO INMEDIATO (opcional, mientras se decide el arreglo de fondo)
-- ============================================================================
-- Copia a `admin` los usuarios que faltan, conservando su id. Con eso la
-- llave foránea deja de rechazar el registro y la gente puede seguir
-- trabajando hoy.
--
-- Es un PARCHE: no resuelve que la columna signifique dos cosas distintas
-- según quién la lea. Revisa antes el bloque 4 para ver qué columnas tiene
-- `admin` y si alguna es obligatoria.
--
-- INSERT INTO admin (id, nombre)
-- SELECT u.id, u.nombre
--   FROM usuarios u
--  WHERE NOT EXISTS (SELECT 1 FROM admin a WHERE a.id = u.id);
