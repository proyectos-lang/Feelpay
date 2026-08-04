-- ============================================================
-- 023 - Subcarpetas dentro del módulo Documentos
-- Un solo nivel de anidación (carpeta > subcarpeta > documentos).
-- La visibilidad de una subcarpeta se hereda 100% de su carpeta padre
-- (no tiene permisos propios en documento_carpeta_permisos): si puedes
-- ver la carpeta, ves todas sus subcarpetas.
-- ============================================================

ALTER TABLE public.documento_carpetas
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.documento_carpetas(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_documento_carpetas_parent ON public.documento_carpetas (parent_id);
