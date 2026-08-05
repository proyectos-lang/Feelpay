-- ============================================================
-- 024 - Habilitar Supabase Realtime para badges de notificacion
-- (documentos, informes, admin_informes)
-- Ejecutar en SQL Editor de Supabase
-- ============================================================

ALTER TABLE public.documentos      REPLICA IDENTITY FULL;
ALTER TABLE public.informes        REPLICA IDENTITY FULL;
ALTER TABLE public.admin_informes  REPLICA IDENTITY FULL;

ALTER PUBLICATION supabase_realtime ADD TABLE public.documentos;
ALTER PUBLICATION supabase_realtime ADD TABLE public.informes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_informes;
