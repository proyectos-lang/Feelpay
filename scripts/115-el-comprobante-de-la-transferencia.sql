-- ============================================================================
-- 115 - El comprobante de la transferencia
-- ============================================================================
-- LO QUE SE PIDIO
-- "En el modulo de Ventas, agregar casilla de cargar imagen adjunta. Se hace
--  necesario por si la venta fue en transferencia: poder subir el comprobante."
--
-- HOY NO HAY DONDE GUARDARLO. `loans` tiene 27 columnas y ninguna sirve para
-- una imagen — se comprobo contra produccion. La venta por transferencia
-- guarda la cuenta (`cuenta_id`) pero no la constancia de que la plata salio.
--
-- LO QUE SE AGREGA
--   `loans.comprobante_url` — la URL de la imagen en Vercel Blob, la misma
--   bodega donde ya viven las fotos de cedula, los logos y los adjuntos del
--   chat. NULL cuando no hay comprobante, que es el caso de toda venta en
--   efectivo y de todo lo que ya existe.
--
-- POR QUE UNA COLUMNA Y NO UNA TABLA APARTE
-- ------------------------------------------
-- Porque es UNA imagen por venta, no una lista. Una tabla `comprobantes`
-- obligaria a un JOIN en cada pantalla que muestre una venta para traer un
-- solo texto. Y pegada a `loans` viaja sola a Ver Ventas, Control Total y la
-- auditoria, sin que ninguna de las tres tenga que aprender nada nuevo.
--
-- EL PASO DELICADO ES EL 4
-- -------------------------
-- `crear_venta_atomica` es la RPC que crea TODA venta de la aplicacion. Su
-- `INSERT INTO loans` tiene dos listas que deben quedar parejas: las columnas
-- y los valores. Si se agrega una columna y no su valor —o al reves— NINGUNA
-- venta se puede registrar mas.
--
-- Ya paso una vez: el script 107 (apodo 2) tenia un ancla que no enganchaba y
-- habria dejado la lista de columnas con una de mas. Se detecto simulando el
-- parche y CONTANDO las dos listas antes de correrlo. Este script hace esa
-- misma comprobacion, pero DENTRO del propio script: cuenta las comas de las
-- dos listas y aborta si no quedan parejas.
--
-- QUE NO CAMBIA
--   * Ninguna venta existente: la columna nace en NULL.
--   * El resto de `crear_venta_atomica`: solo se le agrega una columna y su
--     valor, en el mismo INSERT.
--   * Nada de plata: esto es un adjunto, no un monto.
--
-- Corre los pasos EN ORDEN. Los pasos 1, 5 y 6 no escriben nada.
-- ============================================================================


-- ── PASO 1) Como esta hoy (SOLO LECTURA) ─────────────────────────────────
SELECT count(*)                                              AS ventas_totales,
       count(*) FILTER (WHERE tipo_venta = 'transferencia')  AS por_transferencia,
       count(*) FILTER (WHERE estado = 'activo')             AS activas
  FROM public.loans;


-- ── PASO 2) La columna nueva ─────────────────────────────────────────────
-- NULL = sin comprobante. Es idempotente.
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS comprobante_url TEXT;


-- ── PASO 3) El contador de comas que usa el PASO 4 ───────────────────────
-- Cuenta las comas de NIVEL SUPERIOR de una lista: las que separan elementos,
-- ignorando las que van dentro de un parentesis (`COALESCE(a, b)` es UN
-- elemento, no dos) y las que van dentro de un comentario de linea.
--
-- Es lo que permite comprobar que la lista de columnas y la de valores del
-- INSERT quedan parejas. Sin esto, el parche seria a ciegas.
CREATE OR REPLACE FUNCTION public._comas_nivel_cero(p_texto text)
RETURNS int
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_limpio text;
  v_ch     text;
  v_prof   int := 0;
  v_n      int := 1;   -- n elementos = n-1 comas + 1
  i        int;
BEGIN
  -- Fuera los comentarios de linea: llevan comas y las contaria.
  v_limpio := regexp_replace(p_texto, '--[^' || chr(10) || ']*', '', 'g');

  FOR i IN 1..length(v_limpio) LOOP
    v_ch := substr(v_limpio, i, 1);
    IF v_ch = '(' THEN
      v_prof := v_prof + 1;
    ELSIF v_ch = ')' THEN
      v_prof := v_prof - 1;
    ELSIF v_ch = ',' AND v_prof = 0 THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;

  RETURN v_n;
END;
$fn$;


