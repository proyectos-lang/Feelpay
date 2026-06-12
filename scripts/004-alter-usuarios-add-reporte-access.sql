-- ============================================================
-- 004 · Agregar acceso al módulo Reportes en tabla usuarios
-- ============================================================
-- Ejecutar en Supabase Dashboard → SQL Editor

-- 1. Nueva columna de acceso al módulo Reportes
ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS acceso_modulo_reporte BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.usuarios.acceso_modulo_reporte
  IS 'TRUE = la secretaria puede acceder al módulo de Reportes';

-- 2. Ampliar el check de roles para incluir gerencia
ALTER TABLE public.usuarios
  DROP CONSTRAINT IF EXISTS usuarios_rol_check;

ALTER TABLE public.usuarios
  ADD CONSTRAINT usuarios_rol_check CHECK (
    rol = ANY (ARRAY[
      'vendedor'::text,
      'admin'::text,
      'secretaria'::text,
      'gerencia'::text
    ])
  );
