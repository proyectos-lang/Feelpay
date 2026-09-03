-- ============================================================================
-- 098 - Las cuotas, de cien en cien
-- ============================================================================
-- LO QUE SE PIDIÓ
-- "Que la aproximación al hacer una venta ya no sea en múltiplos de 500 sino
--  en múltiplos de 100, solamente para las cuotas superiores a 1000."
--
-- CAMBIA UNA SOLA COSA: EL ESCALÓN. De 500 a 100. La forma de redondear, las
-- dos guardas y el que la última cuota absorba el residuo se quedan igual.
--
--   19.499  ->  19.500   (con 500 tambien daba 19.500)
--   19.640  ->  19.600   (con 500 daba 19.500)
--   19.650  ->  19.700   (el punto medio sube; con 500 daba 19.500)
--   33.600  ->  33.600   (con 500 daba 33.500 — ya no se mueve)
--
-- EL CORTE SE QUEDA EN MIL, que es exactamente lo que se pidió: solo se
-- redondean las cuotas superiores a mil. Por debajo, la función devuelve la
-- cuota tal cual. La ruta 933 es de Ecuador y trabaja en dólares —cuotas de $2
-- a $80— y a múltiplos de 100 quedarían casi todas en cero.
--
-- Ese corte es la línea que separa las MONEDAS, no un múltiplo del escalón:
-- por eso no baja a 100 aunque el paso ahora sea 100. Bajarlo metería a
-- Ecuador en el redondeo —una cuota de $80 iría a $100— que es justo lo que la
-- guarda existe para evitar.
--
-- LA HISTORIA DEL ESCALÓN, para que se entienda por qué va bajando:
--
--   087   millar   $19.499 -> $19.000. Desvío de hasta $500 por cuota, y esa
--                  diferencia por 25 cuotas se la comía la última: quedaba con
--                  $12.000 de más.
--   097   500      desvío de hasta $250.
--   098   100      desvío de hasta $50. Medido sobre siete créditos típicos,
--                  la última cuota se despega como mucho $600 de las demás,
--                  contra los $12.000 del millar.
--
-- SOLO PARA LAS VENTAS DE AQUÍ EN ADELANTE. No se toca ni un crédito ya
-- creado: `redondear_cuota` la llama `generar_cronograma` al CREAR o EDITAR
-- una venta, no al leerla. Misma decisión del 087 y del 097.
--
-- Corre los pasos DE A UNO. El editor de Supabase mete todo lo que se le pega
-- en una sola transacción, y si un paso falla se deshacen los anteriores — es
-- lo que le pasó al 087 la primera vez.
-- ============================================================================


-- ── PASO 1) Qué está puesto hoy (SOLO LECTURA) ────────────────────────────
-- Tiene que salir la del 097, con `500.0` adentro. Guardá el resultado.
SELECT p.proname,
       strpos(pg_get_functiondef(p.oid), '500.0') > 0 AS redondea_a_quinientos,
       strpos(pg_get_functiondef(p.oid), '100.0') > 0 AS redondea_a_cien,
       pg_get_functiondef(p.oid)                      AS definicion
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'redondear_cuota';


-- ── PASO 2) El escalón nuevo ──────────────────────────────────────────────
-- Se reescribe entera y no con un `replace` sobre la definición viva: son
-- veinte líneas que caben a la vista, y acá lo que importa es que el texto
-- que se lee sea el que corre.
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

  -- GUARDA 1: solo se redondean las cuotas SUPERIORES A MIL. Ver el encabezado.
  IF p_base < 1000 THEN
    RETURN round(p_base, 2);
  END IF;

  -- Al múltiplo de 100 más cercano, con el punto medio subiendo.
  --   19.499 / 100 = 194,99 + 0,5 = 195,49 -> floor 195 -> 19.500
  --   19.640 / 100 = 196,40 + 0,5 = 196,90 -> floor 196 -> 19.600
  --   19.650 / 100 = 196,50 + 0,5 = 197,00 -> floor 197 -> 19.700
  v_r := floor(p_base / 100.0 + 0.5) * 100;

  -- GUARDA 2: la última tiene que quedar en algo. Se baja de 100 en 100.
  WHILE v_r > 0 AND p_total - v_r * (p_cuotas - 1) <= 0 LOOP
    v_r := v_r - 100;
  END LOOP;

  -- Si no cabe ningún múltiplo de 100, se deja como estaba.
  IF v_r <= 0 THEN
    RETURN round(p_base, 2);
  END IF;

  RETURN v_r;
