-- ============================================================================
-- Diagnóstico de auditoría — pagos, no pagos, ventas, resumen y aprobaciones
-- ============================================================================
-- SOLO LECTURA. No borra ni modifica nada.
--
-- CÓMO CORRERLO
-- Cada bloque es UNA sola sentencia, a propósito: el editor de Supabase solo
-- muestra el resultado de la última cuando corres varias juntas. Selecciona
-- un bloque con el mouse, dale Run, y pega el resultado.
-- ============================================================================


-- ── 0) Qué falta en la base ───────────────────────────────────────────────
-- Ya pasó dos veces que un script no se corrió y la función que dependía de
-- él quedó apagada en silencio (la política de multas con el 019, los
-- umbrales por ítem con el 017). Esto lo detecta de una.
WITH esperadas(clase, nombre, script) AS (VALUES
  ('tabla','clients','001'), ('tabla','loans','002'), ('tabla','payment_plan','003'),
  ('tabla','informes','005'), ('tabla','informe_imagenes','005'),
  ('tabla','push_subscriptions','006'),
  ('tabla','admin_informes','008'), ('tabla','admin_informe_imagenes','008'),
  ('tabla','admin_informe_revisiones','009'),
  ('tabla','user_permissions','011'),
  ('tabla','chat_conversations','012'), ('tabla','chat_messages','012'),
  ('tabla','chat_participants','012'), ('tabla','chat_allowed_contacts','012'),
  ('tabla','bi_reportes','015'), ('tabla','bi_reporte_permisos','015'),
  ('tabla','ruta_config_umbrales','016'), ('tabla','solicitudes_revision','016'),
  ('tabla','ruta_item_umbrales','017'),
  ('tabla','multas','019'),
  ('tabla','documentos','020'), ('tabla','documento_carpetas','020'),
  ('tabla','documento_categorias','020'), ('tabla','documento_carpeta_permisos','020'),
  ('tabla','chat_carpetas','021'), ('tabla','chat_conversacion_carpeta','021'),
  ('tabla','operaciones_procesadas','030'),
  -- creadas fuera de scripts/
  ('tabla','usuarios','—'), ('tabla','rutas','—'), ('tabla','usuario_rutas','—'),
  ('tabla','admin','—'), ('tabla','gastos','—'), ('tabla','ingresos','—'),
  ('tabla','retiros','—'), ('tabla','gastosregistros','—'),
  ('tabla','rutas_diarias','—'), ('tabla','cuentas','—'),
  ('tabla','resumen_pagos_diarios','—'), ('tabla','saldo_prestamos_clientes','—'),
  ('tabla','v_loan_mora_status','—'), ('tabla','vista_monitoreo_admin','—'),
  -- funciones que llama la app
  ('funcion','registrar_pago_atomico','010/030/032/033'),
  ('funcion','crear_venta_atomica','031/033'),
  ('funcion','aprobar_solicitud_revision','016'),
  ('funcion','generar_cuota_adicional','028'),
  ('funcion','extender_prestamo_americano','—'),
  ('funcion','registrar_pago_revertir','010'),
  ('funcion','distancia_metros','033')
)
SELECT e.clase, e.nombre, e.script AS script_que_la_crea,
       CASE WHEN e.clase = 'tabla' THEN
              CASE WHEN EXISTS (SELECT 1 FROM pg_class c
                                 WHERE c.relname = e.nombre
                                   AND c.relnamespace = 'public'::regnamespace
                                   AND c.relkind IN ('r','v','m','p'))
                   THEN 'ok' ELSE '*** FALTA ***' END
            ELSE
              CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                                 WHERE p.proname = e.nombre
                                   AND p.pronamespace = 'public'::regnamespace)
                   THEN 'ok' ELSE '*** FALTA ***' END
       END AS estado
  FROM esperadas e
 ORDER BY 4 DESC, 1, 3, 2;


