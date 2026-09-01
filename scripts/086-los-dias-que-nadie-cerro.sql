-- ============================================================================
-- 086 - Los días que nadie cerró
-- ============================================================================
-- PARA QUÉ
-- Es el PASO 1 de dos. El paso 2 es que la ruta amanezca CONGELADA cuando la
-- caja del día anterior quedó sin cerrar, y que solo una secretaría autorizada
-- pueda desbloquearla para terminar ese cierre.
--
-- Ese paso 2 no se puede encender sobre la base como está. Medido el
-- 01/09/2026:
--
--   días pasados con la jornada todavía 'abierta' : 43
--   rutas afectadas                               :  8
--       ruta   1 : 15 días        ruta 190 :  6 días
--       ruta 151 :  6 días        ruta 154 :  6 días
--       ruta   0 :  3 días        ruta 197 :  3 días
--       ruta 933 :  3 días        ruta 196 :  1 día
--
--   de las 74 jornadas registradas, 47 están 'abierta': no cerrar la caja es
--   la norma, no la excepción.
--
-- Encender el congelamiento sin limpiar esto dejaría las 8 rutas bloqueadas al
-- día siguiente, y la ruta 1 tendría que cerrar 15 días viejos antes de cobrar
-- un peso. Este script deja el terreno parejo.
--
-- QUÉ HACE, Y QUÉ NO
-- Cierra esas 43 jornadas dejando ESCRITO que se cerraron por limpieza y no
-- por un cuadre. No inventa un cierre: no toca `hora_fin`, que se queda en
-- NULL, y marca `cerrada_sin_cuadre`. Un informe que quiera distinguir un
-- cierre de verdad de uno administrativo tiene con qué.
--
-- NO MUEVE UN PESO. `rutas_diarias` dice cuándo se abrió y se cerró la
-- jornada; la plata vive en `gestiones` y en `gastosregistros`, y este script
-- no los toca. Lo que se cobró esos días sigue cobrado y contado.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) La marca de "esto no fue un cuadre" ───────────────────────────
-- Va como columna y no se deduce de `hora_fin IS NULL`. Hoy las 27 jornadas
-- cerradas de verdad tienen todas su `hora_fin`, así que la deducción
-- funcionaría —pero funcionaría por coincidencia, y el día que alguien
-- rellene esa columna a mano se pierde el dato sin que nadie se entere.
ALTER TABLE public.rutas_diarias
  ADD COLUMN IF NOT EXISTS cerrada_sin_cuadre boolean NOT NULL DEFAULT false;


-- ── PASO 2) Y el porqué, escrito ──────────────────────────────────────────
-- Para que dentro de seis meses nadie tenga que adivinar por qué el 14 de
-- agosto de la ruta 933 aparece cerrado sin comprobante.
ALTER TABLE public.rutas_diarias
  ADD COLUMN IF NOT EXISTS observacion text;


-- ── PASO 3) Foto de lo que se va a tocar (SOLO LECTURA) ───────────────────
-- Córrelo ANTES del paso 4 y guarda el resultado. Es la lista de jornadas que
-- van a cambiar de estado, y la única forma de saber después cuáles fueron.
SELECT rd.ruta_id,
       r.nombre AS ruta,
       rd.fecha,
       rd.hora_inicio,
       rd.estado
  FROM public.rutas_diarias rd
  LEFT JOIN public.rutas r ON r.id = rd.ruta_id
 WHERE rd.estado = 'abierta'
   AND rd.fecha < (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY rd.ruta_id, rd.fecha;


-- ── PASO 4) Cerrarlas ─────────────────────────────────────────────────────
-- `fecha <` y no `<=`: la jornada de HOY no se toca, esté como esté. Alguien
-- puede estar cobrando en este momento.
--
-- `hora_fin` se queda en NULL a propósito. Ponerle una hora sería inventar el
-- momento en que se cuadró una caja que nunca se cuadró.
UPDATE public.rutas_diarias
   SET estado             = 'cerrada',
       cerrada_sin_cuadre = true,
       observacion        = COALESCE(observacion || ' · ', '')
                          || 'Cerrada por el script 086: la jornada quedó abierta '
                          || 'y nadie hizo el cierre de caja. No hubo cuadre.'
 WHERE estado = 'abierta'
   AND fecha < (now() AT TIME ZONE 'America/Bogota')::date;


-- ── PASO 5) Que no quedó ninguna suelta (SOLO LECTURA) ────────────────────
-- TIENE QUE DAR 0. Si da otra cosa, el paso 4 no alcanzó a todas y encender el
-- congelamiento seguiría bloqueando rutas.
SELECT COUNT(*) AS dias_pasados_todavia_abiertos
  FROM public.rutas_diarias
 WHERE estado = 'abierta'
   AND fecha < (now() AT TIME ZONE 'America/Bogota')::date;


-- ── PASO 6) Cómo quedó el conteo (SOLO LECTURA) ───────────────────────────
-- Se esperan ~43 en 'cerrada sin cuadre' y las 27 de siempre en 'cerrada de
-- verdad'. Las 'abierta' que queden deben ser todas de HOY.
SELECT CASE
         WHEN estado = 'abierta'      THEN 'abierta (hoy)'
         WHEN cerrada_sin_cuadre      THEN 'cerrada SIN cuadre (script 086)'
         ELSE                              'cerrada con su cuadre'
       END AS tipo,
       COUNT(*) AS cuantas,
       MIN(fecha) AS desde,
       MAX(fecha) AS hasta
  FROM public.rutas_diarias
 GROUP BY 1
 ORDER BY cuantas DESC;


-- ── PASO 7) Las jornadas abiertas que quedan (SOLO LECTURA) ───────────────
-- Todas tienen que ser de hoy. Si aparece una de otra fecha, algo se escapó.
SELECT rd.ruta_id, r.nombre AS ruta, rd.fecha, rd.hora_inicio
  FROM public.rutas_diarias rd
  LEFT JOIN public.rutas r ON r.id = rd.ruta_id
 WHERE rd.estado = 'abierta'
 ORDER BY rd.fecha, rd.ruta_id;
