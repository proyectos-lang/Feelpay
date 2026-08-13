-- ============================================================================
-- Diagnóstico — el apodo metido dentro del nombre completo
-- ============================================================================
-- SOLO LECTURA. No modifica nada.
--
-- SÍNTOMA
-- En el recibo de pago sale el nombre con el oficio o el negocio en la mitad
-- ("EDUARDO MECÁNICO RODRÍGUEZ") en vez del nombre a secas.
--
-- CAUSA
-- El recibo imprime `clients.nombre_completo` tal cual, una sola vez. No
-- concatena el apodo por ningún lado. Lo que pasa es que el apodo quedó
-- guardado DENTRO de ese campo al registrar al cliente.
--
-- Cada bloque es una sola sentencia: selecciónalo y dale Run.
-- ============================================================================


-- ── 1) Qué tan extendido está ─────────────────────────────────────────────
-- Reparte todos los clientes en tres grupos para dimensionar el problema.
SELECT CASE
         WHEN apodo IS NULL OR btrim(apodo) = ''         THEN 'sin apodo'
         WHEN lower(btrim(apodo)) = lower(btrim(nombre_completo))
                                                          THEN 'apodo IGUAL al nombre completo'
         WHEN lower(nombre_completo) LIKE '%' || lower(btrim(apodo)) || '%'
                                                          THEN 'apodo CONTENIDO en el nombre'
         ELSE 'separados correctamente'
       END AS situacion,
       count(*) AS clientes
  FROM clients
 GROUP BY 1
 ORDER BY 2 DESC;


-- ── 2) Los casos concretos ────────────────────────────────────────────────
-- `nombre_sugerido` es cómo quedaría el nombre al quitarle el apodo. Revísalo
-- antes de corregir nada: donde el apodo es idéntico al nombre completo no
-- hay nada que quitar y la sugerencia sale vacía — esos hay que escribirlos
-- a mano.
SELECT documento,
       nombre_completo,
       apodo,
       btrim(regexp_replace(
         regexp_replace(nombre_completo, '(?i)' || regexp_replace(btrim(apodo), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), '', 'g'),
         '\s+', ' ', 'g'
       )) AS nombre_sugerido
  FROM clients
 WHERE apodo IS NOT NULL
   AND btrim(apodo) <> ''
   AND lower(nombre_completo) LIKE '%' || lower(btrim(apodo)) || '%'
 ORDER BY nombre_completo;


-- ── 3) Nombres con doble espacio ──────────────────────────────────────────
-- El doble espacio delata que el texto se armó pegando pedazos. Sirve para
-- encontrar los que se escribieron mal aunque el apodo no calce exacto.
SELECT documento, nombre_completo, apodo
  FROM clients
 WHERE nombre_completo LIKE '%  %'
 ORDER BY nombre_completo;


-- ============================================================================
-- PARA CORREGIR (revisar primero los bloques de arriba)
-- ============================================================================
-- Está comentado a propósito. Solo toca los casos donde el apodo aparece
-- dentro del nombre PERO no es el nombre entero, y donde lo que queda tiene
-- al menos dos palabras — así no deja a nadie con el nombre en blanco ni con
-- una sola palabra suelta.
--
-- Los que quedan por fuera (apodo idéntico al nombre completo) hay que
-- arreglarlos a mano: no hay forma de saber qué parte sobra.
--
-- UPDATE clients
--    SET nombre_completo = btrim(regexp_replace(
--          regexp_replace(nombre_completo, '(?i)' || regexp_replace(btrim(apodo), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), '', 'g'),
--          '\s+', ' ', 'g'
--        )),
--        updated_at = NOW()
--  WHERE apodo IS NOT NULL
--    AND btrim(apodo) <> ''
--    AND lower(nombre_completo) LIKE '%' || lower(btrim(apodo)) || '%'
--    AND lower(btrim(apodo)) <> lower(btrim(nombre_completo))
--    AND array_length(string_to_array(btrim(regexp_replace(
--          regexp_replace(nombre_completo, '(?i)' || regexp_replace(btrim(apodo), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), '', 'g'),
--          '\s+', ' ', 'g')), ' '), 1) >= 2;
--
-- Después vuelve a correr el bloque 1: los grupos "apodo IGUAL" y "apodo
-- CONTENIDO" deberían bajar.
