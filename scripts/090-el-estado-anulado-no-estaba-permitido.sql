-- ============================================================================
-- 090 - `anulado` no estaba permitido como estado
-- ============================================================================
-- DÓNDE VAMOS
-- El error cambió, y eso es la señal de que lo anterior sí quedó:
--
--   088 → faltaban las cuatro columnas          → creadas
--   089 → una función tenía `anualda_at`         → corregida
--   090 → `loans.estado` no admite 'anulado'     → este script
--
-- Ahora dice:
--
--   new row for relation "loans" violates check constraint "ch_loans_estado"
--
-- `ch_loans_estado` es una restricción que limita los valores de
-- `loans.estado`. Hoy admite los que se usan —'activo' y 'cancelado'— pero no
-- 'anulado', así que el UPDATE de `anular_venta` rebota contra ella.
--
-- POR QUÉ NO ESTABA
-- La restricción no aparece en ningún script del repositorio: se creó fuera,
-- como las tablas del `000-tablas-preexistentes.sql`. El script 068 agregó el
-- estado 'anulado' a la aplicación y a las funciones, pero nadie se lo agregó
-- a la restricción — y como el 068 tampoco llegó a correr entero, nunca se
-- probó una anulación de verdad hasta ahora.
--
-- CÓMO SE ARREGLA SIN ROMPER NADA
-- No se reescribe la restricción a mano. Se LEE la que está puesta y se le
-- agrega 'anulado' a la lista que ya tiene. Así, cualquier otro valor que
-- admita hoy —y que no esté en los datos, por lo que no se puede saber
-- mirándolos— se conserva. Reescribirla de memoria sería la forma de perderlo.
--
-- NO MUEVE UN PESO. Cambia qué valores se ACEPTAN en una columna. Ningún
-- crédito cambia de estado: los 160 activos y los 20 cancelados siguen igual.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Qué restricciones tiene hoy `loans` (SOLO LECTURA) ────────────
-- Corre esto PRIMERO y guarda el resultado. Sirve para dos cosas: ver qué
-- admite `ch_loans_estado` antes de tocarla, y saber si hay OTRA restricción
-- que vaya a estorbar después de esta.
SELECT c.conname                    AS restriccion,
       pg_get_constraintdef(c.oid)  AS definicion
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND t.relname = 'loans'
   AND c.contype = 'c'              -- solo las CHECK
 ORDER BY c.conname;


-- ── PASO 2) Agregarle 'anulado' a la lista ────────────────────────────────
-- Lee la restricción viva y le mete 'anulado' en el ARRAY que ya tiene, sin
-- tocar el resto. Si ya lo admitía, no hace nada y lo dice.
--
-- Aborta si la restricción no tiene la forma esperada, en vez de instalar algo
-- inventado: mejor un error claro que una tabla sin restricción.
DO $fix090$
DECLARE
  v_def   text;
  v_nuevo text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'loans' AND c.conname = 'ch_loans_estado';

  IF v_def IS NULL THEN
    RAISE NOTICE 'No existe ch_loans_estado en loans. No hay nada que hacer.';
    RETURN;
  END IF;

  IF position('anulado' IN v_def) > 0 THEN
    RAISE NOTICE 'ch_loans_estado ya admitía anulado: %', v_def;
    RETURN;
  END IF;

  -- PostgreSQL normaliza cualquier `IN (...)` a `= ANY (ARRAY[...])`, así que
  -- con encontrar el ARRAY alcanza para las dos formas de escribirla.
  IF position('ARRAY[' IN v_def) = 0 THEN
    RAISE EXCEPTION 'ch_loans_estado no tiene la forma esperada, no la toco: %', v_def;
  END IF;

  v_nuevo := replace(v_def, 'ARRAY[', 'ARRAY[''anulado''::text, ');

  EXECUTE 'ALTER TABLE public.loans DROP CONSTRAINT ch_loans_estado';
  EXECUTE 'ALTER TABLE public.loans ADD CONSTRAINT ch_loans_estado ' || v_nuevo;

  RAISE NOTICE 'Antes : %', v_def;
  RAISE NOTICE 'Ahora : %', v_nuevo;
