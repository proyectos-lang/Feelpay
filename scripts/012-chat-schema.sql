-- ============================================================
-- 012 - Chat Interno
-- Conversaciones privadas y grupales entre usuarios.
-- Seguridad: RLS deshabilitado (consistente con el resto de la app).
-- El filtrado por participación es 100% a nivel app.
-- ============================================================

-- Conversaciones (privadas y grupos)
CREATE TABLE IF NOT EXISTS public.chat_conversations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT,                       -- NULL = chat privado (nombre se infiere del otro participante)
  is_group    BOOLEAN     NOT NULL DEFAULT false,
  created_by  BIGINT      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Participantes de cada conversación
CREATE TABLE IF NOT EXISTS public.chat_participants (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  user_id         BIGINT      NOT NULL,
  user_nombre     TEXT        NOT NULL,   -- desnormalizado para evitar JOINs
  last_read_at    TIMESTAMPTZ,            -- para calcular mensajes no leídos
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_participants_unique UNIQUE (conversation_id, user_id)
);

-- Mensajes
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  sender_id       BIGINT      NOT NULL,
  sender_nombre   TEXT        NOT NULL,   -- desnormalizado
  body            TEXT,                   -- NULL si el mensaje es solo imagen
  image_url       TEXT,                   -- URL de Vercel Blob
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contactos permitidos en chat por usuario
-- Sin filas para user_id → ese usuario ve a todos los demás
-- Con filas → ese usuario solo ve a los allowed_user_id listados
CREATE TABLE IF NOT EXISTS public.chat_allowed_contacts (
  id               UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          BIGINT NOT NULL,
  allowed_user_id  BIGINT NOT NULL,
  CONSTRAINT chat_contacts_unique UNIQUE (user_id, allowed_user_id)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_chat_parts_user   ON public.chat_participants (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_parts_conv   ON public.chat_participants (conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_conv    ON public.chat_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_msgs_ts      ON public.chat_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_chat_contacts_uid ON public.chat_allowed_contacts (user_id);

-- RLS deshabilitado
ALTER TABLE public.chat_conversations    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_participants     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_allowed_contacts DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- Función RPC: lista de conversaciones con metadatos
-- Evita N+1 queries desde el cliente
-- ============================================================
CREATE OR REPLACE FUNCTION get_my_conversations(p_user_id BIGINT)
RETURNS TABLE(
  conversation_id UUID,
  name            TEXT,
  is_group        BOOLEAN,
  last_body       TEXT,
  last_sender     TEXT,
  last_at         TIMESTAMPTZ,
  unread_count    BIGINT,
  members_count   BIGINT
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
    (SELECT COUNT(*) FROM chat_participants cp4 WHERE cp4.conversation_id = c.id) AS members_count
  FROM  chat_conversations c
  JOIN  chat_participants  cp ON cp.conversation_id = c.id AND cp.user_id = p_user_id
  ORDER BY COALESCE(
    (SELECT created_at FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
    c.created_at
  ) DESC;
$$;
