-- ============================================================================
-- 119 - Las tasas de cambio y su vigencia
-- ============================================================================
-- LO QUE SE PIDIO
-- "En secretaria un modulo de registro de tasas de cambio, donde vamos a poner
--  la tasa de cambio de las monedas que vamos a manejar en el sistema en su
--  conversion a USD. Hay que implementar un sistema que permita que estas
--  tasas de cambio tengan un rango de fechas, para que en el tiempo podamos
--  ver los movimientos que se hicieron con su tasa de cambio en ese entonces."
--
-- LO IMPORTANTE ES LA ULTIMA FRASE
-- ---------------------------------
-- No se trata de saber cuanto vale el dolar HOY: eso se busca en internet.
-- Se trata de que un gasto del 3 de agosto se siga viendo con la tasa que
-- habia EL 3 DE AGOSTO, aunque hoy el dolar este al doble. Por eso la tasa no
-- es una columna con el valor actual, sino una tabla con historia.
--
-- Una tabla de "tasa actual" haria que el informe de agosto cambiara solo
-- cada vez que se actualiza el dolar, y los numeros del pasado dejarian de
-- cuadrar con lo que se reporto en su momento.
--
-- COMO SE ESCRIBE LA TASA (lo decidio el dueño)
-- ----------------------------------------------
-- CUANTA MONEDA LOCAL VALE 1 USD. "El dolar esta a 1.450" se carga como
-- 1450, que es como se cotiza y como lo dice la gente. Para pasar a dolares
-- se DIVIDE:  USD = monto_local / tasa.
--
-- Se prefirio sobre el factor directo (1 ARS = 0,00068966 USD) porque ese
-- obliga a teclear ocho decimales y un error de un digito no se ve al
-- escribirlo.
--
-- EL RANGO DE FECHAS (tambien lo decidio el dueño)
-- -------------------------------------------------
-- Se carga SOLO la fecha de inicio y la tasa anterior se cierra sola el dia
-- antes. Asi es IMPOSIBLE que queden huecos (un dia sin tasa) o solapes (un
-- dia con dos tasas), que es justo lo que rompe una conversion historica: un
-- movimiento de ese dia no sabria cual de las dos usar.
--
-- `vigente_hasta = NULL` significa "hasta nuevo aviso", que es la tasa de hoy.
--
-- USD NO LLEVA TASA. Un dolar vale un dolar; la funcion lo resuelve sola y
-- una CHECK impide cargarla, porque una tasa USD->USD distinta de 1 seria
-- plata inventada.
--
-- QUE NO CAMBIA
--   * Ningun monto, ningun saldo, ninguna vista. Esto solo AGREGA una forma
--     de mirar la misma plata. La moneda de verdad de una ruta sigue siendo
--     la suya; el dolar es una lectura de arriba, para comparar unidades de
--     paises distintos.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 8 no escriben nada.
-- ============================================================================


-- ── PASO 1) Con que monedas se trabaja hoy (SOLO LECTURA) ────────────────
-- Son las que van a necesitar tasa. USD no la necesita.
SELECT moneda,
       COUNT(*)                               AS rutas,
       string_agg(id::text, ', ' ORDER BY id) AS unidades
  FROM public.rutas
 WHERE moneda IS NOT NULL
 GROUP BY moneda
 ORDER BY moneda;


-- ── PASO 2) La tabla ─────────────────────────────────────────────────────
-- `tasa` es NUMERIC(20,6) y no un float: con `double precision` la division
-- arrastra error y dos informes del mismo mes pueden no dar igual. Seis
-- decimales alcanzan de sobra — el guarani, que es la moneda mas debil de la
-- region, cotiza sobre 7.300 por dolar.
CREATE TABLE IF NOT EXISTS public.tasas_cambio (
  id             BIGSERIAL PRIMARY KEY,
  moneda         CHAR(3)     NOT NULL,
  -- CUANTA MONEDA LOCAL VALE 1 USD. 1450 = "el dolar esta a 1.450".
  tasa           NUMERIC(20,6) NOT NULL,
  vigente_desde  DATE        NOT NULL,
  -- NULL = sigue vigente. Lo cierra solo el trigger del paso 5.
  vigente_hasta  DATE,
  nota           TEXT,
  creado_por     BIGINT      REFERENCES public.usuarios(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Una tasa de cero o negativa haria una division por cero o plata negativa.
  CONSTRAINT tasas_cambio_positiva CHECK (tasa > 0),

  -- El dolar no se convierte a si mismo.
  CONSTRAINT tasas_cambio_no_usd CHECK (moneda <> 'USD'),

  -- La misma lista de `lib/monedas.ts` y del script 118.
  CONSTRAINT tasas_cambio_moneda_valida CHECK (
    moneda IN ('ARS','BOB','BRL','CLP','COP','CRC','CUP','DOP','GTQ',
               'HNL','MXN','NIO','PAB','PEN','PYG','UYU','VES')
  ),

  -- Un rango al reves no se puede consultar.
  CONSTRAINT tasas_cambio_rango_valido CHECK (
    vigente_hasta IS NULL OR vigente_hasta >= vigente_desde
  ),

  -- Dos tasas de la misma moneda no pueden empezar el mismo dia.
  CONSTRAINT tasas_cambio_una_por_dia UNIQUE (moneda, vigente_desde)
);


-- ── PASO 3) Indice para la busqueda de siempre ───────────────────────────
-- "Que tasa tenia el ARS el 3 de agosto" es la consulta que va a correr una
-- vez por cada movimiento que se muestre.
CREATE INDEX IF NOT EXISTS idx_tasas_cambio_busqueda
  ON public.tasas_cambio (moneda, vigente_desde DESC);


