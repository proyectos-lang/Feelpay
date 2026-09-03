-- ============================================================================
-- 097 - Las cuotas, de quinientos en quinientos
-- ============================================================================
-- LO QUE SE PIDIÓ
-- "Que la aproximación sea que las cuotas se cierren en múltiplos de 500,
--  redondeando hacia arriba o hacia abajo. Para los préstamos que sean
--  pequeños —cuotas de 35, 26— esos sí los dejamos normales."
--
-- QUÉ HAY HOY
-- El script 087 puso el redondeo AL MILLAR: $19.500 subía a $20.000 y $19.499
-- bajaba a $19.000.
--
-- POR QUÉ EL MILLAR SE QUEDÓ GRANDE
-- Mueve demasiado. Una cuota de $19.499 se iba a $19.000 —medio punto
-- porcentual abajo— y esa diferencia, por veinticinco cuotas, se la come
-- entera la última: quedaba con $12.000 de más. Con 500 el ajuste es la mitad
-- y las cuotas siguen siendo números que se dicen en voz alta y se pagan con
-- billetes.
--
-- CAMBIA UNA SOLA COSA: EL ESCALÓN. De 1000 a 500. La forma de redondear, las
-- dos guardas y el que la última cuota absorba el residuo se quedan igual.
--
--   19.499  ->  19.500   (antes 19.000)
--   19.600  ->  19.500
--   19.750  ->  20.000   (el punto medio sube)
--   33.600  ->  33.500   (antes 34.000 — caso real de la ruta 190)
--
-- LOS PRÉSTAMOS CHICOS NO SE TOCAN, igual que antes: por debajo de MIL la
-- función devuelve la cuota tal cual. La ruta 933 es de Ecuador y trabaja en
-- dólares —cuotas de $2 a $80— y a múltiplos de 500 quedarían todas en cero.
--
-- El corte sigue en MIL y no en 500 a propósito: entre 500 y 999 el escalón
-- vale más que la mitad de la cuota, así que redondear ahí la deforma en vez
-- de acomodarla.
--
-- SOLO PARA LAS VENTAS DE AQUÍ EN ADELANTE. No se toca ni un crédito ya
-- creado: sus cronogramas están escritos y su plata repartida sobre ellos.
-- Es la misma decisión que se tomó con el 087.
--
-- Corre los pasos DE A UNO. El editor de Supabase mete todo lo que se le pega
-- en una sola transacción, y si un paso falla se deshacen los anteriores — es
-- lo que le pasó al 087 la primera vez.
-- ============================================================================


-- ── PASO 1) Qué está puesto hoy (SOLO LECTURA) ────────────────────────────
-- Tiene que salir la del 087, con `1000.0` adentro. Guardá el resultado.
SELECT p.proname,
       strpos(pg_get_functiondef(p.oid), '1000.0') > 0 AS redondea_al_millar,
       strpos(pg_get_functiondef(p.oid), '500.0')  > 0 AS redondea_a_quinientos,
       pg_get_functiondef(p.oid)                       AS definicion
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'redondear_cuota';


-- ── PASO 2) El escalón nuevo ──────────────────────────────────────────────
-- Se reescribe entera y no con un `replace` sobre la definición viva: son
-- veinte líneas que caben a la vista, y acá lo que importa es que el texto
-- que se lee sea el que corre. (El truco de parchear la definición se usa
-- cuando la función tiene cientos de líneas — ver los scripts 083 y 094.)
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

  -- Al múltiplo de 500 más cercano, con el punto medio subiendo.
  --   19.499 / 500 = 38,998 + 0,5 = 39,498 -> floor 39 -> 19.500
  --   19.600 / 500 = 39,2   + 0,5 = 39,7   -> floor 39 -> 19.500
  --   19.750 / 500 = 39,5   + 0,5 = 40,0   -> floor 40 -> 20.000
  v_r := floor(p_base / 500.0 + 0.5) * 500;

  -- GUARDA 2: la última tiene que quedar en algo. Se baja de 500 en 500.
  WHILE v_r > 0 AND p_total - v_r * (p_cuotas - 1) <= 0 LOOP
    v_r := v_r - 500;
  END LOOP;

  -- Si no cabe ningún múltiplo de 500, se deja como estaba.
  IF v_r <= 0 THEN
    RETURN round(p_base, 2);
  END IF;

  RETURN v_r;
END;
$$;


-- ── PASO 3) Que la app la pueda usar ──────────────────────────────────────
-- `CREATE OR REPLACE` conserva los permisos, pero se repite por si alguna vez
-- hay que recrearla desde cero.
GRANT EXECUTE ON FUNCTION public.redondear_cuota(numeric, numeric, integer) TO anon, authenticated;


