-- ============================================================================
-- 078 - Una venta que se teclea hoy puede pertenecer al reporte de ayer
-- ============================================================================
-- QUÉ PIDIÓ EL DUEÑO
-- «Poder crear ventas a una determinada ruta eligiendo la fecha de creación:
--  se crea hoy pero que podamos aclarar que pertenece al reporte de ayer.»
--
-- POR QUÉ HACÍA FALTA TOCAR EL SERVIDOR
-- El día de una venta no es un campo que la app elija: es `loans.fecha_creacion`
-- cayendo en su DEFAULT NOW(). De ahí lo leen, todos con la misma fórmula
-- `(fecha_creacion AT TIME ZONE 'America/Bogota')::date`:
--
--   · resumen_diario_v2      → cantidad_ventas, valor_ventas, valor_ventas_caja
--   · vista_monitoreo_admin  → total_ventas, cantidad_ventas
--   · Ventas del Día         → sales-today-list.tsx
--   · Resumen del Día        → daily-summary.tsx
--
-- Así que no había forma de "aclarar" nada desde el navegador sin escribirle a
-- `loans` a mano, que es justo lo que la convención prohíbe. Se agrega
-- entonces UNA clave opcional al payload que ya viaja: `p_loan->>'fecha_venta'`.
-- Sin ella, `crear_venta_atomica` hace exactamente lo de siempre.
--
-- LAS DOS FECHAS DEJAN DE SER LA MISMA
-- Hoy `fecha_creacion` y `created_at` son gemelas: las dos caen en NOW() y
-- ninguna se escribe explícitamente. A partir de acá se separan y cada una
-- dice una cosa distinta:
--
--   fecha_creacion → EL DÍA DE NEGOCIO de la venta. Lo que leen los informes.
--   created_at     → EL INSTANTE REAL en que se registró. No lo lee ningún
--                    informe, así que queda como el rastro de cuándo se tecleó.
--
-- Es la misma separación que el libro de eventos hace desde el script 042
-- entre `fecha_gestion` (el día al que aplica) y `fecha_hora` (el reloj). Una
-- venta fechada hacia atrás deja además un `ajuste` de monto 0 en el libro,
-- que no entra en ninguna cuenta pero sí aparece en el historial.
--
-- LO QUE ESTO MUEVE, Y HAY QUE SABERLO ANTES DE USARLO
-- `resumen_diario_v2.efectivo` es una suma CORRIDA por ruta ordenada por
-- fecha, y `caja_anterior` es esa misma suma menos el día. Una venta fechada
-- ayer no cambia solo el reporte de ayer: baja la caja de ayer y la de TODOS
-- los días siguientes, incluidos los ya cerrados y aprobados. Eso es correcto
-- —la plata salió ese día—, pero no es invisible, y por eso la pantalla lo
-- advierte antes de guardar.
--
-- De ahí también el tope de 60 días: no es prudencia, es el guardia contra el
-- año mal tecleado. Una venta fechada en 2025 arrastraría la caja de todos los
-- días desde entonces sin que nadie lo note.
--
-- QUÉ NO CAMBIA
-- La firma de la función, sus permisos, la idempotencia, la homologación, el
-- abono inicial y el camino de aprobación (`registrar_venta` del 061 y
-- `aprobar_solicitud_revision` pasan `p_loan` entero, así que `fecha_venta`
-- sobrevive intacta a una venta que se va a revisión).
--
-- Base: script 045, PASO 2. Se copió completa y se cambió solo lo listado.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) crear_venta_atomica, con el día del reporte ───────────────────
CREATE OR REPLACE FUNCTION public.crear_venta_atomica(
  p_user_id      bigint,
  p_ruta_id      bigint,
  p_rol          text,
  p_cliente      jsonb,
  p_loan         jsonb,
  p_payment_plan jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_idem          uuid;
  v_prev          jsonb;
  v_hoy           date;
  v_manana        date;
  v_fecha_venta   date;
  v_ts_venta      timestamptz;
  v_lat           numeric;
  v_lon           numeric;
  v_is_new        boolean;
  v_client_id     uuid;
  v_loan_id       uuid;
  v_fecha_primer  date;
  v_historial     jsonb;
  v_origen        text;
  v_plan_cliente  boolean;
  v_valor         numeric;
  v_tasa          numeric;
  v_n             int;
  v_tipo_am       text;
  v_freq          text;
  v_empleado      boolean;
  v_dia_semana    text;
  v_valor_a_pagar numeric;
  v_valor_cuota   numeric;
  v_abono         numeric;
  v_fecha_disp    date;
  v_item          jsonb;
  v_f             date;
  v_t             text;
  v_m             numeric;
  v_hist_n        int := 0;
  v_hist_total    numeric := 0;
  v_recalc        jsonb;
  v_resultado     jsonb;
BEGIN
  -- Idempotencia (la llave viaja dentro de p_loan para no cambiar la firma)
  v_idem := NULLIF(p_loan->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  v_hoy := (now() AT TIME ZONE 'America/Bogota')::date;

  -- ── EL DÍA AL QUE PERTENECE LA VENTA ────────────────────────────────────
  -- Por defecto hoy, que es lo que pasaba siempre. Control Total puede mandar
  -- `fecha_venta` para decir «esto ocurrió ayer, cuéntalo en el reporte de
  -- ayer»: la plata salió de la caja ese día y ahí tiene que restar.
  v_fecha_venta := COALESCE(NULLIF(p_loan->>'fecha_venta','')::date, v_hoy);

  IF v_fecha_venta > v_hoy THEN
    RAISE EXCEPTION 'La venta no puede pertenecer a un día que todavía no llega (% > %)',
      v_fecha_venta, v_hoy;
  END IF;

  -- TOPE DE 60 DÍAS. No es prudencia: es el guardia contra el año mal
  -- tecleado. `efectivo` en `resumen_diario_v2` es una suma corrida por ruta
  -- ordenada por fecha, así que una venta fechada en 2025 no cambiaría un día
  -- — arrastraría la caja de todos los días desde entonces, en silencio.
  IF v_fecha_venta < v_hoy - 60 THEN
    RAISE EXCEPTION 'La fecha de la venta (%) está a más de 60 días de hoy (%). Revisa el año antes de insistir.',
      v_fecha_venta, v_hoy;
  END IF;

  -- MEDIODÍA para un día pasado, la hora real para hoy. Es la misma regla de
  -- `instanteDelDia` en el diálogo de movimientos: los informes agrupan por
  -- `(fecha_creacion AT TIME ZONE 'America/Bogota')::date`, y a las 12:00
  -- −05:00 no hay corrimiento de zona que empuje la venta al día vecino. Para
  -- hoy se conserva la hora real y así queda en su lugar cronológico dentro
  -- de "Ventas del día".
  v_ts_venta := CASE
    WHEN v_fecha_venta = v_hoy THEN NOW()
    ELSE (v_fecha_venta::timestamp + TIME '12:00') AT TIME ZONE 'America/Bogota'
  END;

  -- La primera cuota cae al día siguiente DE LA VENTA, no de hoy. Con una
  -- venta de ayer y este default puesto en hoy, el cronograma nacía corrido un
  -- día respecto de lo que se pactó con el cliente.
  v_manana := v_fecha_venta + 1;

  v_lat    := NULLIF(p_cliente->>'latitud','')::numeric;
  v_lon    := NULLIF(p_cliente->>'longitud','')::numeric;

  -- ── Cliente ─────────────────────────────────────────────────────────────
  v_is_new := COALESCE((p_cliente->>'is_new')::boolean, false);
  IF v_is_new THEN
    INSERT INTO clients (
      documento, nombre_completo, apodo, telefono, telefono2, direccion,
      sector, tipo_comercio, ref1_nombre, ref1_telefono, ref1_direccion,
      cedula_image_url, ruta, tiene_prestamo_activo,
      latitud, longitud, ubicacion_capturada_at
    ) VALUES (
      p_cliente->>'documento',
      p_cliente->>'nombre_completo',
      NULLIF(p_cliente->>'apodo',''),
      NULLIF(p_cliente->>'telefono',''),
      NULLIF(p_cliente->>'telefono2',''),
      NULLIF(p_cliente->>'direccion',''),
      NULLIF(p_cliente->>'sector',''),
      NULLIF(p_cliente->>'tipo_comercio',''),
      NULLIF(p_cliente->>'ref1_nombre',''),
      NULLIF(p_cliente->>'ref1_telefono',''),
      NULLIF(p_cliente->>'ref1_direccion',''),
      NULLIF(p_cliente->>'cedula_image_url',''),
      p_ruta_id, true,
      v_lat, v_lon,
      CASE WHEN v_lat IS NOT NULL THEN NOW() ELSE NULL END
    ) RETURNING id INTO v_client_id;
  ELSE
    v_client_id := NULLIF(p_cliente->>'id','')::uuid;
    IF v_client_id IS NULL THEN
      RAISE EXCEPTION 'Renovación sin id de cliente';
    END IF;
    -- La ubicación de referencia NUNCA se pisa si ya existe (geocerca).
    UPDATE clients
       SET tiene_prestamo_activo = true,
           latitud  = COALESCE(latitud, v_lat),
           longitud = COALESCE(longitud, v_lon),
           ubicacion_capturada_at = CASE WHEN latitud IS NULL AND v_lat IS NOT NULL
                                         THEN NOW() ELSE ubicacion_capturada_at END,
           updated_at = NOW()
     WHERE id = v_client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El cliente de la renovación no existe';
    END IF;
  END IF;

  -- ── Parámetros del préstamo ─────────────────────────────────────────────
  v_valor      := (p_loan->>'valor')::numeric;
  v_tasa       := COALESCE(NULLIF(p_loan->>'tasa_interes','')::numeric, 0);
  v_n          := (p_loan->>'numero_cuotas')::int;
  v_empleado   := COALESCE((p_loan->>'prestamo_empleado')::boolean, false);
  v_tipo_am    := CASE WHEN v_empleado THEN 'empleado'
                       ELSE COALESCE(NULLIF(p_loan->>'tipo_amortizacion',''),'aleman') END;
  v_freq       := COALESCE(NULLIF(p_loan->>'frecuencia_pago',''), 'daily');
  v_dia_semana := NULLIF(p_loan->>'dia_semana','');
  v_fecha_primer := COALESCE(NULLIF(p_loan->>'fecha_primer_pago','')::date, v_manana);
  v_fecha_disp   := COALESCE(NULLIF(p_loan->>'fecha_dispositivo','')::date, v_fecha_venta);

  v_historial := p_loan->'historial';
  v_origen := CASE WHEN v_historial IS NOT NULL
                    AND jsonb_typeof(v_historial) = 'array'
                    AND jsonb_array_length(v_historial) > 0
                   THEN 'homologado' ELSE 'normal' END;

  v_plan_cliente := (p_payment_plan IS NOT NULL
                     AND jsonb_typeof(p_payment_plan) = 'array'
                     AND jsonb_array_length(p_payment_plan) > 0);

  IF v_plan_cliente THEN
    -- Compatibilidad: la app vieja manda el plan hecho; se respeta.
    v_valor_a_pagar := COALESCE(NULLIF(p_loan->>'valor_a_pagar','')::numeric,
                                NULLIF(p_loan->>'saldo','')::numeric, v_valor);
    v_valor_cuota   := NULLIF(p_loan->>'valor_cuota','')::numeric;
  ELSE
    -- App nueva: el servidor es la fuente de verdad del plan y los totales.
    SELECT COALESCE(SUM(g.valor_cuota), 0),
           (array_agg(g.valor_cuota ORDER BY g.numero_cuota))[1]
      INTO v_valor_a_pagar, v_valor_cuota
      FROM public.generar_cronograma(v_valor, v_tasa, v_n, v_tipo_am,
                                     v_freq, v_empleado, v_fecha_primer,
                                     v_dia_semana) g;
  END IF;

  -- ── Préstamo ────────────────────────────────────────────────────────────
  INSERT INTO loans (
    client_id, valor, saldo, valor_a_pagar, valor_cuota, tasa_interes,
    numero_cuotas, tipo_amortizacion, frecuencia_pago, dia_semana,
    -- OJO: `enrutar_venta` NO va aquí. Está en el CREATE TABLE del script 002
    -- pero NO existe en la base real (la tabla se creó por fuera del repo), y
    -- el formulario nunca la llenó: el estado existía sin ningún input que lo
    -- cambiara, así que siempre viajaba en null. Incluirla hacía fallar TODA
    -- la venta con «column "enrutar_venta" of relation "loans" does not exist».
    tipo_venta, cuenta_id, prestamo_empleado, estado,
    fecha_primer_pago, ruta, origen,
    -- DOS FECHAS QUE NO SON LA MISMA, y hasta ahora lo eran por accidente.
    --
    --   fecha_creacion → el DÍA DE NEGOCIO de la venta. Es lo que leen el
    --                    Resumen del Día, el Monitoreo, Ventas del Día y la
    --                    caja. Es el dato que Control Total puede mover.
    --   created_at     → el INSTANTE REAL en que se tecleó. No lo lee ningún
    --                    informe (solo sobrevive como respaldo en una línea
    --                    de register-payment), así que queda libre para ser
    --                    lo único que recuerda cuándo se registró de verdad.
    --
    -- Es la misma separación que el libro de eventos ya hace entre
    -- `fecha_gestion` y `fecha_hora`: el día al que aplica, y el reloj.
    fecha_creacion, created_at
  ) VALUES (
    v_client_id, v_valor, v_valor_a_pagar, v_valor_a_pagar, v_valor_cuota,
    v_tasa, v_n, v_tipo_am, v_freq, v_dia_semana,
    COALESCE(NULLIF(p_loan->>'tipo_venta',''), 'efectivo'),
    NULLIF(p_loan->>'cuenta_id','')::bigint,
    v_empleado,
    'activo', v_fecha_primer, p_ruta_id, v_origen,
    v_ts_venta, NOW()
  ) RETURNING id INTO v_loan_id;

  -- ── Cronograma ──────────────────────────────────────────────────────────
  IF v_plan_cliente THEN
    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    )
    SELECT v_loan_id,
           (e->>'numero_cuota')::int,
           (e->>'fecha_pago')::date,
           (e->>'valor_cuota')::numeric,
           COALESCE((e->>'capital')::numeric, 0),
           COALESCE((e->>'interes')::numeric, 0),
           0, 'pendiente', p_ruta_id, false
      FROM jsonb_array_elements(p_payment_plan) e;
  ELSE
    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    )
    SELECT v_loan_id, g.numero_cuota, g.fecha_pago, g.valor_cuota,
           g.capital, g.interes, 0, 'pendiente', p_ruta_id, false
      FROM public.generar_cronograma(v_valor, v_tasa, v_n, v_tipo_am,
                                     v_freq, v_empleado, v_fecha_primer,
                                     v_dia_semana) g;
  END IF;

  -- ── Abono inicial: EVENTO fechado con la fecha del dispositivo ──────────
  v_abono := COALESCE(NULLIF(p_loan->>'abono_inicial','')::numeric, 0);
  IF v_abono > 0 THEN
    v_abono := LEAST(v_abono, v_valor_a_pagar);
    INSERT INTO gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, origen, observacion, fecha_hora
    ) VALUES (
      gen_random_uuid(), v_loan_id, v_client_id, p_ruta_id, p_user_id,
      'abono_venta', 'aplicada', v_fecha_disp, v_abono, 'venta',
      'Abono inicial de la venta', NOW()
    );
  END IF;

  -- ── Venta homologada: historia día a día → eventos ──────────────────────
  IF v_origen = 'homologado' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_historial) LOOP
      v_f := NULLIF(v_item->>'fecha','')::date;
      v_t := v_item->>'tipo';
      v_m := COALESCE(NULLIF(v_item->>'monto','')::numeric, 0);
      IF v_f IS NULL OR v_f > v_hoy THEN
        RAISE EXCEPTION 'Historial: fecha inválida o futura (%)', v_item->>'fecha';
      END IF;
      IF v_t NOT IN ('pago','no_pago') THEN
        RAISE EXCEPTION 'Historial: tipo inválido (%) — solo pago o no_pago', v_t;
      END IF;
      IF v_m < 0 THEN
        RAISE EXCEPTION 'Historial: monto negativo';
      END IF;
      IF v_t = 'pago' THEN
        v_hist_total := v_hist_total + v_m;
        IF v_hist_total + v_abono > v_valor_a_pagar THEN
          RAISE EXCEPTION 'Historial: los pagos (%) más el abono superan el total a pagar (%)',
            v_hist_total + v_abono, v_valor_a_pagar;
        END IF;
      END IF;
      INSERT INTO gestiones (
        id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
        monto, origen, observacion, fecha_hora
      ) VALUES (
        gen_random_uuid(), v_loan_id, v_client_id, p_ruta_id, p_user_id,
        v_t, 'aplicada', v_f,
        CASE WHEN v_t = 'pago' THEN v_m ELSE 0 END,
        'homologacion', 'Homologación de venta migrada',
        (v_f::timestamp + interval '18 hours') AT TIME ZONE 'America/Bogota'
      );
      v_hist_n := v_hist_n + 1;
    END LOOP;
  END IF;

  -- ── Rastro de que esta venta se fechó hacia atrás ───────────────────────
  -- Un `ajuste` de monto 0: no lo mira ninguna cuenta (`v_pagos_netos` solo
  -- suma pago, cancelacion, abono_venta y reversa), pero aparece en el
  -- historial del préstamo, que es donde alguien va a preguntarse por qué esta
  -- venta figura en un día en el que nadie la vio entrar.
  --
  -- Va con `fecha_gestion = v_hoy`, el día en que de verdad se hizo, igual que
  -- el ajuste de auditoría de `editar_venta_atomica`.
  IF v_fecha_venta <> v_hoy THEN
    INSERT INTO gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, origen, observacion, detalle
    ) VALUES (
      gen_random_uuid(), v_loan_id, v_client_id, p_ruta_id, p_user_id,
      'ajuste', 'aplicada', v_hoy, 0, 'ajuste',
      'Venta registrada el ' || to_char(v_hoy, 'DD/MM/YYYY') ||
        ' y fechada en el reporte del ' || to_char(v_fecha_venta, 'DD/MM/YYYY'),
      jsonb_build_object(
        'fecha_venta',    v_fecha_venta,
        'fecha_registro', v_hoy,
        'dias_atras',     v_hoy - v_fecha_venta)
    );
  END IF;

  -- ── Derivar todo ────────────────────────────────────────────────────────
  v_recalc := public.recalcular_prestamo(v_loan_id);

  v_resultado := jsonb_build_object(
    'ok', true,
    'loan_id', v_loan_id,
    'client_id', v_client_id,
    'fecha_venta', v_fecha_venta,
    'abono_inicial_aplicado', v_abono,
    'historial_eventos', v_hist_n,
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'total_a_pagar', v_valor_a_pagar
  );
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 2) Permisos ──────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.crear_venta_atomica(bigint, bigint, text, jsonb, jsonb, jsonb) TO anon, authenticated;


