-- ============================================================================
-- 053 - La ruta "UNID 196" quedó con id 3, y el contador de ids está atrasado
-- ============================================================================
-- EL SÍNTOMA
-- Se creó la ruta de la unidad 196 desde el módulo de Rutas y aparece como
-- «UNID 196 · Ruta #3».
--
-- LA CAUSA
-- En esta base el ID DE LA RUTA *ES* EL NÚMERO DE UNIDAD. Se ve en las que
-- ya existían, todas cargadas a mano con su id explícito:
--
--     id 112 → '112 JP'      id 154 → '154'      id 168 → 'Unid 168'
--     id 190 → '190'         id 933 → '933'
--
-- Pero `rutas.id` es un BIGSERIAL. Cuando una fila se inserta con el id
-- puesto a mano, la secuencia NO avanza: sigue donde estaba. Como las rutas
-- reales se cargaron así, la secuencia nunca pasó de 2.
--
-- El formulario de "Nueva ruta" inserta sin id — no tiene dónde escribirlo —
-- así que la base repartió el siguiente valor de la secuencia: 3.
--
-- Esto se va a repetir en CADA ruta que se cree desde la app: la siguiente
-- saldría con id 4, y así. Peor: cuando la secuencia llegue a 112 el INSERT
-- fallará por llave duplicada contra una unidad que ya existe.
--
-- SE PUEDE ARREGLAR SIN RIESGO
-- Verificado antes de escribir este script: la ruta 3 no tiene NADA colgando
-- — 0 clientes, 0 préstamos, 0 gestiones, 0 movimientos de caja, 0 jornadas,
-- 0 configuración y 0 usuarios asignados. Y el id 196 está libre. Por eso
-- basta con renumerarla; no hay integridad referencial que reconstruir.
--
-- Correr los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Confirmar que sigue sin datos (SOLO LECTURA) ──────────────────
-- Si alguna columna sale distinta de 0, DETENTE: entre la auditoría y este
-- script alguien ya empezó a trabajar sobre la ruta 3, y renumerarla dejaría
-- esos registros apuntando a una ruta que ya no existe.
SELECT (SELECT count(*) FROM public.clients              WHERE ruta    = 3) AS clientes,
       (SELECT count(*) FROM public.loans                WHERE ruta    = 3) AS prestamos,
       (SELECT count(*) FROM public.gestiones            WHERE ruta    = 3) AS gestiones,
       (SELECT count(*) FROM public.gastosregistros      WHERE ruta    = 3) AS movimientos,
       (SELECT count(*) FROM public.rutas_diarias        WHERE ruta_id = 3) AS jornadas,
       (SELECT count(*) FROM public.ruta_config_umbrales WHERE ruta_id = 3) AS config,
       (SELECT count(*) FROM public.usuario_rutas        WHERE ruta_id = 3) AS asignaciones,
       (SELECT count(*) FROM public.rutas                WHERE id      = 196) AS id_196_ocupado;


-- ── PASO 2) Renumerar la ruta ─────────────────────────────────────────────
-- El WHERE lleva las dos condiciones a propósito: si la fila ya se corrigió
-- (o el id 196 se ocupó por otro lado), esta sentencia no hace nada en vez de
-- pisar algo que no debe.
UPDATE public.rutas
   SET id = 196
 WHERE id = 3
   AND nombre = 'UNID 196'
   AND NOT EXISTS (SELECT 1 FROM public.rutas WHERE id = 196);


-- ── PASO 3) Poner la secuencia por encima de todas las unidades ───────────
-- ESTE ES EL PASO QUE EVITA QUE VUELVA A PASAR EN LAS RUTAS VIEJAS.
-- Sin esto la secuencia seguiría en 3 y las próximas altas automáticas
-- irían 4, 5, 6... hasta chocar con la unidad 112 y fallar por llave
-- duplicada.
--
-- El nombre de la secuencia se resuelve con pg_get_serial_sequence en vez de
-- escribirlo a mano, para que funcione aunque no se llame 'rutas_id_seq'.
SELECT setval(pg_get_serial_sequence('public.rutas', 'id'),
              (SELECT COALESCE(MAX(id), 1) FROM public.rutas));


-- ── PASO 4) Verificar ─────────────────────────────────────────────────────
-- Debe aparecer 196 → 'UNID 196', ya sin la fila id 3, y el proximo_id por
-- encima del mayor. Ojo: `proximo_id` consume un valor de la secuencia al
-- consultarlo; es normal y no rompe nada.
SELECT id, nombre, ciudad, pais FROM public.rutas ORDER BY id;

SELECT (SELECT MAX(id) FROM public.rutas)                        AS mayor_id_actual,
       nextval(pg_get_serial_sequence('public.rutas', 'id'))     AS proximo_id;


-- ── PASO 5) Asignar el usuario a su ruta ──────────────────────────────────
-- HALLAZGO APARTE DE LA AUDITORÍA: el usuario 196-OPAD@GMAIL.COM (id 27,
-- rol vendedor) NO tiene ninguna ruta asignada. Sin fila en `usuario_rutas`
-- no puede seleccionar la unidad al entrar, así que no podría trabajar
-- aunque la ruta quede bien numerada.
--
-- Se deja como paso aparte por si prefieres hacerlo desde la pestaña
-- Asignaciones de la app, que es su lugar natural. Si lo corres acá, es
-- idempotente.
INSERT INTO public.usuario_rutas (usuario_id, ruta_id)
SELECT 27, 196
 WHERE EXISTS (SELECT 1 FROM public.rutas WHERE id = 196)
   AND NOT EXISTS (
     SELECT 1 FROM public.usuario_rutas WHERE usuario_id = 27 AND ruta_id = 196
   );