-- ── 1) Multas regeneradas después de pagarlas o cancelarlas ────────────────
-- La generación solo se frenaba si el préstamo ya tenía una multa PENDIENTE.
-- Como las fallas históricas nunca dejaban de contar, apenas se pagaba o se
-- cancelaba una multa se generaba otra igual.
--
-- `regeneradas` = multas creadas DESPUÉS de que otra del mismo préstamo ya
-- se había resuelto. Si es > 0, el problema ocurrió de verdad.
SELECT m.loan_id,
       m.cliente_nombre,
       count(*)                                       AS multas_del_prestamo,
       count(*) FILTER (WHERE m.estado = 'pagada')    AS pagadas,
       count(*) FILTER (WHERE m.estado = 'cancelada') AS canceladas,
       count(*) FILTER (WHERE m.estado = 'pendiente') AS pendientes,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM multas prev
          WHERE prev.loan_id = m.loan_id
            AND COALESCE(prev.pagada_at, prev.cancelada_at) < m.created_at
       ))                                             AS regeneradas,
       sum(m.valor) FILTER (WHERE m.estado = 'pagada') AS cobrado_al_cliente,
       min(m.created_at)                              AS primera,
       max(m.created_at)                              AS ultima
  FROM multas m
 GROUP BY m.loan_id, m.cliente_nombre
HAVING count(*) > 1
 ORDER BY 7 DESC, 3 DESC;


-- ── 2) Gastos posiblemente cobrados dos veces ─────────────────────────────
-- Aprobar un gasto en Movimientos en Revisión registraba el gasto y DESPUÉS
-- marcaba la solicitud, en dos pasos sin transacción ni llave de
-- idempotencia. Si el segundo paso fallaba, o dos personas aprobaban a la
-- vez, el gasto entraba dos veces.
SELECT ruta, tipo, concepto, valor,
       count(*) AS veces,
       valor * (count(*) - 1) AS exceso_en_caja,
       array_agg(id ORDER BY id) AS ids,
       min(fechahorasol) AS primera,
       max(fechahorasol) AS ultima
  FROM gastosregistros
 GROUP BY ruta, tipo, concepto, valor,
          date_trunc('day', fechahorasol AT TIME ZONE 'America/Bogota')
HAVING count(*) > 1
 ORDER BY max(fechahorasol) DESC
 LIMIT 50;


-- ── 2b) Solicitudes de gasto colgadas con el gasto ya registrado ──────────
-- El síntoma exacto del segundo paso fallando: la solicitud sigue pendiente
-- aunque el gasto ya entró. Aprobarla de nuevo lo duplicaría.
SELECT s.id, s.ruta_id, s.monto, s.descripcion, s.estado, s.created_at
  FROM solicitudes_revision s
 WHERE s.tipo = 'gasto'
   AND s.estado = 'pendiente'
   AND EXISTS (SELECT 1 FROM gastosregistros g
                WHERE g.ruta = s.ruta_id AND g.valor = s.monto
                  AND g.fechahorasol >= s.created_at)
 ORDER BY s.created_at DESC;


-- ── 3) Préstamos cancelados con saldo vivo ────────────────────────────────
-- El payload de un abono enviado a revisión no llevaba `generar_cuota_si_debe`,
-- así que al aprobarlo se cancelaba el préstamo sin mirar el saldo.
SELECT l.id AS loan_id, c.nombre_completo, c.apodo, l.ruta,
       l.saldo, v.saldo_pendiente, l.estado, l.updated_at
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN saldo_prestamos_clientes v ON v.loan_id = l.id
 WHERE l.estado = 'cancelado'
   AND (l.saldo > 0 OR COALESCE(v.saldo_pendiente, 0) > 0)
 ORDER BY l.updated_at DESC;


-- ── 4) Rutas mezcladas en la cola de revisión ─────────────────────────────
SELECT s.ruta_id,
       COALESCE(r.nombre, '(ruta sin nombre)') AS ruta,
       s.tipo, s.estado, count(*) AS n, sum(s.monto) AS monto_total
  FROM solicitudes_revision s
  LEFT JOIN rutas r ON r.id = s.ruta_id
 GROUP BY s.ruta_id, r.nombre, s.tipo, s.estado
 ORDER BY s.ruta_id, s.tipo, s.estado;


-- ── 5) Movimientos que se saltaron la aprobación del admin ────────────────
-- Superaron el límite de su ítem y aun así quedaron sin pasar por el admin.
SELECT g.id, g.ruta, g.tipo, g.concepto, g.valor, g.limite,
       g.estadoadmin, g.estadosecre, g.fechahorasol
  FROM gastosregistros g
 WHERE g.limite IS NOT NULL
   AND g.valor > g.limite
   AND g.estadoadmin = 'NA'
 ORDER BY g.fechahorasol DESC
 LIMIT 50;


