-- ============================================================================
-- 118 - Cada ruta con su moneda
-- ============================================================================
-- LO QUE SE PIDIO
-- "Vamos a crear para cada ruta un campo llamado moneda. Y alli tendremos una
--  libreria con las monedas de latinoamerica y con dolares, y podremos
--  seleccionarle a cada ruta la moneda con la que trabajar. Identifica los
--  paises de cada ruta y asignarle automaticamente una moneda a cada ruta."
--
-- POR QUE HACE FALTA
-- Toda la plata de la app se muestra con un `$` y formato colombiano, sin que
-- nada diga de que moneda se habla. Con rutas en Argentina, Ecuador y Paraguay
-- el mismo "$1.200" significa cosas muy distintas.
--
-- Y ya habia un parche que lo delata: `redondearCien` en lib/gestion-core.ts
-- no redondea por debajo de 1000 "porque las rutas 1 y 933 trabajan en
-- dolares". O sea que la app YA sabia que hay monedas distintas, pero lo
-- adivinaba por el monto en vez de preguntarlo. Este campo es el que permite
-- dejar de adivinar.
--
-- LA LIBRERIA DE MONEDAS VIVE EN EL CODIGO, NO EN LA BASE
-- --------------------------------------------------------
-- `lib/monedas.ts` tiene las 18 monedas con su simbolo, sus decimales y su
-- formato. Aca solo se guarda el CODIGO ISO 4217 ('ARS', 'USD', 'PYG'...).
--
-- Se penso en una tabla `monedas` y se descarto: seria una tabla de catalogo
-- que nadie edita, que obliga a un JOIN en cada consulta de plata y que
-- ademas habria que mantener sincronizada con el archivo del front, porque el
-- formateo igual ocurre en el navegador. El codigo ISO es estable —no cambia
-- nunca— asi que una CHECK contra la lista es suficiente y mas barato.
--
-- LA ASIGNACION AUTOMATICA
-- -------------------------
-- Se mira `pais` y, si no se reconoce, `ciudad`. Ese segundo intento NO es
-- por si acaso: la ruta 204 tiene las dos columnas al reves —`pais` dice
-- 'BUENOS AIRES' y `ciudad` dice 'ARGENTINA'—. Se comprobo contra produccion
-- que con esta regla las 14 rutas quedan con moneda y ninguna se queda fuera.
--
-- Quedaria asi (verificado corriendo la misma logica contra los datos reales):
--   ARS -> 151, 154, 168, 190, 196, 197, 204   (Argentina)
--   USD -> 2, 112, 166, 182, 933               (Ecuador, que usa dolar)
--   COP -> 1                                    (Colombia)
--   PYG -> 202                                  (Paraguay)
--
-- QUE NO CAMBIA
--   * Ningun monto. Esto NO convierte plata: un saldo de 500.000 sigue siendo
--     500.000, solo que ahora se sabe que son pesos argentinos y no
--     colombianos. No hay tasas de cambio en ningun lado.
--   * Ninguna vista, ninguna funcion, ningun saldo.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 6 no escriben nada.
-- ============================================================================


-- ── PASO 1) Que paises hay hoy (SOLO LECTURA) ────────────────────────────
-- Fijate en la 204: `pais` y `ciudad` estan cambiadas. El paso 4 lo resuelve,
-- pero lo suyo seria arreglar esa fila a mano algun dia.
SELECT id,
       nombre,
       pais,
       ciudad,
       CASE
         WHEN lower(trim(COALESCE(pais, ''))) IN ('argentina') THEN 'ARS'
         WHEN lower(trim(COALESCE(pais, ''))) IN ('colombia')  THEN 'COP'
         WHEN lower(trim(COALESCE(pais, ''))) IN ('ecuador')   THEN 'USD'
         WHEN lower(trim(COALESCE(pais, ''))) IN ('paraguay')  THEN 'PYG'
         ELSE '(por ciudad)'
       END AS moneda_probable
  FROM public.rutas
 ORDER BY id;


-- ── PASO 2) La columna ───────────────────────────────────────────────────
-- Tres letras, que es lo que mide un codigo ISO 4217. Sin DEFAULT a
-- proposito: una ruta nueva sin moneda tiene que NOTARSE en la pantalla de
-- configuracion, no heredar en silencio el peso colombiano y mostrar cifras
-- creibles pero de otro pais.
ALTER TABLE public.rutas
  ADD COLUMN IF NOT EXISTS moneda CHAR(3);


