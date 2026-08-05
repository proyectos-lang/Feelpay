-- ============================================================
-- 025 - Valor de la multa: fijo en $ o multiplicador de cuotas
-- ============================================================
-- multa_tipo_valor = 'fijo'   -> usa multa_valor (pesos, ya existia)
-- multa_tipo_valor = 'cuotas' -> multa = multa_cantidad_cuotas * valor_cuota
--                                del prestamo (multiplicador fijo, no escala
--                                con la cantidad de cuotas realmente vencidas)
-- ============================================================

ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS multa_tipo_valor TEXT NOT NULL DEFAULT 'fijo'
    CHECK (multa_tipo_valor IN ('fijo', 'cuotas'));

ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS multa_cantidad_cuotas NUMERIC(6,2);
