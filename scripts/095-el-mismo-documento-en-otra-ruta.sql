-- ============================================================================
-- 095 - El mismo documento puede estar en otra ruta
-- ============================================================================
-- LO QUE SE PIDIÓ
-- Que una misma persona pueda estar dada de alta en varias rutas. Hoy no se
-- puede: `clients.documento` es UNIQUE en toda la tabla desde el script 001 —
--
--     documento VARCHAR(50) NOT NULL UNIQUE
--
-- así que el segundo intento rebota con 23505 y el cobrador ve "Ya existe un
-- cliente con ese documento", aunque ese cliente esté en otra ruta, a mil
-- kilómetros y con otro cobrador.
--
-- LO QUE CAMBIA
-- La unicidad pasa a ser POR RUTA: `UNIQUE (ruta, documento)`.
--
--   · el mismo documento en la 190 y en la 196  → ahora SÍ
--   · el mismo documento dos veces en la 190    → sigue rebotando
--
-- Esa segunda mitad importa tanto como la primera: es lo que evita que el
-- mismo señor quede cargado dos veces en la misma ruta y aparezca duplicado en
-- la lista del cobrador.
--
-- POR QUÉ NO ROMPE NADA QUE YA EXISTA
-- Medido contra la base el 02/09/2026: 315 clientes, CERO documentos repetidos
-- y CERO clientes sin documento. Todos tienen ruta —55 en la 1, 20 en la 2, 37
-- en la 112, 22 en la 151, 16 en la 154, 39 en la 168, 56 en la 190, 5 en la
-- 196, 13 en la 197 y 52 en la 933—. La restricción nueva es más floja que la
-- vieja, así que todo lo que pasaba antes sigue pasando.
--
-- POR QUÉ NO ROMPE LA APLICACIÓN
-- Se revisó cada lugar donde la app toca `clients`. NINGUNO busca un cliente
-- por documento a secas:
--
--   · la lista de "Cliente Existente" filtra `.eq("ruta", rutaId)` y busca por
--     apodo — components/views/new-loan.tsx
--   · el detalle del cliente y el recibo van por `id` — register-payment.tsx
--   · `GET /api/clients` filtra por ruta y busca por apodo
--   · `crear_venta_atomica` INSERTA el cliente nuevo con `p_ruta_id`, y para
--     una renovación usa el `id` que le manda el formulario, nunca el
--     documento — scripts/078
--
-- El documento se muestra y se busca dentro de listas que ya vienen filtradas
-- por ruta. Nadie lo usa como llave.
--
-- LO QUE HAY QUE SABER IGUAL
-- Dos fichas del mismo documento son DOS CLIENTES DISTINTOS, con id distinto y
-- su propia cartera. No se comparte nada entre ellas: ni el saldo, ni la mora,
-- ni la foto de la cédula, ni la ubicación. Es a propósito —cada ruta lleva su
-- relación con esa persona— pero conviene tenerlo claro antes de usarlo.
--
-- Corre los pasos DE A UNO. El editor de Supabase mete todo lo que se le pega
-- en una sola transacción, y si un paso falla se deshacen los anteriores.
-- ============================================================================


-- ── PASO 1) Qué hay hoy sobre `documento` (SOLO LECTURA) ──────────────────
-- Corre esto PRIMERO y guarda el resultado. La fila que interesa es la que
-- tenga `definicion = 'UNIQUE (documento)'`: esa es la que hay que cambiar.
--
-- Salen las restricciones y TAMBIÉN los índices, porque una unicidad puede
-- estar puesta de las dos formas y se quitan distinto.
SELECT 'restriccion'                AS tipo,
       c.conname                    AS nombre,
       pg_get_constraintdef(c.oid)  AS definicion
  FROM pg_constraint c
  JOIN pg_class t     ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname = 'clients' AND c.contype = 'u'
UNION ALL
SELECT 'indice', i.indexname, i.indexdef
  FROM pg_indexes i
 WHERE i.schemaname = 'public' AND i.tablename = 'clients'
   AND i.indexdef ILIKE '%unique%'
 ORDER BY 1, 2;


-- ── PASO 2) Que ningún par (ruta, documento) choque (SOLO LECTURA) ────────
-- TIENE QUE SALIR VACÍO. Si sale una fila, hay dos fichas con el mismo
-- documento EN LA MISMA RUTA y el PASO 3 no va a poder crear la restricción
-- nueva: hay que resolver esas primero.
--
-- Medido hoy: vacío.
SELECT ruta,
       documento,
       COUNT(*)                              AS fichas,
       string_agg(nombre_completo, ' | ')     AS quienes
  FROM public.clients
 GROUP BY ruta, documento
