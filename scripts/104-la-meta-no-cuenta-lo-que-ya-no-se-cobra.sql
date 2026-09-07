-- ============================================================================
-- 104 - La meta del dia no cuenta lo que ya no se puede cobrar
-- ============================================================================
-- LO QUE SE PIDIO
-- "Revisar el calculo del debido cobrar o meta de cada dia: debe ser la
--  sumatoria de todas las cuotas que se tengan que pagar en el dia, ignorando
--  por ejemplo las que son de dias de la semana diferente."
--
-- LO PRIMERO, PORQUE CAMBIA LA RESPUESTA: ESA PARTE YA ESTABA BIEN
-- -----------------------------------------------------------------
-- La meta ya agrupa por `fecha_pago`, asi que un semanal de martes NO suma el
-- sabado. Comprobado contra la base, ruta por ruta y dia por dia:
--
--   ruta 190  04/09  meta 1.805.500  =  la suma de sus 71 cuotas de ese dia
--   ruta 151  05/09  meta   826.000  =  la suma de sus 22 cuotas
--   ruta 196  05/09  meta   433.334  =  su UNICA cuota de ese sabado
--
-- La 196 es justo el caso reportado: sus semanales de martes no aparecen el
-- sabado. Eso ya funcionaba y no se toca.
--
-- LO QUE SI ESTABA MAL: SUMA CREDITOS QUE YA NO SE COBRAN
-- --------------------------------------------------------
-- Quien termina de pagar antes de tiempo deja en su cronograma las cuotas que
-- ya no va a pagar. El plan no se recorta —y esta bien que no se recorte, es
-- el pacto original— pero la meta las seguia sumando todos los dias.
--
-- Medido el 07/09:
--
--   ruta 190   meta 1.676.000   de cancelados 440.600   26%  (22 de 73 cuotas)
--   ruta 197   meta   139.550   de cancelados  29.900   21%
--   ruta 1     meta       446   de cancelados      66   15%
--
-- En la 190, uno de cada cuatro pesos de la meta era de gente que ya no debe
-- nada: el cobrador no podia llegar al 100% ni cobrando todo lo cobrable.
--
-- POR QUE NO ALCANZA CON "EXCLUIR LOS CANCELADOS"
-- ------------------------------------------------
-- Porque reescribiria la historia. Un credito cancelado el 3 de septiembre SI
-- era cobrable el 1. Medido en la 190:
--
--   dia     antes        excluir a secas   contar hasta su cierre
--   01/09   1.320.500       847.400           1.065.700   <- la correcta
--   03/09   1.492.500     1.019.400           1.135.100
--   07/09   1.676.000     1.235.400           1.235.400   (hoy coinciden)
--
-- LA REGLA: un credito suma HASTA EL DIA EN QUE SE CANCELO, y no despues. El
-- dia del cierre sale del libro —el ultimo evento aplicado— que es donde
-- quedo escrito cuando se acabo de pagar. No hace falta ninguna columna nueva.
--
-- POR QUE SE REESCRIBE LA VISTA ENTERA Y NO SE PARCHEA
-- -----------------------------------------------------
-- Se intento parchear la definicion viva con regex, como en los scripts 101 y
-- 102. Acá NO se puede comprobar el ancla antes de correrlo: `pg_get_viewdef`
-- no se puede leer por la API, asi que el regex iria a ciegas — que es
-- exactamente como se rompio el script 090.
--
-- En cambio SI se pudo comprobar que el 070 es la definicion vigente: las 32
-- columnas que la vista devuelve hoy estan las 32 en el 070, ninguna la
-- agrego un script posterior. Asi que se reescribe desde ahi, con el bloque
-- `meta` cambiado y TODO lo demas letra por letra.
--
-- QUE NO SE TOCA
--   * `valor_pago` y los conteos: la plata cobrada no cambia.
--   * el cronograma: no se borra ni se recorta ninguna cuota.
--   * los creditos activos: suman igual que siempre.
--   * `caja_anterior` y el arrastre de la caja.
--
-- COMO CORRERLO: un paso a la vez, en orden. El PASO 1 no escribe nada.
-- ============================================================================


