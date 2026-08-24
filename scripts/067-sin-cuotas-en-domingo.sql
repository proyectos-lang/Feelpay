-- ============================================================================
-- 067 - Ninguna cuota cae en domingo
-- ============================================================================
-- QUE SE PIDIO
-- "Que los domingos no se programen fechas de pago."
--
-- COMO ESTABA
-- Solo la frecuencia DIARIA saltaba los domingos. Las demas no:
--
--   · Un credito SEMANAL con dia de cobro "domingo" dejaba TODAS sus cuotas
--     en domingo.
--   · Uno semanal, QUINCENAL o MENSUAL que arrancara un domingo, tambien:
--     avanza de 7, 15 o 30 dias y 7 es multiplo de la semana, asi que si la
--     primera cae en domingo caen todas.
--   · Y con paso de 15 o 30 dias, algunas cuotas sueltas aterrizan en domingo
--     aunque la primera no lo haga.
--
-- Esas cuotas nacian vencidas: nadie sale a la ruta ese dia, asi que el
-- cliente aparecia en mora sin haber fallado nunca.
--
-- LO QUE HACE
--   1. La fecha de inicio nunca es domingo, en NINGUNA frecuencia (antes solo
--      se corregia en la diaria).
--   2. El dia de cobro semanal "domingo" se manda a lunes.
--   3. Cualquier cuota que aterrice en domingo se corre al lunes, SIN mover
--      las siguientes: si se corrieran, el credito se alargaria un dia por
--      cada domingo que toque y las cuotas se irian desfasando.
--
-- LOS CREDITOS YA CREADOS NO SE TOCAN. Sus cronogramas estan pactados con el
-- cliente; moverlos cambiaria fechas de vencimiento y mora hacia atras. El
-- paso 4 muestra cuantos hay, por si se quiere corregir alguno a mano desde
-- Control de Pagos.
--
-- El espejo del cliente (`lib/loan-schedule.ts`), que dibuja la vista previa
-- en Nueva Venta, se cambio igual: si no, el vendedor veria una fecha y se
-- guardaria otra.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) generar_cronograma sin domingos ───────────────────────────────
CREATE OR REPLACE FUNCTION public.generar_cronograma(
  p_valor             numeric,
  p_tasa              numeric,
  p_num_cuotas        int,
  p_tipo_amortizacion text,
  p_frecuencia        text,
  p_empleado          boolean,
  p_fecha_inicio      date,
  p_dia_semana        text
)
RETURNS TABLE (numero_cuota int, fecha_pago date, valor_cuota numeric,
               capital numeric, interes numeric)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_tasa_dec numeric;
  v_tipo     text;
  v_freq     text;
  v_inicio   date;
  v_pos      int;
  v_target   int;
  v_paso     int;
  v_total    numeric;
  v_int      numeric;
  v_cuota_b  numeric;
  v_cap_b    numeric;
  v_i        int;
