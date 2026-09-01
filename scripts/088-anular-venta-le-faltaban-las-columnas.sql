-- ============================================================================
-- 088 - Anular una venta: le faltaban las columnas
-- ============================================================================
-- EL SÍNTOMA
-- Desde Control Total, al anular una venta:
--
--   column anulada_at of relation loans does not exist
--
-- LO QUE SE COMPROBÓ CONTRA LA BASE
-- `loans` tiene 22 columnas y NINGUNA de las cuatro que la anulación necesita:
--
--   anulada_at · anulada_por · anulada_por_nombre · motivo_anulacion
--
-- El script 068 las creaba en su PASO 1, pero ese paso nunca corrió: sí
-- corrieron los que crean la función, así que `anular_venta` existe y se puede
-- llamar — falla al llegar al UPDATE, que es exactamente lo que se ve.
--
-- Es coherente con la otra cosa que se midió en su momento: `loans.estado`
-- solo tiene 'activo' y 'cancelado'. Nunca se anuló una venta en producción
-- porque nunca se pudo.
--
-- QUÉ HACE ESTE SCRIPT
--   1. Crea las cuatro columnas y su índice — el PASO 1 y 2 del 068.
--   2. Reinstala `anular_venta` con la versión del script 069, que es la
--      última que la define en el repositorio.
--
-- El (2) va por si acaso y no cuesta nada: la función de la base no se puede
-- leer desde la app, así que no hay forma de comprobar desde acá que sea la
-- misma del repositorio. Reinstalarla deja las dos iguales sin ambigüedad. El
-- texto se copió del 069 tal cual, sin retocar una letra.
--
-- NO MUEVE UN PESO. Agrega columnas vacías y reinstala una función. Ningún
-- crédito cambia de estado, ni de saldo, ni de cuotas.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) Las cuatro columnas que faltaban ──────────────────────────────
-- `IF NOT EXISTS` en las cuatro: si alguna llegara a existir, no estorba.
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS anulada_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anulada_por        BIGINT,
  ADD COLUMN IF NOT EXISTS anulada_por_nombre TEXT,
  ADD COLUMN IF NOT EXISTS motivo_anulacion   TEXT;


-- ── PASO 2) Buscar las anuladas sin recorrer toda la tabla ────────────────
-- Índice PARCIAL: solo indexa las anuladas, que van a ser pocas. Un índice
-- sobre toda la tabla costaría escritura en cada pago para responder una
-- consulta que casi nadie hace.
CREATE INDEX IF NOT EXISTS idx_loans_estado_anulado
  ON public.loans (ruta, anulada_at DESC) WHERE estado = 'anulado';


-- ── PASO 3) Que las columnas quedaron (SOLO LECTURA) ──────────────────────
-- Tienen que salir las cuatro. Si falta alguna, no sigas.
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'loans'
   AND column_name IN ('anulada_at', 'anulada_por', 'anulada_por_nombre', 'motivo_anulacion')
 ORDER BY column_name;


