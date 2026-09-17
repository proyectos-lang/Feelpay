-- ============================================================================
-- 117 - Cada cliente con su numero
-- ============================================================================
-- LO QUE SE PIDIO
-- "Vamos a crearle a la tabla clients un campo de id numerico diferente al de
--  id normal, que sea un numero del 1 al n, y que en ese orden aparezcan en
--  los listados selectores para hacer ventas."
--
-- POR QUE HACE FALTA
-- `clients.id` es un UUID —"f203e4bb-7c1a-..."— que no se puede decir en voz
-- alta ni escribir en un papel. El vendedor necesita poder decir "el 14".
-- Este numero es PARA LA GENTE; el UUID sigue siendo la llave de verdad y no
-- se toca: todo lo que apunta a un cliente (loans, gestiones) sigue
-- apuntando al UUID.
--
-- LAS DOS DECISIONES, QUE LAS TOMO EL DUEÑO
--   * El numero es GLOBAL, uno solo para toda la base (1..420 hoy). No se
--     reinicia por ruta, asi que dos clientes nunca comparten numero.
--   * El orden inicial es POR ANTIGUEDAD (`created_at`): el mas viejo es el 1.
--     Asi el numero queda fijo para siempre y no se mueve cuando entra gente
--     nueva, que es lo que pasaria con un orden alfabetico.
--
-- EL EMPATE DE FECHAS: LO IMPORTANTE DE ESTE SCRIPT
-- ---------------------------------------------------
-- `created_at` NO alcanza para ordenar. Se midio contra produccion: de los
-- 420 clientes, 253 comparten su `created_at` con otro —hay cargas masivas de
-- 52, 45 y 39 clientes con el segundo exacto—. Ordenar solo por fecha dejaria
-- el numero de esos 253 a suerte del planificador, y correr el script dos
-- veces podria dar dos numeraciones distintas.
--
-- Por eso el orden es `created_at, id`: el UUID desempata. Es arbitrario pero
-- ESTABLE, que es lo unico que se necesita — el mismo cliente saca siempre el
-- mismo numero.
--
-- QUE NO CAMBIA
--   * `clients.id` sigue siendo la llave primaria. Nada de lo que apunta a un
--     cliente se toca.
--   * Ninguna vista, ninguna funcion de plata, ningun saldo.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 7 no escriben nada.
-- ============================================================================


-- ── PASO 1) Como esta la cosa hoy (SOLO LECTURA) ─────────────────────────
-- Cuantos clientes hay y cuantos comparten fecha de creacion. Lo segundo es
-- la razon de que el orden lleve `id` como desempate.
SELECT COUNT(*)                                            AS clientes,
       COUNT(DISTINCT created_at)                          AS fechas_distintas,
       COUNT(*) - COUNT(DISTINCT created_at)               AS empatados,
       COUNT(*) FILTER (WHERE created_at IS NULL)          AS sin_fecha
  FROM public.clients;


-- ── PASO 2) La columna ───────────────────────────────────────────────────
-- Sin NOT NULL todavia: primero hay que llenarla. Se pone al final del paso 4.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS numero INTEGER;


-- ── PASO 3) La secuencia ─────────────────────────────────────────────────
-- Es lo que le da el numero al cliente que entre mañana. Va aparte de la
-- columna —y no como IDENTITY— porque los 420 que ya existen se numeran a
-- mano en el paso 4, y despues hay que decirle a la secuencia por donde va.
CREATE SEQUENCE IF NOT EXISTS public.clients_numero_seq AS INTEGER START 1;


-- ── PASO 4) Numerar a los que ya existen ─────────────────────────────────
-- `created_at, id`: la fecha manda y el UUID desempata. Sin el segundo
-- criterio, los 253 clientes que comparten segundo quedarian en cualquier
-- orden. `created_at NULLS LAST` por si algun dia hay una fila sin fecha: se
-- va al final en vez de encabezar la lista.
--
-- El WHERE hace el script REPETIBLE: si ya se corrio, no vuelve a numerar a
-- nadie ni le cambia el numero a quien ya lo tiene.
WITH ordenados AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY created_at NULLS LAST, id) AS n
    FROM public.clients
   WHERE numero IS NULL
)
UPDATE public.clients c
   SET numero = o.n + COALESCE((SELECT MAX(numero) FROM public.clients), 0)
  FROM ordenados o
 WHERE c.id = o.id;


-- ── PASO 5) La secuencia arranca donde termino la numeracion ─────────────
-- Si no, el proximo cliente pediria el 1 y chocaria con el indice unico.
-- `false` en el tercer argumento = el proximo valor es exactamente este.
SELECT setval('public.clients_numero_seq',
              COALESCE((SELECT MAX(numero) FROM public.clients), 0) + 1,
              false);


-- ── PASO 6) Que nadie se quede sin numero y que nadie lo repita ──────────
-- El DEFAULT le da el numero al que entre desde ahora. El NOT NULL y el
-- indice unico son los que garantizan que el numero SIRVA para nombrar a un
-- cliente: sin el unico, dos clientes podrian ser "el 14".
ALTER TABLE public.clients
  ALTER COLUMN numero SET DEFAULT nextval('public.clients_numero_seq');

ALTER TABLE public.clients
  ALTER COLUMN numero SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_numero
  ON public.clients (numero);

-- La secuencia queda amarrada a la columna: si algun dia se borra la columna,
-- la secuencia se va con ella en vez de quedar suelta.
ALTER SEQUENCE public.clients_numero_seq OWNED BY public.clients.numero;


-- ── PASO 7) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- Tiene que dar: sin_numero = 0, repetidos = 0, minimo = 1 y
-- maximo = clientes. Si el maximo no es igual al total, hay un hueco —lo cual
-- es normal si alguna vez se borro un cliente, pero conviene saberlo.
SELECT COUNT(*)                                   AS clientes,
       COUNT(*) FILTER (WHERE numero IS NULL)      AS sin_numero,
       COUNT(*) - COUNT(DISTINCT numero)           AS repetidos,
       MIN(numero)                                 AS minimo,
       MAX(numero)                                 AS maximo
  FROM public.clients;

-- Los diez primeros, para verlo con nombre propio.
SELECT numero, apodo, nombre_completo, ruta, created_at
  FROM public.clients
 ORDER BY numero
 LIMIT 10;
