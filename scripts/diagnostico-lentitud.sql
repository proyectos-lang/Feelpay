-- ============================================================================
-- DIAGNÓSTICO — cuando la app se pone lenta
-- ============================================================================
-- CUÁNDO CORRERLO
-- MIENTRAS está pasando. Casi todo lo que mide es el estado de AHORA
-- (conexiones abiertas, consultas corriendo, bloqueos): media hora después ya
-- no queda rastro. Los pasos 5 en adelante sí son acumulados y sirven en
-- cualquier momento.
--
-- QUÉ SÍNTOMA EXPLICA
-- El 27/08/2026 el módulo de pagos se quedaba en "Verificando estado de la
-- ruta...". Midiendo desde afuera: la latencia normal era de 150-200 ms, pero
-- una de cada diez peticiones se quedaba esperando el primer byte entre 8 y 90
-- segundos, y le tocaba a una consulta DISTINTA cada vez — hasta a un
-- `SELECT id FROM rutas LIMIT 1` sobre una tabla de diez filas, que tardó 91 s.
-- El DNS, el TCP y el TLS iban en 40-70 ms: el minuto se iba entero esperando
-- al servidor.
--
-- Eso descarta el código de la app y apunta a la base o a lo que hay delante
-- de ella. Estos pasos dicen a cuál de las dos.
--
-- NO ESCRIBE NADA. Todos los pasos son SELECT.
-- ============================================================================


-- ── PASO 1) ¿Se acabaron las conexiones? ──────────────────────────────────
-- La causa número uno de "una petición al azar se cuelga un minuto": no hay
-- conexión libre y la petición hace fila. Si `conexiones` está pegado a
-- `max_conexiones`, es esto.
--
-- `idle_en_transaccion` es el veneno silencioso: una transacción abierta y
-- olvidada —una pestaña del editor SQL, un script a medias— retiene su
-- conexión y además bloquea el vacuum. Si ese número no es 0, revisa el PASO 3.
SELECT (SELECT count(*) FROM pg_stat_activity)                                  AS conexiones,
       (SELECT setting::int FROM pg_settings WHERE name = 'max_connections')    AS max_conexiones,
       (SELECT count(*) FROM pg_stat_activity WHERE state = 'active')           AS activas,
       (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle')             AS ociosas,
       (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction')
                                                                                AS idle_en_transaccion,
       (SELECT setting FROM pg_settings WHERE name = 'shared_buffers')          AS shared_buffers,
       pg_size_pretty(pg_database_size(current_database()))                     AS tamano_base;


-- ── PASO 2) Quién está conectado y desde dónde ────────────────────────────
-- `app` distingue al PostgREST de la app, del editor SQL, del realtime. Si una
-- sola fila se lleva casi todas las conexiones, ahí está el que las agota.
SELECT COALESCE(NULLIF(application_name, ''), '(sin nombre)') AS app,
       usename,
       state,
       count(*)                                                   AS n,
       max(extract(epoch FROM (now() - state_change)))::int       AS seg_en_ese_estado
  FROM pg_stat_activity
 GROUP BY 1, 2, 3
 ORDER BY n DESC;


-- ── PASO 3) Consultas que llevan más de 5 segundos ────────────────────────
-- Lo que hay que mirar es `wait_event`:
--   · Lock          → está esperando a otra transacción (mira el PASO 4)
--   · IO / DataFileRead → el disco no da abasto
--   · vacío / CPU   → está calculando de verdad
-- Vacío también es un resultado: significa que nadie está trabado y que la
-- espera está DELANTE de la base (el pooler, el proxy, la instancia
-- throttleada), no dentro.
SELECT pid,
       usename,
       state,
       extract(epoch FROM (now() - query_start))::int  AS seg_corriendo,
       wait_event_type,
       wait_event,
       left(regexp_replace(query, '\s+', ' ', 'g'), 140) AS consulta
  FROM pg_stat_activity
 WHERE state <> 'idle'
   AND query_start < now() - interval '5 seconds'
 ORDER BY query_start;


-- ── PASO 4) Quién está bloqueando a quién ─────────────────────────────────
-- Vacío es lo normal y lo bueno. Si sale algo, la columna `bloqueante_query`
-- es la que hay que matar: `SELECT pg_terminate_backend(<bloqueante_pid>)`.
SELECT esperando.pid                                                    AS bloqueado_pid,
       left(regexp_replace(esperando.query, '\s+', ' ', 'g'), 90)       AS bloqueado_query,
       culpable.pid                                                     AS bloqueante_pid,
       culpable.state                                                   AS bloqueante_estado,
       extract(epoch FROM (now() - culpable.state_change))::int         AS bloqueante_seg,
       left(regexp_replace(culpable.query, '\s+', ' ', 'g'), 90)        AS bloqueante_query
  FROM pg_stat_activity esperando
  JOIN LATERAL unnest(pg_blocking_pids(esperando.pid)) AS b(pid) ON true
  JOIN pg_stat_activity culpable ON culpable.pid = b.pid;


