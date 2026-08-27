-- ============================================================================
-- 079 - Secretaría no se pide permiso a sí misma
-- ============================================================================
-- EL SÍNTOMA
-- Desde Control Total, una venta que supera el umbral de la ruta se va a la
-- bandeja de "Movimientos en Revisión" — la misma bandeja que atiende quien
-- acaba de registrarla. La secretaria termina aprobando su propia venta dos
-- clics después, y mientras tanto la venta no existe.
--
-- POR QUÉ PASABA
-- `registrar_venta` (script 061) decide por RUTA, no por quién registra:
-- compara el valor contra `ruta_config_umbrales` y punto. Eso es exactamente
-- lo correcto para el cobrador en la calle, que es para quien se escribió: el
-- umbral existe para que nadie preste por encima del tope sin que alguien
-- firme. Lo que no se contempló es que quien firma también vende.
--
-- LA CORRECCIÓN
-- Control Total manda `p_loan->>'omitir_umbral'`. Cuando viene, la venta entra
-- directo por `crear_venta_atomica` sin pasar por la bandeja.
--
-- LA BANDERA SOLA NO ALCANZA, Y POR ESO NO SE CONFÍA EN ELLA
-- Cualquiera puede armar la llamada HTTP a mano y ponerla. Así que la bandera
-- solo surte efecto si el ROL REAL de `p_user_id` —leído de `usuarios`, no el
-- `p_rol` que manda el navegador— es secretaría o admin. En esta app la
-- identidad vive en localStorage y no hay sesión de servidor: `p_rol` es lo
-- que el cliente DICE ser, y para decidir un permiso hay que preguntárselo a
-- la base. Es la misma postura de `editar_venta_atomica`, subida un escalón.
--
-- El SELECT no cuesta nada nuevo: esta función ya leía `usuarios` más abajo
-- para sacar el nombre del solicitante. Ahora se lee una sola vez, arriba.
--
-- QUÉ NO CAMBIA
-- Sin la bandera, la función se comporta EXACTAMENTE igual que antes: mismo
-- umbral, misma bandeja, misma idempotencia, mismo mensaje. Un vendedor que
-- mande la bandera tampoco cambia nada. La respuesta gana `umbral_omitido`
-- para que quede dicho cuándo se saltó.
--
-- Base: script 061, PASO 1. Se copió completa y se cambió solo lo listado.
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) registrar_venta — la puerta, sabiendo quién toca ──────────────
CREATE OR REPLACE FUNCTION public.registrar_venta(
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
  v_idem        uuid;
  v_valor       numeric;
  v_renovacion  boolean;
  v_u           record;
  v_habilitado  boolean := false;
  v_umbral      numeric;
  v_nombre_cli  text;
  v_solicitante text;
  v_rol_real    text;
  v_directo     boolean;
  v_sol_id      uuid;
  v_duplicado   boolean;
  v_motivo      text;
BEGIN
  v_idem  := NULLIF(p_loan->>'idempotency_key','')::uuid;
  v_valor := NULLIF(p_loan->>'valor','')::numeric;

  -- ── QUIÉN ESTÁ REGISTRANDO ──────────────────────────────────────────────
  -- El rol se lee de `usuarios`, NO del `p_rol` que manda el navegador. En
  -- esta app la identidad vive en localStorage y no hay sesión de servidor,
  -- así que `p_rol` es lo que el cliente DICE ser; para decidir un permiso
  -- hay que preguntárselo a la base. Cuesta un SELECT que esta función ya
  -- hacía más abajo para sacar el nombre del solicitante.
  SELECT nombre, lower(COALESCE(rol,''))
    INTO v_solicitante, v_rol_real
    FROM usuarios WHERE id = p_user_id;

  -- ── LA VENTA DE SECRETARÍA NO SE PIDE PERMISO A SÍ MISMA ────────────────
  -- Control Total manda `omitir_umbral`. El umbral existe para que un
  -- cobrador en la calle no preste por encima del tope sin que nadie firme, y
  -- quien firma es secretaría. Cuando es secretaría la que registra —desde
  -- Control Total, cuadrando una venta que ya ocurrió— mandarla a la bandeja
  -- solo crea una solicitud que ella misma va a aprobar dos clics después.
  --
  -- La bandera SOLA no alcanza: cualquiera puede armar la llamada a mano y
  -- ponerla. Por eso manda el rol REAL, y una bandera puesta por un vendedor
  -- no hace nada.
  v_directo := COALESCE((p_loan->>'omitir_umbral')::boolean, false)
               AND v_rol_real IN ('secretaria','secretario','admin','administrador');

  -- Renovación = el crédito va a un cliente que YA existe. Se deduce de lo
  -- que se va a escribir, no de por qué pantalla entró el vendedor: en la app
  -- esto se calculaba con `preSelectedClientId`, y entrar directo a "Nueva
  -- Venta" y elegir un cliente existente lo evaluaba contra el umbral
  -- equivocado.
  v_renovacion := NOT COALESCE((p_cliente->>'is_new')::boolean, false);

  SELECT venta_nueva_habilitado,      venta_nueva_umbral,
         venta_renovacion_habilitado, venta_renovacion_umbral
    INTO v_u
    FROM ruta_config_umbrales
   WHERE ruta_id = p_ruta_id;

  IF FOUND THEN
    IF v_renovacion THEN
      v_habilitado := COALESCE(v_u.venta_renovacion_habilitado, false);
      v_umbral     := v_u.venta_renovacion_umbral;
    ELSE
      v_habilitado := COALESCE(v_u.venta_nueva_habilitado, false);
      v_umbral     := v_u.venta_nueva_umbral;
    END IF;
  END IF;

  -- ── No requiere revisión: se crea y punto ───────────────────────────────
  -- `v_valor IS NULL` entra acá a propósito: una venta sin valor es un error
  -- del payload, y quien tiene que explicarlo con su mensaje de siempre es
  -- `crear_venta_atomica`. Mandarla a la bandeja de secretaría solo escondería
  -- el error detrás de una solicitud que nadie va a poder aprobar.
  IF v_directo OR v_valor IS NULL OR NOT v_habilitado OR v_umbral IS NULL OR v_valor <= v_umbral THEN
    RETURN public.crear_venta_atomica(
             p_user_id, p_ruta_id, p_rol, p_cliente, p_loan, p_payment_plan)
           || jsonb_build_object('enviado_a_revision', false,
                                 'umbral_omitido', v_directo);
  END IF;

  -- ── A revisión: NADA se escribe en loans/clients/payment_plan ───────────
  -- El nombre lo arma el servidor. La app lo mandaba desde el formulario, y
  -- en una renovación esos campos llegan vacíos: por eso las solicitudes de
  -- venta decían «Venta nueva — » sin nombre, justo lo que el aprobador
  -- necesita para saber qué está aprobando.
  IF v_renovacion THEN
    SELECT COALESCE(NULLIF(apodo,''), nombre_completo) INTO v_nombre_cli
      FROM clients WHERE id = NULLIF(p_cliente->>'id','')::uuid;
  ELSE
    v_nombre_cli := COALESCE(NULLIF(p_cliente->>'apodo',''),
                             NULLIF(p_cliente->>'nombre_completo',''));
  END IF;

  v_motivo := 'La venta de $' || to_char(v_valor, 'FM999G999G999G999')
              || ' supera el umbral de ' ||
              CASE WHEN v_renovacion THEN 'renovación' ELSE 'venta nueva' END
              || ' de la ruta ($' || to_char(v_umbral, 'FM999G999G999G999') || ')';

  -- La llave de idempotencia ES el id de la solicitud: si el envío se repite
  -- (reintento de la cola offline), la llave primaria rechaza el duplicado y
  -- no entran dos solicitudes por la misma venta.
  v_sol_id := COALESCE(v_idem, gen_random_uuid());

  INSERT INTO solicitudes_revision (
    id, tipo, subtipo, ruta_id, solicitado_por, solicitado_por_nombre,
    monto, descripcion, payload
  ) VALUES (
    v_sol_id, 'venta',
    CASE WHEN v_renovacion THEN 'renovacion' ELSE 'nueva' END,
    p_ruta_id, p_user_id, v_solicitante,
    v_valor,
    (CASE WHEN v_renovacion THEN 'Renovación' ELSE 'Venta nueva' END)
      || ' — ' || COALESCE(v_nombre_cli, 'Cliente'),
    -- La llave se saca del payload guardado: cuando secretaría apruebe, la
    -- venta se crea con llave nueva. Si se guardara, `crear_venta_atomica`
    -- vería la llave de la solicitud ya usada y no crearía nada.
    jsonb_build_object('p_cliente',      p_cliente,
                       'p_loan',         p_loan - 'idempotency_key',
                       'p_payment_plan', p_payment_plan)
  )
  ON CONFLICT (id) DO NOTHING;
  v_duplicado := NOT FOUND;

  RETURN jsonb_build_object(
    'ok',                 true,
    'enviado_a_revision', true,
    'solicitud_id',       v_sol_id,
    'motivo',             v_motivo,
    'duplicado',          v_duplicado
  );
END;
$$;


-- ── PASO 2) Permisos ──────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.registrar_venta(bigint, bigint, text, jsonb, jsonb, jsonb)
  TO anon, authenticated;


