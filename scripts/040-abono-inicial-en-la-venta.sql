-- ============================================================================
-- 040 - El abono inicial de la venta se aplica de verdad
-- ============================================================================
-- Correr DESPUES del 033. Redefine crear_venta_atomica.
--
-- PROBLEMA
-- La pantalla de Nueva Venta tiene "Pago adelantado" con su cantidad de
-- cuotas y su valor. El cobrador lo llenaba, el cliente entregaba la plata...
-- y ese dato NUNCA salia del telefono: `p_loan` no lo incluia y esta funcion
-- no sabia que existia. La venta se creaba con todas las cuotas pendientes.
--
-- No es que se aplicara mal ni que se perdiera despues: nunca se envio. Esa
-- plata no quedaba ni en el plan, ni en el saldo, ni en la caja del dia.
--
-- SOLUCION
-- El abono viaja dentro de `p_loan` como `abono_inicial` (igual que la llave
-- de idempotencia, para no cambiar la firma de la funcion, que tiene otros
-- callers) y se aplica en la MISMA transaccion que la venta: o entran los
-- dos, o no entra ninguno.
--
-- COMO QUEDA REGISTRADO
-- Como una CUOTA EXTRA del dia de la venta (`es_extra = true`), no
-- consumiendo las cuotas programadas.
--
-- Es el mismo mecanismo que ya usa registrar_pago_atomico cuando el cobrador
-- elige "registrar como pago de hoy". Tiene dos ventajas:
--
--   · El cronograma pactado con el cliente queda intacto. Las cuotas siguen
--     con sus fechas y sus valores; el abono no se las come.
--   · La plata aparece en la caja del dia en que el cliente la entrego, que
--     es cuando el cobrador la recibio.
--
-- El abono baja el saldo, que es lo que el cliente debe. Las cuotas siguen
-- programadas: es un abono contra el saldo, no un prepago de cuotas
-- especificas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.crear_venta_atomica(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol text,
  p_cliente jsonb,
  p_loan jsonb,
  p_payment_plan jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_client_id uuid;
  v_loan_id uuid;
  v_cuota jsonb;
  v_fecha_manana date;
  v_idem uuid;
  v_resultado jsonb;
  v_latitud numeric;
  v_longitud numeric;

  -- Abono inicial
  v_abono           numeric;
  v_hoy             date;
  v_max_numero      int;
  v_valor_a_pagar   numeric;
  v_saldo_nuevo     numeric;
  v_pagado          numeric;
BEGIN
  -- 1) Fijar variables de sesión en esta transacción
  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_ruta_id', p_ruta_id::text, true);
  PERFORM set_config('app.current_rol', COALESCE(p_rol, ''), true);

  -- ── Llave de idempotencia ────────────────────────────────────────────
  -- Si la venta ya se creo (reintento por respuesta perdida, o la cola
  -- offline reenviando), devolvemos el resultado original sin duplicar.
  v_idem := NULLIF(p_loan->>'idempotency_key', '')::uuid;

  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
      SELECT resultado INTO v_resultado FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_resultado, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  v_fecha_manana := (now() at time zone 'America/Bogota')::date + 1;
  v_hoy          := (now() at time zone 'America/Bogota')::date;

  -- Ubicacion donde se hizo la venta (geocerca, script 033).
  v_latitud  := NULLIF(p_cliente->>'latitud', '')::numeric;
  v_longitud := NULLIF(p_cliente->>'longitud', '')::numeric;

  -- 2) Crear o actualizar Cliente
  --
  -- OJO: este INSERT enumera las columnas una por una. Cualquier campo que se
  -- agregue a p_cliente sin agregarlo aca se descarta EN SILENCIO.
  IF (p_cliente->>'is_new')::boolean = true THEN
    INSERT INTO public.clients (
      documento, nombre_completo, apodo, telefono, direccion, sector, cedula_image_url, ruta, tiene_prestamo_activo,
      latitud, longitud, ubicacion_capturada_at
    ) VALUES (
      p_cliente->>'documento', p_cliente->>'nombre_completo', p_cliente->>'apodo',
      p_cliente->>'telefono', p_cliente->>'direccion', p_cliente->>'sector',
      p_cliente->>'cedula_image_url', p_ruta_id, true,
      v_latitud, v_longitud,
      CASE WHEN v_latitud IS NOT NULL THEN NOW() END
    ) RETURNING id INTO v_client_id;
  ELSE
    v_client_id := (p_cliente->>'id')::uuid;
    -- Renovacion: se aprovecha para llenar la ubicacion si el cliente venia
    -- sin ella. Nunca se pisa una que ya existe.
    UPDATE public.clients
    SET tiene_prestamo_activo = true,
        latitud  = COALESCE(latitud, v_latitud),
        longitud = COALESCE(longitud, v_longitud),
        ubicacion_capturada_at = CASE
          WHEN latitud IS NULL AND v_latitud IS NOT NULL THEN NOW()
          ELSE ubicacion_capturada_at
        END,
        updated_at = NOW()
    WHERE id = v_client_id;
  END IF;

  -- 3) Crear Préstamo
  v_valor_a_pagar := (p_loan->>'valor_a_pagar')::numeric;

  INSERT INTO public.loans (
    client_id, valor, saldo, valor_a_pagar, valor_cuota, tasa_interes, numero_cuotas,
    tipo_amortizacion, frecuencia_pago, dia_semana, tipo_venta, prestamo_empleado,
    fecha_primer_pago, ruta, estado
  ) VALUES (
    v_client_id, (p_loan->>'valor')::numeric, (p_loan->>'saldo')::numeric,
    v_valor_a_pagar, (p_loan->>'valor_cuota')::numeric,
    (p_loan->>'tasa_interes')::numeric, (p_loan->>'numero_cuotas')::integer,
    p_loan->>'tipo_amortizacion', p_loan->>'frecuencia_pago',
    NULLIF(p_loan->>'dia_semana', ''), p_loan->>'tipo_venta',
    (p_loan->>'prestamo_empleado')::boolean,
    COALESCE(NULLIF(p_loan->>'fecha_primer_pago', '')::date, v_fecha_manana),
    p_ruta_id, 'activo'
  ) RETURNING id INTO v_loan_id;

  -- 4) Crear Plan de Pagos
  FOR v_cuota IN SELECT * FROM jsonb_array_elements(p_payment_plan)
  LOOP
    INSERT INTO public.payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo, estado, ruta
    ) VALUES (
      v_loan_id, (v_cuota->>'numero_cuota')::integer, (v_cuota->>'fecha_pago')::date,
      (v_cuota->>'valor_cuota')::numeric, (v_cuota->>'capital')::numeric,
      (v_cuota->>'interes')::numeric, (v_cuota->>'saldo')::numeric,
      v_cuota->>'estado', p_ruta_id
    );
  END LOOP;

  -- ── 5) Abono inicial ─────────────────────────────────────────────────
  v_abono := COALESCE(NULLIF(p_loan->>'abono_inicial', '')::numeric, 0);

  IF v_abono > 0 THEN
    -- No se puede abonar mas de lo que vale la venta. Si llega un monto
    -- mayor (dedazo al escribirlo) se topa, en vez de dejar el saldo en
    -- negativo y descuadrar el recaudo.
    IF v_abono > COALESCE(v_valor_a_pagar, 0) THEN
      v_abono := COALESCE(v_valor_a_pagar, 0);
    END IF;

    SELECT max(numero_cuota) INTO v_max_numero
      FROM payment_plan WHERE loan_id = v_loan_id;

    -- Fila EXTRA del dia de la venta. No toca las cuotas programadas.
    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes, saldo,
      estado, monto_pagado, fecha_pago_real, ruta, es_extra
    ) VALUES (
      v_loan_id, COALESCE(v_max_numero, 0) + 1, v_hoy, v_abono, v_abono, 0,
      GREATEST(0, COALESCE(v_valor_a_pagar, 0) - v_abono),
      'pagado', v_abono, NOW(), p_ruta_id, true
    );

    -- Saldo con la misma formula del script 037: total menos lo pagado.
    SELECT COALESCE(sum(monto_pagado), 0) INTO v_pagado
      FROM payment_plan WHERE loan_id = v_loan_id;
    v_saldo_nuevo := GREATEST(0, COALESCE(v_valor_a_pagar, 0) - v_pagado);

    UPDATE loans SET saldo = v_saldo_nuevo, updated_at = NOW() WHERE id = v_loan_id;
  END IF;

  v_resultado := jsonb_build_object(
    'ok', true,
    'loan_id', v_loan_id,
    'client_id', v_client_id,
    'abono_inicial_aplicado', COALESCE(v_abono, 0)
  );

  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;

  RETURN v_resultado;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.crear_venta_atomica(bigint, bigint, text, jsonb, jsonb, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- VERIFICACIÓN — ventas de ayer que quedaron sin su abono
-- ============================================================================
-- Solo lectura. Lista las ventas creadas ayer y cuánto se les ha recaudado.
-- Las que salgan con recaudado en 0 son candidatas a que les falte el abono
-- inicial que el cliente sí entregó. No hay forma de saber el monto: ese
-- dato nunca se guardó. Hay que confirmarlo con el cobrador y registrarlo
-- como un pago normal con la fecha correcta.
SELECT c.apodo,
       c.documento,
       l.valor,
       l.valor_a_pagar,
       COALESCE(sum(pp.monto_pagado), 0) AS recaudado,
       count(pp.id) FILTER (WHERE pp.estado <> 'pendiente') AS cuotas_gestionadas,
       (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date AS creada
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN payment_plan pp ON pp.loan_id = l.id
 WHERE (l.fecha_creacion AT TIME ZONE 'America/Bogota')::date
       >= (now() AT TIME ZONE 'America/Bogota')::date - 2
 GROUP BY c.apodo, c.documento, l.id, l.valor, l.valor_a_pagar, l.fecha_creacion
 ORDER BY l.fecha_creacion DESC;
