-- ============================================================================
-- 061 - El umbral de la venta lo decide el servidor
-- ============================================================================
-- EL AGUJERO
-- Hasta hoy, quién decide si una venta pasa por revisión de secretaría es el
-- teléfono. Y `getRutaUmbrales()` FALLA ABIERTO: ante cualquier error —red
-- caída, tabla que no responde, sesión a medias— devuelve todo deshabilitado,
-- que significa "ninguna venta necesita revisión".
--
-- O sea: un error de red en el momento de vender hace que una venta de
-- cualquier monto se aplique directo, sin revisión y SIN DEJAR RASTRO de que
-- la revisión se saltó. No hay log, no hay solicitud, no hay nada. Desde la
-- bandeja de secretaría se ve idéntico a una venta que legítimamente estaba
-- por debajo del umbral.
--
-- Hay un caché en localStorage que lo tapa parcialmente (guarda el último
-- valor leído), pero solo funciona si ese teléfono ya leyó la config alguna
-- vez con señal. Un teléfono nuevo, o uno al que le limpiaron el navegador,
-- vende sin revisión y nadie se entera.
--
-- LA CORRECCIÓN
-- Es el mismo movimiento que ya se hizo con los abonos: la decisión baja al
-- servidor, donde la config no puede "no llegar". Se agrega `registrar_venta`
-- como la puerta que usa la app, con la misma forma que `registrar_gestion`:
-- mira el umbral y, o crea la venta, o la manda a la bandeja de secretaría.
-- Nunca las dos cosas, nunca ninguna.
--
-- SON DOS LÍNEAS, NO UNA
-- El teléfono sigue mirando el umbral, pero ya no para decidir: para poder
-- PREGUNTAR antes de mandar («esto va a revisión, ¿sigo?»). Si el vendedor
-- dice que sí, la solicitud entra por ahí y la RPC nunca se llama; si dice que
-- no, no se envía nada. Los dos caminos son excluyentes por construcción, así
-- que no pueden producir dos solicitudes por la misma venta.
--
-- El servidor es la RED DE SEGURIDAD: atrapa exactamente el caso que antes se
-- escapaba, el de la lectura que falló.
--
-- SI ESTE SCRIPT NO SE HA CORRIDO
-- La app lo detecta (PostgREST responde PGRST202, «función no encontrada»),
-- deja un error en consola y vende por el camino de siempre. Que a un cobrador
-- se le caigan TODAS las ventas en la calle es mucho peor que seguir un día
-- más con la decisión en el teléfono. Pero mientras tanto el agujero sigue
-- abierto: no lo dejes ahí.
--
-- POR QUÉ UNA FUNCIÓN NUEVA Y NO EL CHEQUEO DENTRO DE `crear_venta_atomica`
-- Porque `aprobar_solicitud_revision` APRUEBA llamando a
-- `crear_venta_atomica`. Con el chequeo adentro, aprobar una venta grande
-- volvería a encontrarla por encima del umbral y crearía otra solicitud en
-- vez del préstamo: un ciclo infinito de solicitudes que se aprueban a sí
-- mismas para siempre.
--
-- Se podría haber puesto una banderita tipo `omitir_revision` en el payload,
-- pero eso es peor: viaja desde el cliente, así que cualquiera puede mandarla
-- y saltarse la revisión a propósito. Separar las dos funciones deja la
-- puerta de aprobación limpia sin ninguna bandera que se pueda falsificar.
--
-- `crear_venta_atomica` queda intacta como el ESCRITOR de bajo nivel. Nadie
-- toca esa función: la usan la aprobación y la homologación.
--
-- LA IDEMPOTENCIA NO SE CONSUME DOS VECES
-- `registrar_venta` NO reclama la llave en `operaciones_procesadas`. Si lo
-- hiciera, `crear_venta_atomica` la encontraría ya tomada, creería que es un
-- reintento y devolvería «duplicado» sin crear nada: la venta se perdería en
-- silencio. Cada rama usa el mecanismo que ya tiene:
--   · venta normal  → `crear_venta_atomica` reclama la llave como siempre
--   · a revisión    → la llave ES el `id` de la solicitud, y la llave
--                     primaria rechaza el reintento sola (el mismo truco que
--                     ya usa la cola offline para el tipo 'revision')
--
-- Corre los pasos EN ORDEN. Cada uno es una sola sentencia.
-- ============================================================================


-- ── PASO 1) registrar_venta — la puerta ───────────────────────────────────
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
  v_sol_id      uuid;
  v_duplicado   boolean;
  v_motivo      text;
