-- ============================================================
-- 014 - Habilitar Supabase Realtime en chat_conversations
-- Ejecutar en SQL Editor de Supabase.
-- Necesario para que el renombrado de un grupo se refleje en vivo
-- en las sesiones de los demás participantes.
-- ============================================================

ALTER TABLE public.chat_conversations REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_conversations;