-- ── PASO 4) Una sola tasa vigente por moneda ─────────────────────────────
-- Indice UNICO parcial: solo mira las filas con `vigente_hasta IS NULL`. Es
-- la red de seguridad por debajo del trigger — si algo fallara alli, la base
-- igual impide dos tasas abiertas para la misma moneda.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasas_cambio_una_vigente
  ON public.tasas_cambio (moneda)
  WHERE vigente_hasta IS NULL;


-- ── PASO 5) Al cargar una tasa, se cierra la anterior ────────────────────
-- Esto es lo que hace imposible el hueco y el solape. Sin el trigger habria
-- que acordarse de cerrar la anterior a mano, y el dia que alguien lo olvide
-- la conversion de ese dia queda ambigua.
--
-- Se cierra el dia ANTES de que empiece la nueva: si la nueva rige desde el
-- 20, la vieja rige hasta el 19. Asi los rangos se tocan sin pisarse.
CREATE OR REPLACE FUNCTION public.cerrar_tasa_anterior()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- CIERRA LA QUE CUBRIA ESTE DIA, este abierta o ya cerrada.
  --
  -- El `vigente_hasta IS NULL OR vigente_hasta >= NEW.vigente_desde` es lo
  -- importante y costo un bug: mirar solo las ABIERTAS funciona cuando las
  -- tasas se cargan en orden, pero con una correccion RETROACTIVA —cargar el
  -- 10 cuando ya existen el 1 y el 20— la del 1 ya estaba cerrada al 19 y
  -- quedaba pisandose con la nueva. Dos tasas para los mismos dias es
  -- exactamente lo que este trigger existe para impedir.
  UPDATE public.tasas_cambio
     SET vigente_hasta = NEW.vigente_desde - 1
   WHERE moneda = NEW.moneda
     AND id <> NEW.id
     AND vigente_desde < NEW.vigente_desde
     AND (vigente_hasta IS NULL OR vigente_hasta >= NEW.vigente_desde);

  -- Y la nueva se cierra contra la siguiente que ya exista. Si no hay
  -- ninguna posterior queda abierta, que es el caso normal.
  UPDATE public.tasas_cambio
     SET vigente_hasta = (
           SELECT MIN(t2.vigente_desde) - 1
             FROM public.tasas_cambio t2
            WHERE t2.moneda = NEW.moneda
              AND t2.vigente_desde > NEW.vigente_desde
         )
   WHERE id = NEW.id
     AND EXISTS (
           SELECT 1 FROM public.tasas_cambio t3
            WHERE t3.moneda = NEW.moneda
              AND t3.vigente_desde > NEW.vigente_desde
         );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cerrar_tasa_anterior ON public.tasas_cambio;
CREATE TRIGGER trg_cerrar_tasa_anterior
  AFTER INSERT ON public.tasas_cambio
  FOR EACH ROW
  EXECUTE FUNCTION public.cerrar_tasa_anterior();


-- ── PASO 6) La funcion que usa todo el mundo ─────────────────────────────
-- "Cuanto valia 1 USD en esta moneda ESE dia". Devuelve NULL si no hay tasa
-- cargada para esa fecha — y NULL es la respuesta correcta: obliga a la
-- pantalla a decir "sin tasa" en vez de mostrar un cero que parece plata.
--
-- `STABLE` porque no escribe y dentro de una misma consulta siempre da lo
-- mismo: deja que el planificador la llame una vez por fila y no mas.
CREATE OR REPLACE FUNCTION public.tasa_vigente(
  p_moneda CHAR(3),
  p_fecha  DATE
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN p_moneda = 'USD' THEN 1::NUMERIC
           ELSE (
             SELECT t.tasa
               FROM public.tasas_cambio t
              WHERE t.moneda = p_moneda
                AND t.vigente_desde <= p_fecha
                AND (t.vigente_hasta IS NULL OR t.vigente_hasta >= p_fecha)
              ORDER BY t.vigente_desde DESC
              LIMIT 1
           )
         END;
$$;


-- ── PASO 7) Permisos ─────────────────────────────────────────────────────
-- La app lee y escribe con la llave anon, igual que con todo lo demas. El
-- DELETE se permite para poder borrar una tasa recien cargada con un error de
-- dedo; no hay plata en esta tabla, asi que no aplica la regla de "nada se
-- borra, se reversa".
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasas_cambio TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.tasas_cambio_id_seq TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tasa_vigente(CHAR, DATE) TO anon, authenticated;


-- ── PASO 8) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- La tabla tiene que existir y estar VACIA: las tasas se cargan desde el
-- modulo "Tasas de Cambio" de secretaria, no a mano.
SELECT COUNT(*) AS tasas_cargadas FROM public.tasas_cambio;

-- La funcion responde. USD tiene que dar 1 y una moneda sin tasa, NULL.
SELECT public.tasa_vigente('USD', CURRENT_DATE) AS usd_siempre_1,
       public.tasa_vigente('ARS', CURRENT_DATE) AS ars_hoy_null_si_no_hay;


-- ── PASO 9) Como se cargaria a mano, si hiciera falta (NO SE CORRE SOLO) ─
-- Queda de referencia. Lo normal es hacerlo desde la app.
--
--   INSERT INTO public.tasas_cambio (moneda, tasa, vigente_desde, nota)
--   VALUES ('ARS', 1450, '2026-09-20', 'Oficial BNA');
--
-- Y para ver la historia de una moneda:
--
--   SELECT moneda, tasa, vigente_desde, vigente_hasta
--     FROM public.tasas_cambio
--    WHERE moneda = 'ARS'
--    ORDER BY vigente_desde DESC;