-- ── PASO 3) Que solo entren codigos de la libreria ───────────────────────
-- La lista es la misma de `lib/monedas.ts`. Si algun dia se agrega una moneda
-- alla, hay que agregarla aca tambien — el precio de no tener tabla de
-- catalogo, y esta escrito para que se sepa.
--
-- Se permite NULL: es "todavia no le han elegido moneda", que es un estado
-- valido y distinto de "tiene una moneda invalida".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rutas_moneda_valida'
  ) THEN
    ALTER TABLE public.rutas
      ADD CONSTRAINT rutas_moneda_valida CHECK (
        moneda IS NULL OR moneda IN (
          'USD','ARS','BOB','BRL','CLP','COP','CRC','CUP','DOP','GTQ',
          'HNL','MXN','NIO','PAB','PEN','PYG','UYU','VES'
        )
      );
  END IF;
END $$;


-- ── PASO 4) Asignarle la moneda a cada ruta ──────────────────────────────
-- Primero por pais. `unaccent` no esta garantizado en esta base, asi que las
-- tildes se resuelven a mano en la lista de ciudades del bloque siguiente.
--
-- El `WHERE moneda IS NULL` hace el script REPETIBLE: si ya se corrio, o si
-- alguien le cambio la moneda a una ruta a mano, no se le pisa.
UPDATE public.rutas
   SET moneda = CASE lower(trim(pais))
                  WHEN 'argentina' THEN 'ARS'
                  WHEN 'bolivia'   THEN 'BOB'
                  WHEN 'brasil'    THEN 'BRL'
                  WHEN 'chile'     THEN 'CLP'
                  WHEN 'colombia'  THEN 'COP'
                  WHEN 'ecuador'   THEN 'USD'
                  WHEN 'mexico'    THEN 'MXN'
                  WHEN 'paraguay'  THEN 'PYG'
                  WHEN 'peru'      THEN 'PEN'
                  WHEN 'uruguay'   THEN 'UYU'
                END
 WHERE moneda IS NULL
   AND lower(trim(COALESCE(pais, ''))) IN
       ('argentina','bolivia','brasil','chile','colombia','ecuador',
        'mexico','paraguay','peru','uruguay');


-- ── PASO 5) Las que tienen una CIUDAD donde deberia ir el pais ───────────
-- Este es el caso de la 204. Se mira en las dos columnas porque no se sabe
-- cual de las dos trae la ciudad.
UPDATE public.rutas
   SET moneda = CASE
                  WHEN lower(trim(COALESCE(pais, '')))   IN ('buenos aires','la plata','chaco','rosario','cordoba')
                    OR lower(trim(COALESCE(ciudad, ''))) IN ('argentina')
                    THEN 'ARS'
                  WHEN lower(trim(COALESCE(pais, '')))   IN ('cali','bogota','medellin')
                    OR lower(trim(COALESCE(ciudad, ''))) IN ('colombia')
                    THEN 'COP'
                  WHEN lower(trim(COALESCE(pais, '')))   IN ('cuenca','quito','guayaquil','ibarra','rioamba','riobamba')
                    OR lower(trim(COALESCE(ciudad, ''))) IN ('ecuador')
                    THEN 'USD'
                  WHEN lower(trim(COALESCE(pais, '')))   IN ('asuncion','asunción','ciudad del este')
                    OR lower(trim(COALESCE(ciudad, ''))) IN ('paraguay')
                    THEN 'PYG'
                END
 WHERE moneda IS NULL;


-- ── PASO 6) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- `sin_moneda` tiene que dar 0. Si no, esa ruta tiene en `pais` algo que no
-- esta en ninguna de las dos listas: se le pone a mano desde la pantalla de
-- Usuarios y Rutas, que para eso quedo el selector.
SELECT COUNT(*)                                  AS rutas,
       COUNT(*) FILTER (WHERE moneda IS NULL)    AS sin_moneda
  FROM public.rutas;

SELECT moneda,
       COUNT(*)                          AS rutas,
       string_agg(id::text, ', ' ORDER BY id) AS unidades
  FROM public.rutas
 GROUP BY moneda
 ORDER BY moneda;
