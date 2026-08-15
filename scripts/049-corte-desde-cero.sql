-- ============================================================================
-- 049 - EL CORTE: reset desde cero y arranque del núcleo nuevo
-- ============================================================================
-- ⚠️  ESTE SCRIPT BORRA TODOS LOS PRÉSTAMOS, PLANES DE PAGO Y GESTIONES. ⚠️
-- Decisión del dueño (2026-08-15): comenzar desde cero; los préstamos
-- vigentes se recrean como VENTAS HOMOLOGADAS con su historia real.
--
-- ══════════════════ CEREMONIA COMPLETA DEL CORTE ══════════════════
--
--   1. Cerrar el día en TODAS las rutas y verificar que ningún dispositivo
--      tenga operaciones pendientes en la cola offline (indicador del
--      header en cada teléfono). Nada capturado sin sincronizar.
--   2. BACKUP: Supabase → Database → Backups → Create backup.
--   3. Correr los scripts 041 → 048, en orden. Son aditivos: crean el
--      núcleo nuevo sin romper nada de lo viejo.
--   4. Correr ESTE script (los pasos de borrado y validación).
--   5. Publicar la app nueva (deploy).
--   6. Recrear los préstamos vigentes desde el módulo de ventas como
--      ventas homologadas (fecha de inicio real + qué días pagó / no pagó
--      → el saldo queda exacto al día). Las ventas nuevas, por el flujo
--      normal.
--   7. Verificación post-corte: el PASO 14 de este script y el PASO 6 del
--      script 043 (paridad cache == vista) deben dar cero problemas.
--
-- QUÉ SE CONSERVA: clients (con tiene_prestamo_activo = false), usuarios,
-- rutas, configuración de umbrales/multas/geocerca, chat, informes,
-- documentos. Los movimientos de caja (gastosregistros) y las rutas
-- diarias se conservan por defecto — hay un bloque OPCIONAL comentado.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 0) SOLO LECTURA: qué se va a borrar ──────────────────────────────
SELECT 'loans' AS tabla, COUNT(*) AS filas FROM loans
UNION ALL SELECT 'payment_plan', COUNT(*) FROM payment_plan
UNION ALL SELECT 'gestiones', COUNT(*) FROM gestiones
UNION ALL SELECT 'multas', COUNT(*) FROM multas
UNION ALL SELECT 'solicitudes_revision', COUNT(*) FROM solicitudes_revision
UNION ALL SELECT 'operaciones_procesadas', COUNT(*) FROM operaciones_procesadas
UNION ALL SELECT 'ajustes_manuales_cuota', COUNT(*) FROM ajustes_manuales_cuota
UNION ALL SELECT 'clients (se conservan)', COUNT(*) FROM clients;


-- ── PASO 1) Solicitudes de revisión ───────────────────────────────────────
DELETE FROM solicitudes_revision;


-- ── PASO 2) Multas ────────────────────────────────────────────────────────
DELETE FROM multas;


-- ── PASO 3) Bitácora de ajustes manuales (del sistema viejo) ──────────────
DELETE FROM ajustes_manuales_cuota;


-- ── PASO 4) Llaves de idempotencia ────────────────────────────────────────
DELETE FROM operaciones_procesadas;


-- ── PASO 5) Apagar el candado de inmutabilidad para poder vaciar ──────────
ALTER TABLE public.gestiones DISABLE TRIGGER trg_gestiones_inmutables;


-- ── PASO 6) Vaciar el ledger ──────────────────────────────────────────────
DELETE FROM gestiones;


-- ── PASO 7) Volver a encender el candado ──────────────────────────────────
ALTER TABLE public.gestiones ENABLE TRIGGER trg_gestiones_inmutables;


-- ── PASO 8) Planes de pago ────────────────────────────────────────────────
DELETE FROM payment_plan;


-- ── PASO 9) Préstamos ─────────────────────────────────────────────────────
DELETE FROM loans;


-- ── PASO 10) Clientes: quedan, pero sin préstamo activo ───────────────────
UPDATE clients SET tiene_prestamo_activo = false, updated_at = NOW()
 WHERE tiene_prestamo_activo IS DISTINCT FROM false;


-- ── PASO OPCIONAL (comentado): caja y rutas diarias desde cero ────────────
-- Descomenta SOLO si también quieres arrancar la caja en ceros.
-- DELETE FROM gastosregistros;
-- DELETE FROM rutas_diarias;


-- ── PASO 11) Validar los CHECKs (la base ya está vacía: es instantáneo) ───
ALTER TABLE public.payment_plan VALIDATE CONSTRAINT chk_payment_plan_estado;


-- ── PASO 12) ──────────────────────────────────────────────────────────────
ALTER TABLE public.loans VALIDATE CONSTRAINT chk_loans_estado;


-- ── PASO 13) ──────────────────────────────────────────────────────────────
ALTER TABLE public.multas VALIDATE CONSTRAINT multas_loan_id_fkey;


-- ── PASO 14) Verificar: todo en cero y restricciones validadas ────────────
SELECT 'loans' AS tabla, COUNT(*) AS filas FROM loans
UNION ALL SELECT 'payment_plan', COUNT(*) FROM payment_plan
UNION ALL SELECT 'gestiones', COUNT(*) FROM gestiones
UNION ALL SELECT 'multas', COUNT(*) FROM multas
UNION ALL SELECT 'solicitudes_revision', COUNT(*) FROM solicitudes_revision
UNION ALL SELECT 'operaciones_procesadas', COUNT(*) FROM operaciones_procesadas
UNION ALL SELECT 'clientes_con_prestamo_activo',
                 COUNT(*) FROM clients WHERE tiene_prestamo_activo
UNION ALL SELECT 'restricciones_sin_validar',
                 COUNT(*) FROM pg_constraint
                  WHERE conname IN ('chk_payment_plan_estado','chk_loans_estado',
                                    'multas_loan_id_fkey')
                    AND NOT convalidated;
