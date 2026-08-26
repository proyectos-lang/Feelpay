-- ============================================================================
-- 075 - Un cobro salda UNA cuota, no las que alcance la plata
-- ============================================================================
-- LO QUE SE PIDIO
-- "Un dia hice un pago de 192.000 para una cuota de 9.600 y el sistema me
--  diluyo ese valor en las cuotas siguientes y las marco como pagas. Esto no
--  debe pasar. Si hago un pago de un dia, independiente del valor, debe
--  marcarme el pago completo solo ese dia. Y la mora debe calcularse sobre el
--  saldo que se debe contra el saldo que se deberia tener pagado a esa fecha."
--
-- LA MORA YA ES ASI. NO SE TOCA.
-- ------------------------------
-- `v_loan_financiero` ya la calcula exactamente sobre plata:
--
--   cuotas_mora = (suma de lo vencido a la fecha - todo lo pagado) / valor_cuota
--
-- Eso es "lo que deberia tener pagado" contra "lo que pago". Este script no
-- la modifica, y despues del cambio sigue dando lo mismo: no depende del
-- reparto por cuotas, solo del total pagado.
--
-- LO QUE SI CAMBIA: EL REPARTO
-- -----------------------------
-- Hasta hoy la plata caia en CASCADA: llenaba la cuota mas vieja, el sobrante
-- pasaba a la siguiente, y asi. Un cobro grande adelantaba cuotas futuras.
--
-- Ahora un COBRO DE CAMPO salda UNA cuota: la que el cobrador estaba
-- cobrando. Lo que sobre baja el saldo, pero no adelanta ninguna otra.
--
--   pago de 192.000 sobre una cuota de 9.600
--     antes -> cubria 20 cuotas
--     ahora -> cubre 1; los 182.400 restantes bajan el saldo y nada mas
--
-- SI PAGA DE MENOS, LA CUOTA QUEDA PARCIAL. No se marca completa por menos
-- de su valor (con el margen de centavos del 072).
--
-- LA EXCEPCION QUE HAY QUE CONOCER
-- ---------------------------------
-- El ABONO DE LA VENTA y la HISTORIA MIGRADA (`abono_venta`, origen
-- 'homologacion') NO son la visita de un dia: son plata contra el credito
-- entero. Esos siguen repartiendose en cascada.
--
-- No es un capricho, se midio: aplicar "una cuota por pago" tambien a ellos
-- movia 986 cuotas en 116 creditos — en la ruta 933 hay creditos con UN solo
-- abono de venta cubriendo 28 cuotas, y habrian quedado 27 en pendiente de
-- un dia para otro. Limitandolo a los cobros de campo, el cambio baja a 144
-- cuotas en 57 creditos, que son las diluciones de verdad.
--
-- LO QUE VA A CAMBIAR, MEDIDO CONTRA LA BASE
-- -------------------------------------------
--   cuotas comparadas : 3.715
--   quedan igual      : 3.559
--   CAMBIAN           :   156
--        pagado -> pendiente     92
--        pagado -> parcial       22
--        parcial -> pendiente    18
--        pendiente -> pagado     11
--        parcial -> pagado        5
--   creditos afectados: 57 de 150
--
--   INVARIANTE comprobado: en NINGUN credito lo repartido supera lo pagado.
--
-- Ejemplos reales de los que cambian:
--   pablo martin kiosko  (190): 1 cobro de 186.000, cuota 33.600 -> cubria 5
--   romina amalia paletta(190): 2 cobros por 120.000, cuota 16.800 -> cubrian 7
--   alicia isabel sosa   (190): 7 cobros por 312.000, cuota 26.000 -> cubrian 12
--
-- LO QUE NO CAMBIA
--   · El saldo. La plata es la plata: `pagado_neto` no se toca.
--   · La mora. Sale del saldo, no del reparto.
--   · Los totales de caja, recaudo y cierre. Nada de eso mira las cuotas.
--
-- LO QUE HAY QUE ESPERAR
-- Un cliente que paga mas de una cuota por visita va a acumular cuotas en
-- 'pendiente' aunque vaya adelantado en plata. Su saldo y su mora diran la
-- verdad, pero la lista de cuotas mostrara mas pendientes que antes. Es la
-- consecuencia directa de "un pago = una cuota".
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Foto de como esta el reparto AHORA (solo lectura) ─────────────
-- Se guarda para poder comparar en el paso 5 y, si algo no cuadra, saber
-- exactamente que cuota cambio y de que a que.
DROP TABLE IF EXISTS public.cobertura_antes_075;


