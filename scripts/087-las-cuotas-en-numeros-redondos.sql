-- ============================================================================
-- 087 - Las cuotas en números redondos
-- ============================================================================
-- LO QUE SE PIDIÓ
-- "Que las cuotas no se calculen con decimales. Si la cuota es $19.500 cerrar
--  a $20.000; $19.499 dejar en $19.000. Aproximar por encima y por debajo de
--  $500. Y la última cuota será el acumulado de lo que se ha aproximado."
--
-- SOLO DE AQUÍ EN ADELANTE. Este script cambia cómo se GENERA un cronograma
-- nuevo. Los `payment_plan` ya guardados no se tocan: ni un crédito vivo
-- cambia de cuota por correr esto.
--
-- LA REGLA
--   cuota = al millar más cercano, y el 500 sube
--   la última = el total menos las anteriores, así la suma sigue dando exacto
--
-- LAS DOS GUARDAS, Y POR QUÉ EXISTEN
-- Se midió la regla contra los 178 créditos de la base antes de escribir esto,
-- y sin guardas rompía 66.
--
-- 1) CUOTAS POR DEBAJO DE MIL NO SE REDONDEAN.
--    La ruta 933 es de Ecuador y trabaja en dólares: sus cuotas van de $2 a
--    $80. Redondear al millar las dejaría todas en CERO. Son 61 créditos.
--    No hace falta configurar nada por país — una cuota de $6 no se redondea
--    a millares en ninguna moneda, y la regla se acomoda sola.
--
-- 2) LA ÚLTIMA NUNCA QUEDA EN CERO NI NEGATIVA.
--    Subir la cuota le quita hasta $500 a cada una de las n−1 primeras, y eso
--    puede pasarse de lo que vale la última. Caso real, ruta 154: 20 cuotas
--    sobre $150.000 dan $7.500, que sube a $8.000 — pero 8.000 × 19 = 152.000,
--    más que el total, y la última quedaría en −$2.000. En ese caso la cuota
--    baja un escalón, a $7.000, y la última queda en $17.000.
--    Le pasa a 11 de los 178.
--
-- COMPROBADO, con la regla y sus guardas, sobre los 178 créditos:
--   última cuota en cero o negativa : 0
--   no se redondean (cuota chica)   : 61   (todos Ecuador)
--   bajan un escalón                : 11
--   Ecuador, créditos afectados     : 0
--
-- QUÉ NO SE TOCA
-- El AMERICANO. Ahí la cuota ES el interés del período, y el total a pagar se
-- calcula como `capital + interés × n`: redondear el interés cambiaría lo que
-- el cliente debe, que es otra cosa y no es lo que se pidió. Hoy no hay un
-- solo crédito americano en la base — los 178 son alemán.
--
-- CORRE LOS PASOS DE A UNO, NO TODO PEGADO.
-- El editor de Supabase mete todo lo que se le pega en UNA transacción: si el
-- último paso falla, se deshacen también los primeros. Pasó con la primera
-- versión de este script — la consulta de prueba del PASO 6 llamaba a
-- `generar_cronograma` con la firma equivocada, y el error borró de vuelta la
-- función del PASO 1 y el parche del PASO 4. Parecía que el script no había
-- hecho nada, y literalmente no lo había hecho.
--
-- Cada paso es una sola sentencia. Corre uno, mira el resultado, sigue.
-- ============================================================================


-- ── PASO 1) La regla, en una función ──────────────────────────────────────
-- Vive aparte para que la app pueda espejarla exacta (`lib/loan-schedule.ts`)
-- y para poder probarla sola, sin generar un cronograma entero.
CREATE OR REPLACE FUNCTION public.redondear_cuota(
  p_base    numeric,   -- total / número de cuotas, sin redondear
  p_total   numeric,   -- el total a pagar del crédito
  p_cuotas  integer    -- cuántas cuotas son
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_r numeric;
BEGIN
  IF p_base IS NULL OR p_cuotas IS NULL OR p_cuotas < 1 THEN
    RETURN p_base;
  END IF;

  -- GUARDA 1: por debajo de mil, redondear la borraría. Ver el encabezado.
  IF p_base < 1000 THEN
    RETURN round(p_base, 2);
  END IF;

  -- Al millar más cercano, con el 500 subiendo.
  --   19.500 / 1000 = 19,5  + 0,5 = 20,0  -> floor 20 -> 20.000
  --   19.499 / 1000 = 19,499 + 0,5 = 19,999 -> floor 19 -> 19.000
  v_r := floor(p_base / 1000.0 + 0.5) * 1000;

  -- GUARDA 2: la última tiene que quedar en algo. Se baja de mil en mil.
  WHILE v_r > 0 AND p_total - v_r * (p_cuotas - 1) <= 0 LOOP
    v_r := v_r - 1000;
  END LOOP;

  -- Si no cabe ningún múltiplo de mil, se deja como estaba.
  IF v_r <= 0 THEN
    RETURN round(p_base, 2);
  END IF;

  RETURN v_r;
END;
$$;


-- ── PASO 2) Que la app pueda usarla ───────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.redondear_cuota(numeric, numeric, integer) TO anon, authenticated;


