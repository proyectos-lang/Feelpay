-- 1. Ampliar CHECK de rol en usuarios para incluir socioadmin
ALTER TABLE public.usuarios
  DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE public.usuarios
  ADD CONSTRAINT usuarios_rol_check
  CHECK (rol = ANY(ARRAY['vendedor','admin','secretaria','gerencia','socioadmin']));

-- 2. Columna destinatario en informes (gerencia | socioadmin)
ALTER TABLE public.informes
  ADD COLUMN IF NOT EXISTS destinatario TEXT NOT NULL DEFAULT 'gerencia'
    CHECK (destinatario IN ('gerencia','socioadmin'));

-- 3. Columna socioadmin_id en informes (NULL cuando destinatario='gerencia')
ALTER TABLE public.informes
  ADD COLUMN IF NOT EXISTS socioadmin_id BIGINT NULL
    REFERENCES public.usuarios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_informes_socioadmin
  ON public.informes (socioadmin_id) WHERE socioadmin_id IS NOT NULL;

-- 4. Columna tipo en informe_imagenes para distinguir imagen/archivo
ALTER TABLE public.informe_imagenes
  ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'imagen'
    CHECK (tipo IN ('imagen','archivo'));