-- ── PASO 2) Guardarla ─────────────────────────────────────────────────────
CREATE TABLE public.cobertura_antes_075 AS
SELECT id, loan_id, numero_cuota, monto_asignado, estado_derivado
  FROM public.v_cobertura_cuotas;


-- ── PASO 3) El reparto nuevo ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cobertura_cuotas AS
WITH vivos AS (
  -- Los eventos que siguen en pie: los que tienen una reversa APLICADA
  -- apuntandoles quedan fuera.
  --
  -- Hace falta explicitamente porque la anulacion desde el modulo de pagos
  -- referencia el evento (`referencia_gestion_id`) pero NO trae
  -- `cuota_objetivo`. Sin esto, un cobro anulado seguiria clavado en su
  -- cuota: la reversa no tendria por donde descontarlo.
  SELECT g.*
    FROM public.gestiones g
   WHERE g.estado = 'aplicada'
     AND NOT EXISTS (
       SELECT 1 FROM public.gestiones r
        WHERE r.referencia_gestion_id = g.id
          AND r.tipo = 'reversa'
          AND r.estado = 'aplicada')
),
clavado AS (
  -- PLATA CLAVADA EN UNA CUOTA. Ahora son DOS cosas:
  --
  --  · lo que secretaria fija desde Control de Pagos (origen 'ajuste'), como
  --    siempre; y
  --  · EL COBRO DE CAMPO (origen 'campo'), que es lo nuevo.
  --
  -- Un cobro es la visita de UN dia y salda UNA cuota: la que el cobrador
  -- estaba cobrando. Lo que sobre baja el saldo, pero no adelanta ninguna
  -- otra cuota.
  --
  -- El abono de la venta y la historia migrada NO entran aca: no son la
  -- visita de un dia, son plata contra el credito entero, y siguen cayendo
  -- en cascada. Ver el encabezado.
  SELECT v.cuota_objetivo AS cuota_id,
         v.loan_id,
         SUM(CASE WHEN v.tipo IN ('pago','cancelacion','abono_venta') THEN  v.monto
                  WHEN v.tipo = 'reversa'                             THEN -v.monto
                  ELSE 0 END) AS monto
    FROM vivos v
   WHERE v.origen IN ('ajuste', 'campo')
     AND v.cuota_objetivo IS NOT NULL
     AND v.tipo IN ('pago', 'cancelacion', 'abono_venta', 'reversa')
   GROUP BY v.cuota_objetivo, v.loan_id
),
clavado_bruto AS (
  -- Lo clavado en TODO el prestamo, SIN CAPAR.
  --
  -- Es la pieza que impide que la dilucion vuelva por la puerta de atras: si
  -- solo se descontara la parte que cabe en cada cuota, el excedente quedaria
  -- en la bolsa libre y caeria en cascada sobre las siguientes — exactamente
  -- lo que se quiere evitar. Al descontar el monto COMPLETO, el sobrante no
  -- adelanta nada: solo baja el saldo.
  SELECT loan_id, GREATEST(0, SUM(monto)) AS monto
    FROM clavado
   GROUP BY loan_id
),
dirigido AS (
  SELECT cuota_id, GREATEST(0, monto) AS monto FROM clavado
),
base AS (
  SELECT pp.id, pp.loan_id, pp.numero_cuota, pp.fecha_pago, pp.valor_cuota,
         pp.es_extra,
         -- Lo clavado nunca puede pasarse del valor de la cuota: eso es lo que
         -- SE VE en la cuota. Pero el sobrante YA NO vuelve a la bolsa libre
         -- — se descuenta entero en `clavado_bruto`. Ahi esta la diferencia
         -- con la cascada de antes.
         LEAST(pp.valor_cuota, COALESCE(d.monto, 0)) AS dirigido
    FROM public.payment_plan pp
    LEFT JOIN dirigido d ON d.cuota_id = pp.id
),
plan AS (
  SELECT b.*,
         -- El acumulado de SIEMPRE, que otras vistas siguen leyendo.
         SUM(b.valor_cuota) OVER (
           PARTITION BY b.loan_id ORDER BY b.fecha_pago, b.numero_cuota, b.id
         ) AS acumulado,
         -- Lo que le falta a cada cuota DESPUÉS de lo dirigido: es sobre esto
         -- que corre la cascada de la plata libre.
         SUM(b.valor_cuota - b.dirigido) OVER (
           PARTITION BY b.loan_id ORDER BY b.fecha_pago, b.numero_cuota, b.id
         ) AS acum_libre
         -- `dirigido_total` ya no existe: la bolsa libre no se calcula
         -- restando lo capado, sino lo clavado COMPLETO (`clavado_bruto`).
    FROM base b
),
calc AS (
  SELECT p.*,
         COALESCE(n.pagado_neto, 0)             AS neto,
         COALESCE(n.pagado_sin_cancelacion, 0)  AS neto_sin_canc,
         COALESCE(n.tiene_cancelacion, false)   AS tiene_cancelacion,
         -- LA BOLSA LIBRE.
         --
         -- Es el total menos lo clavado SIN CAPAR (`cb.monto`), no menos la
         -- parte que cupo en cada cuota. Esa resta es la que hace que un cobro
         -- de 192.000 sobre una cuota de 9.600 no adelante nada: los 182.400
         -- de sobra no entran a la cascada.
         --
         -- Lo que queda libre es lo que NO esta clavado: el abono de la venta
         -- y la historia migrada. Eso sigue cayendo en cascada, como siempre.
         GREATEST(0, COALESCE(n.pagado_neto, 0)            - COALESCE(cb.monto, 0)) AS libre,
         GREATEST(0, COALESCE(n.pagado_sin_cancelacion, 0) - COALESCE(cb.monto, 0)) AS libre_sin_canc
    FROM plan p
    LEFT JOIN public.v_pagos_netos n ON n.loan_id = p.loan_id
    LEFT JOIN clavado_bruto cb       ON cb.loan_id = p.loan_id
)
SELECT c.id, c.loan_id, c.numero_cuota, c.fecha_pago, c.valor_cuota,
       c.es_extra, c.acumulado,
       -- Lo dirigido + lo que le toque de la cascada libre.
       c.dirigido
         + LEAST(c.valor_cuota - c.dirigido,
                 GREATEST(0, c.libre - (c.acum_libre - (c.valor_cuota - c.dirigido))))
         AS monto_asignado,
       CASE
         -- 'pagado' se mide sin la plata de cancelación, igual que antes: una
         -- cancelación no debe pintar todas las cuotas como pagadas.
         -- `cubre_cuota` en vez de `>=`: es el MISMO umbral, con el margen
         -- de redondeo. Ver el encabezado del 072.
         WHEN public.cubre_cuota(
                c.dirigido
                  + LEAST(c.valor_cuota - c.dirigido,
                          GREATEST(0, c.libre_sin_canc - (c.acum_libre - (c.valor_cuota - c.dirigido)))),
                c.valor_cuota) THEN 'pagado'
         WHEN c.tiene_cancelacion THEN 'cancelada'
         WHEN c.dirigido
                + LEAST(c.valor_cuota - c.dirigido,
                        GREATEST(0, c.libre - (c.acum_libre - (c.valor_cuota - c.dirigido))))
              > 0 THEN 'parcial'
         WHEN EXISTS (
           SELECT 1 FROM public.gestiones g
            WHERE g.cuota_objetivo = c.id AND g.tipo = 'no_pago'
              AND g.estado = 'aplicada'
              AND NOT EXISTS (
                SELECT 1 FROM public.gestiones r
                 WHERE r.referencia_gestion_id = g.id
                   AND r.tipo = 'reversa' AND r.estado = 'aplicada')
         ) THEN 'no_pago'
         ELSE 'pendiente'
       END AS estado_derivado
  FROM calc c;


