-- ============================================================================
-- 035 - Aviso al cobrador cuando se resuelve su movimiento + estados cerrados
-- ============================================================================
-- 1) REALTIME SOBRE gastosregistros
-- El cobrador registraba un gasto que quedaba "por aprobar" y nunca se
-- enteraba de si se lo aprobaron o se lo rechazaron: tenia que ir a buscarlo
-- a mano a "Ver Gastos". Ahora la app escucha los UPDATE de esta tabla y le
-- avisa a quien lo registro.
--
-- `REPLICA IDENTITY FULL` es imprescindible: sin eso el evento de UPDATE
-- llega SIN los valores anteriores, y la app necesita `old` para distinguir
-- "acaba de resolverse" de cualquier otra edicion de la fila.
--
-- 2) ESTADOS CERRADOS
-- `estadoadmin` y `estadosecre` eran texto libre. Un typo creaba un estado
-- fantasma que no aparecia en ningun filtro y dejaba el movimiento invisible
-- para todos. Con el CHECK, la base no lo acepta.
-- ============================================================================

ALTER TABLE public.gastosregistros REPLICA IDENTITY FULL;

-- Si la tabla ya estaba en la publicacion, el ADD falla. Se ignora ese caso.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.gastosregistros;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;


-- ── Estados validos ─────────────────────────────────────────────────────
-- Antes de crear el CHECK hay que ver si hay filas que no lo cumplan. Si
-- esta consulta devuelve algo, corrige esas filas ANTES de seguir: si no, el
-- ALTER TABLE va a fallar (y hace bien).
SELECT estadoadmin, estadosecre, count(*) AS filas
  FROM gastosregistros
 WHERE estadoadmin IS NULL
    OR estadosecre IS NULL
    OR estadoadmin NOT IN ('NA', 'por aprobar', 'aprobado', 'rechazado')
    OR estadosecre NOT IN ('NA', 'por aprobar', 'aprobado', 'rechazado')
 GROUP BY estadoadmin, estadosecre;

-- Si la consulta de arriba no devolvio nada, corre estas dos:
ALTER TABLE public.gastosregistros
  ADD CONSTRAINT gastosregistros_estadoadmin_check
  CHECK (estadoadmin IN ('NA', 'por aprobar', 'aprobado', 'rechazado'));

ALTER TABLE public.gastosregistros
  ADD CONSTRAINT gastosregistros_estadosecre_check
  CHECK (estadosecre IN ('NA', 'por aprobar', 'aprobado', 'rechazado'));

NOTIFY pgrst, 'reload schema';
