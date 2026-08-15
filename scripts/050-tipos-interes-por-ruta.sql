-- ============================================================================
-- 050 - Qué tipos de interés usa cada unidad, y cuál por defecto
-- ============================================================================
-- Hasta ahora el formulario de venta ofrecía SIEMPRE los dos métodos de
-- interés, en todas las rutas, sin ninguno preseleccionado. Pero una unidad
-- suele trabajar con uno solo: ofrecer el otro es una forma silenciosa de
-- equivocarse, y el vendedor tenía que acordarse de elegir el correcto en
-- cada venta.
--
-- Ahora secretaría define, por ruta:
--   · qué métodos están habilitados  → el formulario solo muestra esos
--   · cuál es el predeterminado      → llega elegido en la venta nueva
--
-- Los nombres que ve el usuario cambiaron para que digan lo que hacen:
--   'aleman'    → "Cuota fija"      (todas las cuotas valen lo mismo)
--   'americano' → "Cuota interés"   (se paga interés y el capital al final)
-- El VALOR guardado no cambia: sigue siendo 'aleman' / 'americano', así que
-- nada de lo que ya existe se toca.
--
-- Correr los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Las columnas ──────────────────────────────────────────────────
-- El default deja las dos habilitadas: una ruta que no se configure sigue
-- comportándose exactamente como hasta hoy.
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS amortizaciones_habilitadas TEXT[] NOT NULL
    DEFAULT ARRAY['aleman','americano']::text[],
  ADD COLUMN IF NOT EXISTS amortizacion_default TEXT;


-- ── PASO 2) Que no se pueda guardar basura ────────────────────────────────
-- Al menos un método habilitado (una ruta sin ninguno no podría vender), y
-- solo los dos valores que existen.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_amortizaciones_habilitadas') THEN
    ALTER TABLE public.ruta_config_umbrales
      ADD CONSTRAINT chk_amortizaciones_habilitadas CHECK (
        array_length(amortizaciones_habilitadas, 1) >= 1
        AND amortizaciones_habilitadas <@ ARRAY['aleman','americano']::text[]
      );
  END IF;
END $$;


-- ── PASO 3) El predeterminado tiene que estar habilitado ──────────────────
-- Sin esto se podría dejar como predeterminado un método que el formulario
-- no muestra, y la venta llegaría con un tipo que nadie puede elegir.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_amortizacion_default') THEN
    ALTER TABLE public.ruta_config_umbrales
      ADD CONSTRAINT chk_amortizacion_default CHECK (
        amortizacion_default IS NULL
        OR amortizacion_default = ANY (amortizaciones_habilitadas)
      );
  END IF;
END $$;


-- ── PASO 4) Verificar ─────────────────────────────────────────────────────
-- Una fila por ruta configurada, con lo que quedó.
SELECT ruta_id,
       amortizaciones_habilitadas,
       COALESCE(amortizacion_default, '(ninguno)') AS predeterminado
  FROM public.ruta_config_umbrales
 ORDER BY ruta_id;
