-- ============================================================================
-- 038 - Permisos sobre operaciones_procesadas
-- ============================================================================
-- SINTOMA
-- "Error al guardar el ingreso" (o el gasto, o el retiro) al registrarlo.
--
-- HIPOTESIS
-- `saveTransaction` escribe en `operaciones_procesadas` DIRECTAMENTE desde el
-- servidor de la app, con la llave anon. Las RPC de pagos y ventas tambien
-- escriben en esa tabla, pero ellas son SECURITY DEFINER: corren como el
-- dueño de la funcion y se saltan los permisos. Por eso los pagos funcionan
-- y los movimientos de caja no.
--
-- POR QUE APARECE AHORA
-- Hasta el commit anterior ese INSERT se hacia al FINAL y su error NUNCA se
-- revisaba:
--
--     await supabase.from("operaciones_procesadas").insert({...})   // sin ver el error
--
-- Asi que si venia fallando, fallaba en silencio: el movimiento se guardaba
-- igual y la llave de idempotencia simplemente no quedaba. La proteccion
-- contra duplicados existia en el codigo pero no en la practica.
--
-- Al hacerla atomica, la reserva de la llave pasa a ser el PRIMER paso y su
-- error si se revisa. Un permiso que faltaba desde siempre dejo de ser
-- invisible y se volvio un bloqueo.
--
-- Cada bloque es una sola sentencia: selecciona y dale Run.
-- ============================================================================


-- ── PASO 1) Confirmar la hipotesis ────────────────────────────────────────
-- Muestra que puede hacer cada rol sobre la tabla. Si `anon` o
-- `authenticated` NO aparecen con INSERT, ese es el problema.
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name = 'operaciones_procesadas'
 ORDER BY grantee, privilege_type;


-- ── PASO 2) Ver si la tabla tiene RLS encendida ───────────────────────────
-- Deberia estar en false, como el resto de la app.
SELECT relname, relrowsecurity AS rls_encendida
  FROM pg_class
 WHERE oid = 'public.operaciones_procesadas'::regclass;


-- ── PASO 3) Corregir ──────────────────────────────────────────────────────
-- Se necesita INSERT (reservar la llave), SELECT (reconocer un reintento),
-- UPDATE (guardar el resultado) y DELETE (liberar la llave si el movimiento
-- falla despues de reservarla).
GRANT SELECT, INSERT, UPDATE, DELETE
   ON public.operaciones_procesadas
   TO anon, authenticated;

ALTER TABLE public.operaciones_procesadas DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';


-- ── PASO 4) Verificar ─────────────────────────────────────────────────────
-- Ahora `anon` y `authenticated` deben tener las cuatro operaciones.
SELECT grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS permisos
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name = 'operaciones_procesadas'
   AND grantee IN ('anon', 'authenticated')
 GROUP BY grantee;


-- ── PASO 5) Cuantas llaves se alcanzaron a guardar ────────────────────────
-- Si `transacciones` sale en 0 mientras hay pagos y ventas, queda confirmado
-- que el INSERT de los movimientos de caja venia fallando en silencio.
SELECT CASE WHEN tipo LIKE 'transaccion%' THEN 'transacciones' ELSE tipo END AS clase,
       count(*) AS llaves,
       min(created_at) AS primera,
       max(created_at) AS ultima
  FROM operaciones_procesadas
 GROUP BY 1
 ORDER BY 2 DESC;