HAVING COUNT(*) > 1
 ORDER BY ruta, documento;


-- ── PASO 3) Cambiar la unicidad ───────────────────────────────────────────
-- Primero AGREGA la nueva y después quita la vieja, en ese orden y dentro del
-- mismo bloque: en ningún momento la tabla queda sin protección. Si algo falla
-- en medio, no queda nada a medias.
--
-- La vieja se busca POR LO QUE HACE, no por su nombre. Es la lección del
-- script 090: ahí se buscó `ch_loans_estado` por nombre exacto, el nombre real
-- era `chk_loans_estado`, y el script corrió sin hacer absolutamente nada.
--
-- Se contemplan las dos formas de tener puesta una unicidad —restricción o
-- índice único— porque se quitan con sentencias distintas.
DO $doc095$
DECLARE
  v_nom      text;
  v_def      text;
  v_idx      text;
  v_ya_esta  boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t     ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'clients' AND c.contype = 'u'
       AND pg_get_constraintdef(c.oid) IN ('UNIQUE (ruta, documento)',
                                           'UNIQUE (documento, ruta)')
  ) INTO v_ya_esta;

  IF v_ya_esta THEN
    RAISE NOTICE 'La unicidad por (ruta, documento) ya estaba puesta.';
  ELSE
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_ruta_documento_key UNIQUE (ruta, documento);
    RAISE NOTICE 'Puesta: UNIQUE (ruta, documento).';
  END IF;

  -- ── La vieja, la que abarca TODA la tabla ──
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_nom, v_def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'clients' AND c.contype = 'u'
     AND pg_get_constraintdef(c.oid) = 'UNIQUE (documento)'
   LIMIT 1;

  IF v_nom IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.clients DROP CONSTRAINT %I', v_nom);
    RAISE NOTICE 'Quitada la restriccion % (%).', v_nom, v_def;
    RETURN;
  END IF;

  -- No era una restricción: puede estar como índice único suelto.
  SELECT i.indexname INTO v_idx
    FROM pg_indexes i
   WHERE i.schemaname = 'public' AND i.tablename = 'clients'
     AND i.indexdef ILIKE '%unique%'
     AND i.indexdef ILIKE '%(documento)%'
   LIMIT 1;

  IF v_idx IS NOT NULL THEN
    EXECUTE format('DROP INDEX public.%I', v_idx);
    RAISE NOTICE 'Quitado el indice unico %.', v_idx;
    RETURN;
  END IF;

  RAISE NOTICE 'No habia unicidad global sobre documento. Nada mas que quitar.';
END
$doc095$;


-- ── PASO 4) Que quedó como se quería (SOLO LECTURA) ───────────────────────
-- Tiene que salir `UNIQUE (ruta, documento)` y NO puede salir
-- `UNIQUE (documento)`. Compará con el PASO 1.
SELECT 'restriccion'                AS tipo,
       c.conname                    AS nombre,
       pg_get_constraintdef(c.oid)  AS definicion
  FROM pg_constraint c
  JOIN pg_class t     ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname = 'clients' AND c.contype = 'u'
UNION ALL
SELECT 'indice', i.indexname, i.indexdef
  FROM pg_indexes i
 WHERE i.schemaname = 'public' AND i.tablename = 'clients'
   AND i.indexdef ILIKE '%unique%'
 ORDER BY 1, 2;


-- ── PASO 5) Que ningún cliente se movió (SOLO LECTURA) ────────────────────
-- Se esperan 315 clientes repartidos igual que antes: 55 en la 1, 20 en la 2,
-- 37 en la 112, 22 en la 151, 16 en la 154, 39 en la 168, 56 en la 190, 5 en
-- la 196, 13 en la 197 y 52 en la 933. Cambiar una restricción no toca una
-- sola fila; esto es para poder decirlo con el número delante.
SELECT ruta, COUNT(*) AS clientes
  FROM public.clients
 GROUP BY ruta
 ORDER BY ruta;


-- ── PASO 6) La prueba de fuego, ya en la app ──────────────────────────────
-- Registrá en una ruta una venta a un cliente NUEVO con un documento que ya
-- exista en OTRA ruta. Tiene que dejar. Después corré esto: salen las dos
-- fichas, con id distinto y su ruta.
--
-- Y probá el otro lado: el mismo documento dos veces en la MISMA ruta tiene
-- que seguir rebotando con "Documento ya registrado en esta ruta".
SELECT documento,
       COUNT(*)                                        AS en_cuantas_rutas,
       string_agg(ruta::text || ': ' || nombre_completo, '  |  ' ORDER BY ruta) AS fichas
  FROM public.clients
 GROUP BY documento
HAVING COUNT(*) > 1
 ORDER BY documento;
