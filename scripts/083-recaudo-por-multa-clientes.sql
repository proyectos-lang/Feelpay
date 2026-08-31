-- ============================================================================
-- 083 - "Recaudo x Multa Clientes": un concepto que solo escribe el sistema
-- ============================================================================
-- QUÉ PASA HOY
-- Cuando un cliente paga una multa, `registrar_gestion` mete esa plata en
-- `gastosregistros` como Ingreso. Hasta ahí, bien: entró a la caja y tiene que
-- estar ahí. El problema es el CONCEPTO con el que entra:
--
--     'Multa — carmen ballos'           $20
--     'Multa — damaris pul  rodríguez'  $40
--
-- Uno distinto por cliente. Así, las multas no se pueden sumar en una sola
-- línea de ningún informe: cada una es un concepto que no existe en el catálogo
-- de ingresos y que no se parece a ningún otro. Con veinte multas cobradas hay
-- veinte conceptos de una fila cada uno.
--
-- LA CORRECCIÓN
-- Un concepto único, 'Recaudo x Multa Clientes', que el sistema usa siempre. El
-- nombre del cliente no se pierde: pasa a la observación, que es justamente
-- donde vive el detalle de cada movimiento.
--
-- POR QUÉ NADIE LO PUEDE ELEGIR A MANO
-- Si el cobrador pudiera escogerlo del desplegable, esa línea dejaría de
-- significar lo que dice. Hoy "Recaudo x Multa Clientes" es, por construcción,
-- exactamente lo que el sistema cobró en multas: nada más entra ahí. Un
-- concepto que cualquiera puede usar a mano es un concepto del que ya no se
-- puede afirmar nada.
--
-- La marca es una COLUMNA, `solo_sistema`, y no una comparación por nombre en
-- la app: un día alguien retoca el nombre y la comparación deja de coincidir
-- sin que nadie se entere.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia y se puede repetir
-- sin daño.
-- ============================================================================


-- ── PASO 1) La marca ──────────────────────────────────────────────────────
-- Por defecto `false`: los cuatro conceptos que ya existen siguen a la mano de
-- todo el mundo, igual que hasta ahora.
ALTER TABLE public.ingresos
  ADD COLUMN IF NOT EXISTS solo_sistema boolean NOT NULL DEFAULT false;


-- ── PASO 2) El concepto ───────────────────────────────────────────────────
-- Va con `WHERE NOT EXISTS` y no con `ON CONFLICT` porque `ingresos.nombre` no
-- tiene índice único: `ON CONFLICT (nombre)` fallaría con "no unique or
-- exclusion constraint matching". Así es idempotente igual, sin tener que
-- crear una llave nueva sobre una tabla que ya está en uso.
INSERT INTO public.ingresos (nombre, activo, limite, solo_sistema)
SELECT 'Recaudo x Multa Clientes', true, NULL, true
 WHERE NOT EXISTS (
   SELECT 1 FROM public.ingresos WHERE nombre = 'Recaudo x Multa Clientes'
 );


-- ── PASO 3) Y queda marcado ───────────────────────────────────────────────
-- Cubre el caso de que alguien ya lo hubiera creado a mano desde el catálogo:
-- existiría con `solo_sistema = false` y seguiría siendo elegible.
UPDATE public.ingresos
   SET solo_sistema = true, activo = true
 WHERE nombre = 'Recaudo x Multa Clientes';


-- ── PASO 4) Que el sistema lo use ─────────────────────────────────────────
-- NO se vuelve a escribir `registrar_gestion` a mano. Se lee la definición que
-- está VIVA en la base, se le cambian esas dos líneas y se vuelve a instalar.
--
-- Esto no es coquetería: la función son 500 líneas, y ya pasó una vez (script
-- 081) que transcribirla a mano se comió cinco columnas de un INSERT. Copiando
-- la definición viva no hay nada que transcribir, y además se conservan solos
-- la firma, el SECURITY DEFINER, el search_path y los permisos.
--
-- Si el texto que se busca no está donde se espera, el bloque ABORTA sin tocar
-- nada, en vez de instalar una versión a medias.
DO $fix083$
DECLARE
  v_cuantas int;
  v_src     text;
  v_nuevo   text;