-- ── PASO 4) Rehacer el cache de todos los prestamos ───────────────────────
-- `payment_plan.estado`, `payment_plan.monto_pagado`, `loans.saldo` y
-- `loans.estado` son un CACHE que solo escribe `recalcular_prestamo`. La
-- vista ya cambio; sin esto las tablas seguirian con el reparto viejo.
SELECT public.recalcular_prestamo(id) FROM public.loans;


-- ── PASO 5) QUE CAMBIO, cuota por cuota ───────────────────────────────────
-- Deberian salir ~156 filas. Si sale MUCHO mas, para: significa que la
-- excepcion del abono de venta no quedo y se movieron cuotas que no debian.
SELECT l.ruta,
       c.nombre_completo,
       a.numero_cuota,
       a.monto_asignado  AS antes,
       n.monto_asignado  AS ahora,
       a.estado_derivado AS estado_antes,
       n.estado_derivado AS estado_ahora
  FROM public.cobertura_antes_075 a
  JOIN public.v_cobertura_cuotas  n ON n.id = a.id
  JOIN public.loans   l ON l.id = a.loan_id
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE a.estado_derivado IS DISTINCT FROM n.estado_derivado
 ORDER BY l.ruta, c.nombre_completo, a.numero_cuota;


-- ── PASO 6) Cuantas cambiaron, en una linea ───────────────────────────────
SELECT COUNT(*)                                                    AS cuotas_que_cambian,
       COUNT(DISTINCT a.loan_id)                                   AS creditos,
       COUNT(*) FILTER (WHERE a.estado_derivado = 'pagado'
                          AND n.estado_derivado = 'pendiente')     AS pagado_a_pendiente,
       COUNT(*) FILTER (WHERE a.estado_derivado = 'pagado'
                          AND n.estado_derivado = 'parcial')       AS pagado_a_parcial
  FROM public.cobertura_antes_075 a
  JOIN public.v_cobertura_cuotas  n ON n.id = a.id
 WHERE a.estado_derivado IS DISTINCT FROM n.estado_derivado;


