-- ============================================================================
-- 120 - La moto de la ruta
-- ============================================================================
-- LO QUE SE PIDIO
-- "Vamos a hacer que en configuracion de las rutas tambien tengamos la opcion
--  de registrarle una moto: aqui se le pondra la placa de la moto, fecha de
--  compra y una foto de la moto."
--
-- DONDE VA
-- En `ruta_config_umbrales`, que es donde ya vive todo lo que se configura de
-- una unidad —los umbrales, la geocerca, la multa y el `logo_url`—. Tres
-- columnas al lado de las que ya estan.
--
-- POR QUE NO UNA TABLA `motos`
-- -----------------------------
-- Una tabla aparte tendria sentido si una unidad pudiera tener VARIAS motos, o
-- si hiciera falta guardar la historia de cual moto tuvo cuando. Lo que se
-- pidio es una moto por ruta, asi que una tabla nueva serian un JOIN y una
-- pantalla de mas para guardar lo mismo.
--
-- Si manana hacen falta varias —o el historial de traspasos— se migra a
-- `motos (ruta_id, placa, ...)` y estas tres columnas se copian a la primera
-- fila de cada ruta. Queda dicho para que la decision no parezca un descuido.
--
-- LA FOTO ES UNA URL, NO LA IMAGEN
-- Igual que `logo_url` y que `usuarios.foto_url`: el archivo se sube a Vercel
-- Blob por `/api/upload-photo` y aca se guarda a donde quedo. Meter la imagen
-- en la base la engorda y la hace lenta para todo lo demas.
--
-- QUE NO CAMBIA
--   * Ningun monto, ningun saldo, ninguna vista, ninguna funcion.
--   * Las columnas nacen en NULL: una unidad sin moto es lo normal, no un
--     error. Nada es obligatorio.
--
-- Corre los pasos EN ORDEN. Los pasos 1 y 5 no escriben nada.
-- ============================================================================


-- ── PASO 1) Como esta la tabla hoy (SOLO LECTURA) ────────────────────────
-- Para ver que las tres columnas todavia no estan.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'ruta_config_umbrales'
 ORDER BY ordinal_position;


-- ── PASO 2) Las tres columnas ────────────────────────────────────────────
-- `moto_placa` es TEXT y no VARCHAR(6): las placas no miden lo mismo en los
-- cuatro paises —en Argentina son AA123BB (7) y en Colombia ABC12D (6)— y un
-- limite corto rebotaria una placa valida de otro pais.
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS moto_placa TEXT;

-- La fecha de compra es DATE, no TIMESTAMP: nadie anota la hora a la que
-- compro una moto, y un TIMESTAMP invitaria a inventarsela.
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS moto_fecha_compra DATE;

-- A donde quedo la foto en Vercel Blob. Ver `logo_url`, que funciona igual.
ALTER TABLE public.ruta_config_umbrales
  ADD COLUMN IF NOT EXISTS moto_foto_url TEXT;


-- ── PASO 3) La placa, normalizada ────────────────────────────────────────
-- Se guarda SIN espacios y en mayuscula. Si no, la misma moto entra como
-- "abc12d", "ABC 12D" y "ABC-12D", y buscarla se vuelve imposible.
--
-- Es una CHECK y no un trigger a proposito: el trigger la arreglaria en
-- silencio y el usuario no se enteraria de que lo que ve no es lo que
-- escribio. La app ya manda la placa en mayuscula y sin espacios (ver
-- `gestion-usuarios-rutas.tsx`); esto es la red por debajo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ruta_config_moto_placa_formato'
  ) THEN
    ALTER TABLE public.ruta_config_umbrales
      ADD CONSTRAINT ruta_config_moto_placa_formato CHECK (
        moto_placa IS NULL
        OR (moto_placa = upper(moto_placa)
            AND moto_placa !~ '\s'
            AND length(moto_placa) BETWEEN 5 AND 10)
      );
  END IF;
END $$;


-- ── PASO 4) Una placa no puede estar en dos unidades ─────────────────────
-- La misma moto en dos rutas es un error de dedo, no un caso de negocio.
-- Indice UNICO parcial: solo mira las filas que TIENEN placa, asi las
-- muchisimas unidades sin moto no chocan entre si por ser todas NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ruta_config_moto_placa
  ON public.ruta_config_umbrales (moto_placa)
  WHERE moto_placa IS NOT NULL;


-- ── PASO 5) Verificacion (SOLO LECTURA) ──────────────────────────────────
-- Las tres columnas tienen que existir y estar TODAS en NULL: las motos se
-- registran desde la pantalla de Usuarios y Rutas, no a mano.
SELECT COUNT(*)                                          AS unidades_configuradas,
       COUNT(moto_placa)                                 AS con_placa,
       COUNT(moto_fecha_compra)                          AS con_fecha,
       COUNT(moto_foto_url)                              AS con_foto
  FROM public.ruta_config_umbrales;

-- Y las motos que haya, cuando las haya.
SELECT c.ruta_id,
       r.nombre,
       c.moto_placa,
       c.moto_fecha_compra,
       (c.moto_foto_url IS NOT NULL) AS tiene_foto
  FROM public.ruta_config_umbrales c
  JOIN public.rutas r ON r.id = c.ruta_id
 WHERE c.moto_placa IS NOT NULL
 ORDER BY c.ruta_id;
