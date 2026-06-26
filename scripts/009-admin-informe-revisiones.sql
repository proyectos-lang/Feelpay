CREATE TABLE IF NOT EXISTS public.admin_informe_revisiones (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_informe_id  UUID        NOT NULL REFERENCES public.admin_informes(id) ON DELETE CASCADE,
  accion            TEXT        NOT NULL CHECK (accion IN ('aprobado','rechazado')),
  secretaria_id     BIGINT      NOT NULL,
  secretaria_nombre TEXT        NOT NULL,
  comentario        TEXT        NULL,
  version_reporte   INT         NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_informe_revisiones_informe ON public.admin_informe_revisiones (admin_informe_id);
CREATE INDEX IF NOT EXISTS idx_admin_informe_revisiones_fecha   ON public.admin_informe_revisiones (created_at);

ALTER TABLE public.admin_informe_revisiones DISABLE ROW LEVEL SECURITY;
