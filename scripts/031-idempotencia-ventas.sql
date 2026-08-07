-- ============================================================================
-- 031 - Idempotencia en la creacion de ventas
-- ============================================================================
-- FASE 2 del modo offline: permite encolar ventas hechas sin conexion.
--
-- PROBLEMA
-- crear_venta_atomica no tenia forma de reconocer un reenvio. Si la venta
-- llegaba al servidor y se guardaba pero la respuesta se perdia por mala
-- senal, el reintento creaba un prestamo DUPLICADO con su plan de pagos
-- completo. Con una cola offline esto pasaria de riesgo ocasional a
-- frecuente.
--
-- SOLUCION
-- Mismo mecanismo que ya usa registrar_pago_atomico (script 030): una llave
-- generada en el dispositivo al CAPTURAR la venta. Si la operacion ya se
-- proceso, se devuelve el resultado original (con el loan_id real) sin crear
-- nada nuevo.
--
-- La llave viaja dentro de p_loan como `idempotency_key` para no cambiar la
-- firma de la funcion — hay callers existentes (aprobar_solicitud_revision)
-- que la invocan con los 6 parametros actuales.
--
-- Compatibilidad: si la llave no viene, el comportamiento es el de siempre.
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

  -- Fecha de manana en zona Colombia (solo se usa como respaldo; la fecha
  -- real del primer pago viene en p_loan.fecha_primer_pago, calculada en el
  -- dispositivo al momento de pactar la venta con el cliente).
  v_fecha_manana := (now() at time zone 'America/Bogota')::date + 1;

  -- 2) Crear o actualizar Cliente
  IF (p_cliente->>'is_new')::boolean = true THEN
    INSERT INTO public.clients (
      documento, nombre_completo, apodo, telefono, direccion, sector, cedula_image_url, ruta, tiene_prestamo_activo
    ) VALUES (
      p_cliente->>'documento', p_cliente->>'nombre_completo', p_cliente->>'apodo',
      p_cliente->>'telefono', p_cliente->>'direccion', p_cliente->>'sector',
      p_cliente->>'cedula_image_url', p_ruta_id, true
    ) RETURNING id INTO v_client_id;
  ELSE
    v_client_id := (p_cliente->>'id')::uuid;
    UPDATE public.clients
    SET tiene_prestamo_activo = true, updated_at = NOW()
    WHERE id = v_client_id;
  END IF;

  -- 3) Crear Préstamo
  --
  -- fecha_primer_pago: se respeta la que trae el payload (la pactada con el
  -- cliente al hacer la venta). Antes se forzaba SIEMPRE a manana, lo que
  -- para una venta sincronizada un dia despues movia el cronograma respecto
  -- de lo acordado. Si no viene, se cae al comportamiento anterior.
  INSERT INTO public.loans (
    client_id, valor, saldo, valor_a_pagar, valor_cuota, tasa_interes, numero_cuotas,
    tipo_amortizacion, frecuencia_pago, dia_semana, tipo_venta, prestamo_empleado,
    fecha_primer_pago, ruta, estado
  ) VALUES (
    v_client_id, (p_loan->>'valor')::numeric, (p_loan->>'saldo')::numeric,
    (p_loan->>'valor_a_pagar')::numeric, (p_loan->>'valor_cuota')::numeric,
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

  v_resultado := jsonb_build_object('ok', true, 'loan_id', v_loan_id, 'client_id', v_client_id);

  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;

  RETURN v_resultado;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.crear_venta_atomica(bigint, bigint, text, jsonb, jsonb, jsonb) TO authenticated;
