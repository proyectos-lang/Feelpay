-- ============================================================================
-- 062 - Eliminar un movimiento de caja, sin perder el rastro
-- ============================================================================
-- QUÉ SE PIDIÓ
-- Que el asesor y la secretaría puedan BORRAR un ingreso, gasto o retiro del
-- mismo día que todavía nadie aprobó. Editar ya se podía (script 051);
-- borrar, no.
--
-- POR QUÉ UN BORRADO DE VERDAD Y NO UNA "ANULACIÓN"
-- La primera idea fue marcar el movimiento como anulado y filtrarlo al leer.
-- Se descartó: `gastosregistros` lo leen DOS vistas (`resumen_diario_v2` y
-- `vista_monitoreo_admin`) y dieciséis consultas de la app. Cada una tendría
-- que acordarse de excluir los anulados, y la que se olvidara seguiría
-- contando plata borrada — en silencio y para siempre. Un DELETE deja las
-- dieciocho consistentes sin tocar ninguna.
--
-- El precio de borrar es quedarse sin rastro, y eso sí es inaceptable: esto
-- es plata, y `resumen_pagos_diarios` ya sumó ese movimiento en la caja del
-- día. Por eso la fila se COPIA ENTERA acá antes de desaparecer.
--
-- Guardar la fila como `jsonb` y no columna por columna es a propósito: si
-- mañana `gastosregistros` gana una columna, esta tabla la conserva sola. Una
-- copia con columnas fijas empezaría a perder datos el día que eso pase, y
-- nadie se enteraría hasta necesitarlos.
--
-- QUIÉN PUEDE BORRAR — lo decide el servidor, no esta tabla
-- Las reglas viven en `lib/actions/delete-transaction.ts`: del día de hoy,
-- sin aprobar ni rechazar, y el asesor además solo los suyos. Acá solo queda
-- dónde cae la copia.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) La tabla del rastro ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gastosregistros_eliminados (
  id                    BIGSERIAL PRIMARY KEY,
  -- El id que tenía en `gastosregistros`. NO es llave foránea: la fila
  -- original ya no existe, ese es el punto.
  movimiento_id         BIGINT      NOT NULL,
  -- La fila completa tal como estaba justo antes de borrarse.
  movimiento            JSONB       NOT NULL,
  -- Se sacan del jsonb a columnas propias SOLO estos cuatro, que son por los
  -- que se busca: "qué se borró en la ruta 190 el martes".
  ruta                  SMALLINT,
  tipo                  TEXT,
  valor                 NUMERIC(15,2),
  fechahorasol          TIMESTAMPTZ,
  eliminado_por         BIGINT,
  eliminado_por_nombre  TEXT,
  motivo                TEXT,
  eliminado_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ── PASO 2) Índice para buscar por ruta y día ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gastosregistros_eliminados_ruta_fecha
  ON public.gastosregistros_eliminados (ruta, fechahorasol DESC);


-- ── PASO 3) Sin RLS, como el resto del esquema ────────────────────────────
ALTER TABLE public.gastosregistros_eliminados DISABLE ROW LEVEL SECURITY;


-- ── PASO 4) Permisos para la app ──────────────────────────────────────────
-- INSERT y SELECT, nada más: esta tabla es el rastro, y un rastro que se
-- puede editar o borrar no es un rastro.
GRANT SELECT, INSERT ON public.gastosregistros_eliminados TO anon, authenticated;


-- ── PASO 5) La secuencia del id ───────────────────────────────────────────
GRANT USAGE ON SEQUENCE public.gastosregistros_eliminados_id_seq TO anon, authenticated;


-- ── PASO 6) Verificar ─────────────────────────────────────────────────────
-- Recién corrido debe salir vacío. Después de borrar un movimiento desde la
-- app, acá tiene que aparecer la fila con todo lo que decía.
SELECT id, movimiento_id, ruta, tipo, valor,
       fechahorasol, eliminado_por_nombre, motivo, eliminado_at
  FROM public.gastosregistros_eliminados
 ORDER BY eliminado_at DESC
 LIMIT 20;


-- ── PASO 7) Cuadrar la caja de un día contra lo borrado ───────────────────
-- Para cuando alguien pregunte "¿por qué la caja del martes cambió?": esto
-- dice cuánto se sacó por borrados, por ruta y por día.
SELECT (fechahorasol AT TIME ZONE 'America/Bogota')::date AS dia,
       ruta,
       tipo,
       COUNT(*)    AS movimientos_borrados,
       SUM(valor)  AS total_borrado
  FROM public.gastosregistros_eliminados
 GROUP BY 1, 2, 3
 ORDER BY 1 DESC, 2, 3;