-- ── PASO 3) Quién puede saltarse el umbral (SOLO LECTURA) ─────────────────
-- La lista completa de usuarios, y para cada uno si la bandera le sirve de
-- algo. `puede_omitir` tiene que dar true SOLO en secretaría y admin: si un
-- vendedor apareciera en true, el umbral dejó de proteger algo.
SELECT u.id,
       u.nombre,
       u.rol,
       lower(COALESCE(u.rol,'')) IN ('secretaria','secretario','admin','administrador')
         AS puede_omitir
  FROM public.usuarios u
 ORDER BY puede_omitir DESC, u.rol, u.nombre;


-- ── PASO 4) Dónde estaba mordiendo el umbral (SOLO LECTURA) ───────────────
-- Las rutas que tienen el tope ENCENDIDO. Solo en estas cambia algo: donde
-- está apagado, la venta ya entraba directa para todo el mundo.
SELECT c.ruta_id,
       r.nombre,
       c.venta_nueva_habilitado,
       c.venta_nueva_umbral,
       c.venta_renovacion_habilitado,
       c.venta_renovacion_umbral
  FROM public.ruta_config_umbrales c
  LEFT JOIN public.rutas r ON r.id = c.ruta_id
 WHERE COALESCE(c.venta_nueva_habilitado, false)
    OR COALESCE(c.venta_renovacion_habilitado, false)
 ORDER BY c.ruta_id;


-- ── PASO 5) Lo que hay hoy en la bandeja (SOLO LECTURA) ───────────────────
-- Las solicitudes de venta pendientes ANTES de este cambio. Este script no
-- toca ninguna: siguen ahí y se aprueban como siempre. Sirve de referencia
-- para ver que de acá en adelante no se sumen las que registre secretaría.
SELECT id, subtipo, ruta_id, solicitado_por_nombre, monto, descripcion,
       estado, created_at
  FROM public.solicitudes_revision
 WHERE tipo = 'venta'
   AND estado = 'pendiente'
 ORDER BY created_at DESC;