-- ── PASO 4) La regla, caso por caso (SOLO LECTURA) ────────────────────────
-- `ok` tiene que dar true en las DIECISIETE filas. Son los mismos casos que
-- se corrieron contra el espejo de la app (`lib/loan-schedule.ts`), con los
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
    ( 19500::numeric, 487500::numeric, 25,  19500::numeric, 'ya es múltiplo de 500'),
    ( 19499::numeric, 487475::numeric, 25,  19500::numeric, 'sube al 500 más cercano (con el millar bajaba a 19.000)'),
    ( 19600::numeric, 490000::numeric, 25,  19500::numeric, 'baja: 19.600 está más cerca de 19.500'),
    ( 19750::numeric, 493750::numeric, 25,  20000::numeric, 'el punto medio sube'),
    ( 19749::numeric, 493725::numeric, 25,  19500::numeric, 'justo debajo del medio, baja'),
    ( 33600::numeric, 840000::numeric, 25,  33500::numeric, 'caso real ruta 190 (con el millar daba 34.000)'),
    (  7500::numeric, 150000::numeric, 20,   7500::numeric, 'ruta 154: ya es múltiplo, no se mueve'),
    (216666.67::numeric, 650000::numeric, 3, 216500::numeric, '500.000 al 30% en 3 cuotas'),
    (    35::numeric,    875::numeric, 25,     35::numeric, 'Ecuador: cuota de 35, sin tocar'),
    (    26::numeric,    650::numeric, 25,     26::numeric, 'Ecuador: cuota de 26, sin tocar'),
    (     6::numeric,    150::numeric, 25,      6::numeric, 'Ecuador: cuota de 6, sin tocar'),
    (    80::numeric,   2000::numeric, 25,     80::numeric, 'Ecuador: la más alta de la 933'),
    (   999::numeric,  24975::numeric, 25,    999::numeric, 'justo debajo del corte: no se toca'),
    (  1000::numeric,  25000::numeric, 25,   1000::numeric, 'justo en el corte: ya es múltiplo'),
    (  1200::numeric,  30000::numeric, 25,   1000::numeric, '1.200 baja a 1.000'),
    (  1300::numeric,  32500::numeric, 25,   1000::numeric, 'subiría a 1.500, no cabe: la guarda 2 lo baja'),
    (  1300::numeric,  40000::numeric, 25,   1500::numeric, '1.300 sube a 1.500 cuando sí cabe')
  ) AS b(base, total, cuotas, esperado, caso);


-- ── PASO 5) Que la suma del plan siga siendo exacta (SOLO LECTURA) ────────
-- La última cuota absorbe el residuo, así que `suma` tiene que ser IGUAL a
-- `total` en todas las filas, y `ultima` siempre mayor que cero. Es lo que
-- garantiza que redondear no le regale ni le cobre de más a nadie.
SELECT v.valor, v.tasa, v.n,
       (v.valor * (1 + v.tasa / 100.0))                                   AS total,
       public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                              v.valor * (1 + v.tasa / 100.0), v.n)        AS cuota,
       (v.valor * (1 + v.tasa / 100.0))
         - public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                                  v.valor * (1 + v.tasa / 100.0), v.n) * (v.n - 1)
                                                                          AS ultima,
       public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                              v.valor * (1 + v.tasa / 100.0), v.n) * (v.n - 1)
         + ((v.valor * (1 + v.tasa / 100.0))
            - public.redondear_cuota(v.valor * (1 + v.tasa / 100.0) / v.n,
                                     v.valor * (1 + v.tasa / 100.0), v.n) * (v.n - 1))
                                                                          AS suma
  FROM (VALUES
    ( 300000::numeric, 30::numeric, 20),
    ( 500000::numeric, 30::numeric,  3),
    ( 150000::numeric, 60::numeric, 25),
    (1000000::numeric, 20::numeric, 30),
    ( 250000::numeric, 40::numeric, 12)
  ) AS v(valor, tasa, n);


-- ── PASO 6) Que quedó puesta (SOLO LECTURA) ───────────────────────────────
-- `redondea_a_quinientos` = true y `redondea_al_millar` = false.
SELECT p.proname,
       strpos(pg_get_functiondef(p.oid), '1000.0') > 0 AS redondea_al_millar,
       strpos(pg_get_functiondef(p.oid), '500.0')  > 0 AS redondea_a_quinientos
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'redondear_cuota';


-- ── PASO 7) Que NINGÚN crédito viejo se movió (SOLO LECTURA) ──────────────
-- TIENE QUE SALIR VACÍO. `redondear_cuota` la llama `generar_cronograma` al
-- CREAR o EDITAR una venta, no al leerla, así que los planes ya escritos no
-- se tocan. Esto lo comprueba en vez de darlo por hecho: busca cuotas cuyo
-- valor no sea múltiplo de 500 y que ADEMÁS sean de un crédito creado después
-- de este script — o sea, las que sí tendrían que estar redondeadas.
SELECT l.ruta, l.id, pp.numero_cuota, pp.valor_cuota, l.fecha_creacion
  FROM public.payment_plan pp
  JOIN public.loans l ON l.id = pp.loan_id
 WHERE l.fecha_creacion > now()
   AND pp.valor_cuota >= 1000
   AND (pp.valor_cuota::numeric % 500) <> 0
   AND pp.numero_cuota < l.numero_cuotas   -- la última absorbe el residuo
 ORDER BY l.fecha_creacion DESC;


-- ── PASO 8) La prueba de fuego, ya en la app ──────────────────────────────
-- Registrá una venta de $300.000 al 30% en 20 cuotas. El plan tiene que
-- quedar con cuotas de $19.500 —no $20.000— y la última también en $19.500,
-- porque 19.500 × 20 = 390.000 exactos.
--
-- Corré esto después y mirá `valor_cuota`: todas múltiplos de 500.
SELECT l.ruta, c.nombre_completo, l.valor, l.tasa_interes, l.numero_cuotas,
       l.valor_cuota, l.valor_a_pagar,
       (SELECT string_agg(DISTINCT pp.valor_cuota::text, ', ' ORDER BY pp.valor_cuota::text)
          FROM public.payment_plan pp WHERE pp.loan_id = l.id) AS cuotas_del_plan
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.fecha_creacion > now() - interval '2 hours'
 ORDER BY l.fecha_creacion DESC;
