-- ============================================================================
-- 110 - El cronograma no se acaba antes que la deuda
-- ============================================================================
-- LO QUE SE REPORTO
-- "Tenemos el mismo problema de antes: cuando a un cliente se le acaban los
--  dias programados en payment_plan y no ha terminado de pagar, desaparece
--  del debido cobrar. Que si se le registra un pago o un no pago y ya no
--  tiene mas cuotas a futuro, el sistema le genere automaticamente una cuota
--  para el dia siguiente (sin domingos), y las semanales para su dia."
--
-- POR QUE VOLVIO A PASAR
-- ----------------------
-- No es que el arreglo fallara: es que NUNCA SE CORRIO. El script 106 creo
-- `completar_cronograma` pero quedo sin ejecutar — se comprobo contra
-- produccion y la funcion no existe. Y el enganche automatico que SI existe
-- en `registrar_gestion` esta condicionado de una forma que no alcanza.
--
-- MEDIDO HOY (12/09/2026), sobre los 190 creditos activos:
--
--   28 creditos activos, CON SALDO, sin una sola cuota de hoy en adelante
--   $4.582.534 de deuda que no entra en ninguna meta
--
--     ruta 1      2 creditos          790
--     ruta 151    4 creditos      959.500
--     ruta 154   15 creditos    2.549.600
--     ruta 190    4 creditos    1.072.200
--     ruta 933    3 creditos          444
--
--   El mas viejo lleva 65 dias sin cuota; el promedio, 14.
--   Cuando se escribio el 106 eran 8 creditos y $160.081. El problema crecio
--   solo, porque nadie lo estaba mirando.
--
-- LA CAUSA EXACTA DEL ENGANCHE QUE NO ENGANCHA
-- ---------------------------------------------
-- `registrar_gestion` ya sabe crear la cuota adicional, pero pide DOS cosas:
--
--   1. Que el dispositivo mande `generar_cuota_si_debe = true`.
--   2. Que la app haya calculado `esUltimaCuotaPendiente`, que es
--      `sinCubrirRestantes === 1`: EXACTAMENTE una cuota sin cubrir.
--
-- La segunda es la que mata. Solo dispara en el instante justo en que queda
-- UNA cuota. Si el cliente se adelanto, si el conteo cayo distinto, o si el
-- plan YA se acabo —que es justo el caso que se quiere cubrir—, la condicion
-- es falsa y no se genera nada. Un credito que ya perdio su cronograma no
-- puede recuperarlo por esta via: nunca vuelve a tener "una cuota restante".
--
-- Ademas depende de que el cobrador no desmarque un checkbox. Que el
-- cronograma de un credito sobreviva depende de una casilla es fragil: si se
-- desmarca una vez, el credito desaparece de la meta y nadie se entera.
--
-- LO QUE HACE ESTE SCRIPT
-- -----------------------
--   PASO 2  `completar_cronograma`, la funcion del 106 que quedo sin correr.
--   PASO 3  El enganche AUTOMATICO dentro de `registrar_gestion`: despues de
--           un pago o un no pago, si el credito quedo debiendo y no tiene
--           NADA por delante, se le crea la cuota siguiente. Sin checkbox,
--           sin condiciones de conteo.
--   PASO 5  El arreglo de los 28 que ya estan asi: se extienden hasta hoy.
--
-- LAS FECHAS LAS PONE `siguiente_fecha_cobro`, que ya existe (script 044) y
-- ya hace lo que se pidio:
--
--   diaria      +1 dia, y si cae domingo se corre al lunes
--   semanal     +7 dias  (cae siempre en el mismo dia de la semana)
--   quincenal   +15 · mensual +30
--
-- QUE NO CAMBIA
--   * NO se inventa deuda. La cuota nueva vale como mucho lo que falta:
--     `LEAST(cuota_de_referencia, saldo)`. La suma del cronograma sigue
--     siendo el total pactado.
--   * NO se toca `loans.valor_a_pagar` ni `valor`. No hay interes nuevo:
--     esto no es una prorroga, es el calendario que faltaba para cobrar lo
--     que YA se debe.
--   * NO se tocan creditos cancelados ni los que tienen plan por delante.
--   * El libro de eventos no se altera: la cuota nueva deja su rastro como
--     una `extension` de clase `cuota_adicional`, igual que hoy.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 4 no escriben nada.
-- ============================================================================