-- ── PASO 3) La comprobación de la regla, antes de tocar nada (SOLO LECTURA)
-- Tienen que salir los valores de la derecha. Si alguno no cuadra, PARA: no
-- corras el paso 4.
SELECT b.base,
       public.redondear_cuota(b.base, b.total, b.cuotas) AS queda_en,
       b.esperado,
       public.redondear_cuota(b.base, b.total, b.cuotas) = b.esperado AS ok,
       b.caso
  FROM (VALUES
    (19500::numeric, 487500::numeric, 25, 20000::numeric, 'el 500 sube'),
    (19499::numeric, 487475::numeric, 25, 19000::numeric, 'por debajo de 500 baja'),
    (19501::numeric, 487525::numeric, 25, 20000::numeric, 'por encima de 500 sube'),
    (20000::numeric, 500000::numeric, 25, 20000::numeric, 'ya es redondo'),
    (33600::numeric, 840000::numeric, 25, 34000::numeric, 'caso real ruta 190'),
    ( 7500::numeric, 150000::numeric, 20,  7000::numeric, 'guarda 2: baja un escalón'),
    ( 9600::numeric, 240000::numeric, 25,  9000::numeric, 'guarda 2: la última no queda en 0'),
    (    6::numeric,    180::numeric, 30,     6::numeric, 'guarda 1: Ecuador, no se redondea'),
    (   80::numeric,   2400::numeric, 30,    80::numeric, 'guarda 1: Ecuador, no se redondea')
  ) AS b(base, total, cuotas, esperado, caso);


-- ── PASO 4) El generador usa la regla ─────────────────────────────────────
-- NO se reescribe `generar_cronograma` a mano: se lee la definición viva, se
-- le cambia la línea del cálculo de la cuota y se vuelve a instalar. Es lo
-- mismo que hizo el script 083, y por lo mismo — la función tiene el manejo de
-- domingos, las frecuencias y las fechas, y transcribirla es cómo se pierden
-- cosas.
--
-- Aborta si la línea no está donde se espera, en vez de instalar una versión
-- a medias.
DO $fix087$
DECLARE
  v_cuantas int;
  v_src     text;
  v_nuevo   text;
BEGIN
  SELECT count(*) INTO v_cuantas
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generar_cronograma';

  IF v_cuantas <> 1 THEN
    RAISE EXCEPTION 'Esperaba una sola generar_cronograma y encontré %. Revisa a mano.', v_cuantas;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generar_cronograma';

  IF strpos(v_src, 'v_cuota_b := round(v_total / p_num_cuotas, 2);') = 0 THEN
    RAISE EXCEPTION 'No encontré el cálculo de la cuota en generar_cronograma. No toco nada.';
  END IF;

  -- ALEMÁN: la cuota es una división de un total fijo, así que redondearla
  -- solo reparte distinto ese mismo total.
  v_nuevo := replace(
    v_src,
    'v_cuota_b := round(v_total / p_num_cuotas, 2);',
    'v_cuota_b := public.redondear_cuota(v_total / p_num_cuotas, v_total, p_num_cuotas);');

  -- EMPLEADO: mismo caso, el total es el capital y la cuota lo divide.
  IF strpos(v_nuevo, 'v_cap_b   := round(p_valor / p_num_cuotas, 2);
  ELSIF') > 0 THEN
    v_nuevo := replace(
      v_nuevo,
      'v_cap_b   := round(p_valor / p_num_cuotas, 2);
  ELSIF',
      'v_cap_b   := public.redondear_cuota(p_valor / p_num_cuotas, p_valor, p_num_cuotas);
  ELSIF');
  END IF;

  EXECUTE v_nuevo;
END
$fix087$;


-- ── PASO 5) Que el cambio quedó (SOLO LECTURA) ────────────────────────────
-- `usa_la_regla` = true y `queda_el_viejo` = false.
SELECT strpos(pg_get_functiondef(p.oid), 'redondear_cuota(v_total / p_num_cuotas') > 0 AS usa_la_regla,
       strpos(pg_get_functiondef(p.oid), 'v_cuota_b := round(v_total')             > 0 AS queda_el_viejo
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'generar_cronograma';


-- ── PASO 6) Un cronograma de prueba (SOLO LECTURA) ────────────────────────
-- 25 cuotas diarias sobre $600.000 al 40% — el crédito típico de la ruta 190.
-- Antes daban $33.600 cada una. Ahora deben dar $34.000, y la última el
-- acumulado: 840.000 − 34.000 × 24 = $24.000.
-- Los tipos van escritos a la fuerza (`::numeric`, `::text`) porque un
-- literal suelto entra como `unknown` y PostgreSQL no sabe cuál de las
-- funciones elegir. Con eso falló la primera versión de este script.
SELECT numero_cuota, fecha_pago, valor_cuota
  FROM public.generar_cronograma(
         600000::numeric,   -- p_valor
         40::numeric,       -- p_tasa
         25,                -- p_num_cuotas
         'aleman'::text,    -- p_tipo_amortizacion
         'daily'::text,     -- p_frecuencia
         false,             -- p_empleado
         CURRENT_DATE,      -- p_fecha_inicio
         NULL::text)        -- p_dia_semana
 ORDER BY numero_cuota;


-- ── PASO 7) Que la suma sigue dando el total (SOLO LECTURA) ───────────────
-- `suma` tiene que ser exactamente 840000. Es lo que impide que el redondeo
-- le regale o le cobre de más a nadie.
SELECT SUM(valor_cuota) AS suma,
       840000           AS deberia_dar,
       SUM(valor_cuota) = 840000 AS ok
  FROM public.generar_cronograma(
         600000::numeric, 40::numeric, 25, 'aleman'::text, 'daily'::text,
         false, CURRENT_DATE, NULL::text);
