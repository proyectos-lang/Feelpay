-- ============================================================================
-- 091 - `anulado`, buscando la restricción por lo que hace y no por su nombre
-- ============================================================================
-- QUÉ FALLÓ DEL 090
-- El 090 buscaba la restricción por nombre exacto: `ch_loans_estado`. El nombre
-- de verdad es `chk_loans_estado`, con k. Así que el bloque no encontró nada,
-- dijo "no existe" por consola y no tocó nada — por eso el error es idéntico
-- después de correrlo.
--
-- Este script no depende del nombre. Busca en `loans` CUALQUIER restricción
-- CHECK cuya definición hable de `estado` y no admita todavía 'anulado', y le
-- agrega el valor. Da igual cómo se llame.
--
-- LO DEMÁS SIGUE IGUAL QUE EN EL 090
-- No se reescribe la restricción a mano: se lee la que está puesta y se le
-- agrega el valor al ARRAY que ya tiene, para conservar cualquier otro que
-- admita hoy y que no esté en los datos. Aborta —o se salta esa restricción—
-- si no tiene la forma esperada, en vez de dejar la tabla sin protección.
--
-- Y se hace lo mismo con `multas`, que necesita 'cancelada' por la misma razón
-- que explicaba el 090: `anular_venta` termina cancelando las multas
-- pendientes del crédito, y esa columna hoy solo ha tenido 'pendiente' y
-- 'pagada'.
--
-- El 090 se puede dar por muerto: este lo reemplaza y hace su trabajo entero.
--
-- NO MUEVE UN PESO. Cambia qué valores se ACEPTAN en dos columnas. Ningún
-- crédito cambia de estado.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Cómo se llaman de verdad (SOLO LECTURA) ───────────────────────
-- Corre esto PRIMERO. Acá se ve el nombre real y qué valores admite cada una,
-- que es lo que faltaba saber.
SELECT t.relname                    AS tabla,
       c.conname                    AS restriccion,
       pg_get_constraintdef(c.oid)  AS definicion
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND t.relname IN ('loans', 'multas')
   AND c.contype = 'c'
 ORDER BY t.relname, c.conname;


-- ── PASO 2) Agregar el valor que falta, se llame como se llame ────────────
-- Recorre las dos tablas buscando restricciones CHECK que hablen de `estado`
-- y les falte el valor.
--
-- Los nombres y definiciones se recogen ANTES de tocar nada. Modificar
-- restricciones mientras se recorre el catálogo que las lista es la clase de
-- cosa que funciona hasta el día que no.
DO $fix091$
DECLARE
  v_tabla  text;
  v_valor  text;
  v_nombres text[];
  v_defs    text[];
  v_i       int;
  v_nuevo   text;
  v_hechas  int := 0;
BEGIN
  FOREACH v_tabla IN ARRAY ARRAY['loans', 'multas'] LOOP
    v_valor := CASE v_tabla WHEN 'loans' THEN 'anulado' ELSE 'cancelada' END;

    SELECT array_agg(c.conname::text), array_agg(pg_get_constraintdef(c.oid))
      INTO v_nombres, v_defs
      FROM pg_constraint c
      JOIN pg_class t     ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = v_tabla
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%estado%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%' || v_valor || '%';

    IF v_nombres IS NULL THEN
      RAISE NOTICE '% : no hay ninguna restricción de estado a la que le falte "%"', v_tabla, v_valor;
      CONTINUE;
    END IF;

    FOR v_i IN 1..array_length(v_nombres, 1) LOOP
      IF position('ARRAY[' IN v_defs[v_i]) = 0 THEN
        RAISE NOTICE '% : me salto % porque no tiene la forma esperada: %',
                     v_tabla, v_nombres[v_i], v_defs[v_i];
        CONTINUE;
      END IF;

      v_nuevo := replace(v_defs[v_i], 'ARRAY[', 'ARRAY[''' || v_valor || '''::text, ');
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_tabla, v_nombres[v_i]);
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', v_tabla, v_nombres[v_i], v_nuevo);
      v_hechas := v_hechas + 1;

      RAISE NOTICE '% : % arreglada', v_tabla, v_nombres[v_i];
      RAISE NOTICE '    antes : %', v_defs[v_i];
      RAISE NOTICE '    ahora : %', v_nuevo;
    END LOOP;
  END LOOP;

  IF v_hechas = 0 THEN
    RAISE NOTICE 'No hubo nada que cambiar. Si el error sigue, manda lo que salga del PASO 1.';
  ELSE
    RAISE NOTICE 'Listo: % restricción(es) arreglada(s).', v_hechas;
  END IF;
END
$fix091$;


-- ── PASO 3) Que quedaron (SOLO LECTURA) ───────────────────────────────────
-- La de `loans` tiene que decir true en `admite_el_valor`, y la de `multas`
-- también. Y en las definiciones deben seguir estando los valores de antes:
-- compáralas con las del PASO 1.
SELECT t.relname                    AS tabla,
       c.conname                    AS restriccion,
       pg_get_constraintdef(c.oid)  AS definicion,
       pg_get_constraintdef(c.oid) LIKE
         '%' || CASE t.relname WHEN 'loans' THEN 'anulado' ELSE 'cancelada' END || '%'
                                    AS admite_el_valor
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND t.relname IN ('loans', 'multas')
   AND c.contype = 'c'
   AND pg_get_constraintdef(c.oid) LIKE '%estado%'
 ORDER BY t.relname;


-- ── PASO 4) Que ningún crédito se movió (SOLO LECTURA) ────────────────────
-- Se esperan 160 activos y 20 cancelados. `anulado` sigue en cero hasta que
-- alguien anule una venta desde Control Total.
SELECT estado, COUNT(*) AS cuantas
  FROM public.loans
 GROUP BY estado
 ORDER BY cuantas DESC;


-- ── PASO 5) La prueba de fuego, ya en la app ──────────────────────────────
-- Anula una venta desde Control Total y corre esto. Tiene que salir con su
-- fecha, quién la anuló y el motivo.
SELECT l.id, l.ruta, c.nombre_completo, l.estado,
       l.anulada_at, l.anulada_por_nombre, l.motivo_anulacion
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.anulada_at DESC;


-- ── PASO 6) Y que salió de la cartera (SOLO LECTURA) ──────────────────────
-- El crédito anulado NO debe aparecer acá. Si aparece, el monitoreo le sigue
-- contando cartera viva a una venta que ya no existe.
SELECT l.id, l.ruta, l.estado, f.saldo, f.cuotas_mora
  FROM public.loans l
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
 WHERE l.estado = 'anulado';
