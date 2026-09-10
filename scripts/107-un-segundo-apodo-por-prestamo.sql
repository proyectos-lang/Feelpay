-- ============================================================================
-- 107 - Un segundo apodo, y cada prestamo elige con cual se ve
-- ============================================================================
-- LO QUE SE PIDIO
--   * Que las referencias no sean obligatorias al crear una venta.
--   * Un campo "apodo 2" en la creacion y gestion de clientes.
--   * Que al crear la venta se elija con que apodo aparece el prestamo, y que
--     ese apodo sea el que se ve en toda la gestion de ESE prestamo.
--   * Que en Ver Ventas —tanto el cobrador como secretaria— se vean los dos
--     apodos y se pueda cambiar cual se usa.
--
-- LAS REFERENCIAS YA ERAN OPCIONALES EN LA BASE. `ref1_nombre`,
-- `ref1_telefono` y `ref1_direccion` aceptan NULL desde siempre; lo que las
-- exigia era la validacion del formulario. Medido: de 338 clientes, solo 69
-- (20%) tienen la referencia llena — o sea que el requisito ya se estaba
-- esquivando escribiendo cualquier cosa. Ese cambio es de app, no de SQL.
--
-- LAS DOS COLUMNAS
-- -----------------
--   clients.apodo_2      el segundo apodo. NULL = no tiene.
--   loans.apodo_elegido  1 o 2. Cual de los dos usa ESTE prestamo.
--
-- POR QUE EL PRESTAMO GUARDA EL NUMERO Y NO EL TEXTO. Copiar el texto lo
-- congela: si manana se corrige el apodo del cliente —un error de dedo— los
-- prestamos ya creados se quedarian con el texto viejo y habria que
-- arreglarlos uno por uno. Guardando cual de los dos, la correccion se
-- refleja sola en los prestamos que lo usan.
--
-- ARRANCA EN 1 para todos los prestamos: es el apodo que se viene mostrando,
-- asi que correr este script no cambia una sola pantalla. El 2 solo aparece
-- cuando alguien lo elige.
--
-- QUE NO SE TOCA
--   * `clients.apodo` sigue siendo el apodo principal y el que usan las
--     busquedas: nada de lo que ya funciona depende de la columna nueva.
--   * `apodoSiAporta` en el cliente sigue decidiendo si vale la pena mostrar
--     el apodo debajo del nombre. Lo unico que cambia es CUAL apodo recibe.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- -- PASO 1) El segundo apodo del cliente -------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS apodo_2 text;


-- -- PASO 2) Cual apodo usa cada prestamo -------------------------------------
-- 1 = `clients.apodo` (lo de siempre) · 2 = `clients.apodo_2`.
-- El CHECK evita que entre un 3 por un error de tecleo o de payload.
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS apodo_elegido smallint NOT NULL DEFAULT 1;

ALTER TABLE public.loans
  DROP CONSTRAINT IF EXISTS loans_apodo_elegido_check;

ALTER TABLE public.loans
  ADD CONSTRAINT loans_apodo_elegido_check CHECK (apodo_elegido IN (1, 2));


-- -- PASO 3) El apodo que le toca a cada prestamo ------------------------------
-- Una vista chica para no repetir el CASE en cada consulta de la app. Cae al
-- apodo 1 cuando el 2 esta vacio: un prestamo marcado con el 2 sobre un
-- cliente sin apodo 2 no puede quedarse sin nombre.
CREATE OR REPLACE VIEW public.v_loan_apodo AS
SELECT l.id                                   AS loan_id,
       l.client_id,
       l.apodo_elegido,
       c.nombre_completo,
       c.apodo                                AS apodo_1,
       c.apodo_2,
       CASE WHEN l.apodo_elegido = 2 AND NULLIF(TRIM(c.apodo_2), '') IS NOT NULL
            THEN c.apodo_2
            ELSE c.apodo
       END                                    AS apodo_en_uso
  FROM public.loans l
  JOIN public.clients c ON c.id = l.client_id;

GRANT SELECT ON public.v_loan_apodo TO anon, authenticated;


-- -- PASO 4) Verificacion (SOLO LECTURA) --------------------------------------
-- Recien corrido: TODOS en 1, y `apodo_en_uso` igual al apodo de siempre.
SELECT COUNT(*)                                        AS prestamos,
       COUNT(*) FILTER (WHERE apodo_elegido = 1)       AS usan_apodo_1,
       COUNT(*) FILTER (WHERE apodo_elegido = 2)       AS usan_apodo_2,
       COUNT(*) FILTER (WHERE apodo_en_uso IS DISTINCT FROM apodo_1) AS distintos_al_de_siempre
  FROM public.v_loan_apodo;


