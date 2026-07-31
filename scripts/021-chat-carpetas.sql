-- ============================================================
-- 021 - Carpetas personales para organizar el chat
-- Cada usuario arma sus propias carpetas para agrupar sus chats;
-- no son compartidas ni visibles para otros usuarios. Un chat
-- pertenece a lo sumo una carpeta por usuario (sin fila = sin carpeta).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chat_carpetas (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     BIGINT      NOT NULL,
  nombre      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_carpetas_user ON public.chat_carpetas (user_id);
ALTER TABLE public.chat_carpetas DISABLE ROW LEVEL SECURITY;

-- A qué carpeta pertenece cada conversación, para un usuario dado.
CREATE TABLE IF NOT EXISTS public.chat_conversacion_carpeta (
  id               UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          BIGINT NOT NULL,
  conversation_id  UUID   NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  carpeta_id       UUID   NOT NULL REFERENCES public.chat_carpetas(id) ON DELETE CASCADE,
  CONSTRAINT chat_conversacion_carpeta_unique UNIQUE (user_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_conv_carpeta_user    ON public.chat_conversacion_carpeta (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_conv_carpeta_carpeta ON public.chat_conversacion_carpeta (carpeta_id);
ALTER TABLE public.chat_conversacion_carpeta DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- get_my_conversations gana la columna carpeta_id (la carpeta asignada
-- por y para el usuario que consulta). Requiere DROP porque cambia el
-- conjunto de columnas de retorno (CREATE OR REPLACE no lo permite).
-- ============================================================

DROP FUNCTION IF EXISTS get_my_conversations(BIGINT);

CREATE OR REPLACE FUNCTION get_my_conversations(p_user_id BIGINT)
RETURNS TABLE(
  conversation_id UUID,
  name            TEXT,
  is_group        BOOLEAN,
  last_body       TEXT,
  last_sender     TEXT,
  last_at         TIMESTAMPTZ,
  unread_count    BIGINT,
  members_count   BIGINT,
  carpeta_id      UUID
) LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    CASE
      WHEN c.is_group THEN c.name
      ELSE (
        SELECT cp2.user_nombre
        FROM   chat_participants cp2
        WHERE  cp2.conversation_id = c.id AND cp2.user_id <> p_user_id
        LIMIT  1
      )
    END AS name,
    c.is_group,
    (SELECT body          FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body,
    (SELECT sender_nombre FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_sender,
    (SELECT created_at    FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_at,
    (
      SELECT COUNT(*)
      FROM   chat_messages m
      WHERE  m.conversation_id = c.id
        AND  m.sender_id <> p_user_id
        AND  m.created_at > COALESCE(
               (SELECT last_read_at FROM chat_participants cp3
                WHERE  cp3.conversation_id = c.id AND cp3.user_id = p_user_id),
               '2000-01-01'::timestamptz)
    ) AS unread_count,
    (SELECT COUNT(*) FROM chat_participants cp4 WHERE cp4.conversation_id = c.id) AS members_count,
    (
      SELECT ccc.carpeta_id FROM chat_conversacion_carpeta ccc
      WHERE  ccc.conversation_id = c.id AND ccc.user_id = p_user_id
    ) AS carpeta_id
  FROM  chat_conversations c
  JOIN  chat_participants  cp ON cp.conversation_id = c.id AND cp.user_id = p_user_id
  ORDER BY COALESCE(
    (SELECT created_at FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
    c.created_at
  ) DESC;
$$;
