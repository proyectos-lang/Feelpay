-- ============================================================================
-- 039 - `gastosregistros.adminid` referencia a usuarios, no a admin
-- ============================================================================
-- PROBLEMA
--   insert or update on table "gastosregistros" violates foreign key
--   constraint "gastosregistros_adminid_fkey"
--
-- La columna tenia una llave foranea hacia `admin`, pero la app guarda ahi
-- el id de la sesion, que sale de `usuarios`. El diagnostico mostro que:
--
--   · `admin` tiene UNA sola fila: id 1, "Luisa Secretaria".
--   · `usuarios` tiene 14.
--   · El unico id que coincide corresponde a personas DISTINTAS:
--     usuarios.id = 1 es "Carlos (Ruta 1)".
--
-- Resultado: 13 de 14 usuarios no podian registrar ningun gasto, ingreso ni
-- retiro. Solo pasaba quien tuviera id 1.
--
-- Y como los 7 movimientos existentes quedaron con adminid = 1 (el valor
-- fijo que habia antes), en las pantallas de autorizaciones TODOS aparecian
-- como "Luisa Secretaria" sin importar quien los registro. Por eso nadie
-- noto que la columna significaba dos cosas distintas.
--
-- SOLUCION
-- La columna significa "quien registro el movimiento", asi que apunta a
-- `usuarios`. Es lo que ya escribe el formulario de registro y lo que asume
-- el aviso de "te aprobaron el gasto". Las dos pantallas de autorizaciones
-- eran las que la leian mal; se corrigen en la app.
--
-- La tabla `admin` NO se toca. Queda ahi por si algo mas la usa.
--
-- Cada bloque es una sola sentencia: selecciona y dale Run.
-- ============================================================================


-- ── PASO 1) Verificar que se puede repuntar sin romper el historico ───────
-- Debe devolver CERO filas. Si devuelve alguna, son movimientos cuyo
-- `adminid` no existe en `usuarios` y hay que decidir a quien atribuirlos
-- ANTES de crear la llave nueva.
SELECT g.adminid, count(*) AS movimientos
  FROM gastosregistros g
 WHERE g.adminid IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = g.adminid)
 GROUP BY g.adminid;


-- ── PASO 2) Repuntar la llave ─────────────────────────────────────────────
ALTER TABLE public.gastosregistros
  DROP CONSTRAINT IF EXISTS gastosregistros_adminid_fkey;

ALTER TABLE public.gastosregistros
  ADD CONSTRAINT gastosregistros_adminid_fkey
  FOREIGN KEY (adminid) REFERENCES public.usuarios(id);

NOTIFY pgrst, 'reload schema';


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
-- `apunta_a` debe decir `usuarios`.
SELECT con.conname                   AS restriccion,
       destino.relname               AS apunta_a,
       pg_get_constraintdef(con.oid) AS definicion
  FROM pg_constraint con
  JOIN pg_class origen  ON origen.oid  = con.conrelid
  JOIN pg_class destino ON destino.oid = con.confrelid
 WHERE con.contype = 'f'
   AND origen.relname = 'gastosregistros'
   AND con.conname = 'gastosregistros_adminid_fkey';


-- ── PASO 4) A quién quedan atribuidos los movimientos viejos ──────────────
-- OJO: los 7 movimientos previos tienen adminid = 1 porque ese valor estaba
-- fijo en el codigo, no porque los registrara esa persona. Desde ahora
-- apareceran a nombre de quien sea `usuarios.id = 1`. No hay forma de saber
-- quien los registro de verdad; el dato se perdio cuando estaba fijo.
SELECT g.adminid,
       u.nombre AS aparecera_como,
       u.rol,
       count(*) AS movimientos,
       min(g.fechahorasol) AS desde,
       max(g.fechahorasol) AS hasta
  FROM gastosregistros g
  LEFT JOIN usuarios u ON u.id = g.adminid
 GROUP BY g.adminid, u.nombre, u.rol
 ORDER BY count(*) DESC;
