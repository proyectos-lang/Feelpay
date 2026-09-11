-- ============================================================================
-- 109 - El traslado del 108 no debia contar como visita
-- ============================================================================
-- LO QUE SE REPORTO
-- "Los clientes me siguen apareciendo en gestionados y con pagos aunque la
--  reversa fue de ayer."
--
-- ES UN ERROR MIO EN EL SCRIPT 108. Para mover la plata del 11 al 10 escribi
-- un `pago` de +$X el 11 y una `reversa` de -$X el 10. Los TOTALES quedaron
-- bien —el 10 en 883.200 y el 11 en 26.000— pero un `pago` es una VISITA, y
-- la lista de cobro no suma netos: cuenta visitas.
--
-- Resultado: Jenny bodega y jenny condori aparecen en Gestionados con
-- "Pago $0". Comprobado en pantalla antes de escribir esto.
--
-- POR QUE `abono_venta` Y NO OTRA COSA
-- -------------------------------------
-- Hay dos listas distintas, y un evento tiene que estar en la primera y no en
-- la segunda:
--
--   suma plata  (montoEfectivo)  pago · cancelacion · abono_venta
--   es visita   (esVisita)       pago · cancelacion · no_pago
--
-- `abono_venta` es el UNICO tipo que mueve plata sin contar como visita. Es
-- lo que ya se usa para el abono inicial de una venta, que tampoco es una
-- visita al cliente. El SQL lo trata igual (script 070, linea 69).
--
-- POR QUE NO SE ARREGLO CAMBIANDO `esVisita`
-- -------------------------------------------
-- Era la otra salida: que `esVisita` ignore los eventos con origen 'ajuste'.
-- Se midio y esta MAL: hay 93 eventos asi en la base, y 91 son correcciones
-- legitimas de Control de Pagos —"Ajuste desde Control de Pagos" (62) y
-- "Marcada no pago desde Control de Pagos" (29)— donde alguien marco un pago
-- o un no pago REAL. Esos SI son visitas y deben seguir en Gestionados.
-- Solo mis 2 sobran.
--
-- QUE HACE ESTE SCRIPT
-- --------------------
-- El libro es inmutable: no se puede cambiarle el tipo a una fila. Asi que
-- por cada `pago` de ajuste del 108:
--
--   una `reversa` que lo anula        -> el par se descarta entero
--   un `abono_venta` por el mismo $X  -> mueve la misma plata, sin ser visita
--
-- El neto del dia NO cambia. Lo unico que cambia es que el cliente deja de
-- aparecer como gestionado.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 2 no escriben nada.
-- ============================================================================


-- -- PASO 1) Lo que hay hoy (SOLO LECTURA, no cambia nada) -------------------
-- Guarde estos numeros: el PASO 4 tiene que dar exactamente lo mismo.
SELECT fecha_pago, valor_pago, cantidad_pagos
  FROM public.resumen_diario_v2
 WHERE ruta = 151 AND fecha_pago IN (DATE '2026-09-10', DATE '2026-09-11')
 ORDER BY fecha_pago;


-- -- PASO 2) Los pagos del 108 que hay que convertir (SOLO LECTURA) ---------
-- Tienen que salir DOS: $65.000 y $97.500, los dos el 11/09.
SELECT g.id, g.monto, g.fecha_gestion,
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente
  FROM public.gestiones g
  JOIN public.loans l   ON l.id = g.loan_id
  JOIN public.clients c ON c.id = l.client_id
 WHERE g.origen = 'ajuste'
   AND g.tipo = 'pago'
   AND g.estado = 'aplicada'
   AND g.observacion LIKE 'Ajuste 108:%'
 ORDER BY g.monto DESC;


-- -- PASO 3) Convertirlos en abono_venta ---------------------------------------
DO $$
DECLARE
  r    record;
  v_n  int := 0;
