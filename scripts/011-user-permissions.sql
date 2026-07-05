-- ============================================================
-- 011 - user_permissions
-- Permisos individuales de módulos por usuario.
-- Si no hay filas para un user_id → comportamiento por rol (sin cambios).
-- Si hay filas → solo se muestran los view_id con enabled = true.
-- in_mobile_nav = true → aparece en la barra inferior del móvil (máx. 5).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_permissions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        BIGINT      NOT NULL,
  view_id        TEXT        NOT NULL,
  enabled        BOOLEAN     NOT NULL DEFAULT true,
  in_mobile_nav  BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_permissions_user_view_unique UNIQUE (user_id, view_id)
);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id ON public.user_permissions (user_id);

ALTER TABLE public.user_permissions DISABLE ROW LEVEL SECURITY;