-- -- PASO 1) Lo que hay hoy (SOLO LECTURA, no cambia nada) -------------------
-- Guarde este resultado: es contra el que se compara al final.
SELECT l.ruta,
       SUM(pp.valor_cuota)                                        AS meta_hoy,
       COALESCE(SUM(pp.valor_cuota)
                FILTER (WHERE l.estado = 'cancelado'), 0)         AS de_cancelados,
       COUNT(*) FILTER (WHERE l.estado = 'cancelado')             AS cuotas_de_cancelados
  FROM public.payment_plan pp
  JOIN public.loans l ON l.id = pp.loan_id
 WHERE pp.fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date
 GROUP BY l.ruta
 ORDER BY l.ruta;


-- -- PASO 2) La vista, con la meta corregida ---------------------------------
-- Es la definicion del 070 con el bloque `meta` cambiado. El resto va letra
-- por letra. `CREATE OR REPLACE` conserva los permisos ya dados.
CREATE OR REPLACE VIEW public.resumen_diario_v2 AS
WITH cierres AS (
  -- El último día con movimiento de plata de cada préstamo: el que lo dejó
  -- en cero, si es que llegó a cero (ver script 054).
  SELECT g.loan_id,
         MAX(g.fecha_gestion) AS fecha_cierre
    FROM public.gestiones g
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','cancelacion','abono_venta','reversa')
   GROUP BY g.loan_id
),
saldados AS (
  SELECT c.loan_id, c.fecha_cierre
    FROM cierres c
    JOIN public.v_loan_financiero f ON f.loan_id = c.loan_id
   WHERE COALESCE(f.saldo, 0) <= 0
),
canceladas AS (
  SELECT g.fecha_gestion AS fecha, g.ruta,
         COUNT(DISTINCT g.loan_id) AS cantidad_canceladas,
         COALESCE(SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                           WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END), 0) AS valor_canceladas
    FROM public.gestiones g
    JOIN saldados s ON s.loan_id = g.loan_id
                   AND s.fecha_cierre = g.fecha_gestion
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','cancelacion','abono_venta','reversa')
   GROUP BY g.fecha_gestion, g.ruta
),
por_cliente AS (
  -- UN CLIENTE, UN DÍA, UN RESULTADO.
  --
  -- Secretaría puede tocar la misma cuota cinco veces en una tarde: marcar el
  -- pago, quitarlo, poner no pago, anular eso y volver a marcar el pago. En el
  -- libro quedan los cinco eventos, y así tiene que ser: el libro no olvida y
  -- cada corrección lleva su firma. Pero el resumen del día NO es el libro. Es
  -- qué pasó con cada cliente, y con un cliente pasó UNA cosa.
  --
  -- Antes se contaba evento por evento, y un pago solo se descartaba si había
  -- una reversa que lo señalara POR ID. Las reversas de Control de Pagos no
  -- traen ese id —apuntan a la cuota, no al evento—, así que no descontaban
  -- nada: una cuota corregida tres veces contaba tres pagos. Por eso la ruta
  -- 151 mostraba 42 pagos el 24/08 teniendo 13 clientes.
  --
  -- El neto de plata ya venía bien (sumar pagos y restar reversas da lo mismo
  -- agrupado que suelto). Lo que cambia es QUIÉN se cuenta: clientes, no
  -- papeles.
  SELECT g.fecha_gestion AS fecha, g.ruta, g.loan_id,
         SUM(CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                  WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END)        AS neto,
         bool_or(g.tipo = 'no_pago')                                       AS hubo_no_pago,
         SUM(CASE WHEN l.tipo_amortizacion = 'aleman' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS capital,
         SUM(CASE WHEN l.tipo_amortizacion = 'americano' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS intereses,
         -- Igual que antes: `metodo_pago` en NULL cuenta como efectivo, y una
         -- reversa hereda el método del evento que revierte (`ref`).
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) = 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS efectivo,
         SUM(CASE
               WHEN lower(COALESCE(NULLIF(g.metodo_pago,''), ref.metodo_pago, 'efectivo')) <> 'transferencia' THEN 0
               WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
               WHEN g.tipo = 'reversa' THEN -g.monto
               ELSE 0 END)                                                 AS transferencia,
         -- DE DÓNDE VINO LA PLATA: la calle o el escritorio.
         -- Es lo único que explica por qué el cobrador de la 151 dice 341.500
         -- y la pantalla decía 1.103.500. La diferencia no son pagos dobles:
         -- son correcciones de secretaría sobre cuotas de OTROS días, que caen
         -- en el día en que se escribieron. El script 066 ya manda las nuevas
         -- al día de su cuota; esto deja ver las que ya están.
         SUM(CASE WHEN g.origen = 'campo' THEN
               CASE WHEN g.tipo IN ('pago','cancelacion','abono_venta') THEN g.monto
                    WHEN g.tipo = 'reversa' THEN -g.monto ELSE 0 END
             ELSE 0 END)                                                   AS neto_campo,
         MAX(g.fecha_hora)                                                 AS ultimo_movimiento
    FROM public.gestiones g
    LEFT JOIN public.loans l       ON l.id   = g.loan_id
    LEFT JOIN public.gestiones ref ON ref.id = g.referencia_gestion_id
   WHERE g.estado = 'aplicada'
     AND g.origen <> 'homologacion'
     AND g.tipo IN ('pago','no_pago','cancelacion','abono_venta','reversa')
   GROUP BY g.fecha_gestion, g.ruta, g.loan_id
),
pagos AS (
  SELECT fecha, ruta,
         SUM(neto)                                                    AS valor_pago,
         -- Clientes que terminaron el día con plata puesta. No eventos.
         COUNT(*) FILTER (WHERE neto > 0)                             AS cantidad_pagos,
         -- Quedó sin plata Y se registró una visita sin pago. Un cliente cuyo
         -- pago se anuló y no tiene `no_pago` no entra en ninguna de las dos:
         -- no pagó, pero tampoco hubo una visita fallida que contar.
         COUNT(*) FILTER (WHERE neto <= 0 AND hubo_no_pago)           AS cantidad_no_pagos,
         SUM(capital)                                                 AS pago_capital,
         SUM(intereses)                                               AS pago_intereses,
         SUM(efectivo)                                                AS pago_efectivo,
         SUM(transferencia)                                           AS pago_transferencia,
         SUM(neto_campo)                                              AS valor_pago_campo,
         SUM(neto) - SUM(neto_campo)                                  AS valor_pago_ajuste,
         COUNT(*) FILTER (WHERE neto_campo > 0)                       AS cantidad_pagos_campo,
         (MAX(ultimo_movimiento) AT TIME ZONE 'America/Bogota')::time AS hora_ultimo_movimiento
    FROM por_cliente
   GROUP BY fecha, ruta
),
meta AS (
  -- EL DEBIDO COBRAR DEL DIA: la suma de las cuotas que vencen ESE dia.
  --
  -- Agrupar por `fecha_pago` ya dejaba fuera al semanal de martes cuando el
  -- dia es sabado; eso no cambia. Lo que se agrega es la condicion de abajo.
  --
  -- UN CREDITO CANCELADO DEJA DE SUMAR EL DIA DESPUES DE CANCELARSE.
  -- El que termina de pagar antes de tiempo deja en su cronograma las cuotas
  -- que ya no va a pagar. El plan NO se recorta —es el pacto original y ahi
  -- se queda— pero pedirle al cobrador que recaude una cuota de alguien que
  -- ya no debe nada es una meta imposible: en la ruta 190 eso era el 26% de
  -- la meta diaria.
  --
  -- Se cuenta HASTA EL DIA DEL CIERRE y no antes, para no reescribir la
  -- historia: un credito cancelado el 3 SI era cobrable el 1, y la meta de
  -- ese dia ya se cerro y se aprobo con el adentro.
  --
  -- El dia del cierre sale del LIBRO (el ultimo evento aplicado del credito),
  -- que es donde quedo escrito cuando se acabo de pagar. No hace falta ninguna
  -- columna nueva.
  SELECT pp.fecha_pago AS fecha, pp.ruta,
         SUM(pp.valor_cuota) AS meta_pagos
    FROM public.payment_plan pp
    JOIN public.loans l ON l.id = pp.loan_id
    LEFT JOIN LATERAL (
      SELECT MAX(g.fecha_gestion) AS dia_cierre
        FROM public.gestiones g
       WHERE g.loan_id = pp.loan_id
         AND g.estado = 'aplicada'
    ) fin ON true
   WHERE l.estado <> 'cancelado'
      OR pp.fecha_pago <= fin.dia_cierre
   GROUP BY pp.fecha_pago, pp.ruta
),
gastos AS (
  SELECT (g.fechahorasol AT TIME ZONE 'America/Bogota')::date AS fecha, g.ruta,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Ingreso'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_ingresos,
         COUNT(*) FILTER (WHERE g.tipo = 'Ingreso'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_ingresos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Gasto'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_gastos,
         COUNT(*) FILTER (WHERE g.tipo = 'Gasto'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_gastos,
         COALESCE(SUM(g.valor) FILTER (WHERE g.tipo = 'Retiro'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA')), 0) AS valor_retiros,
         COUNT(*) FILTER (WHERE g.tipo = 'Retiro'
           AND (g.estadosecre = 'aprobado' OR g.estadoadmin = 'NA'))     AS cantidad_retiros
    FROM public.gastosregistros g
   GROUP BY (g.fechahorasol AT TIME ZONE 'America/Bogota')::date, g.ruta
),
ventas AS (
  -- YA NO se filtran las homologadas: entran en el conteo y en el valor que
  -- muestra el Resumen. Lo que se aparta es `valor_ventas_caja`, que es lo
  -- único que puede restar del efectivo.
  SELECT (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS fecha, l.ruta,
         COUNT(*)                                                          AS cantidad_ventas,
         COALESCE(SUM(l.valor), 0)                                         AS valor_ventas,
         COUNT(*) FILTER (WHERE COALESCE(l.origen,'normal') = 'homologado') AS cantidad_ventas_homologadas,
         COALESCE(SUM(l.valor) FILTER (
           WHERE COALESCE(l.origen,'normal') = 'homologado'), 0)           AS valor_ventas_homologadas,
         -- Solo las ventas que de verdad sacaron plata de la caja de hoy.
         COALESCE(SUM(l.valor) FILTER (
           WHERE COALESCE(l.origen,'normal') <> 'homologado'), 0)          AS valor_ventas_caja
    FROM public.loans l
   GROUP BY (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date, l.ruta
),
base AS (
  SELECT COALESCE(p.fecha, m.fecha, g.fecha, v.fecha) AS fecha_pago,
         COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)  AS ruta,
         COALESCE(m.meta_pagos, 0)          AS meta_pagos,
         COALESCE(p.valor_pago, 0)          AS valor_pago,
         COALESCE(p.cantidad_pagos, 0)      AS cantidad_pagos,
         COALESCE(p.cantidad_no_pagos, 0)   AS cantidad_no_pagos,
         COALESCE(c.cantidad_canceladas, 0) AS cantidad_canceladas,
         COALESCE(c.valor_canceladas, 0)    AS valor_canceladas,
         COALESCE(p.pago_capital, 0)        AS pago_capital,
         COALESCE(p.pago_intereses, 0)      AS pago_intereses,
         COALESCE(p.pago_efectivo, 0)       AS pago_efectivo,
         COALESCE(p.pago_transferencia, 0)  AS pago_transferencia,
         COALESCE(p.valor_pago_campo, 0)     AS valor_pago_campo,
         COALESCE(p.valor_pago_ajuste, 0)    AS valor_pago_ajuste,
         COALESCE(p.cantidad_pagos_campo, 0) AS cantidad_pagos_campo,
         p.hora_ultimo_movimiento,
         COALESCE(g.valor_ingresos, 0)      AS valor_ingresos,
         COALESCE(g.cantidad_ingresos, 0)   AS cantidad_ingresos,
         COALESCE(g.valor_gastos, 0)        AS valor_gastos,
         COALESCE(g.cantidad_gastos, 0)     AS cantidad_gastos,
         COALESCE(g.valor_retiros, 0)       AS valor_retiros,
         COALESCE(g.cantidad_retiros, 0)    AS cantidad_retiros,
         COALESCE(v.cantidad_ventas, 0)     AS cantidad_ventas,
         COALESCE(v.valor_ventas, 0)        AS valor_ventas,
         COALESCE(v.cantidad_ventas_homologadas, 0) AS cantidad_ventas_homologadas,
         COALESCE(v.valor_ventas_homologadas, 0)    AS valor_ventas_homologadas,
         COALESCE(v.valor_ventas_caja, 0)           AS valor_ventas_caja
    FROM pagos p
    FULL JOIN meta   m ON m.fecha = p.fecha AND m.ruta = p.ruta
    FULL JOIN gastos g ON g.fecha = COALESCE(p.fecha, m.fecha)
                      AND g.ruta  = COALESCE(p.ruta,  m.ruta)
    FULL JOIN ventas v ON v.fecha = COALESCE(p.fecha, m.fecha, g.fecha)
                      AND v.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta)
    LEFT JOIN canceladas c ON c.fecha = COALESCE(p.fecha, m.fecha, g.fecha, v.fecha)
                          AND c.ruta  = COALESCE(p.ruta,  m.ruta,  g.ruta,  v.ruta)
)
SELECT b.*,
       -- OJO: acá va `valor_ventas_caja`, NO `valor_ventas`. Es la diferencia
       -- entre mostrar una homologada y descontarla de una plata que nunca
       -- salió de la caja.
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)   AS efectivo,
       SUM(b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
           - b.valor_gastos - b.valor_retiros)
         OVER (PARTITION BY b.ruta ORDER BY b.fecha_pago)
       - (b.valor_ingresos + b.valor_pago - b.valor_ventas_caja
          - b.valor_gastos - b.valor_retiros)               AS caja_anterior,
       -- Alias con los nombres de la vista vieja.
       b.cantidad_ingresos AS recuento_ingresos,
       b.cantidad_gastos   AS recuento_gastos,
       b.cantidad_retiros  AS recuento_retiros
  FROM base b
 ORDER BY b.fecha_pago DESC, b.ruta;



-- -- PASO 3) Que la regla quedo puesta (SOLO LECTURA) ------------------------
-- Tiene que devolver `true`.
SELECT pg_get_viewdef('public.resumen_diario_v2'::regclass, true) LIKE '%dia_cierre%'
       AS regla_puesta;


-- -- PASO 4) La meta de hoy, ya corregida (SOLO LECTURA) --------------------
-- Comparela con el PASO 1: en las rutas que tenian cancelados, `meta_pagos`
-- tiene que ser MENOR, y la diferencia es justo la columna `de_cancelados`.
SELECT ruta, fecha_pago, meta_pagos, valor_pago
  FROM public.resumen_diario_v2
 WHERE fecha_pago = (now() AT TIME ZONE 'America/Bogota')::date
 ORDER BY ruta;


-- -- PASO 5) Que la historia se respeto (SOLO LECTURA) -----------------------
-- Los dias viejos bajan MENOS que el de hoy, porque ahi esos creditos todavia
-- estaban vivos. Si un dia viejo quedo igual que el de hoy, la condicion del
-- dia de cierre no esta aplicando.
SELECT fecha_pago, ruta, meta_pagos
  FROM public.resumen_diario_v2
 WHERE ruta = 190
   AND fecha_pago >= (now() AT TIME ZONE 'America/Bogota')::date - 7
 ORDER BY fecha_pago;


-- -- PASO 6) Que la plata cobrada NO se movio (SOLO LECTURA) -----------------
-- Este script no toca el recaudo. Compare este total con el de antes de
-- correrlo: tiene que ser identico.
SELECT COUNT(*)        AS dias_con_fila,
       SUM(valor_pago) AS total_recaudado
  FROM public.resumen_diario_v2
 WHERE fecha_pago >= (now() AT TIME ZONE 'America/Bogota')::date - 30;