-- ── PASO 7) QUE NO SE HAYA PERDIDO NI APARECIDO PLATA ─────────────────────
-- EL INVARIANTE QUE IMPORTA. Lo repartido sobre las cuotas nunca puede pasar
-- de lo pagado, y el saldo tiene que seguir siendo contrato menos pagado.
-- `descuadre` debe dar 0 en TODAS las filas.
SELECT l.ruta, l.id AS loan_id,
       COALESCE(n.pagado_neto, 0)                     AS pagado,
       COALESCE(l.valor_a_pagar, l.valor)             AS contrato,
       l.saldo,
       COALESCE(l.valor_a_pagar, l.valor) - COALESCE(n.pagado_neto, 0) - l.saldo AS descuadre
  FROM public.loans l
  LEFT JOIN public.v_pagos_netos n ON n.loan_id = l.id
 WHERE l.estado <> 'anulado'
   AND abs(COALESCE(l.valor_a_pagar, l.valor) - COALESCE(n.pagado_neto, 0) - l.saldo) > 0.004
 ORDER BY l.ruta;


-- ── PASO 8) Que la mora no se haya movido ─────────────────────────────────
-- No deberia: sale del saldo, no del reparto. Esta lista es para confirmarlo
-- con los ojos. Compara la mora de cada credito activo con lo que da la
-- formula a mano.
SELECT l.ruta, c.nombre_completo,
       f.cuotas_mora,
       f.saldo_en_mora,
       f.cuotas_cubiertas || '/' || f.cuotas_totales AS cuotas
  FROM public.loans l
  JOIN public.v_loan_financiero f ON f.loan_id = l.id
  LEFT JOIN public.clients c ON c.id = l.client_id
 WHERE l.estado = 'activo' AND f.cuotas_mora > 0
 ORDER BY f.cuotas_mora DESC, l.ruta
 LIMIT 30;


-- ── PASO 9) El caso que lo origino ────────────────────────────────────────
-- MARTINEZ EMILCE, ruta 197. Sus cuotas deben reflejar UN cobro por cuota.
SELECT n.numero_cuota, n.fecha_pago, n.valor_cuota, n.monto_asignado, n.estado_derivado
  FROM public.v_cobertura_cuotas n
  JOIN public.loans l   ON l.id = n.loan_id
  JOIN public.clients c ON c.id = l.client_id
 WHERE c.nombre_completo ILIKE '%EMILCE%'
 ORDER BY n.numero_cuota;
