-- ============================================================================
-- 051 - Editar un movimiento de caja dejando rastro
-- ============================================================================
-- Hasta ahora un ingreso, gasto o retiro mal registrado no se podía corregir:
-- había que pedirle a alguien que lo arreglara en la base, o dejarlo mal. El
-- asesor ahora puede editar los suyos del día mientras nadie los haya
-- aprobado, y secretaría puede editar cualquiera desde Control Total.
--
-- POR QUÉ EL RASTRO
-- `gastosregistros` no es el libro de eventos de los préstamos: no tiene
-- reversas ni nada parecido, un UPDATE pisa el valor y no queda constancia.
-- Y esto SÍ es plata: la vista `resumen_pagos_diarios` suma los movimientos
-- con `estadosecre = 'aprobado' OR estadoadmin = 'NA'`, así que corregir el
-- valor de un movimiento 'NA' cambia la caja de ese día hacia atrás. Sin
-- rastro, un movimiento corregido queda idéntico a uno que siempre fue así,
-- y el descuadre de una caja no se puede explicar.
--
-- Estas columnas guardan lo MÍNIMO para poder explicar un cambio: quién,
-- cuándo, cuántas veces, y qué decía antes. No es un historial completo —
-- si se edita dos veces solo sobrevive el valor previo a la última edición—
-- pero alcanza para auditar el caso real: corregir un error de digitación.
--
-- Correr los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Las columnas del rastro ───────────────────────────────────────
-- Todas nullable: los movimientos que ya existen nunca se editaron, y ese
-- NULL es justamente la señal de "este nunca se tocó".
ALTER TABLE public.gastosregistros
  ADD COLUMN IF NOT EXISTS editado_por TEXT,
  ADD COLUMN IF NOT EXISTS fechahoraedicion TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS veces_editado INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS valor_anterior NUMERIC,
  ADD COLUMN IF NOT EXISTS concepto_anterior TEXT,
  ADD COLUMN IF NOT EXISTS observacion_anterior TEXT;


-- ── PASO 2) Que el contador no pueda mentir ───────────────────────────────
-- Si hay firma de edición tiene que haber contador, y al revés. Sin esto se
-- podría guardar `editado_por` con `veces_editado = 0` y la lista mostraría
-- "editado" sin que ningún contador lo respalde.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_gastosregistros_edicion') THEN
    ALTER TABLE public.gastosregistros
      ADD CONSTRAINT chk_gastosregistros_edicion CHECK (
        (veces_editado = 0 AND editado_por IS NULL AND fechahoraedicion IS NULL)
        OR
        (veces_editado > 0 AND editado_por IS NOT NULL AND fechahoraedicion IS NOT NULL)
      );
  END IF;
END $$;


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
-- Debe devolver todo en 0 la primera vez: nadie ha editado nada todavía.
SELECT count(*)                                        AS movimientos_totales,
       count(*) FILTER (WHERE veces_editado > 0)        AS editados,
       count(*) FILTER (WHERE estadoadmin = 'NA')       AS sin_aprobacion_requerida,
       count(*) FILTER (WHERE estadoadmin = 'aprobado') AS aprobados
  FROM public.gastosregistros;