-- ── PASO 5) Salud acumulada de la base (SIRVE EN CUALQUIER MOMENTO) ───────
-- `pct_cache` por debajo de 99 en una base de este tamaño significa que se
-- está yendo a disco por datos que deberían estar en memoria: instancia corta
-- de RAM. `temp_files` creciendo = consultas que no caben en `work_mem` y se
-- escriben en disco. `deadlocks` debería ser 0.
SELECT numbackends                                                        AS conexiones,
       xact_commit, xact_rollback,
       blks_read, blks_hit,
       round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2)       AS pct_cache,
       deadlocks,
       temp_files,
       pg_size_pretty(temp_bytes)                                         AS temp_escrito,
       stats_reset
  FROM pg_stat_database
 WHERE datname = current_database();


-- ── PASO 6) Las consultas más caras del histórico ─────────────────────────
-- Requiere `pg_stat_statements`, que Supabase trae encendido. Si da error de
-- relación inexistente, sáltalo.
--
-- Ordenado por TIEMPO TOTAL: lo que más pesa no siempre es lo más lento, a
-- veces es lo mediano repetido diez mil veces. `media_ms` al lado dice cuál de
-- las dos cosas es.
SELECT calls                                              AS veces,
       round(total_exec_time)                             AS total_ms,
       round(mean_exec_time, 1)                           AS media_ms,
       round(max_exec_time)                               AS peor_ms,
       rows,
       left(regexp_replace(query, '\s+', ' ', 'g'), 140)  AS consulta
  FROM pg_stat_statements
 ORDER BY total_exec_time DESC
 LIMIT 25;


-- ── PASO 7) Y las de peor tiempo MEDIO ────────────────────────────────────
-- Con al menos 20 ejecuciones, para no llenarse de rarezas de una sola vez.
-- Acá es donde aparecería una consulta nuestra mal indexada, si la hubiera.
SELECT calls                                              AS veces,
       round(mean_exec_time, 1)                           AS media_ms,
       round(max_exec_time)                               AS peor_ms,
       left(regexp_replace(query, '\s+', ' ', 'g'), 140)  AS consulta
  FROM pg_stat_statements
 WHERE calls >= 20
 ORDER BY mean_exec_time DESC
 LIMIT 25;


-- ── PASO 8) Tablas: tamaño, basura acumulada y vacuum ─────────────────────
-- `muertas` muy por encima de `vivas` = la tabla está hinchada y cada lectura
-- pasea por basura. Si `ultimo_autovacuum` está en blanco o es muy viejo en
-- una tabla con muchas muertas, el autovacuum no está alcanzando.
SELECT relname                                              AS tabla,
       n_live_tup                                           AS vivas,
       n_dead_tup                                           AS muertas,
       CASE WHEN n_live_tup > 0
            THEN round(100.0 * n_dead_tup / n_live_tup, 1) END AS pct_muertas,
       seq_scan                                             AS lecturas_secuenciales,
       idx_scan                                             AS lecturas_por_indice,
       last_autovacuum                                      AS ultimo_autovacuum,
       last_autoanalyze                                     AS ultimo_autoanalyze,
       pg_size_pretty(pg_total_relation_size(relid))        AS tamano
  FROM pg_stat_user_tables
 ORDER BY pg_total_relation_size(relid) DESC
 LIMIT 25;


-- ── PASO 9) Índices que nadie usa ─────────────────────────────────────────
-- Un índice sin usar no hace daño al leer, pero se paga en CADA escritura.
-- Informativo: no borres nada sin mirar si es de una función que corre poco.
SELECT relname            AS tabla,
       indexrelname       AS indice,
       idx_scan           AS veces_usado,
       pg_size_pretty(pg_relation_size(indexrelid)) AS tamano
  FROM pg_stat_user_indexes
 WHERE idx_scan < 50
 ORDER BY pg_relation_size(indexrelid) DESC
 LIMIT 20;


-- ── PASO 10) Si TODO lo anterior sale limpio ──────────────────────────────
-- Conexiones sobradas, nada bloqueado, nada corriendo hace rato, cache alto y
-- ninguna consulta lenta en el histórico: entonces la base está bien y la
-- espera está DELANTE de ella. Eso ya no se ve desde SQL. Toca el panel:
--
--   · Reports → Database   : CPU, memoria y I/O de las últimas horas. Un
--                            instancia sin margen de cómputo hace exactamente
--                            esto — casi todo rápido, con parones de un minuto.
--   · Logs → Postgres / API: buscar los minutos del parón.
--   · status.supabase.com  : por si fue un incidente de la región.
--
-- Y si el patrón se repite, con estos números y los tiempos medidos desde
-- afuera ya hay con qué abrir un ticket que no se conteste con "reinicia".
