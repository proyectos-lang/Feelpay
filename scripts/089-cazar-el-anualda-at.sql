-- ============================================================================
-- 089 - Cazar el `anualda_at` que quedó suelto
-- ============================================================================
-- DÓNDE ESTAMOS
-- El script 088 creó las cuatro columnas y reinstaló `anular_venta`. Se
-- comprobó contra la base:
--
--   · `loans` ya tiene anulada_at, anulada_por, anulada_por_nombre y
--     motivo_anulacion — las 26 columnas están.
--   · `anular_venta` es la buena: sus cuatro guardas responden en orden
--     (rol, loan_id, motivo, "La venta no existe") y no hay otra versión con
--     otra firma que PostgREST pudiera estar eligiendo.
--
-- Y aun así anular sigue fallando con el MISMO mensaje:
--
--   column anualda_at of relation loans does not exist
--
-- Fíjate en el nombre: `anualda_at`, con las letras cambiadas. No es la
-- columna que se creó. Ese nombre no aparece en ningún script del repositorio
-- —se buscó— así que está escrito a mano en algún objeto de la base, y ese
-- objeto corre DENTRO de la anulación: un trigger sobre `loans`, o una función
-- que `anular_venta` llama después del UPDATE.
--
-- Desde la app no se puede mirar: el catálogo de PostgreSQL no está expuesto a
-- la llave pública. Por eso este script primero LO BUSCA y después LO ARREGLA.
--
-- POR QUÉ NO ROMPIÓ NADA MÁS
-- Lo que sea que lo tenga, solo se ejecuta al anular. Registrar pagos, crear
-- ventas y recalcular saldos también escriben en `loans` y funcionan todos los
-- días, así que no puede ser algo que corra siempre.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) ¿QUIÉN LO TIENE? Funciones (SOLO LECTURA) ─────────────────────
-- Corre esto PRIMERO y guarda el resultado: es la respuesta a "de dónde salía
-- el error". Si sale vacío, salta al PASO 2, que busca en otros sitios.
SELECT n.nspname     AS esquema,
       p.proname     AS funcion,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       -- El pedacito con el error, para verlo sin leer 500 líneas
       substring(p.prosrc from '.{0,60}anualda.{0,60}') AS donde_aparece
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.prosrc LIKE '%anualda%'
 ORDER BY p.proname;


-- ── PASO 2) ¿Y en las vistas? (SOLO LECTURA) ──────────────────────────────
-- Menos probable —una vista no se ejecuta en un UPDATE— pero si aparece algo
-- acá, NO lo arregla el paso 4: avísame antes de tocarlo.
SELECT schemaname, viewname,
       substring(definition from '.{0,60}anualda.{0,60}') AS donde_aparece
  FROM pg_views
 WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
   AND definition LIKE '%anualda%';


-- ── PASO 3) Los triggers que tiene `loans` (SOLO LECTURA) ─────────────────
-- Para saber qué se dispara al escribir en la tabla. La lógica de un trigger
-- vive en su función, así que si el culpable es uno, ya salió en el PASO 1 —
-- esto es para verlo en contexto.
SELECT t.tgname                                   AS trigger,
       p.proname                                  AS funcion_que_ejecuta,
       pg_get_triggerdef(t.oid)                   AS definicion
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
 WHERE c.relname = 'loans'
   AND NOT t.tgisinternal
 ORDER BY t.tgname;


-- ── PASO 4) ARREGLARLO ────────────────────────────────────────────────────
-- Reescribe cada función que tenga `anualda` cambiándolo por `anulada`, que es
-- como se llama la columna de verdad.
--
-- Se lee la definición viva y se le cambia SOLO esa palabra: no se transcribe
-- nada a mano, igual que en los scripts 083 y 087. Y se cambia una palabra que
-- no existe en ningún otro sitio —`anualda` no es una columna, ni una tabla,
-- ni una palabra— así que no puede pisar nada por accidente.
--
-- Avisa por consola qué tocó. Si no encuentra ninguna, lo dice: significa que
-- el error viene de un sitio que este script no cubre, y hay que mirar lo que
-- salió en el PASO 2.
DO $fix089$
DECLARE
  r         record;
  v_src     text;
  v_nuevo   text;
  v_cuantas int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, n.nspname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prosrc LIKE '%anualda%'
       AND p.prokind = 'f'          -- funciones normales; no agregados ni ventana
  LOOP
    v_src   := pg_get_functiondef(r.oid);
    v_nuevo := replace(v_src, 'anualda', 'anulada');
    EXECUTE v_nuevo;
    v_cuantas := v_cuantas + 1;
    RAISE NOTICE 'Arreglada: %.%', r.nspname, r.proname;
  END LOOP;

  IF v_cuantas = 0 THEN
    RAISE NOTICE 'No había ninguna función con "anualda". Mira el PASO 2.';
  ELSE
    RAISE NOTICE 'Listo: % función(es) arreglada(s).', v_cuantas;
  END IF;
END
$fix089$;


-- ── PASO 5) Que no quedó ninguna (SOLO LECTURA) ───────────────────────────
-- TIENE QUE DAR 0. Si da otra cosa, el paso 4 no alcanzó a todas.
SELECT COUNT(*) AS funciones_con_el_error
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.prosrc LIKE '%anualda%';


-- ── PASO 6) Y que las que importan siguen bien escritas (SOLO LECTURA) ────
-- Las dos columnas `_ok` tienen que dar true.
SELECT p.proname AS funcion,
       strpos(p.prosrc, 'anulada') > 0 AS escribe_bien_ok,
       strpos(p.prosrc, 'anualda') = 0 AS sin_el_error_ok
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('anular_venta', 'recalcular_prestamo')
 ORDER BY p.proname;


-- ── PASO 7) Después de anular una venta de prueba (SOLO LECTURA) ──────────
-- Corre ESTO cuando ya hayas anulado una desde Control Total. Tiene que
-- aparecer con su fecha, quién la anuló y el motivo.
SELECT l.id, l.ruta, c.nombre_completo, l.estado,
       l.anulada_at, l.anulada_por_nombre, l.motivo_anulacion
  FROM public.loans l
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'anulado'
 ORDER BY l.anulada_at DESC;