BEGIN
  SELECT count(*) INTO v_cuantas
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion';

  IF v_cuantas <> 1 THEN
    RAISE EXCEPTION 'Esperaba una sola registrar_gestion y encontré %. Revisa a mano.', v_cuantas;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion';

  IF strpos(v_src, '''Multa — '' || COALESCE(v_cliente_nombre, ''Cliente''),') = 0 THEN
    RAISE EXCEPTION 'No encontré el concepto de la multa en registrar_gestion. No toco nada.';
  END IF;

  IF strpos(v_src, 'NULL, v_multa_valor, ''Pago de multa por fallas'',') = 0 THEN
    RAISE EXCEPTION 'No encontré la observación de la multa en registrar_gestion. No toco nada.';
  END IF;

  -- El concepto: del nombre del cliente al concepto fijo del catálogo.
  v_nuevo := replace(
    v_src,
    '''Multa — '' || COALESCE(v_cliente_nombre, ''Cliente''),',
    '''Recaudo x Multa Clientes'',');

  -- La observación, que es donde queda el detalle: quién pagó esa multa.
  v_nuevo := replace(
    v_nuevo,
    'NULL, v_multa_valor, ''Pago de multa por fallas'',',
    'NULL, v_multa_valor, ''Multa de '' || COALESCE(v_cliente_nombre, ''Cliente''),');

  EXECUTE v_nuevo;
END
$fix083$;


-- ── PASO 5) Que el cambio quedó (SOLO LECTURA) ────────────────────────────
-- `usa_el_concepto` = true y `queda_algo_viejo` = false.
SELECT strpos(pg_get_functiondef(p.oid), '''Recaudo x Multa Clientes''') > 0 AS usa_el_concepto,
       strpos(pg_get_functiondef(p.oid), '''Multa — ''')                 > 0 AS queda_algo_viejo
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'registrar_gestion';


-- ── PASO 6) Las multas ya cobradas, al concepto nuevo ─────────────────────
-- Son dos, las dos de la ruta 1. Si se quedan con el concepto viejo, la línea
-- del informe arranca de cero y esas dos quedan sueltas para siempre. El nombre
-- del cliente pasa a la observación, igual que hará el sistema de aquí en
-- adelante.
--
-- No es plata que se mueva: el valor, la fecha, la ruta y el tipo quedan como
-- estaban. Solo cambia con qué etiqueta se agrupan.
UPDATE public.gastosregistros
   SET observacion = 'Multa de ' || btrim(replace(concepto, 'Multa —', '')),
       concepto    = 'Recaudo x Multa Clientes'
 WHERE tipo = 'Ingreso'
   AND concepto LIKE 'Multa —%';


-- ── PASO 7) Cómo quedaron (SOLO LECTURA) ──────────────────────────────────
-- Todas bajo un solo concepto y con el cliente en la observación. No debe
-- quedar ninguna fila con el concepto viejo.
SELECT g.id,
       g.ruta,
       (g.fechahorasol AT TIME ZONE 'America/Bogota')::date AS dia,
       g.concepto,
       g.valor,
       g.observacion
  FROM public.gastosregistros g
 WHERE g.tipo = 'Ingreso'
   AND (g.concepto = 'Recaudo x Multa Clientes' OR g.concepto LIKE 'Multa —%')
 ORDER BY g.fechahorasol DESC;


-- ── PASO 8) El catálogo (SOLO LECTURA) ────────────────────────────────────
-- 'Recaudo x Multa Clientes' con `solo_sistema = true`, los otros cuatro en
-- false. La app esconde de los formularios de registro todo lo que esté en
-- true, así que ese concepto no se puede elegir a mano desde ningún lado.
SELECT id, nombre, activo, limite, solo_sistema
  FROM public.ingresos
 ORDER BY solo_sistema DESC, nombre;
