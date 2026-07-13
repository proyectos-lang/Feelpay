-- ============================================================
-- 015 - Reportes Power BI dinamicos + permisos por usuario
-- Ejecutar en SQL Editor de Supabase.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bi_reportes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      TEXT NOT NULL,
  url         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Presencia de una fila = el usuario puede ver ese reporte.
-- Sin fila para un reporte -> nadie lo ve hasta que se le asigne
-- explicitamente (los reportes son informacion gerencial sensible).
CREATE TABLE IF NOT EXISTS public.bi_reporte_permisos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporte_id  UUID NOT NULL REFERENCES public.bi_reportes(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL,
  CONSTRAINT bi_reporte_permisos_unique UNIQUE (reporte_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bi_permisos_reporte ON public.bi_reporte_permisos (reporte_id);
CREATE INDEX IF NOT EXISTS idx_bi_permisos_user    ON public.bi_reporte_permisos (user_id);

ALTER TABLE public.bi_reportes         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.bi_reporte_permisos DISABLE ROW LEVEL SECURITY;

-- Migrar los 4 reportes que hasta ahora estaban fijos en el código, y dar
-- acceso a todos los usuarios activos para que nadie pierda visibilidad
-- con el cambio. Solo corre la primera vez (tabla vacía).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bi_reportes) THEN
    INSERT INTO public.bi_reportes (nombre, url) VALUES
      ('Recaudos',    'https://app.powerbi.com/view?r=eyJrIjoiOWQzMGE0OWYtMmM0NS00ODQ0LTkyODUtMDcwYzczNDc4ZDliIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9'),
      ('Betty',       'https://app.powerbi.com/view?r=eyJrIjoiZGE3YmZjODQtMDE5MS00MTUxLWE1YzctYTQ4MjFmMGI4OGJmIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9'),
      ('Richard',     'https://app.powerbi.com/view?r=eyJrIjoiMTcyMDQ3ZDQtZjI4YS00MDhjLWE4N2MtMDJmMjgzOGZkOTVhIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9'),
      ('OPAD- Luisa', 'https://app.powerbi.com/view?r=eyJrIjoiMjkyZTcyMjAtYmJlYy00MzE3LWI1OTItMDNlNTMzYzcwODcxIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9');

    INSERT INTO public.bi_reporte_permisos (reporte_id, user_id)
    SELECT r.id, u.id
    FROM public.bi_reportes r
    CROSS JOIN public.usuarios u
    WHERE u.activo = true;
  END IF;
END $$;