END;
$$;


-- ── PASO 3) Que la app la pueda usar ──────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.redondear_cuota(numeric, numeric, integer) TO anon, authenticated;


-- ── PASO 4) La regla, caso por caso (SOLO LECTURA) ────────────────────────
-- `ok` tiene que dar true en las VEINTE filas. Son los mismos casos que se
-- corrieron contra el espejo de la app (`lib/loan-schedule.ts`), con los
-- mismos resultados.
--
-- Si alguno no cuadra, PARA: la app y la base dirían cuotas distintas para la
-- misma venta.
SELECT b.caso,
       b.base,
       public.redondear_cuota(b.base, b.total, b.cuotas) AS queda_en,
       b.esperado,
       public.redondear_cuota(b.base, b.total, b.cuotas) = b.esperado AS ok
  FROM (VALUES
    ( 19500::numeric, 487500::numeric, 25,  19500::numeric, 'ya es múltiplo de 100'),
    ( 19499::numeric, 487475::numeric, 25,  19500::numeric, '19.499 sube a 19.500'),
    ( 19640::numeric, 491000::numeric, 25,  19600::numeric, '19.640 baja a 19.600 (con 500 daba 19.500)'),
    ( 19650::numeric, 491250::numeric, 25,  19700::numeric, 'el punto medio sube'),
    ( 19649::numeric, 491225::numeric, 25,  19600::numeric, 'justo debajo del medio, baja'),
    ( 33600::numeric, 840000::numeric, 25,  33600::numeric, 'ruta 190: ya es múltiplo, ya no se mueve'),
    (  7500::numeric, 150000::numeric, 20,   7500::numeric, 'ruta 154: no se mueve'),
    (216666.67::numeric, 650000::numeric, 3, 216700::numeric, '500.000 al 30% en 3 cuotas'),
    (18571.43::numeric, 390000::numeric, 21,  18600::numeric, '300.000 al 30% en 21 cuotas'),
    (  9600::numeric, 240000::numeric, 25,   9600::numeric, '150.000 al 60% en 25: ya es múltiplo'),
    (29166.67::numeric, 350000::numeric, 12,  29200::numeric, '250.000 al 40% en 12 cuotas'),
    (    35::numeric,    875::numeric, 25,     35::numeric, 'Ecuador: cuota de 35, sin tocar'),
    (    26::numeric,    650::numeric, 25,     26::numeric, 'Ecuador: cuota de 26, sin tocar'),
    (     6::numeric,    150::numeric, 25,      6::numeric, 'Ecuador: cuota de 6, sin tocar'),
    (    80::numeric,   2000::numeric, 25,     80::numeric, 'Ecuador: la más alta de la 933'),
    (   999::numeric,  24975::numeric, 25,    999::numeric, 'justo debajo del corte: no se toca'),
    (  1000::numeric,  25000::numeric, 25,   1000::numeric, 'justo en el corte: ya es múltiplo'),
    (  1049::numeric,  26225::numeric, 25,   1000::numeric, '1.049 baja a 1.000'),
    (  1050::numeric,  26250::numeric, 25,   1000::numeric, 'subiría a 1.100, no cabe: la guarda 2 lo baja'),
    (  1050::numeric,  30000::numeric, 25,   1100::numeric, '1.050 sube a 1.100 cuando sí cabe')
  ) AS b(base, total, cuotas, esperado, caso);


