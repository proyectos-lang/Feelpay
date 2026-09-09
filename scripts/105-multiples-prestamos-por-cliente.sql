-- ============================================================================
-- 105 - Una ruta puede permitir varios prestamos al mismo cliente
-- ============================================================================
-- LO QUE SE PIDIO
-- "Un check en la configuracion de la ruta para habilitar que se puedan hacer
--  multiples prestamos a un mismo cliente, y con eso poder registrarle una
--  venta nueva a un cliente que ya tiene una venta activa."
--
-- LO QUE HAY HOY, MEDIDO ANTES DE ESCRIBIR NADA
-- ----------------------------------------------
-- La base NO lo prohibe. `crear_venta_atomica` no valida nada parecido: no
-- hay un RAISE, ni un UNIQUE, ni un CHECK que impida el segundo credito. De
-- hecho ya ha pasado — nancy beatriz llego a tener dos, uno cancelado y uno
-- activo.
--
-- Lo unico que lo impide es un FILTRO DE PANTALLA en el formulario de venta:
--
--   const [soloSinPrestamo, setSoloSinPrestamo] = useState(!preSelectedClientId)
--   if (soloSinPrestamo) query = query.eq("tiene_prestamo_activo", false)
--
-- O sea: la casilla "Solo sin prestamo activo" arranca MARCADA, y con ella el
-- desplegable de clientes esconde a todo el que ya tiene un credito. El
-- vendedor puede desmarcarla y vender igual — el limite es blando y depende
-- de que nadie toque una casilla.
--
-- LA COLUMNA
-- `multiples_prestamos` en `ruta_config_umbrales`, donde ya vive el resto de
-- la configuracion por unidad (geocerca, umbrales, cedula, logo).
--
-- ARRANCA EN false, y esa es la decision importante. Es la misma logica del
-- script 080 al reves: aca la restriccion —un credito por cliente— es la que
-- rige hoy en la practica, asi que la bandera que la LEVANTA arranca apagada.
-- Correr este script no cambia absolutamente nada hasta que alguien encienda
-- el interruptor de una ruta.
--
-- Y en la app pasa lo mismo: ante cualquier falla de lectura (sin fila, error
-- de red, config que no cargo) se asume `false`. Un permiso que se concede
-- solo cuando algo sale mal no es un permiso.
--
-- QUE NO SE TOCA
--   * `clients.tiene_prestamo_activo` sigue existiendo y actualizandose igual:
--     es lo que pinta la insignia y lo que usa el filtro. No se convierte en
--     mentira, solo deja de esconder al cliente cuando la ruta lo permite.
--   * `crear_venta_atomica`: no hacia falta tocarla porque nunca bloqueo esto.
--   * Las renovaciones, que ya podian hacerse sobre un cliente con credito.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- -- PASO 1) La columna ------------------------------------------------------
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS multiples_prestamos boolean NOT NULL DEFAULT false;


-- -- PASO 2) Como queda cada ruta (SOLO LECTURA) ------------------------------
-- Recien corrido, `multiples_prestamos` debe dar false en TODAS las filas: la
-- restriccion sigue como estaba hasta que alguien la levante a mano.
SELECT c.ruta_id,
       r.nombre,
       c.multiples_prestamos
  FROM public.ruta_config_umbrales c
  LEFT JOIN public.rutas r ON r.id = c.ruta_id
 ORDER BY c.multiples_prestamos DESC, c.ruta_id;


-- -- PASO 3) Quien tiene HOY mas de un credito activo (SOLO LECTURA) ---------
-- Para saber de que se parte. Si sale vacio, hoy ningun cliente tiene dos
-- creditos vivos a la vez y la funcion nueva empieza sin herencia.
SELECT l.client_id,
       cl.nombre_completo,
       l.ruta,
       COUNT(*) AS creditos_activos
  FROM public.loans l
  JOIN public.clients cl ON cl.id = l.client_id
 WHERE l.estado = 'activo'
 GROUP BY l.client_id, cl.nombre_completo, l.ruta
HAVING COUNT(*) > 1
 ORDER BY COUNT(*) DESC;