END
$fix090$;


-- ── PASO 3) LA MISMA TRAMPA, EN `multas` ──────────────────────────────────
-- `anular_venta` termina cancelando las multas pendientes del crédito:
--
--   UPDATE multas SET estado = 'cancelada' ... WHERE estado = 'pendiente'
--
-- Y `multas.estado` hoy solo ha tenido dos valores: 'pendiente' (7) y 'pagada'
-- (3). Si tiene una restricción como la de `loans`, 'cancelada' rebota igual —
-- y solo se notaría al anular una venta que TENGA una multa pendiente, o sea
-- el día menos pensado y no hoy.
--
-- Se le da el mismo trato: leer la que hay y agregarle el valor. Si no tiene
-- restricción, no hace nada.
DO $multas090$
DECLARE
  v_def   text;
  v_nom   text;
  v_nuevo text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_nom, v_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'multas' AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%estado%'
   LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE 'multas no tiene restricción sobre estado. Nada que hacer.';
    RETURN;
  END IF;

  IF position('cancelada' IN v_def) > 0 THEN
    RAISE NOTICE '% ya admitía cancelada: %', v_nom, v_def;
    RETURN;
  END IF;

  IF position('ARRAY[' IN v_def) = 0 THEN
    RAISE EXCEPTION '% no tiene la forma esperada, no la toco: %', v_nom, v_def;
  END IF;

  v_nuevo := replace(v_def, 'ARRAY[', 'ARRAY[''cancelada''::text, ');
  EXECUTE format('ALTER TABLE public.multas DROP CONSTRAINT %I', v_nom);
  EXECUTE format('ALTER TABLE public.multas ADD CONSTRAINT %I %s', v_nom, v_nuevo);

  RAISE NOTICE 'Antes : %', v_def;
  RAISE NOTICE 'Ahora : %', v_nuevo;
END
$multas090$;


-- ── PASO 4) Que quedó (SOLO LECTURA) ──────────────────────────────────────
-- `admite_anulado` tiene que dar true, y en la definición deben seguir estando
-- los valores que había antes. Compárala con la del PASO 1.
SELECT c.conname                              AS restriccion,
       pg_get_constraintdef(c.oid)            AS definicion,
       position('anulado' IN pg_get_constraintdef(c.oid)) > 0 AS admite_anulado
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname = 'loans' AND c.conname = 'ch_loans_estado';


-- ── PASO 5) Que ningún crédito se movió (SOLO LECTURA) ────────────────────
-- Se esperan 160 activos y 20 cancelados, igual que antes. `anulado` sigue en
-- cero hasta que alguien anule una venta desde Control Total.
SELECT estado, COUNT(*) AS cuantas
  FROM public.loans
 GROUP BY estado
 ORDER BY cuantas DESC;


-- ── PASO 6) La prueba de fuego, ya en la app ──────────────────────────────
-- Anula una venta desde Control Total y corre esto. Tiene que salir la venta
-- con su fecha, quién la anuló y el motivo.
SELECT l.id, l.ruta, c.nombre_completo, l.estado,
       l.anulada_at, l.anulada_por_nombre, l.motivo_anulacion
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.anulada_at DESC;


-- ── PASO 7) Y que la venta anulada salió de la cartera (SOLO LECTURA) ─────
-- El crédito anulado NO debe aparecer acá. Si aparece, el monitoreo le sigue
-- contando cartera viva a una venta que ya no existe — es lo que avisaba el
-- PASO 8 del script 088.
SELECT l.id, l.ruta, l.estado, f.saldo, f.cuotas_mora
  FROM public.loans l
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
 WHERE l.estado = 'anulado';