-- -- PASO 5) Cuantos clientes tienen ya un segundo apodo (SOLO LECTURA) -------
-- Recien corrido da 0: la columna nace vacia y se llena desde la app.
SELECT COUNT(*)                                              AS clientes,
       COUNT(*) FILTER (WHERE NULLIF(TRIM(apodo_2),'') IS NOT NULL) AS con_apodo_2
  FROM public.clients;


-- -- PASO 6) La venta guarda los dos datos nuevos -----------------------------
-- Se parchea la definicion VIVA de `crear_venta_atomica` en vez de reescribir
-- 200 lineas para agregar dos campos. Los anclas se buscan por lo que HACEN
-- —las columnas de cada INSERT— y se comprueba que enganchen EXACTAMENTE una
-- vez antes de aplicar nada: la leccion del script 090.
DO $$
DECLARE
  v_src  text;
  v_new  text;
  v_n    int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.crear_venta_atomica: corra antes el script 078';
  END IF;

  -- 1) El apodo 2 entra al INSERT de clients.
  SELECT count(*) INTO v_n FROM regexp_matches(v_src,
    'documento,\s*nombre_completo,\s*apodo,\s*telefono', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El INSERT de clients no engancha (% veces); revise a mano', v_n;
  END IF;
  v_new := regexp_replace(v_src,
    '(documento,\s*nombre_completo,\s*apodo,)(\s*telefono)',
    '\1 apodo_2,\2');

  -- El valor: justo despues del apodo en la lista de VALUES.
  SELECT count(*) INTO v_n FROM regexp_matches(v_new,
    'NULLIF\(p_cliente->>''apodo'',''''\),', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El valor del apodo no engancha (% veces); revise a mano', v_n;
  END IF;
  v_new := regexp_replace(v_new,
    '(NULLIF\(p_cliente->>''apodo'',''''\),)',
    '\1' || chr(10) || '      NULLIF(p_cliente->>''apodo_2'',''''),');

  -- 2) El apodo elegido entra al INSERT de loans.
  SELECT count(*) INTO v_n FROM regexp_matches(v_new,
    'tipo_venta,\s*cuenta_id,\s*prestamo_empleado,\s*estado,', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El INSERT de loans no engancha (% veces); revise a mano', v_n;
  END IF;
  v_new := regexp_replace(v_new,
    '(tipo_venta,)(\s*cuenta_id,\s*prestamo_empleado,\s*estado,)',
    '\1 apodo_elegido,\2');

  -- El valor va justo despues del que llena `tipo_venta` en la lista de
  -- VALUES, que NO es una variable sino un COALESCE en linea. Se comprobo
  -- contra el cuerpo real: buscar `v_tipo_venta` no enganchaba NADA, y sin
  -- este valor la lista de columnas y la de valores quedaban desparejas, o
  -- sea que TODA venta habria fallado.
  SELECT count(*) INTO v_n FROM regexp_matches(v_new,
    'COALESCE\(NULLIF\(p_loan->>''tipo_venta'',''''\), ''efectivo''\),', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El valor de tipo_venta no engancha (% veces); revise a mano', v_n;
  END IF;
  v_new := regexp_replace(v_new,
    '(COALESCE\(NULLIF\(p_loan->>''tipo_venta'',''''\), ''efectivo''\),)',
    '\1' || chr(10) || '    COALESCE(NULLIF(p_loan->>''apodo_elegido'','''')::smallint, 1),');

  -- 3) En una renovacion, el apodo 2 se agrega si viene y no se pisa si no.
  SELECT count(*) INTO v_n FROM regexp_matches(v_new,
    'SET tiene_prestamo_activo = true,', 'g');
  IF v_n = 1 THEN
    v_new := regexp_replace(v_new,
      '(SET tiene_prestamo_activo = true,)',
      '\1' || chr(10) ||
      '           apodo_2 = COALESCE(NULLIF(p_cliente->>''apodo_2'',''''), apodo_2),');
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'crear_venta_atomica: guarda apodo_2 y apodo_elegido';
END $$;


-- -- PASO 7) Que la funcion quedo parchada (SOLO LECTURA) --------------------
-- Las tres tienen que dar `true`.
SELECT pg_get_functiondef(p.oid) LIKE '%apodo_2%'                  AS guarda_apodo_2,
       pg_get_functiondef(p.oid) LIKE '%apodo_elegido%'            AS guarda_apodo_elegido,
       pg_get_functiondef(p.oid) LIKE '%apodo_elegido'')::smallint%' AS lee_del_payload
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica';
