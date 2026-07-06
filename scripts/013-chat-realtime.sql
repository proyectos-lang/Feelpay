-- ============================================================
-- 013 - Habilitar Supabase Realtime en tablas de chat
-- Ejecutar en SQL Editor de Supabase después de 012-chat-schema.sql
-- ============================================================

-- REPLICA IDENTITY FULL permite que postgres_changes funcione con
-- filtros por columnas que no son PK (ej: conversation_id).
ALTER TABLE public.chat_messages     REPLICA IDENTITY FULL;
ALTER TABLE public.chat_participants REPLICA IDENTITY FULL;

-- Agregar las tablas a la publicación de Supabase Realtime.
-- Si la publicación ya incluye todas las tablas (supabase_realtime = FOR ALL TABLES)
-- estas líneas no son necesarias pero tampoco dañan.
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_participants;