-- ── PASO 1) Quien esta asi hoy (SOLO LECTURA, no cambia nada) ─────────────
-- Creditos activos, con saldo, cuya ultima cuota del plan ya paso. Guarde el
-- numero: el PASO 6 tiene que dar CERO.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo)    AS cliente,
       f.saldo,
       MAX(pp.fecha_pago)                                 AS ultima_cuota,
       (now() AT TIME ZONE 'America/Bogota')::date
         - MAX(pp.fecha_pago)                             AS dias_sin_cuota,
       MAX(pp.valor_cuota) FILTER (WHERE NOT pp.es_extra) AS cuota_ref,
       l.frecuencia_pago
  FROM public.loans l
  JOIN public.clients c            ON c.id = l.client_id
  JOIN public.v_loan_financiero f  ON f.loan_id = l.id
  JOIN public.payment_plan pp      ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
   AND f.saldo > 0
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, f.saldo, l.frecuencia_pago
HAVING MAX(pp.fecha_pago) < (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY l.ruta, f.saldo DESC;


-- ── PASO 2) `completar_cronograma` (la del 106, que quedo sin correr) ─────
-- Reparte el SALDO QUE YA EXISTE en cuotas nuevas del mismo valor que las del
-- plan, a partir del dia habil siguiente. Es idempotente: si el credito ya
-- tiene cuotas por delante que cubren el saldo, no hace nada.
CREATE OR REPLACE FUNCTION public.completar_cronograma(p_loan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_loan        record;
  v_saldo       numeric;
  v_cuota_ref   numeric;
  v_ultima      date;
  v_num_max     int;
  v_por_delante numeric;
  v_falta       numeric;
  v_fecha       date;
  v_n           int := 0;
  v_valor       numeric;
  v_hoy         date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  SELECT id, estado, frecuencia_pago, ruta, prestamo_empleado
    INTO v_loan
    FROM loans WHERE id = p_loan_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no existe');
  END IF;
  IF v_loan.estado <> 'activo' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no esta activo',
                              'estado', v_loan.estado);
  END IF;

  SELECT saldo INTO v_saldo FROM v_loan_financiero WHERE loan_id = p_loan_id;
  IF COALESCE(v_saldo, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'cuotas_creadas', 0, 'motivo', 'No debe nada');
  END IF;

  SELECT MAX(fecha_pago),
         MAX(numero_cuota),
         COALESCE(MAX(valor_cuota) FILTER (WHERE NOT es_extra), MAX(valor_cuota))
    INTO v_ultima, v_num_max, v_cuota_ref
    FROM payment_plan WHERE loan_id = p_loan_id;

  IF v_ultima IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'El prestamo no tiene cronograma');
  END IF;
  IF COALESCE(v_cuota_ref, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'No se pudo determinar el valor de la cuota');
  END IF;

  -- Lo que YA esta programado de hoy en adelante. Si cubre el saldo, el
  -- cronograma esta completo: correr esto dos veces no duplica cuotas.
  SELECT COALESCE(SUM(valor_cuota), 0) INTO v_por_delante
    FROM payment_plan
   WHERE loan_id = p_loan_id
     AND fecha_pago >= v_hoy
     AND estado IN ('pendiente','parcial','no_pago');

  v_falta := v_saldo - v_por_delante;
  IF v_falta <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'cuotas_creadas', 0,
      'motivo', 'El cronograma ya cubre el saldo',
      'saldo', v_saldo, 'programado', v_por_delante);
  END IF;

  -- Las cuotas nuevas arrancan el dia habil siguiente a la ultima del plan.
  -- Si esa fecha ya paso, se avanza hasta HOY: una cuota con fecha vieja
  -- nace vencida y le inventa mora al cliente.
  v_fecha := siguiente_fecha_cobro(
               v_ultima,
               CASE WHEN COALESCE(v_loan.prestamo_empleado, false) THEN 'daily'
                    ELSE v_loan.frecuencia_pago END);
  WHILE v_fecha < v_hoy LOOP
    v_fecha := siguiente_fecha_cobro(
                 v_fecha,
                 CASE WHEN COALESCE(v_loan.prestamo_empleado, false) THEN 'daily'
                      ELSE v_loan.frecuencia_pago END);
  END LOOP;

  WHILE v_falta > 0 LOOP
    -- La ultima cuota lleva el resto exacto: lo que se crea suma IGUAL al
    -- saldo, ni un peso mas.
    v_valor   := LEAST(v_cuota_ref, v_falta);
    v_num_max := v_num_max + 1;
    v_n       := v_n + 1;

    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    ) VALUES (
      p_loan_id, v_num_max, v_fecha, v_valor, v_valor, 0,
      0, 'pendiente', v_loan.ruta, false
    );

    v_falta := v_falta - v_valor;
    v_fecha := siguiente_fecha_cobro(
                 v_fecha,
                 CASE WHEN COALESCE(v_loan.prestamo_empleado, false) THEN 'daily'
                      ELSE v_loan.frecuencia_pago END);

    IF v_n > 400 THEN
      RAISE EXCEPTION 'completar_cronograma: mas de 400 cuotas para el prestamo %; revise el valor de la cuota', p_loan_id;
    END IF;
  END LOOP;

  -- El cache derivado se rehace: `payment_plan.estado`/`monto_pagado` y
  -- `loans.saldo` los escribe SOLO esta funcion, nunca la app.
  PERFORM recalcular_prestamo(p_loan_id);

  RETURN jsonb_build_object('ok', true, 'cuotas_creadas', v_n,
    'saldo', v_saldo, 'cuota_ref', v_cuota_ref, 'desde', v_fecha);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.completar_cronograma(uuid) TO anon, authenticated;


