-- ============================================================================
-- 018 - Umbral de abonos: por cantidad de cuotas, no por monto
-- ============================================================================
-- El umbral de abonos deja de comparar el monto en pesos y pasa a comparar
-- la cantidad de cuotas que se pagan de una sola vez (selector "Nro Cuotas"
-- en register-payment.tsx, solo aplica a "pago normal" -- pago parcial y
-- cancelacion total nunca disparan este umbral).
--
-- El valor anterior de abono_umbral era un monto en pesos y ya no aplica
-- bajo el nuevo esquema; se resetea (deshabilitado) para forzar
-- reconfiguracion explicita por parte de secretaria.
-- ============================================================================

UPDATE public.ruta_config_umbrales SET abono_umbral = NULL, abono_habilitado = false;

ALTER TABLE public.ruta_config_umbrales RENAME COLUMN abono_umbral TO abono_umbral_cuotas;
ALTER TABLE public.ruta_config_umbrales ALTER COLUMN abono_umbral_cuotas TYPE INTEGER USING abono_umbral_cuotas::integer;
