-- ============================================================================
-- 000 - Tablas y objetos que existían en la base SIN DDL en el repo
-- ============================================================================
-- DOCUMENTACIÓN. Capturado del Supabase vivo el 2026-08-16 con el PASO 0 del
-- script 041. Estas tablas se crearon por fuera del repo (editor de Supabase)
-- y por eso ningún script las tenía; este archivo permite reconstruir la base
-- desde cero y sirve de referencia de tipos.
--
-- Es seguro correrlo (CREATE TABLE IF NOT EXISTS no toca lo que ya existe),
-- pero su propósito es documentar.
--
-- HALLAZGOS del capture:
--   · `usuarios` NO tiene `foto_url` ni `created_at` → el script 022
--     (022-usuarios-foto-perfil.sql) NUNCA se corrió en esta base. La foto
--     de perfil del chat/usuarios no puede estar funcionando.
--   · `gastosregistros.adminid` y `.ruta` son SMALLINT (no bigint). Los
--     inserts desde las RPCs castean implícito sin problema.
--   · `vista_monitoreo_admin` agrupa la plata por payment_plan.fecha_pago →
--     con el núcleo nuevo (fecha_pago = vencimiento inmutable) quedaría
--     ciega. El script 048 la redefine sobre `gestiones`. Su definición
--     VIEJA queda comentada al final de este archivo como referencia.
--
-- Los PK/UNIQUE se presumen de los `id NOT NULL` (el capture no los trae).
-- ============================================================================


-- Catálogo de administradores (legado; 1 fila. Desde el script 039
-- gastosregistros.adminid apunta a `usuarios`, no a esta tabla.)
CREATE TABLE IF NOT EXISTS public.admin (
  id     BIGINT PRIMARY KEY,
  nombre TEXT NOT NULL,
  pais   TEXT
);

-- Cuentas bancarias por ruta (ventas por transferencia)
CREATE TABLE IF NOT EXISTS public.cuentas (
  id     BIGINT PRIMARY KEY,
  ruta   SMALLINT NOT NULL,
  nombre TEXT,
  cuenta TEXT
);

-- Catálogos de conceptos de caja (item_id de ruta_item_umbrales)
CREATE TABLE IF NOT EXISTS public.gastos (
  id     BIGINT PRIMARY KEY,
  nombre TEXT NOT NULL,
  activo BOOLEAN DEFAULT true,
  limite NUMERIC
);

CREATE TABLE IF NOT EXISTS public.ingresos (
  id     BIGINT PRIMARY KEY,
  nombre TEXT NOT NULL,
  activo BOOLEAN DEFAULT true,
  limite NUMERIC
);

CREATE TABLE IF NOT EXISTS public.retiros (
  id     BIGINT PRIMARY KEY,
  nombre TEXT NOT NULL,
  activo BOOLEAN DEFAULT true,
  limite NUMERIC
);

-- Movimientos de caja. CHECKs de estadoadmin/estadosecre: script 035.
-- FK adminid → usuarios(id): script 039.
CREATE TABLE IF NOT EXISTS public.gastosregistros (
  id                        BIGINT PRIMARY KEY,
  fechahorasol              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  adminid                   SMALLINT,
  ruta                      SMALLINT,
  concepto                  TEXT,
  limite                    NUMERIC,
  valor                     NUMERIC,
  observacion               TEXT,
  foto                      TEXT,
  estadoadmin               TEXT,
  adminaprobo               TEXT,
  fechahoraaproboadm        TIMESTAMPTZ,
  estadosecre               TEXT,
  secretariaaprobo          TEXT,
  fechahoraaprobosecretaria TIMESTAMP,
  tipo                      TEXT
);

CREATE TABLE IF NOT EXISTS public.rutas (
  id      BIGINT PRIMARY KEY,
  nombre  TEXT NOT NULL,
  ciudad  TEXT,
  idadmin BIGINT,
  pais    TEXT
);