BEGIN
  v_idem  := NULLIF(p_loan->>'idempotency_key','')::uuid;
  v_valor := NULLIF(p_loan->>'valor','')::numeric;

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
  IF v_valor IS NULL OR NOT v_habilitado OR v_umbral IS NULL OR v_valor <= v_umbral THEN
    RETURN public.crear_venta_atomica(
             p_user_id, p_ruta_id, p_rol, p_cliente, p_loan, p_payment_plan)
           || jsonb_build_object('enviado_a_revision', false);
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

  SELECT nombre INTO v_solicitante FROM usuarios WHERE id = p_user_id;

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


-- ── PASO 2) Ejecución para la app ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.registrar_venta(bigint, bigint, text, jsonb, jsonb, jsonb)
  TO anon, authenticated;


-- ── PASO 3) Verificar que la puerta decide bien ───────────────────────────
-- Simulación de solo lectura: para cada ruta con umbral de venta encendido,
-- qué haría `registrar_venta` con montos alrededor del límite. Ninguna fila
-- debe decir 'crea' cuando el monto está por encima.
SELECT ruta_id,
       venta_nueva_habilitado      AS nueva_on,
       venta_nueva_umbral          AS nueva_limite,
       venta_renovacion_habilitado AS renov_on,
       venta_renovacion_umbral     AS renov_limite,
       CASE WHEN COALESCE(venta_nueva_habilitado,false)
             AND venta_nueva_umbral IS NOT NULL
            THEN 'nueva de $' || (venta_nueva_umbral + 1) || ' -> revisión'
            ELSE 'nueva de cualquier monto -> crea' END AS que_pasa_nueva,
       CASE WHEN COALESCE(venta_renovacion_habilitado,false)
             AND venta_renovacion_umbral IS NOT NULL
            THEN 'renovación de $' || (venta_renovacion_umbral + 1) || ' -> revisión'
            ELSE 'renovación de cualquier monto -> crea' END AS que_pasa_renov
  FROM ruta_config_umbrales
 ORDER BY ruta_id;


-- ── PASO 4) Prueba de verdad ──────────────────────────────────────────────
-- Vale más que cualquier consulta: en una ruta con el umbral ENCENDIDO,
-- registra una venta por encima del límite desde la app y confirma que
--   a) NO aparece en Ver Ventas,
--   b) SÍ aparece en Movimientos en Revisión con el nombre del cliente,
--   c) al aprobarla, el crédito queda creado con su cronograma.
--
-- Estado real de la config al 19/08/2026:
--
--   ruta   venta nueva        renovación
--   1      ON,  límite 500    ON,  límite 600     ← lista para probar
--   190    OFF (límite 550.000 guardado pero apagado)
--   933    OFF, sin límite
--   4      OFF, sin límite
--
-- O sea: la ruta 1 sirve tal cual — cualquier venta de más de $500 debe caer
-- en la bandeja. En la 190 y la 933 esta prueba NO prueba nada mientras los
-- interruptores sigan apagados: todo pasa derecho, con corrección o sin ella.
SELECT id, tipo, subtipo, monto, descripcion, estado, created_at
  FROM solicitudes_revision
 WHERE tipo = 'venta'
 ORDER BY created_at DESC
 LIMIT 20;


-- ── PASO 5) OPCIONAL — cerrar la puerta de atrás ──────────────────────────
-- NO CORRER TODAVÍA. Léelo completo antes de decidir.
--
-- Con los pasos de arriba, la app nueva ya decide en el servidor. Pero
-- `crear_venta_atomica` sigue siendo llamable directamente desde el navegador,
-- así que alguien que arme la llamada a mano puede saltarse la revisión.
--
-- Esta sentencia cierra esa puerta. La aprobación NO se ve afectada:
-- `aprobar_solicitud_revision` es SECURITY DEFINER y llama con los permisos
-- del dueño de la función, no con los del navegador.
--
-- EL COSTO: un teléfono con la versión VIEJA de la app todavía cacheada llama
-- a `crear_venta_atomica` directo. Desde el momento en que corras esto, a esa
-- persona se le CAEN TODAS LAS VENTAS con «permission denied» hasta que la app
-- se le actualice — y en el campo, sin señal, puede tardar días.
--
-- Córrelo solo cuando confirmes que todos los cobradores ya abrieron la
-- versión nueva. Mientras tanto, el agujero que queda abierto exige armar una
-- llamada HTTP a mano: es un riesgo distinto (y mucho menor) que el error de
-- red que esta corrección arregla.
--
-- REVOKE EXECUTE ON FUNCTION public.crear_venta_atomica(bigint, bigint, text, jsonb, jsonb, jsonb)
--   FROM anon, authenticated;
