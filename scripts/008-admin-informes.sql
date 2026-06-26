CREATE TABLE IF NOT EXISTS public.admin_informes (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id                   BIGINT      NOT NULL,
  admin_nombre               TEXT        NOT NULL,
  ruta_id                    BIGINT      NULL,
  fecha                      DATE        NOT NULL,
  nombre_reporte             TEXT        NOT NULL,
  notas                      TEXT        NULL,
  estado                     TEXT        NOT NULL DEFAULT 'pendiente'
                               CHECK (estado IN ('pendiente','aprobado','rechazado')),
  revision_secretaria_id     BIGINT      NULL,
  revision_secretaria_nombre TEXT        NULL,
  revision_comentario        TEXT        NULL,
  revision_at                TIMESTAMPTZ NULL,
  version                    INT         NOT NULL DEFAULT 1,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.admin_informe_imagenes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_informe_id  UUID        NOT NULL REFERENCES public.admin_informes(id) ON DELETE CASCADE,
  url_imagen        TEXT        NOT NULL,
  nombre_archivo    TEXT        NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_informes_admin  ON public.admin_informes (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_informes_fecha  ON public.admin_informes (fecha);
CREATE INDEX IF NOT EXISTS idx_admin_informes_estado ON public.admin_informes (estado);

ALTER TABLE public.admin_informes         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_informe_imagenes DISABLE ROW LEVEL SECURITY;
