-- Tabla para almacenar suscripciones de Web Push por dispositivo
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    TEXT        NOT NULL,
  rol        TEXT        NOT NULL,
  endpoint   TEXT        NOT NULL UNIQUE,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subs_rol ON push_subscriptions (rol);
ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;
