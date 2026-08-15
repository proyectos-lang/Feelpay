-- ============================================================================
-- 041 - Fundamentos de la reestructuración del núcleo
-- ============================================================================
-- PARTE DE LA FASE 1 (reestructuración cronograma / eventos / estado derivado).
--
-- CUÁNDO CORRERLO: en la ceremonia del corte, ANTES del reset. El orden
-- completo de la ceremonia está en el encabezado del script 049.
-- Los scripts 041→048 son aditivos: no rompen la app vieja por sí solos.
--
-- QUÉ HACE ESTE SCRIPT
--   1) Captura (solo lectura) el DDL de las tablas que existen en la base
--      pero no están en el repo — comparte el resultado para documentarlas.
--   2) Agrega a `clients` las columnas que el formulario de venta siempre
--      envió y la RPC descartaba en silencio.
--   3) Agrega a `loans` `cuenta_id` (venta por transferencia) y `origen`
--      ('normal' | 'homologado') — las ventas homologadas de otro sistema
--      no deben contar en la caja del día.
--   4) CHECKs de estado en `payment_plan` y `loans` (NOT VALID: los datos
--      viejos no se validan; el 049 los valida sobre la base ya vacía).
--   5) FK de `multas.loan_id` e índice (loan_id, fecha_pago).
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 0a) SOLO LECTURA: columnas de las tablas sin DDL en el repo ──────
-- Comparte el resultado: sirve para escribir su CREATE TABLE documental.
SELECT table_name, ordinal_position, column_name, data_type,
       is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('usuarios','rutas','usuario_rutas','gastosregistros',
                      'rutas_diarias','cuentas','admin','gastos','ingresos','retiros')
 ORDER BY table_name, ordinal_position;


-- ── PASO 0b) SOLO LECTURA: definición de la vista de monitoreo ────────────
SELECT pg_get_viewdef('public.vista_monitoreo_admin'::regclass, true) AS definicion;


-- ── PASO 0c) SOLO LECTURA: definición de login_usuario ────────────────────
SELECT p.proname, pg_get_functiondef(p.oid) AS definicion
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'login_usuario';


-- ── PASO 1) Columnas de clients que la venta enviaba y se perdían ─────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS telefono2      TEXT,
  ADD COLUMN IF NOT EXISTS tipo_comercio  TEXT,
  ADD COLUMN IF NOT EXISTS ref1_nombre    TEXT,
  ADD COLUMN IF NOT EXISTS ref1_telefono  TEXT,
  ADD COLUMN IF NOT EXISTS ref1_direccion TEXT;


-- ── PASO 2) Columnas nuevas de loans ──────────────────────────────────────
-- `cuenta_id`: cuenta de la venta por transferencia (antes se descartaba).
-- `origen`: 'homologado' = venta migrada de otro sistema con su historia;
--           no cuenta como venta del día en la caja.
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS cuenta_id BIGINT,
  ADD COLUMN IF NOT EXISTS origen    TEXT NOT NULL DEFAULT 'normal';


-- ── PASO 3) CHECK de loans.origen ─────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_loans_origen') THEN
    ALTER TABLE public.loans ADD CONSTRAINT chk_loans_origen
      CHECK (origen IN ('normal','homologado'));
  END IF;
END $$;


-- ── PASO 4) CHECK de payment_plan.estado (NOT VALID) ──────────────────────
-- El contrato de 5 estados vivía solo dentro de ajustar_cuota_control_pagos.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_plan_estado') THEN
    ALTER TABLE public.payment_plan ADD CONSTRAINT chk_payment_plan_estado
      CHECK (estado IN ('pendiente','pagado','parcial','no_pago','cancelada')) NOT VALID;
  END IF;
END $$;


-- ── PASO 5) CHECK de loans.estado (NOT VALID) ─────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_loans_estado') THEN
    ALTER TABLE public.loans ADD CONSTRAINT chk_loans_estado
      CHECK (estado IN ('activo','cancelado','inactivo')) NOT VALID;
  END IF;
END $$;


-- ── PASO 6) FK de multas.loan_id (NOT VALID) ──────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'multas_loan_id_fkey') THEN
    ALTER TABLE public.multas ADD CONSTRAINT multas_loan_id_fkey
      FOREIGN KEY (loan_id) REFERENCES public.loans(id) NOT VALID;
  END IF;
END $$;


-- ── PASO 7) Índice compuesto del cronograma ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pp_loan_fecha
  ON public.payment_plan (loan_id, fecha_pago);


-- ── PASO 8) Verificar ─────────────────────────────────────────────────────
-- Deben aparecer las 4 restricciones nuevas y el índice.
SELECT conname::text AS objeto, conrelid::regclass::text AS tabla,
       convalidated AS validada
  FROM pg_constraint
 WHERE conname IN ('chk_loans_origen','chk_payment_plan_estado',
                   'chk_loans_estado','multas_loan_id_fkey')
UNION ALL
SELECT indexname::text, tablename::text, true
  FROM pg_indexes
 WHERE schemaname = 'public' AND indexname = 'idx_pp_loan_fecha';