-- ── PASO 4) `anular_venta`, la del script 069 ─────────────────────────────
-- Copiada del 069 letra por letra. Es la última versión del repositorio.
CREATE OR REPLACE FUNCTION public.anular_venta(
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
  v_idem      uuid;
  v_prev      jsonb;
  v_motivo    text;
  v_nombre    text;
  v_loan      record;
  v_pagado    numeric;
  v_gestiones int;
  v_resultado jsonb;
BEGIN
  -- Solo secretaría y admin. Anular una venta borra un crédito de la cartera:
  -- no es una operación de campo.
  IF lower(COALESCE(p_rol,'')) NOT IN ('secretaria','secretario','admin','administrador') THEN
    RAISE EXCEPTION 'Solo secretaría o admin puede anular una venta (rol: %)', p_rol;
  END IF;

  v_loan_id := NULLIF(p_payload->>'loan_id','')::uuid;
  IF v_loan_id IS NULL THEN
    RAISE EXCEPTION 'Falta loan_id';
  END IF;

  v_motivo := NULLIF(trim(p_payload->>'motivo'), '');
  IF v_motivo IS NULL THEN
    RAISE EXCEPTION 'Hay que decir por qué se anula la venta';
  END IF;

  -- Idempotencia: si el botón se toca dos veces o el reintento de la cola
  -- vuelve a llegar, la segunda no hace nada y devuelve lo mismo.
  v_idem := NULLIF(p_payload->>'idempotency_key','')::uuid;
  IF v_idem IS NOT NULL THEN
    INSERT INTO operaciones_procesadas (id, tipo, user_id, ruta_id)
    VALUES (v_idem, 'anular_venta', p_user_id, p_ruta_id)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT resultado INTO v_prev FROM operaciones_procesadas WHERE id = v_idem;
      RETURN COALESCE(v_prev, '{"ok":true}'::jsonb) || jsonb_build_object('duplicado', true);
    END IF;
  END IF;

  SELECT id, estado, client_id, ruta, valor, valor_a_pagar, saldo
    INTO v_loan
    FROM loans WHERE id = v_loan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La venta no existe';
  END IF;
  IF v_loan.estado = 'anulado' THEN
    RETURN jsonb_build_object('ok', true, 'ya_estaba_anulada', true);
  END IF;

  -- Cuánta plata movió: NO se toca, pero se deja escrito en el rastro para
  -- que quien mire después sepa qué quedó colgado en las cajas de esos días.
  SELECT COALESCE(pagado_neto, 0) INTO v_pagado
    FROM v_pagos_netos WHERE loan_id = v_loan_id;
  v_pagado := COALESCE(v_pagado, 0);
  SELECT COUNT(*) INTO v_gestiones FROM gestiones WHERE loan_id = v_loan_id;

  SELECT nombre INTO v_nombre FROM usuarios WHERE id = p_user_id;

  UPDATE loans
     SET estado             = 'anulado',
         anulada_at         = NOW(),
         anulada_por        = p_user_id,
         anulada_por_nombre = v_nombre,
         motivo_anulacion   = v_motivo,
         updated_at         = NOW()
   WHERE id = v_loan_id;

  -- El evento queda en el libro, como cualquier otra cosa que le pasa a un
  -- préstamo. Monto CERO: anular no mueve plata, y ponerle el saldo lo haría
  -- aparecer como un movimiento en los informes del día.
  INSERT INTO gestiones (id, loan_id, client_id, ruta, user_id, tipo, estado,
    fecha_gestion, monto, origen, observacion, detalle)
  VALUES (gen_random_uuid(), v_loan_id, v_loan.client_id,
    COALESCE(v_loan.ruta, p_ruta_id), p_user_id,
    'ajuste', 'aplicada', (now() AT TIME ZONE 'America/Bogota')::date, 0,
    'ajuste', 'Venta anulada desde Control Total: ' || v_motivo,
    jsonb_build_object('clase', 'anulacion_venta',
                       'pagado_neto_al_anular', v_pagado,
                       'gestiones_del_prestamo', v_gestiones,
                       'saldo_al_anular', v_loan.saldo));

  -- La bandera del cliente se recalcula sola: `recalcular_prestamo` la deduce
  -- de si le queda algún crédito 'activo', y este ya no lo está. Y con el
  -- PASO 3 puesto, el recálculo respeta el 'anulado' en vez de revivirlo.
  PERFORM public.recalcular_prestamo(v_loan_id);

  -- Una multa pendiente de un crédito anulado no se puede cobrar nunca.
  UPDATE multas
     SET estado = 'cancelada',
         cancelada_at = NOW(),
         cancelada_por = p_user_id,
         cancelada_por_nombre = COALESCE(v_nombre, 'Sistema'),
         motivo_cancelacion = 'La venta fue anulada'
   WHERE loan_id = v_loan_id AND estado = 'pendiente';

  v_resultado := jsonb_build_object(
    'ok', true,
    'loan_id', v_loan_id,
    'pagado_neto', v_pagado,
    'gestiones', v_gestiones,
    'mensaje', 'La venta quedó anulada. Los pagos que ya se habían recibido '
               || 'siguen contando en los días en que entraron.');
  IF v_idem IS NOT NULL THEN
    UPDATE operaciones_procesadas SET resultado = v_resultado WHERE id = v_idem;
  END IF;
  RETURN v_resultado;
END;
$$;


-- ── PASO 5) Ejecución para la app ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.anular_venta(bigint, bigint, text, jsonb) TO anon, authenticated;


-- ── PASO 6) Que la función quedó bien escrita (SOLO LECTURA) ──────────────
-- `escribe_las_columnas` = true. `tiene_el_error_viejo` = false: busca la
-- transposición que aparecía en el mensaje de error, por si la versión que
-- estaba instalada la tenía de verdad.
SELECT strpos(pg_get_functiondef(p.oid), 'anulada_at')         > 0 AS escribe_las_columnas,
       strpos(pg_get_functiondef(p.oid), 'anualda_at')         > 0 AS tiene_el_error_viejo,
       strpos(pg_get_functiondef(p.oid), 'motivo_anulacion')   > 0 AS escribe_el_motivo
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'anular_venta';


-- ── PASO 7) Ninguna venta cambió de estado (SOLO LECTURA) ─────────────────
-- Este script no anula nada. `anulado` debe seguir en 0 hasta que alguien
-- anule una venta a mano desde Control Total.
SELECT estado, COUNT(*) AS cuantas
  FROM public.loans
 GROUP BY estado
 ORDER BY cuantas DESC;


-- ── PASO 8) ¿Y el resto del 068 sí corrió? (SOLO LECTURA) ─────────────────
-- El PASO 1 del 068 no corrió, así que hay que dudar de los demás. Este mira
-- si las piezas que sacan a las anuladas de la cartera están puestas:
--
--   recalcular_no_revive  → `recalcular_prestamo` respeta el estado 'anulado'
--                           en vez de devolver el crédito a 'activo'.
--   monitoreo_las_excluye → la cartera del monitoreo no cuenta las anuladas.
--
-- Las dos tienen que dar TRUE. Si `monitoreo_las_excluye` sale false, una
-- venta anulada seguiría apareciéndole al admin como cartera viva — hoy no se
-- nota porque no hay ninguna anulada, y se notaría el día que la haya.
SELECT
  (SELECT strpos(pg_get_functiondef(p.oid), 'anulado') > 0
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'recalcular_prestamo')  AS recalcular_no_revive,
  (SELECT strpos(pg_get_viewdef('public.vista_monitoreo_admin'::regclass), 'anulado') > 0)
                                                                       AS monitoreo_las_excluye;