-- ── PASO 3) El enganche AUTOMATICO dentro de `registrar_gestion` ──────────
-- Aca esta el cambio de fondo. Hoy la cuota adicional depende de que el
-- dispositivo pida `generar_cuota_si_debe` Y de que quede exactamente una
-- cuota sin cubrir. Se le agrega una RED DE SEGURIDAD que no depende de
-- ninguna de las dos: despues de un pago o un no pago, si el credito quedo
-- debiendo y NO tiene ninguna cuota por delante, se le crea la siguiente.
--
-- Se parchea la funcion VIVA en vez de redefinirla entera: `registrar_gestion`
-- tiene ~600 lineas y varios scripts posteriores la han tocado. Reescribirla
-- desde el 044 borraria esos cambios sin avisar.
DO $patch$
DECLARE
  v_src  text;
  v_new  text;
  v_n    int;
  v_ancla text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion'
     AND pg_get_function_identity_arguments(p.oid) = 'p_user_id bigint, p_ruta_id bigint, p_rol text, p_payload jsonb';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No existe public.registrar_gestion(bigint,bigint,text,jsonb): corra antes el script 044';
  END IF;

  IF position('cuota_adicional_automatica' in v_src) > 0 THEN
    RAISE NOTICE 'El enganche automatico ya estaba puesto: no se toca nada.';
    RETURN;
  END IF;

  -- Se engancha JUSTO DESPUES del bloque que ya existe, anclando en el
  -- comentario de la multa, que es la sentencia siguiente. Si el ancla no
  -- aparece una sola vez se aborta: es preferible no tocar nada a dejar la
  -- funcion a medias.
  v_ancla := '  -- ── Evaluar multa tras un no pago';
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, '  -- .. Evaluar multa tras un no pago', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'El ancla de la multa aparece % veces; revise a mano', v_n;
  END IF;

  v_new := regexp_replace(v_src, '(  -- .. Evaluar multa tras un no pago)',
E'  -- ── RED DE SEGURIDAD: el cronograma no se acaba antes que la deuda ────\n'
||E'  -- El bloque de arriba solo dispara si el dispositivo lo pidio Y si quedaba\n'
||E'  -- exactamente una cuota sin cubrir. Esto cubre lo que aquello no puede: un\n'
||E'  -- credito que ya se quedo SIN cronograma y sigue debiendo. Sin checkbox y\n'
||E'  -- sin condiciones de conteo — si debe y no tiene nada por delante, se le\n'
||E'  -- pone la cuota siguiente y asi vuelve a entrar en el debido cobrar.\n'
||E'  IF v_tipo IN (''pago'',''no_pago'')\n'
||E'     AND NOT v_cuota_adic\n'
||E'     AND (v_recalc->>''nuevo_saldo'')::numeric > 0\n'
||E'     AND NOT EXISTS (SELECT 1 FROM payment_plan\n'
||E'                      WHERE loan_id = v_loan_id\n'
||E'                        AND fecha_pago >= v_hoy\n'
||E'                        AND estado IN (''pendiente'',''parcial'',''no_pago'')) THEN\n'
||E'    SELECT valor_cuota, capital, interes INTO v_tpl\n'
||E'      FROM payment_plan WHERE loan_id = v_loan_id AND NOT es_extra\n'
||E'     ORDER BY numero_cuota ASC LIMIT 1;\n'
||E'    SELECT fecha_pago, numero_cuota INTO v_last\n'
||E'      FROM payment_plan WHERE loan_id = v_loan_id\n'
||E'     ORDER BY fecha_pago DESC, numero_cuota DESC LIMIT 1;\n'
||E'    IF v_tpl.valor_cuota IS NOT NULL AND v_last.numero_cuota IS NOT NULL THEN\n'
||E'      INSERT INTO payment_plan (\n'
||E'        loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,\n'
||E'        saldo, estado, ruta, es_extra\n'
||E'      ) VALUES (\n'
||E'        v_loan_id, v_last.numero_cuota + 1,\n'
||E'        public.siguiente_fecha_cobro(\n'
||E'          GREATEST(v_last.fecha_pago, v_hoy),\n'
||E'          CASE WHEN COALESCE(v_loan.prestamo_empleado, false) THEN ''daily''\n'
||E'               ELSE v_loan.frecuencia_pago END),\n'
||E'        LEAST(v_tpl.valor_cuota, (v_recalc->>''nuevo_saldo'')::numeric),\n'
||E'        v_tpl.capital, v_tpl.interes, 0, ''pendiente'', p_ruta_id, true\n'
||E'      );\n'
||E'      INSERT INTO gestiones (\n'
||E'        id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,\n'
||E'        monto, origen, detalle\n'
||E'      ) VALUES (\n'
||E'        gen_random_uuid(), v_loan_id, v_loan.client_id, p_ruta_id, p_user_id,\n'
||E'        ''extension'', ''aplicada'', v_fecha, 0, ''campo'',\n'
||E'        jsonb_build_object(''clase'', ''cuota_adicional_automatica'',\n'
||E'                           ''gestion_origen'', v_id)\n'
||E'      );\n'
||E'      v_cuota_adic := true;\n'
||E'      v_recalc := public.recalcular_prestamo(v_loan_id);\n'
||E'    END IF;\n'
||E'  END IF;\n\n'
||E'\\1');

  IF v_new = v_src THEN
    RAISE EXCEPTION 'El parche no cambio nada; revise a mano';
  END IF;

  EXECUTE v_new;
  RAISE NOTICE 'Enganche automatico puesto en registrar_gestion.';
