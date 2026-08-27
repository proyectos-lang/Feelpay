-- ============================================================================
-- 080 - La lectura de cédula deja de ser obligatoria en toda ruta
-- ============================================================================
-- QUÉ PIDIÓ EL DUEÑO
-- «Que desde la configuración de rutas se pueda marcar o no la opción para
--  registrar ventas o clientes sin lectura de cédula.»
--
-- CÓMO ESTÁ HOY
-- En el formulario de venta, un cliente NUEVO solo se puede registrar
-- fotografiando la cédula. No es una validación: los campos `Documento` y
-- `Nombre completo` son `readOnly` y los llena EXCLUSIVAMENTE el escaneo con
-- GPT-4o. Sin foto quedan vacíos, y el submit rebota porque `documento` es
-- NOT NULL UNIQUE en `clients`.
--
-- Eso está bien donde hay cédula que fotografiar y señal para subirla. Donde
-- no —una ruta en la que el cliente no la carga, o donde la red no da— la
-- venta no se puede hacer, y punto.
--
-- Hay además una promesa rota: cuando el escaneo lee mal, la app dice «o
-- escribe los datos a mano» y «Complétalo a mano». Los campos están en
-- readOnly, así que a mano no se puede escribir nada. El único camino era
-- repetir la foto hasta que saliera.
--
-- LA COLUMNA
-- `cedula_obligatoria` en `ruta_config_umbrales`, donde ya vive el resto de la
-- configuración por unidad (geocerca, umbrales, métodos de interés).
--
-- ARRANCA EN true, y esa es la decisión importante. Todas las demás banderas
-- de esta tabla arrancan en false porque son restricciones que se ENCIENDEN.
-- Esta es una restricción que YA está encendida en el código de hoy: ponerla
-- en false al crear la columna cambiaría el comportamiento de las diez rutas
-- de golpe, sin que nadie lo pidiera. Con NOT NULL DEFAULT true, correr este
-- script no cambia absolutamente nada hasta que alguien apague el interruptor
-- de una ruta.
--
-- Por lo mismo, en la app el valor por defecto también es `true` en los tres
-- caminos en que la lectura puede fallar (sin fila, error de red, cache
-- viejo). Una restricción que se afloja sola cuando algo sale mal no es una
-- restricción.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) La columna ────────────────────────────────────────────────────
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS cedula_obligatoria boolean NOT NULL DEFAULT true;


-- ── PASO 2) Cómo queda cada ruta (SOLO LECTURA) ───────────────────────────
-- Recién corrido, `cedula_obligatoria` debe dar true en TODAS las filas: el
-- script no afloja nada por su cuenta. Después de apagar el interruptor de una
-- unidad, esa —y solo esa— dirá false.
--
-- Las rutas que no aparecen acá no tienen fila de configuración. Esas también
-- siguen exigiendo la cédula: la app usa `true` como valor por defecto cuando
-- no hay nada que leer.
SELECT c.ruta_id,
       r.nombre,
       r.ciudad,
       r.pais,
       c.cedula_obligatoria
  FROM public.ruta_config_umbrales c
  LEFT JOIN public.rutas r ON r.id = c.ruta_id
 ORDER BY c.cedula_obligatoria, c.ruta_id;


-- ── PASO 3) Las rutas sin configurar (SOLO LECTURA) ───────────────────────
-- Solo para saber cuáles son. No hay que hacerles nada: la fila se crea sola
-- la primera vez que se guarde la configuración de esa unidad.
SELECT r.id, r.nombre, r.ciudad, r.pais
  FROM public.rutas r
  LEFT JOIN public.ruta_config_umbrales c ON c.ruta_id = r.id
 WHERE c.ruta_id IS NULL
 ORDER BY r.id;