-- La "ruta iniciada" del día (gate de UI; ningún cálculo de plata depende
-- de ella). OJO: fecha DEFAULT CURRENT_DATE corre en UTC — la app siempre
-- debe mandar la fecha Colombia explícita, nunca confiar en el default.
CREATE TABLE IF NOT EXISTS public.rutas_diarias (
  id                    BIGINT PRIMARY KEY,
  fecha                 DATE NOT NULL DEFAULT CURRENT_DATE,
  ruta_id               SMALLINT NOT NULL,
  hora_inicio           TIMESTAMPTZ DEFAULT NOW(),
  hora_fin              TIMESTAMPTZ,
  estado                TEXT NOT NULL DEFAULT 'abierta',
  vendedor_id           UUID,
  aprobacion_admin      TEXT NOT NULL DEFAULT 'no_aplica',
  admin_aprobador_id    BIGINT,
  fecha_hora_aprobacion TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.usuario_rutas (
  usuario_id BIGINT NOT NULL,
  ruta_id    BIGINT NOT NULL,
  PRIMARY KEY (usuario_id, ruta_id)
);

-- Usuarios de la app (auth propia, sin Supabase Auth).
-- `acceso_modulo_reporte` la agregó el 004. foto_url (022) NO existe: ese
-- script nunca se corrió.
CREATE TABLE IF NOT EXISTS public.usuarios (
  id                    BIGINT PRIMARY KEY,
  usuario               TEXT NOT NULL,
  password              TEXT NOT NULL,
  nombre                TEXT NOT NULL,
  rol                   TEXT NOT NULL,
  activo                BOOLEAN DEFAULT true,
  acceso_modulo_reporte BOOLEAN
);

-- Login (capturado tal cual del vivo)
CREATE OR REPLACE FUNCTION public.login_usuario(p_usuario text, p_password text)
 RETURNS TABLE(id bigint, nombre text, rol text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  return query
  select u.id, u.nombre, u.rol
  from public.usuarios u
  where u.usuario = p_usuario and u.password = p_password and u.activo = true;
end;
$function$;


-- ============================================================================
-- vista_monitoreo_admin — DEFINICIÓN VIEJA (solo referencia, NO correr)
-- ============================================================================
-- Agrupaba recaudo y visitas por payment_plan.fecha_pago y estados de cuota.
-- Con el núcleo nuevo esa columna vuelve a ser el VENCIMIENTO (inmutable),
-- así que esta definición dejaría de reflejar la actividad del día.
-- El script 048 la redefine sobre `gestiones` con las mismas columnas.
--
-- CREATE OR REPLACE VIEW public.vista_monitoreo_admin AS
--  WITH pagos_resumen AS (
--          SELECT ruta, fecha_pago,
--             COALESCE(sum(monto_pagado), 0) AS total_recaudado,
--             count(id) FILTER (WHERE estado IN ('pagado','parcial','cancelada')) AS pagos_exitosos,
--             count(id) FILTER (WHERE estado = 'no_pago') AS visitas_sin_pago,
--             count(id) FILTER (WHERE estado = 'pendiente') AS pendientes_por_visitar
--            FROM payment_plan GROUP BY ruta, fecha_pago
--         ), transacciones_resumen AS (
--          SELECT ruta, (fechahorasol AT TIME ZONE 'America/Bogota')::date AS fecha_transaccion,
--             COALESCE(sum(valor) FILTER (WHERE tipo = 'Ingreso'), 0) AS total_ingresos,
--             COALESCE(sum(valor) FILTER (WHERE tipo = 'Gasto'), 0) AS total_gastos,
--             COALESCE(sum(valor) FILTER (WHERE tipo = 'Retiro'), 0) AS total_retiros
--            FROM gastosregistros GROUP BY ruta, 2
--         ), ventas_resumen AS (
--          SELECT ruta, (created_at AT TIME ZONE 'America/Bogota')::date AS fecha_venta,
--             COALESCE(sum(valor_a_pagar), 0) AS total_ventas, count(id) AS cantidad_ventas
--            FROM loans GROUP BY ruta, 2
--         )
--  SELECT rd.id AS registro_id, rd.fecha, rd.ruta_id, rd.estado AS estado_ruta,
--     rd.hora_inicio, rd.hora_fin,
--     COALESCE(pr.total_recaudado, 0), COALESCE(pr.pagos_exitosos, 0),
--     COALESCE(pr.visitas_sin_pago, 0), COALESCE(pr.pendientes_por_visitar, 0),
--     rd.aprobacion_admin,
--     COALESCE(tr.total_ingresos, 0), COALESCE(tr.total_gastos, 0),
--     COALESCE(tr.total_retiros, 0),
--     COALESCE(vr.total_ventas, 0), COALESCE(vr.cantidad_ventas, 0)
--    FROM rutas_diarias rd
--      LEFT JOIN pagos_resumen pr ON rd.ruta_id = pr.ruta AND rd.fecha = pr.fecha_pago
--      LEFT JOIN transacciones_resumen tr ON rd.ruta_id = tr.ruta AND rd.fecha = tr.fecha_transaccion
--      LEFT JOIN ventas_resumen vr ON rd.ruta_id = vr.ruta AND rd.fecha = vr.fecha_venta;
