-- ============================================================
-- 022 - Foto de perfil por usuario
-- ============================================================

ALTER TABLE public.usuarios ADD COLUMN IF NOT EXISTS foto_url TEXT;