-- ── PASO 5) Que la suma del plan siga siendo exacta (SOLO LECTURA) ────────
-- La última cuota absorbe el residuo, así que `suma` tiene que ser IGUAL a
-- `total` en todas las filas, y `ultima` siempre mayor que cero.
--
-- Mirá tambien `se_despega`: cuánto se separa la última de las demás. Con el
-- escalón de 100 no pasa de unos cientos; con el millar llegaba a $12.000.
SELECT v.valor, v.tasa, v.n,
       (v.valor * (1 + v.tasa / 100.0))                                   AS total,
       public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                              v.valor * (1 + v.tasa / 100.0), v.n)        AS cuota,
       (v.valor * (1 + v.tasa / 100.0))
         - public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                                  v.valor * (1 + v.tasa / 100.0), v.n) * (v.n - 1)
                                                                          AS ultima,
       abs(((v.valor * (1 + v.tasa / 100.0))
            - public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                                     v.valor * (1 + v.tasa / 100.0), v.n) * (v.n - 1))
           - public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                                    v.valor * (1 + v.tasa / 100.0), v.n))  AS se_despega,
       public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                              v.valor * (1 + v.tasa / 100.0), v.n) * (v.n - 1)
         + ((v.valor * (1 + v.tasa / 100.0))
            - public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                                     v.valor * (1 + v.tasa / 100.0), v.n) * (v.n - 1))
                                                                          AS suma
  FROM (VALUES
    ( 300000::numeric, 30::numeric, 20),
    ( 300000::numeric, 30::numeric, 21),
    ( 500000::numeric, 30::numeric,  3),
    ( 150000::numeric, 60::numeric, 25),
    ( 250000::numeric, 40::numeric, 12),
    (1000000::numeric, 20::numeric, 30),
    (  80000::numeric, 25::numeric,  7)
  ) AS v(valor, tasa, n);


-- ── PASO 6) Que quedó puesta (SOLO LECTURA) ───────────────────────────────
-- `redondea_a_cien` = true y `redondea_a_quinientos` = false.
SELECT p.proname,
       strpos(pg_get_functiondef(p.oid), '500.0') > 0 AS redondea_a_quinientos,
       strpos(pg_get_functiondef(p.oid), '100.0') > 0 AS redondea_a_cien
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'redondear_cuota';


-- ── PASO 7) Que NINGÚN crédito viejo se movió (SOLO LECTURA) ──────────────
-- TIENE QUE SALIR VACÍO. Busca cuotas de un crédito creado DESPUÉS de este
-- script cuyo valor no sea múltiplo de 100 — o sea, las que sí tendrían que
-- estar redondeadas. Los planes ya escritos no se tocan.
SELECT l.ruta, l.id, pp.numero_cuota, pp.valor_cuota, l.fecha_creacion
  FROM public.payment_plan pp
  JOIN public.loans l ON l.id = pp.loan_id
 WHERE l.fecha_creacion > now()
   AND pp.valor_cuota >= 1000
   AND (pp.valor_cuota::numeric % 100) <> 0
   AND pp.numero_cuota < l.numero_cuotas   -- la última absorbe el residuo
 ORDER BY l.fecha_creacion DESC;


-- ── PASO 8) La prueba de fuego, ya en la app ──────────────────────────────
-- Registrá una venta de $300.000 al 30% en 21 cuotas. La cuota tiene que
-- quedar en $18.600 —no $18.500— y la última en $18.000.
--
-- Corré esto después y mirá `valor_cuota`: todas múltiplos de 100.
SELECT l.ruta, c.nombre_completo, l.valor, l.tasa_interes, l.numero_cuotas,
       l.valor_cuota, l.valor_a_pagar,
       (SELECT string_agg(DISTINCT pp.valor_cuota::text, ', ' ORDER BY pp.valor_cuota::text)
          FROM public.payment_plan pp WHERE pp.loan_id = l.id) AS cuotas_del_plan
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.fecha_creacion > now() - interval '2 hours'
 ORDER BY l.fecha_creacion DESC;