-- ── PASO 4) Que `crear_venta_atomica` la guarde ──────────────────────────
-- Se parchea la funcion VIVA: tiene varias versiones (scripts 045, 078, 107)
-- y redefinirla desde cualquiera de ellas borraria lo que las otras
-- agregaron — el `apodo_elegido` del 107, por ejemplo.
--
-- El parche cuenta las dos listas ANTES y DESPUES. Si no quedan parejas,
-- aborta sin escribir: mas vale no tener la columna que romper las ventas.
DO $patch$
DECLARE
  v_src     text;
  v_nuevo   text;
  v_n       int;
  v_ins     text;
  v_cols    text;
  v_vals    text;
  v_c_antes int;
  v_v_antes int;
  v_c_dsp   int;
  v_v_dsp   int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.crear_venta_atomica: corra antes el script 045';
  END IF;

  IF position('comprobante_url' in v_src) > 0 THEN
    RAISE NOTICE 'crear_venta_atomica ya guardaba el comprobante. Nada que cambiar.';
    RETURN;
  END IF;

  -- ── Contar las dos listas del INSERT INTO loans, ANTES de tocar nada ───
  -- Se recorta desde `INSERT INTO loans` hasta el `RETURNING`, y se parte en
  -- la lista de columnas y la de valores por el `) VALUES (`.
  v_ins := substring(v_src from position('INSERT INTO loans' in v_src));
  v_ins := substring(v_ins from 1 for position('RETURNING' in v_ins) - 1);

  v_cols := substring(v_ins from position('(' in v_ins) + 1
                      for position(') VALUES (' in v_ins) - position('(' in v_ins) - 1);
  v_vals := substring(v_ins from position(') VALUES (' in v_ins) + 10);

  -- Las comas de nivel superior. Se quitan los comentarios de linea (que
  -- llevan comas) y se cuentan solo las que estan fuera de parentesis.
  v_c_antes := public._comas_nivel_cero(v_cols);
  v_v_antes := public._comas_nivel_cero(v_vals);

  RAISE NOTICE 'INSERT INTO loans, antes: % columnas · % valores', v_c_antes, v_v_antes;

  IF v_c_antes <> v_v_antes THEN
    RAISE EXCEPTION
      'El INSERT ya venia desparejo (% columnas vs % valores). NO lo toco: revise a mano.',
      v_c_antes, v_v_antes;
  END IF;

  -- ── El ancla de COLUMNAS ───────────────────────────────────────────────
  -- Se ancla en `client_id,` —la PRIMERA columna del INSERT, que ningun
  -- script posterior mueve— y NO en `tipo_venta`, que el script 107 ya
  -- reescribio a `tipo_venta, apodo_elegido,`. Anclar en algo que otro parche
  -- toca es exactamente como el 107 se quedo sin enganchar.
  SELECT count(*) INTO v_n
    FROM regexp_matches(v_src, 'INSERT INTO loans \(\s*client_id,', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El ancla de columnas engancha % veces; revise a mano', v_n;
  END IF;

  v_nuevo := regexp_replace(v_src,
    '(INSERT INTO loans \(\s*)client_id,',
    '\1comprobante_url, client_id,');

  -- ── Y su VALOR, como PRIMER valor ──────────────────────────────────────
  -- Va primero porque la columna quedo primera: las dos listas se leen en
  -- orden y se corresponden una a una. `v_client_id` es el primer valor del
  -- INSERT y tampoco lo mueve ningun parche.
  SELECT count(*) INTO v_n
    FROM regexp_matches(v_nuevo, '\) VALUES \(\s*v_client_id,', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El ancla de valores engancha % veces; revise a mano', v_n;
  END IF;

  v_nuevo := regexp_replace(v_nuevo,
    '(\) VALUES \(\s*)v_client_id,',
    '\1NULLIF(p_loan->>''comprobante_url'',''''), v_client_id,');

  -- ── Volver a contar: las dos listas TIENEN que haber subido en 1 ───────
  v_ins := substring(v_nuevo from position('INSERT INTO loans' in v_nuevo));
  v_ins := substring(v_ins from 1 for position('RETURNING' in v_ins) - 1);
  v_cols := substring(v_ins from position('(' in v_ins) + 1
                      for position(') VALUES (' in v_ins) - position('(' in v_ins) - 1);
  v_vals := substring(v_ins from position(') VALUES (' in v_ins) + 10);
  v_c_dsp := public._comas_nivel_cero(v_cols);
  v_v_dsp := public._comas_nivel_cero(v_vals);

  RAISE NOTICE 'INSERT INTO loans, despues: % columnas · % valores', v_c_dsp, v_v_dsp;

  IF v_c_dsp <> v_v_dsp OR v_c_dsp <> v_c_antes + 1 THEN
    RAISE EXCEPTION
      'El parche dejo el INSERT desparejo (% columnas vs % valores; antes %). NO se aplica.',
      v_c_dsp, v_v_dsp, v_c_antes;
  END IF;

  EXECUTE v_nuevo;
  RAISE NOTICE 'crear_venta_atomica ahora guarda `comprobante_url`.';
END
$patch$;


-- ── PASO 5) Que quedo bien puesto (SOLO LECTURA) ─────────────────────────
-- Las tres columnas tienen que decir `t`.
SELECT position('comprobante_url' in pg_get_functiondef(p.oid)) > 0 AS guarda_el_comprobante,
       position('apodo_elegido'   in pg_get_functiondef(p.oid)) > 0 AS conserva_el_apodo,
       position('cuenta_id'       in pg_get_functiondef(p.oid)) > 0 AS conserva_la_cuenta
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'crear_venta_atomica';


-- ── PASO 6) La columna existe y esta vacia (SOLO LECTURA) ────────────────
SELECT count(*)                                        AS ventas,
       count(comprobante_url)                          AS con_comprobante
  FROM public.loans;
