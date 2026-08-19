-- ============================================================================
-- 058 - Que las solicitudes de revisión avisen cuando llegan
-- ============================================================================
-- EL SÍNTOMA
-- "La aprobación de ventas cuando se supera el límite no está llegando, ni
-- para admin ni para secretaría."
--
-- LO QUE SE VERIFICÓ EN LA BASE
-- Las solicitudes SÍ se están creando: hay 7 de tipo `venta` pendientes, dos
-- de la ruta 190. El insert funciona perfectamente. Lo que faltaba era que
-- alguien se enterara:
--
--   · El admin no tenía acceso al módulo (se corrige en la app).
--   · La bandeja abría siempre en la pestaña "Gastos" (se corrige en la app).
--   · Y NADA avisaba: ni badge, ni toast, ni push. La tabla ni siquiera
--     estaba publicada en tiempo real, así que la app no podía enterarse de
--     una solicitud nueva aunque quisiera. Eso es lo que arregla este script.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Publicar la tabla en tiempo real ──────────────────────────────
-- `ALTER PUBLICATION ... ADD TABLE` no admite IF NOT EXISTS y falla si la
-- tabla ya está publicada, así que se consulta antes. Con esto el script se
-- puede volver a correr sin romper nada.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'solicitudes_revision'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.solicitudes_revision;
  END IF;
END $$;


-- ── PASO 2) Índice para el conteo del aviso ───────────────────────────────
-- Al abrir sesión, la app cuenta las solicitudes pendientes para sembrar el
-- badge. Índice parcial: solo interesan las pendientes, que son pocas.
CREATE INDEX IF NOT EXISTS idx_solicitudes_pendientes
  ON public.solicitudes_revision (estado, created_at)
  WHERE estado = 'pendiente';


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
-- La primera consulta debe devolver UNA fila (la tabla ya publicada).
-- La segunda muestra lo que hay hoy sin resolver: deberían verse las ventas.
SELECT 'publicada en tiempo real' AS objeto, tablename
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime'
   AND schemaname = 'public'
   AND tablename = 'solicitudes_revision';

SELECT tipo, estado, COUNT(*) AS cuantas, MIN(created_at) AS la_mas_vieja
  FROM public.solicitudes_revision
 GROUP BY tipo, estado
 ORDER BY tipo, estado;
