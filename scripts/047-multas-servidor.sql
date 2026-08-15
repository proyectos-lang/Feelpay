-- ============================================================================
-- 047 - Multas generadas en el servidor
-- ============================================================================
-- PARTE DE LA FASE 1. Correr en la ceremonia del corte (ver 049), tras el 046.
--
-- ANTES: las multas se generaban DESDE EL NAVEGADOR al abrir el módulo de
-- pagos — un INSERT en el camino de lectura, por cada dispositivo, con el
-- índice único parcial como única protección, y con un bug: si la primera
-- cuota vencida era una fila sintética de valor 0, la multa salía en 0 y se
-- descartaba en silencio.
--
-- AHORA:
--   evaluar_multa_prestamo(loan)  evalúa y genera la multa de UN préstamo.
--     La llama registrar_gestion después de cada no pago (hook del 044).
--   generar_multas_ruta(ruta)     barre todos los préstamos activos de la
--     ruta. La app la llama al abrir el módulo de pagos (una sola RPC en
--     lugar de N inserts del navegador).
--
-- QUÉ ES UNA FALLA (misma regla de negocio de siempre, sobre el modelo nuevo):
--   · un evento no_pago aplicado (no reversado), o
--   · una cuota del cronograma vencida y sin cubrir,
--   contadas DESPUÉS de la última multa del préstamo (cualquier estado).
-- Si fallas >= multa_cuotas_umbral y la ruta tiene multas habilitadas →
-- se genera una multa 'pendiente' (valor fijo o N × cuota de referencia).
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) evaluar_multa_prestamo ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.evaluar_multa_prestamo(p_loan_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_loan     record;
  v_cfg      record;
  v_hoy      date;
  v_corte    date;
  v_fallas   int;
  v_valor    numeric;
  v_ref      numeric;
  v_nombre   text;
BEGIN
  SELECT id, client_id, ruta, estado INTO v_loan
    FROM loans WHERE id = p_loan_id;
  IF NOT FOUND OR v_loan.estado <> 'activo' OR v_loan.ruta IS NULL THEN
    RETURN false;
  END IF;

  SELECT multa_habilitada, multa_cuotas_umbral, multa_tipo_valor,
         multa_valor, multa_cantidad_cuotas
    INTO v_cfg
    FROM ruta_config_umbrales WHERE ruta_id = v_loan.ruta;
  IF NOT FOUND OR NOT COALESCE(v_cfg.multa_habilitada, false)
     OR v_cfg.multa_cuotas_umbral IS NULL OR v_cfg.multa_cuotas_umbral < 1 THEN
    RETURN false;
  END IF;

  -- Ya hay una multa pendiente: no se apilan
  IF EXISTS (SELECT 1 FROM multas WHERE loan_id = p_loan_id AND estado = 'pendiente') THEN
    RETURN false;
  END IF;

  v_hoy := (now() AT TIME ZONE 'America/Bogota')::date;

  -- Corte: la última multa del préstamo (cualquier estado)
  SELECT MAX((created_at AT TIME ZONE 'America/Bogota')::date) INTO v_corte
    FROM multas WHERE loan_id = p_loan_id;

  SELECT
    (SELECT COUNT(*) FROM gestiones g
      WHERE g.loan_id = p_loan_id AND g.tipo = 'no_pago' AND g.estado = 'aplicada'
        AND (v_corte IS NULL OR g.fecha_gestion > v_corte)
        AND NOT EXISTS (SELECT 1 FROM gestiones r
                         WHERE r.referencia_gestion_id = g.id
                           AND r.tipo = 'reversa' AND r.estado = 'aplicada'))
    +
    (SELECT COUNT(*) FROM payment_plan pp
      WHERE pp.loan_id = p_loan_id AND pp.estado = 'pendiente'
        AND pp.fecha_pago < v_hoy
        AND (v_corte IS NULL OR pp.fecha_pago > v_corte))
    INTO v_fallas;

  IF v_fallas < v_cfg.multa_cuotas_umbral THEN
    RETURN false;
  END IF;

  -- Valor de la multa: fijo, o N × cuota de referencia del plan BASE
  IF COALESCE(v_cfg.multa_tipo_valor, 'fijo') = 'cuotas' THEN
    SELECT COALESCE(MAX(valor_cuota) FILTER (WHERE NOT es_extra), MAX(valor_cuota))
      INTO v_ref FROM payment_plan WHERE loan_id = p_loan_id;
    v_valor := round(COALESCE(v_cfg.multa_cantidad_cuotas, 0) * COALESCE(v_ref, 0), 2);
  ELSE
    v_valor := v_cfg.multa_valor;
  END IF;
  IF COALESCE(v_valor, 0) <= 0 THEN
    RETURN false;
  END IF;

  SELECT COALESCE(NULLIF(apodo, ''), nombre_completo) INTO v_nombre
    FROM clients WHERE id = v_loan.client_id;

  BEGIN
    INSERT INTO multas (loan_id, client_id, ruta_id, cliente_nombre, valor,
                        cuotas_mora, estado)
    VALUES (p_loan_id, v_loan.client_id, v_loan.ruta, v_nombre, v_valor,
            v_fallas, 'pendiente');
  EXCEPTION WHEN unique_violation THEN
    RETURN false;  -- otra sesión la generó en paralelo: perfecto
  END;

  RETURN true;
END;
$$;


-- ── PASO 2) generar_multas_ruta ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generar_multas_ruta(p_ruta_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_habilitada boolean;
  v_loan       record;
  v_generadas  int := 0;
BEGIN
  SELECT COALESCE(multa_habilitada, false) INTO v_habilitada
    FROM ruta_config_umbrales WHERE ruta_id = p_ruta_id;
  IF NOT FOUND OR NOT v_habilitada THEN
    RETURN jsonb_build_object('ok', true, 'habilitada', false, 'generadas', 0);
  END IF;

  FOR v_loan IN
    SELECT id FROM loans WHERE ruta = p_ruta_id AND estado = 'activo'
  LOOP
    IF public.evaluar_multa_prestamo(v_loan.id) THEN
      v_generadas := v_generadas + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'habilitada', true, 'generadas', v_generadas);
END;
$$;


-- ── PASO 3) Verificar ─────────────────────────────────────────────────────
SELECT p.proname AS funcion, pg_get_function_identity_arguments(p.oid) AS argumentos
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('evaluar_multa_prestamo','generar_multas_ruta')
 ORDER BY p.proname;
