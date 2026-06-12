-- ============================================================
-- 005 · Tablas para el módulo de Reportes
-- ============================================================
-- Ejecutar en Supabase Dashboard → SQL Editor (después del 004)

-- Tabla principal: cabecera del reporte/bitácora
CREATE TABLE IF NOT EXISTS public.informes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  secretaria_id     BIGINT      NOT NULL,          -- usuarios.id
  secretaria_nombre TEXT        NOT NULL,
  ruta_id           INTEGER,
  fecha             DATE        NOT NULL DEFAULT CURRENT_DATE,
  nombre_reporte    TEXT        NOT NULL,
  notas             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_informes_fecha       ON public.informes (fecha);
CREATE INDEX IF NOT EXISTS idx_informes_secretaria  ON public.informes (secretaria_id);
CREATE INDEX IF NOT EXISTS idx_informes_ruta        ON public.informes (ruta_id);

ALTER TABLE public.informes DISABLE ROW LEVEL SECURITY;

-- Tabla de imágenes adjuntas (1 reporte → N imágenes)
CREATE TABLE IF NOT EXISTS public.informe_imagenes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  informe_id      UUID        NOT NULL REFERENCES public.informes(id) ON DELETE CASCADE,
  url_imagen      TEXT        NOT NULL,
  nombre_archivo  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_informe_imagenes_informe ON public.informe_imagenes (informe_id);

ALTER TABLE public.informe_imagenes DISABLE ROW LEVEL SECURITY;