END
$patch$;


-- ── PASO 4) Que el parche quedo bien puesto (SOLO LECTURA) ───────────────
-- Tiene que decir `t` en las dos columnas. Si alguna sale `f`, el PASO 3 no
-- hizo lo que debia y NO conviene seguir.
SELECT position('cuota_adicional_automatica' in pg_get_functiondef(p.oid)) > 0
         AS tiene_el_enganche,
       position('Evaluar multa tras un no pago' in pg_get_functiondef(p.oid)) > 0
         AS conserva_lo_de_antes
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion'
   AND pg_get_function_identity_arguments(p.oid) = 'p_user_id bigint, p_ruta_id bigint, p_rol text, p_payload jsonb';


-- ── PASO 5) Poner al dia a los 28 que ya estan asi ───────────────────────
-- El arreglo puntual que se pidio: "que se extiendan hasta el dia de hoy".
-- De aqui en adelante el PASO 3 se encarga solo.
DO $fix$
DECLARE
  r        record;
  v_res    jsonb;
  v_total  int := 0;
  v_cuotas int := 0;
BEGIN
  FOR r IN
    SELECT l.id, l.ruta, COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente
      FROM public.loans l
      JOIN public.clients c            ON c.id = l.client_id
      JOIN public.v_loan_financiero f  ON f.loan_id = l.id
     WHERE l.estado = 'activo'
       AND f.saldo > 0
       AND (SELECT MAX(pp.fecha_pago) FROM public.payment_plan pp WHERE pp.loan_id = l.id)
           < (now() AT TIME ZONE 'America/Bogota')::date
     ORDER BY l.ruta
  LOOP
    v_res := public.completar_cronograma(r.id);
    IF COALESCE((v_res->>'cuotas_creadas')::int, 0) > 0 THEN
      v_total  := v_total + 1;
      v_cuotas := v_cuotas + (v_res->>'cuotas_creadas')::int;
      RAISE NOTICE 'ruta % · % · % cuotas nuevas desde %',
        r.ruta, r.cliente, v_res->>'cuotas_creadas', v_res->>'desde';
    ELSE
      RAISE NOTICE 'ruta % · % · sin cambios (%)', r.ruta, r.cliente, v_res->>'motivo';
    END IF;
  END LOOP;
  RAISE NOTICE '---';
  RAISE NOTICE 'Creditos puestos al dia: %  ·  cuotas creadas: %', v_total, v_cuotas;