BEGIN
  IF p_valor IS NULL OR p_valor <= 0 THEN
    RAISE EXCEPTION 'El valor del préstamo debe ser mayor que cero';
  END IF;
  IF p_num_cuotas IS NULL OR p_num_cuotas < 1 THEN
    RAISE EXCEPTION 'El número de cuotas debe ser al menos 1';
  END IF;
  IF p_fecha_inicio IS NULL THEN
    RAISE EXCEPTION 'Falta la fecha del primer pago';
  END IF;

  v_tasa_dec := COALESCE(p_tasa, 0) / 100.0;
  v_tipo := CASE WHEN COALESCE(p_empleado, false) THEN 'empleado'
                 ELSE lower(COALESCE(p_tipo_amortizacion, 'aleman')) END;
  v_freq := CASE WHEN COALESCE(p_empleado, false) THEN 'daily'
                 ELSE lower(COALESCE(p_frecuencia, 'daily')) END;

  -- Fecha de inicio ajustada
  -- NINGUNA cuota puede caer en domingo, en ninguna frecuencia.
  --
  -- Antes esto solo miraba la frecuencia diaria. Un credito semanal,
  -- quincenal o mensual que arrancara un domingo dejaba TODAS sus cuotas en
  -- domingo — un dia en que nadie sale a la ruta, asi que nacian vencidas y
  -- el cliente aparecia en mora sin haber fallado nunca.
  v_inicio := p_fecha_inicio;
  IF EXTRACT(dow FROM v_inicio) = 0 THEN
    v_inicio := v_inicio + 1;  -- domingo -> lunes
  END IF;
  IF v_freq IN ('weekly','semanal') AND p_dia_semana IS NOT NULL THEN
    -- 'domingo' se manda a lunes: no se cobra los domingos, asi que un
    -- credito semanal fechado en domingo dejaba TODAS sus cuotas en un dia
    -- en que nadie sale a la ruta.
    v_target := CASE lower(p_dia_semana)
      WHEN 'domingo' THEN 1 WHEN 'lunes' THEN 1 WHEN 'martes' THEN 2
      WHEN 'miercoles' THEN 3 WHEN 'miércoles' THEN 3 WHEN 'jueves' THEN 4
      WHEN 'viernes' THEN 5 WHEN 'sabado' THEN 6 WHEN 'sábado' THEN 6
      ELSE NULL END;
    IF v_target IS NOT NULL THEN
      v_inicio := v_inicio
        + ((v_target - EXTRACT(dow FROM v_inicio)::int) % 7 + 7) % 7;
    END IF;
  END IF;

  v_paso := CASE v_freq
    WHEN 'weekly' THEN 7 WHEN 'semanal' THEN 7
    WHEN 'biweekly' THEN 15 WHEN 'quincenal' THEN 15
    WHEN 'monthly' THEN 30 WHEN 'mensual' THEN 30
    ELSE 1 END;

  -- Totales por tipo
  IF v_tipo = 'empleado' THEN
    v_total   := p_valor;
    v_cap_b   := round(p_valor / p_num_cuotas, 2);
  ELSIF v_tipo = 'americano' THEN
    v_int     := round(p_valor * v_tasa_dec, 2);
    v_total   := p_valor + v_int * p_num_cuotas;
  ELSE  -- aleman
    v_total   := round(p_valor * (1 + v_tasa_dec), 2);
    v_cuota_b := round(v_total / p_num_cuotas, 2);
    v_cap_b   := round(p_valor / p_num_cuotas, 2);
  END IF;

  v_pos := (EXTRACT(dow FROM v_inicio)::int + 6) % 7;  -- lunes=0 ... domingo=6

  FOR v_i IN 1..p_num_cuotas LOOP
    numero_cuota := v_i;

    IF v_paso = 1 THEN
      -- i-ésimo día de cobro saltando domingos de corrido (semana lun-sáb)
      fecha_pago := v_inicio + (v_i - 1) + ((v_pos + v_i - 1) / 6);
    ELSE
      fecha_pago := v_inicio + v_paso * (v_i - 1);
      -- La diaria ya saltea domingos por construccion. Las demas avanzan de
      -- 7, 15 o 30 dias, y ahi si pueden aterrizar en domingo: la cuota se
      -- corre al lunes SIN mover las siguientes, para que el credito no se
      -- vaya alargando de a un dia por cada domingo que toque.
      IF EXTRACT(dow FROM fecha_pago) = 0 THEN
        fecha_pago := fecha_pago + 1;
      END IF;
    END IF;

    IF v_tipo = 'empleado' THEN
      capital := CASE WHEN v_i = p_num_cuotas
                      THEN p_valor - v_cap_b * (p_num_cuotas - 1)
                      ELSE v_cap_b END;
      interes := 0;
      valor_cuota := capital;
    ELSIF v_tipo = 'americano' THEN
      IF v_i < p_num_cuotas THEN
        valor_cuota := v_int; capital := 0; interes := v_int;
      ELSE
        valor_cuota := p_valor + v_int; capital := p_valor; interes := v_int;
      END IF;
    ELSE  -- aleman
      valor_cuota := CASE WHEN v_i = p_num_cuotas
                          THEN v_total - v_cuota_b * (p_num_cuotas - 1)
                          ELSE v_cuota_b END;
      capital := CASE WHEN v_i = p_num_cuotas
                      THEN p_valor - v_cap_b * (p_num_cuotas - 1)
                      ELSE v_cap_b END;
      interes := valor_cuota - capital;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;


-- ── PASO 2) Comprobar con datos, sin escribir nada ────────────────────────
-- Un credito semanal que arranca DOMINGO. Ninguna fecha debe dar domingo.
SELECT numero_cuota, fecha_pago, to_char(fecha_pago, 'Day') AS dia
  FROM public.generar_cronograma(100000, 20, 8, 'aleman', 'weekly', false,
                                 DATE '2026-08-23', 'domingo');


-- ── PASO 3) Lo mismo en quincenal y mensual ───────────────────────────────
SELECT 'quincenal' AS frecuencia, numero_cuota, fecha_pago, to_char(fecha_pago, 'Day') AS dia
  FROM public.generar_cronograma(100000, 20, 6, 'aleman', 'biweekly', false,
                                 DATE '2026-08-23', NULL)
UNION ALL
SELECT 'mensual', numero_cuota, fecha_pago, to_char(fecha_pago, 'Day')
  FROM public.generar_cronograma(100000, 20, 6, 'aleman', 'monthly', false,
                                 DATE '2026-08-23', NULL)
 ORDER BY 1, 2;


-- ── PASO 4) Cuotas en domingo que YA existen ──────────────────────────────
-- No se tocan: son cronogramas pactados. Esto es solo para saber cuantas hay
-- y en que rutas, por si conviene corregir alguna desde Control de Pagos.
SELECT pp.ruta,
       l.frecuencia_pago,
       COUNT(*)                                        AS cuotas_en_domingo,
       COUNT(*) FILTER (WHERE pp.estado = 'pendiente') AS todavia_pendientes,
       MIN(pp.fecha_pago)                              AS desde,
       MAX(pp.fecha_pago)                              AS hasta
  FROM public.payment_plan pp
  JOIN public.loans l ON l.id = pp.loan_id
 WHERE EXTRACT(dow FROM pp.fecha_pago) = 0
   AND l.estado = 'activo'
 GROUP BY pp.ruta, l.frecuencia_pago
 ORDER BY pp.ruta, l.frecuencia_pago;