BEGIN
  FOR r IN
    SELECT g.id, g.loan_id, g.client_id, g.ruta, g.user_id, g.monto, g.fecha_gestion
      FROM public.gestiones g
     WHERE g.origen = 'ajuste'
       AND g.tipo = 'pago'
       AND g.estado = 'aplicada'
       AND g.observacion LIKE 'Ajuste 108:%'
       -- Y que no este ya anulado, para poder correr esto dos veces sin dano.
       AND NOT EXISTS (
         SELECT 1 FROM public.gestiones rev
          WHERE rev.referencia_gestion_id = g.id
            AND rev.tipo = 'reversa'
            AND rev.estado = 'aplicada')
  LOOP
    -- 1) Se anula el `pago` que yo habia escrito. El par (pago + su reversa)
    --    se descarta entero al leer el dia, asi que deja de ser una visita.
    INSERT INTO public.gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, fecha_hora, origen, referencia_gestion_id, observacion
    ) VALUES (
      gen_random_uuid(), r.loan_id, r.client_id, r.ruta, r.user_id,
      'reversa', 'aplicada', r.fecha_gestion, r.monto, NOW(), 'ajuste', r.id,
      'Ajuste 109: el traslado del 108 no debia ser un pago (contaba como visita).'
    );

    -- 2) Y la misma plata entra como `abono_venta`, que suma igual pero no
    --    es una visita al cliente.
    INSERT INTO public.gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, fecha_hora, origen, observacion
    ) VALUES (
      gen_random_uuid(), r.loan_id, r.client_id, r.ruta, r.user_id,
      'abono_venta', 'aplicada', r.fecha_gestion, r.monto, NOW(), 'ajuste',
      'Ajuste 109: traslado de plata del 108, sin contar como visita.'
    );

    v_n := v_n + 1;
    RAISE NOTICE 'Convertido a abono_venta: $% del %', r.monto, r.fecha_gestion;
  END LOOP;

  IF v_n = 0 THEN
    RAISE NOTICE 'No habia nada que convertir: puede que ya se haya corrido.';
  ELSE
    RAISE NOTICE 'Traslados corregidos: %', v_n;
  END IF;
END $$;


-- -- PASO 4) Que los totales NO se movieron (SOLO LECTURA) --------------------
-- Tiene que dar lo MISMO que el PASO 1:
--
--   10/09   883.200
--   11/09    26.000
--
-- Si `valor_pago` cambio, el par no neteo y hay que revisar.
SELECT fecha_pago, valor_pago, cantidad_pagos
  FROM public.resumen_diario_v2
 WHERE ruta = 151 AND fecha_pago IN (DATE '2026-09-10', DATE '2026-09-11')
 ORDER BY fecha_pago;


-- -- PASO 5) Que los dos clientes ya NO estan gestionados hoy (SOLO LECTURA) -
-- Cuenta las VISITAS vivas de cada uno el 11/09, con el mismo criterio de la
-- app: pago, no_pago o cancelacion que no esten anuladas. Tiene que dar 0
-- para los dos; si da mas, algo quedo contando como visita.
SELECT COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       COUNT(*) FILTER (
         WHERE g.tipo IN ('pago','no_pago','cancelacion')
           AND NOT EXISTS (
             SELECT 1 FROM public.gestiones rev
              WHERE rev.referencia_gestion_id = g.id
                AND rev.tipo = 'reversa'
                AND rev.estado = 'aplicada')
       ) AS visitas_vivas
  FROM public.gestiones g
  JOIN public.loans l   ON l.id = g.loan_id
  JOIN public.clients c ON c.id = l.client_id
 WHERE g.ruta = 151
   AND g.fecha_gestion = DATE '2026-09-11'
   AND g.estado = 'aplicada'
   AND l.client_id IN (
     SELECT l2.client_id FROM public.gestiones g2
       JOIN public.loans l2 ON l2.id = g2.loan_id
      WHERE g2.observacion LIKE 'Ajuste 109:%')
 GROUP BY c.apodo, c.nombre_completo;


-- -- PASO 6) Y que el saldo sigue igual (SOLO LECTURA) -----------------------
-- Los eventos de este script netean cero sobre el credito, asi que cada
-- cliente debe seguir debiendo lo mismo que antes de correrlo.
SELECT DISTINCT
       COALESCE(NULLIF(c.apodo,''), c.nombre_completo) AS cliente,
       f.total_pagado,
       f.saldo
  FROM public.gestiones g
  JOIN public.loans l              ON l.id = g.loan_id
  JOIN public.clients c            ON c.id = l.client_id
  JOIN public.v_loan_financiero f  ON f.loan_id = l.id
 WHERE g.observacion LIKE 'Ajuste 109:%';
