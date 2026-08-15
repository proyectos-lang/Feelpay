-- ============================================================================
-- 046 - Editor total de secretaría: cronograma y gestiones sin restricciones
-- ============================================================================
-- PARTE DE LA FASE 1. Correr en la ceremonia del corte (ver 049), tras el 045.
--
-- QUÉ TRAE
--   1) ajustar_cronograma()  crear / editar / eliminar cuotas una a una.
--      Cada cambio queda auditado como evento 'ajuste' con su before/after
--      y recalcula todo por la cascada (la plata se reasigna sola).
--   2) corregir_gestion()    "editar" o "anular" una gestión SIN tocarla:
--      se materializa como reversa + evento nuevo en una transacción.
--      El historial completo queda visible en la Auditoría 360.
--
-- Solo roles secretaria / secretario / admin / administrador.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) ajustar_cronograma ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ajustar_cronograma(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol     text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_loan_id   uuid;
  v_accion    text;
  v_cuota_id  uuid;
  v_idem      uuid;
  v_prev      jsonb;
  v_loan      record;
  v_pp        record;
  v_hoy       date;
  v_antes     jsonb;
  v_despues   jsonb;
  v_num       int;
  v_recalc    jsonb;
  v_resultado jsonb;
BEGIN
  IF lower(COALESCE(p_rol,'')) NOT IN ('secretaria','secretario','admin','administrador') THEN
    RAISE EXCEPTION 'Solo secretaría o admin puede ajustar el cronograma (rol: %)', p_rol;
  END IF;

  v_loan_id := NULLIF(p_payload->>'loan_id','')::uuid;
  v_accion  := p_payload->>'accion';
  IF v_loan_id IS NULL OR v_accion NOT IN ('crear','editar','eliminar') THEN
    RAISE EXCEPTION 'Payload inválido: se requiere loan_id y accion crear|editar|eliminar';
  END IF;

  v_idem := NULLIF(p_payload->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'ajuste_cronograma', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  SELECT id, client_id, ruta INTO v_loan FROM loans WHERE id = v_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El préstamo no existe';
  END IF;

  v_hoy := (now() AT TIME ZONE 'America/Bogota')::date;

  IF v_accion = 'crear' THEN
    IF NULLIF(p_payload->>'fecha_pago','') IS NULL
       OR NULLIF(p_payload->>'valor_cuota','') IS NULL THEN
      RAISE EXCEPTION 'Para crear una cuota se requiere fecha_pago y valor_cuota';
    END IF;
    IF (p_payload->>'valor_cuota')::numeric < 0 THEN
      RAISE EXCEPTION 'valor_cuota no puede ser negativo';
    END IF;
    SELECT COALESCE(MAX(numero_cuota), 0) + 1 INTO v_num
      FROM payment_plan WHERE loan_id = v_loan_id;
    v_num := COALESCE(NULLIF(p_payload->>'numero_cuota','')::int, v_num);

    INSERT INTO payment_plan (
      loan_id, numero_cuota, fecha_pago, valor_cuota, capital, interes,
      saldo, estado, ruta, es_extra
    ) VALUES (
      v_loan_id, v_num,
      (p_payload->>'fecha_pago')::date,
      (p_payload->>'valor_cuota')::numeric,
      COALESCE(NULLIF(p_payload->>'capital','')::numeric,
               (p_payload->>'valor_cuota')::numeric),
      COALESCE(NULLIF(p_payload->>'interes','')::numeric, 0),
      0, 'pendiente', COALESCE(v_loan.ruta, p_ruta_id),
      COALESCE((p_payload->>'es_extra')::boolean, true)
    ) RETURNING id INTO v_cuota_id;

    v_despues := jsonb_build_object('cuota_id', v_cuota_id,
      'numero_cuota', v_num, 'fecha_pago', p_payload->>'fecha_pago',
      'valor_cuota', p_payload->>'valor_cuota');
    v_antes := NULL;

  ELSE
    v_cuota_id := NULLIF(p_payload->>'cuota_id','')::uuid;
    IF v_cuota_id IS NULL THEN
      RAISE EXCEPTION 'Falta cuota_id';
    END IF;
    SELECT * INTO v_pp FROM payment_plan
     WHERE id = v_cuota_id AND loan_id = v_loan_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La cuota no existe en este préstamo';
    END IF;
    v_antes := jsonb_build_object('cuota_id', v_pp.id,
      'numero_cuota', v_pp.numero_cuota, 'fecha_pago', v_pp.fecha_pago,
      'valor_cuota', v_pp.valor_cuota, 'capital', v_pp.capital,
      'interes', v_pp.interes, 'es_extra', v_pp.es_extra);

    IF v_accion = 'eliminar' THEN
      DELETE FROM payment_plan WHERE id = v_cuota_id;
      v_despues := NULL;
    ELSE  -- editar
      IF NULLIF(p_payload->>'valor_cuota','') IS NOT NULL
         AND (p_payload->>'valor_cuota')::numeric < 0 THEN
        RAISE EXCEPTION 'valor_cuota no puede ser negativo';
      END IF;
      UPDATE payment_plan
         SET numero_cuota = COALESCE(NULLIF(p_payload->>'numero_cuota','')::int, numero_cuota),
             fecha_pago   = COALESCE(NULLIF(p_payload->>'fecha_pago','')::date, fecha_pago),
             valor_cuota  = COALESCE(NULLIF(p_payload->>'valor_cuota','')::numeric, valor_cuota),
             capital      = COALESCE(NULLIF(p_payload->>'capital','')::numeric, capital),
             interes      = COALESCE(NULLIF(p_payload->>'interes','')::numeric, interes),
             updated_at   = NOW()
       WHERE id = v_cuota_id;
      SELECT jsonb_build_object('cuota_id', id, 'numero_cuota', numero_cuota,
               'fecha_pago', fecha_pago, 'valor_cuota', valor_cuota,
               'capital', capital, 'interes', interes)
        INTO v_despues
        FROM payment_plan WHERE id = v_cuota_id;
    END IF;
  END IF;

  INSERT INTO gestiones (
    id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
    monto, origen, observacion, detalle
  ) VALUES (
    gen_random_uuid(), v_loan_id, v_loan.client_id,
    COALESCE(v_loan.ruta, p_ruta_id), p_user_id,
    'ajuste', 'aplicada', v_hoy, 0, 'ajuste',
    'Cronograma: ' || v_accion || ' cuota',
    jsonb_build_object('accion', v_accion, 'antes', v_antes, 'despues', v_despues)
  );

  v_recalc := public.recalcular_prestamo(v_loan_id);

  v_resultado := jsonb_build_object(
    'ok', true, 'accion', v_accion, 'cuota_id', v_cuota_id,
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'loan_estado_final', v_recalc->>'loan_estado_final',
    'cuotas_totales', (v_recalc->>'cuotas_totales')::int
  );
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 2) corregir_gestion ──────────────────────────────────────────────
-- "Editar" una gestión = reversa del evento original + evento nuevo con los
-- valores corregidos. "Anular" = solo la reversa. El original nunca se toca.
CREATE OR REPLACE FUNCTION public.corregir_gestion(
  p_user_id bigint,
  p_ruta_id bigint,
  p_rol     text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_gestion_id  uuid;
  v_accion      text;
  v_idem        uuid;
  v_prev        jsonb;
  v_ref         record;
  v_loan        record;
  v_hoy         date;
  v_motivo      text;
  v_monto_nuevo numeric;
  v_fecha_nueva date;
  v_reversa_id  uuid;
  v_nueva_id    uuid;
  v_recalc      jsonb;
  v_resultado   jsonb;
BEGIN
  IF lower(COALESCE(p_rol,'')) NOT IN ('secretaria','secretario','admin','administrador') THEN
    RAISE EXCEPTION 'Solo secretaría o admin puede corregir gestiones (rol: %)', p_rol;
  END IF;

  v_gestion_id := NULLIF(p_payload->>'gestion_id','')::uuid;
  v_accion     := p_payload->>'accion';
  v_motivo     := NULLIF(p_payload->>'motivo','');
  IF v_gestion_id IS NULL OR v_accion NOT IN ('anular','editar') THEN
    RAISE EXCEPTION 'Payload inválido: se requiere gestion_id y accion anular|editar';
  END IF;

  v_idem := NULLIF(p_payload->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'corregir_gestion', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  SELECT * INTO v_ref FROM gestiones WHERE id = v_gestion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La gestión no existe';
  END IF;
  IF v_ref.estado <> 'aplicada' THEN
    RAISE EXCEPTION 'Solo se corrigen gestiones aplicadas (esta está %)', v_ref.estado;
  END IF;
  IF v_ref.tipo NOT IN ('pago','no_pago','cancelacion','abono_venta') THEN
    RAISE EXCEPTION 'Las gestiones de tipo % no se corrigen por aquí', v_ref.tipo;
  END IF;
  IF EXISTS (SELECT 1 FROM gestiones r
              WHERE r.referencia_gestion_id = v_gestion_id
                AND r.tipo = 'reversa' AND r.estado = 'aplicada') THEN
    RAISE EXCEPTION 'Esa gestión ya fue reversada';
  END IF;

  SELECT id, client_id, ruta INTO v_loan
    FROM loans WHERE id = v_ref.loan_id FOR UPDATE;

  v_hoy := (now() AT TIME ZONE 'America/Bogota')::date;
  v_monto_nuevo := NULLIF(p_payload->>'monto','')::numeric;
  v_fecha_nueva := NULLIF(p_payload->>'fecha_gestion','')::date;
  IF v_fecha_nueva IS NOT NULL AND v_fecha_nueva > v_hoy THEN
    RAISE EXCEPTION 'La fecha corregida no puede ser futura';
  END IF;
  IF v_monto_nuevo IS NOT NULL AND v_monto_nuevo < 0 THEN
    RAISE EXCEPTION 'El monto corregido no puede ser negativo';
  END IF;

  -- 1) Reversa del original (anula su monto completo)
  v_reversa_id := gen_random_uuid();
  INSERT INTO gestiones (
    id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
    monto, referencia_gestion_id, origen, observacion, detalle
  ) VALUES (
    v_reversa_id, v_ref.loan_id, v_ref.client_id, v_ref.ruta, p_user_id,
    'reversa', 'aplicada', v_hoy, v_ref.monto, v_gestion_id, 'ajuste',
    COALESCE(v_motivo, 'Corrección de secretaría'),
    jsonb_build_object('accion', v_accion)
  );

  -- 2) Si es edición, el evento corregido
  IF v_accion = 'editar' THEN
    v_nueva_id := gen_random_uuid();
    INSERT INTO gestiones (
      id, loan_id, client_id, ruta, user_id, tipo, estado, fecha_gestion,
      monto, cuota_objetivo, metodo_pago, origen, observacion, detalle
    ) VALUES (
      v_nueva_id, v_ref.loan_id, v_ref.client_id, v_ref.ruta, p_user_id,
      v_ref.tipo, 'aplicada',
      COALESCE(v_fecha_nueva, v_ref.fecha_gestion),
      CASE WHEN v_ref.tipo = 'no_pago' THEN 0
           ELSE COALESCE(v_monto_nuevo, v_ref.monto) END,
      v_ref.cuota_objetivo, v_ref.metodo_pago, 'ajuste',
      COALESCE(v_motivo, 'Corrección de secretaría'),
      jsonb_build_object('corrige', v_gestion_id, 'reversa', v_reversa_id)
    );
  END IF;

  v_recalc := public.recalcular_prestamo(v_ref.loan_id);

  v_resultado := jsonb_build_object(
    'ok', true, 'accion', v_accion,
    'reversa_id', v_reversa_id, 'nueva_gestion_id', v_nueva_id,
    'nuevo_saldo', (v_recalc->>'nuevo_saldo')::numeric,
    'loan_estado_final', v_recalc->>'loan_estado_final'
  );
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
SELECT p.proname AS funcion, pg_get_function_identity_arguments(p.oid) AS argumentos
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('ajustar_cronograma','corregir_gestion')
 ORDER BY p.proname;