-- ── 6) Combinaciones de estado en la cadena de aprobación ─────────────────
-- Sirve para ver estados imposibles (p.ej. secretaría aprobó algo que el
-- admin rechazó) y cuánto lleva colgado esperando a alguien.
SELECT estadoadmin, estadosecre, count(*) AS n, sum(valor) AS monto_total,
       min(fechahorasol) AS mas_antiguo,
       count(*) FILTER (WHERE fechahorasol < NOW() - INTERVAL '2 days') AS colgados_mas_de_2_dias
  FROM gastosregistros
 GROUP BY estadoadmin, estadosecre
 ORDER BY n DESC;


-- ── 7) Definición de las vistas que no están en el repo ───────────────────
-- LO MÁS IMPORTANTE QUE FALTA POR REVISAR. El Resumen del Día se arma con
-- `resumen_pagos_diarios`. Hay que ver si sus totales de gastos e ingresos
-- excluyen los que están 'por aprobar' o 'rechazado' — si no los excluyen,
-- el resumen está contando plata que todavía nadie autorizó.
SELECT viewname, definition
  FROM pg_views
 WHERE schemaname = 'public'
   AND viewname IN ('resumen_pagos_diarios', 'saldo_prestamos_clientes',
                    'v_loan_mora_status', 'vista_monitoreo_admin');


-- ── 8) Cuadre del Resumen del Día contra los datos crudos ─────────────────
-- Cambia la fecha en `dia` si quieres revisar otro día.
WITH dia AS (SELECT (NOW() AT TIME ZONE 'America/Bogota')::date AS f)
SELECT r.ruta,
       r.valor_pago AS resumen_pagos,
       (SELECT COALESCE(sum(pp.monto_pagado), 0)
          FROM payment_plan pp, dia
         WHERE pp.ruta = r.ruta AND pp.fecha_pago = dia.f
           AND pp.estado IN ('pagado','parcial','cancelada'))            AS crudo_pagos,
       r.valor_gastos AS resumen_gastos,
       (SELECT COALESCE(sum(g.valor), 0)
          FROM gastosregistros g, dia
         WHERE g.ruta = r.ruta AND g.tipo = 'Gasto'
           AND g.fechahorasol >= (dia.f::text || 'T00:00:00-05:00')::timestamptz
           AND g.fechahorasol <= (dia.f::text || 'T23:59:59-05:00')::timestamptz) AS crudo_gastos_todos,
       (SELECT COALESCE(sum(g.valor), 0)
          FROM gastosregistros g, dia
         WHERE g.ruta = r.ruta AND g.tipo = 'Gasto'
           AND (g.estadoadmin = 'rechazado' OR g.estadosecre = 'rechazado'
                OR g.estadoadmin = 'por aprobar' OR g.estadosecre = 'por aprobar')
           AND g.fechahorasol >= (dia.f::text || 'T00:00:00-05:00')::timestamptz
           AND g.fechahorasol <= (dia.f::text || 'T23:59:59-05:00')::timestamptz) AS gastos_no_autorizados
  FROM resumen_pagos_diarios r, dia
 WHERE r.fecha_pago = dia.f
 ORDER BY r.ruta;


-- ── 9) Gestiones que no quedaron en el día en que se hicieron ─────────────
-- Desde el script 032 un no pago fija `fecha_pago` al día en que se hizo.
-- Lo de antes del 032 puede seguir descuadrado.
SELECT pp.ruta, pp.estado, pp.fecha_pago,
       (pp.fecha_pago_real AT TIME ZONE 'America/Bogota')::date AS dia_real,
       count(*) AS n
  FROM payment_plan pp
 WHERE pp.fecha_pago_real IS NOT NULL
   AND pp.fecha_pago <> (pp.fecha_pago_real AT TIME ZONE 'America/Bogota')::date
 GROUP BY 1, 2, 3, 4
 ORDER BY 5 DESC
 LIMIT 50;


-- ── 9b) Cuotas con `ruta` mala o nula ─────────────────────────────────────
-- Sin RLS, TODA consulta filtra por `.eq('ruta', rutaId)`. Una cuota con
-- ruta NULL es invisible para la app: no aparece en el módulo de pagos, ni
-- en el Resumen del Día, ni en Control de Pagos. Existe pero nadie la ve.
-- Y una ruta que no está en la tabla `rutas` es un dato corrupto.
SELECT pp.ruta,
       CASE WHEN pp.ruta IS NULL THEN '*** NULA — invisible para la app ***'
            WHEN r.id IS NULL   THEN '*** no existe en la tabla rutas ***'
            ELSE r.nombre END AS diagnostico,
       count(*)               AS cuotas,
       count(DISTINCT pp.loan_id) AS prestamos,
       min(pp.fecha_pago)     AS desde,
       max(pp.fecha_pago)     AS hasta,
       COALESCE(sum(pp.monto_pagado), 0) AS recaudado
  FROM payment_plan pp
  LEFT JOIN rutas r ON r.id = pp.ruta
 GROUP BY pp.ruta, r.id, r.nombre
 ORDER BY (pp.ruta IS NULL) DESC, (r.id IS NULL) DESC, 3 DESC;


