-- ============================================================================
-- 020 - Modulo Documentos: carpetas, permisos por carpeta, categorias, archivos
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.documento_carpetas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre              TEXT NOT NULL,
  descripcion         TEXT,
  created_by          BIGINT NOT NULL,
  created_by_nombre   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quien mas (aparte de created_by) puede ver/usar la carpeta.
-- Mismo modelo que bi_reporte_permisos: sin fila = sin acceso.
CREATE TABLE IF NOT EXISTS public.documento_carpeta_permisos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carpeta_id  UUID NOT NULL REFERENCES public.documento_carpetas(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL,
  CONSTRAINT documento_carpeta_permisos_unique UNIQUE (carpeta_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_carpeta_permisos_carpeta ON public.documento_carpeta_permisos (carpeta_id);
CREATE INDEX IF NOT EXISTS idx_doc_carpeta_permisos_user    ON public.documento_carpeta_permisos (user_id);

-- Catalogo global de categorias (Informe, Foto, Reporte, ...)
CREATE TABLE IF NOT EXISTS public.documento_categorias (
  id          BIGSERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL UNIQUE,
  created_by  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.documentos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carpeta_id          UUID NOT NULL REFERENCES public.documento_carpetas(id) ON DELETE CASCADE,
  categoria_id        BIGINT REFERENCES public.documento_categorias(id) ON DELETE SET NULL,
  nombre_archivo      TEXT NOT NULL,
  url                 TEXT NOT NULL,
  tipo_mime           TEXT,
  tamano_bytes        BIGINT,
  notas               TEXT,
  uploaded_by         BIGINT NOT NULL,
  uploaded_by_nombre  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documentos_carpeta   ON public.documentos (carpeta_id);
CREATE INDEX IF NOT EXISTS idx_documentos_categoria ON public.documentos (categoria_id);
CREATE INDEX IF NOT EXISTS idx_documentos_created   ON public.documentos (created_at DESC);

ALTER TABLE public.documento_carpetas         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.documento_carpeta_permisos DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.documento_categorias        DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.documentos                  DISABLE ROW LEVEL SECURITY;