END
$fix$;


-- ── PASO 6) Que no quedo ninguno (SOLO LECTURA) ──────────────────────────
-- Tiene que salir VACIO. Es el PASO 1 otra vez.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       f.saldo,
       MAX(pp.fecha_pago) AS ultima_cuota
  FROM public.loans l
  JOIN public.clients c            ON c.id = l.client_id
  JOIN public.v_loan_financiero f  ON f.loan_id = l.id
  JOIN public.payment_plan pp      ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
   AND f.saldo > 0
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, f.saldo
HAVING MAX(pp.fecha_pago) < (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY l.ruta;


-- ── PASO 7) Que NO se invento deuda (SOLO LECTURA) ───────────────────────
-- Lo mas importante de todo. Para cada credito activo, la suma del cronograma
-- tiene que seguir siendo igual al total pactado. Si alguna fila sale aca con
-- una diferencia grande, algo se rompio y hay que mirarlo.
--
-- OJO: pueden salir filas que YA estaban descuadradas antes de este script
-- (creditos viejos, homologados). Lo que importa es que no aparezca ninguna
-- de las que se acaban de tocar.
SELECT l.ruta,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo)          AS cliente,
       COALESCE(l.valor_a_pagar, l.valor)                       AS total_pactado,
       SUM(pp.valor_cuota)                                      AS suma_cronograma,
       COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota) AS diferencia
  FROM public.loans l
  JOIN public.clients c       ON c.id = l.client_id
  JOIN public.payment_plan pp ON pp.loan_id = l.id
 WHERE l.estado = 'activo'
 GROUP BY l.id, l.ruta, c.apodo, c.nombre_completo, l.valor_a_pagar, l.valor
HAVING ABS(COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota)) > 1
 ORDER BY ABS(COALESCE(l.valor_a_pagar, l.valor) - SUM(pp.valor_cuota)) DESC
 LIMIT 20;


-- ── PASO 8) La meta de hoy, antes y despues (SOLO LECTURA) ───────────────
-- Cuanto subio el debido cobrar de hoy al volver a meter a estos clientes.
-- Es el numero que el dueño va a ver en el Resumen.
SELECT ruta, fecha_pago, meta_pagos
  FROM public.resumen_diario_v2
 WHERE fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date
   AND ruta IN (1, 151, 154, 190, 933)
 ORDER BY ruta;