-- ── 11) Verificación después de correr 033, 034 y 035 ─────────────────────
-- Confirma que cada pieza quedó realmente instalada. Todo debe decir "ok".
SELECT 'geocerca: columnas en clients' AS pieza, '033' AS script,
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='clients'
                     AND column_name IN ('latitud','longitud','ubicacion_capturada_at')) = 3
            THEN 'ok' ELSE '*** FALTA ***' END AS estado
UNION ALL
SELECT 'geocerca: config por ruta', '033',
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='ruta_config_umbrales'
                     AND column_name IN ('geocerca_habilitada','geocerca_radio_metros')) = 2
            THEN 'ok' ELSE '*** FALTA ***' END
UNION ALL
SELECT 'geocerca: resultado en payment_plan', '033',
       CASE WHEN (SELECT count(*) FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='payment_plan'
                     AND column_name IN ('geocerca_estado','geocerca_distancia_m','geocerca_motivo')) = 3
            THEN 'ok' ELSE '*** FALTA ***' END
UNION ALL
SELECT 'ajuste manual: funcion', '034',
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc
                          WHERE proname='ajustar_cuota_control_pagos'
                            AND pronamespace='public'::regnamespace)
            THEN 'ok' ELSE '*** FALTA ***' END
UNION ALL
SELECT 'ajuste manual: bitacora', '034',
       CASE WHEN to_regclass('public.ajustes_manuales_cuota') IS NOT NULL
            THEN 'ok' ELSE '*** FALTA ***' END
UNION ALL
SELECT 'estados: CHECK admin', '035',
       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname='gastosregistros_estadoadmin_check')
            THEN 'ok' ELSE '*** FALTA ***' END
UNION ALL
SELECT 'estados: CHECK secretaria', '035',
       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname='gastosregistros_estadosecre_check')
            THEN 'ok' ELSE '*** FALTA ***' END
UNION ALL
-- Sin REPLICA IDENTITY FULL el evento de realtime llega sin los valores
-- anteriores y el aviso al cobrador nunca se dispara.
SELECT 'aviso al cobrador: replica identity', '035',
       CASE WHEN (SELECT relreplident FROM pg_class
                   WHERE oid='public.gastosregistros'::regclass) = 'f'
            THEN 'ok' ELSE '*** FALTA (no es FULL) ***' END
UNION ALL
SELECT 'aviso al cobrador: en la publicacion', '035',
       CASE WHEN EXISTS (SELECT 1 FROM pg_publication_tables
                          WHERE pubname='supabase_realtime'
                            AND schemaname='public' AND tablename='gastosregistros')
            THEN 'ok' ELSE '*** FALTA ***' END
UNION ALL
-- Estado de los datos: sirve para saber si el reset de pruebas ya corrio.
SELECT 'datos: cuotas antes del 10-ago', '—',
       (SELECT count(*)::text FROM payment_plan WHERE fecha_pago < DATE '2026-08-10')
UNION ALL
SELECT 'datos: movimientos de caja', '—', (SELECT count(*)::text FROM gastosregistros)
UNION ALL
SELECT 'datos: prestamos activos', '—', (SELECT count(*)::text FROM loans WHERE estado='activo')
 ORDER BY 2, 1;


-- ── 10) Ventas duplicadas por la regresión del 7 de agosto ────────────────
-- Para limpiarlas usa scripts/limpiar-venta-duplicada.sql, que muestra cuál
-- de las dos conservar antes de borrar nada.
SELECT c.documento, c.nombre_completo, l.valor, count(*) AS prestamos,
       array_agg(l.id ORDER BY l.created_at) AS loan_ids,
       array_agg(l.created_at ORDER BY l.created_at) AS creados
  FROM loans l
  JOIN clients c ON c.id = l.client_id
 WHERE l.created_at >= '2026-08-01'
 GROUP BY c.documento, c.nombre_completo, l.valor,
          date_trunc('minute', l.created_at)
HAVING count(*) > 1
 ORDER BY max(l.created_at) DESC;