-- ── PASO 3) Que nada le escriba la fecha por debajo (SOLO LECTURA) ────────
-- La corrección se apoya en que `fecha_creacion` es una columna común y
-- corriente con DEFAULT NOW(). Si hubiera un trigger que la pisara, el valor
-- elegido no llegaría a quedar y la venta volvería a caer en hoy sin avisar.
-- Esta consulta tiene que devolver CERO filas.
SELECT trigger_name, event_manipulation, action_timing, action_statement
  FROM information_schema.triggers
 WHERE event_object_schema = 'public'
   AND event_object_table  = 'loans';


-- ── PASO 4) Línea base: hoy las dos fechas son gemelas (SOLO LECTURA) ─────
-- Antes de usar la función nueva, `dia_negocio` y `dia_registro` coinciden en
-- TODAS las ventas: `iguales` debe dar true en todas las filas. Después de
-- fechar una venta hacia atrás, esa venta —y solo esa— dirá false, y las dos
-- columnas mostrarán a qué día se le contó y qué día se tecleó.
SELECT l.id,
       l.ruta,
       l.valor,
       (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS dia_negocio,
       (l.created_at     AT TIME ZONE 'America/Bogota')::date AS dia_registro,
       (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date
         = (l.created_at AT TIME ZONE 'America/Bogota')::date AS iguales
  FROM public.loans l
 ORDER BY l.created_at DESC
 LIMIT 30;


-- ── PASO 5) Las ventas fechadas hacia atrás, con su rastro (SOLO LECTURA) ─
-- Vacío hasta que se use la función nueva. Después, una fila por cada venta
-- que se registró en un día y se contó en otro, con el ajuste que lo dice.
SELECT g.fecha_gestion                     AS se_registro_el,
       (g.detalle->>'fecha_venta')::date   AS se_conto_en_el,
       (g.detalle->>'dias_atras')::int     AS dias_atras,
       g.ruta,
       l.valor,
       c.nombre_completo,
       u.nombre                            AS lo_registro
  FROM public.gestiones g
  JOIN public.loans   l ON l.id = g.loan_id
  JOIN public.clients c ON c.id = g.client_id
  LEFT JOIN public.usuarios u ON u.id = g.user_id
 WHERE g.tipo = 'ajuste'
   AND g.detalle ? 'fecha_venta'
 ORDER BY g.fecha_hora DESC;


-- ── PASO 6) Que la caja siga cuadrando (SOLO LECTURA) ─────────────────────
-- La cadena caja inicial + recaudo + ingresos − gastos − retiros − ventas =
-- caja final. `cuadra` debe dar true en todas las filas, antes y después de
-- fechar una venta hacia atrás: lo que cambia es CUÁNTO da cada día, no si la
-- suma cierra. Si alguna fila diera false, la venta se contó en un sitio y se
-- descontó en otro.
SELECT r.fecha_pago,
       r.ruta,
       r.caja_anterior,
       r.valor_pago,
       r.valor_ventas_caja,
       r.efectivo,
       round(r.caja_anterior + r.valor_pago + r.valor_ingresos
             - r.valor_gastos - r.valor_retiros - r.valor_ventas_caja, 2)
         = round(r.efectivo, 2) AS cuadra
  FROM public.resumen_diario_v2 r
 WHERE r.fecha_pago >= (now() AT TIME ZONE 'America/Bogota')::date - 15
 ORDER BY r.fecha_pago DESC, r.ruta;
