"use client"

/**
 * lib/imagen-comprobante.ts
 * ---------------------------------------------------------------------------
 * Comprobantes como imagen PNG, dibujados con Canvas 2D.
 *
 * POR QUÉ IMAGEN Y NO PDF
 * Compartido por WhatsApp o por el chat de la app, un PNG se ve DENTRO de la
 * conversación y el otro lo lee de una. Un PDF llega como adjunto que hay que
 * abrir aparte, y en muchos teléfonos ni previsualiza.
 *
 * Es el mismo dibujo que ya venía funcionando para el recibo de pago
 * (`buildReciboImagen` en register-payment.tsx), sacado acá para que también
 * lo pueda usar el cierre de caja. Sin librerías: son filas de texto, un par
 * de líneas y el logo.
 */

export interface SeccionComprobante {
  titulo: string
  filas: {
    label: string
    valor: string
    /** Se pinta mas grande, como en pantalla. */
    destacado?: boolean
    /** Solo en formato `tabla`: las celdas del medio y de la derecha. */
    celdas?: string[]
  }[]
  /** Solo en formato `tabla`: los titulos de las columnas. */
  columnas?: string[]
  /**
   * COMO SE ACOMODAN LAS FILAS.
   *
   * `lista`  (por defecto) — etiqueta a la izquierda, valor a la derecha, un
   *          renglon completo por dato. Es lo del cierre de caja.
   * `rejilla` — dos columnas, con la etiqueta ENCIMA del valor. Es como se ve
   *          el extracto en la app, y por eso el que se comparte lo usa: el
   *          cliente recibe lo mismo que el cobrador le acaba de mostrar en
   *          la pantalla, no otra cosa con los mismos numeros.
   * `tabla`  — cuatro columnas con encabezado, como el historial de pagos de
   *          la app: Fecha, Cuota, Pagado, Saldo.
   */
  formato?: "lista" | "rejilla" | "tabla"
}

export interface OpcionesComprobante {
  titulo: string
  subtitulo?: string
  /** Línea pequeña bajo el título: fecha, hora, estado. */
  meta?: string
  secciones: SeccionComprobante[]
  logoUrl?: string
  nombreArchivo: string
  /** Línea final en cursiva. */
  pie?: string
}

/**
 * Trae el logo como data URL. Devuelve null ante cualquier fallo: un
 * comprobante sin logo sirve; uno que no se genera, no.
 */
export async function cargarLogoBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader()
      fr.onloadend = () => resolve(typeof fr.result === "string" ? fr.result : null)
      fr.onerror = () => resolve(null)
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

async function cargarImagen(dataUrl: string | null): Promise<HTMLImageElement | null> {
  if (!dataUrl) return null
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

/** Dibuja el comprobante y lo devuelve listo para compartir o descargar. */
export async function renderComprobanteImagen(
  opts: OpcionesComprobante,
): Promise<{ blob: Blob; dataUrl: string; filename: string }> {
  const logoImg = await cargarImagen(opts.logoUrl ? await cargarLogoBase64(opts.logoUrl) : null)

  // Medidas en puntos lógicos; se pinta a 3x para que se vea nítido en la
  // pantalla de un celular.
  const ESCALA = 3
  const W = 340
  const PAD = 20
  const ALTO_FILA = 19
  const ALTO_SECCION = 24
  const ALTO_LOGO = logoImg ? 64 : 0

  // Una fila de REJILLA lleva la etiqueta encima del valor, asi que es mas
  // alta; pero entran DOS datos por renglon, y por eso ocupa menos.
  const ALTO_FILA_REJILLA = 30
  const altoDeSeccion = (x: SeccionComprobante) =>
    x.formato === "rejilla"
      ? Math.ceil(x.filas.length / 2) * ALTO_FILA_REJILLA
      : x.formato === "tabla"
        ? (x.filas.length + 1) * ALTO_FILA   // +1 por el encabezado
        : x.filas.length * ALTO_FILA

  // El alto se calcula ANTES de crear el canvas: con el canvas ya creado no
  // se puede redimensionar sin perder lo dibujado.
  const H =
    PAD + ALTO_LOGO + 26 + (opts.subtitulo ? 18 : 0) + (opts.meta ? 16 : 0) + 12 +
    opts.secciones.length * ALTO_SECCION +
    opts.secciones.reduce((s, x) => s + altoDeSeccion(x), 0) +
    (opts.pie ? 26 : 0) + PAD

  const canvas = document.createElement("canvas")
  canvas.width = W * ESCALA
  canvas.height = H * ESCALA
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("No se pudo preparar el lienzo del comprobante")
  ctx.scale(ESCALA, ESCALA)

  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = "#000000"
  ctx.textBaseline = "alphabetic"

  const linea = (yy: number, color = "#cccccc") => {
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD, yy)
    ctx.lineTo(W - PAD, yy)
    ctx.stroke()
  }

  /** Etiqueta a la izquierda, valor a la derecha, sin que se pisen. */
  const parLabelValor = (label: string, valor: string, yy: number) => {
    ctx.font = "12px Helvetica, Arial, sans-serif"
    ctx.fillStyle = "#444444"
    ctx.textAlign = "left"
    ctx.fillText(label, PAD, yy)
    const anchoLabel = ctx.measureText(label).width

    ctx.font = "bold 12px Helvetica, Arial, sans-serif"
    ctx.fillStyle = "#000000"
    ctx.textAlign = "right"
    ctx.fillText(valor, W - PAD, yy, W - PAD * 2 - anchoLabel - 8)
    ctx.textAlign = "left"
  }

  let y = PAD

  if (logoImg) {
    const alto = 56
    const ancho = (logoImg.width / logoImg.height) * alto
    ctx.drawImage(logoImg, (W - ancho) / 2, y, ancho, alto)
    y += ALTO_LOGO
  }

  ctx.textAlign = "center"
  ctx.font = "bold 17px Helvetica, Arial, sans-serif"
  ctx.fillStyle = "#000000"
  ctx.fillText(opts.titulo.toUpperCase(), W / 2, y + 16)
  y += 26

  if (opts.subtitulo) {
    ctx.font = "13px Helvetica, Arial, sans-serif"
    ctx.fillStyle = "#333333"
    ctx.fillText(opts.subtitulo, W / 2, y + 10)
    y += 18
  }
  if (opts.meta) {
    ctx.font = "11px Helvetica, Arial, sans-serif"
    ctx.fillStyle = "#666666"
    ctx.fillText(opts.meta, W / 2, y + 9)
    y += 16
  }
  ctx.textAlign = "left"

  y += 8
  linea(y)
  y += 4

  for (const sec of opts.secciones) {
    y += ALTO_SECCION - 6
    ctx.font = "bold 11px Helvetica, Arial, sans-serif"
    ctx.fillStyle = "#0f766e"
    ctx.fillText(sec.titulo.toUpperCase(), PAD, y)
    y += 6
    if (sec.formato === "rejilla") {
      // DOS COLUMNAS, la etiqueta encima del valor — igual que en la app.
      const COL = (W - PAD * 2) / 2
      for (let i = 0; i < sec.filas.length; i += 2) {
        y += ALTO_FILA_REJILLA
        for (const [col, f] of [sec.filas[i], sec.filas[i + 1]].entries()) {
          if (!f) continue
          const x = PAD + col * COL
          ctx.textAlign = "left"
          ctx.font = "10px Helvetica, Arial, sans-serif"
          ctx.fillStyle = "#666666"
          ctx.fillText(f.label, x, y - 13, COL - 6)
          // El destacado va mas grande, como el Saldo y el Estado en pantalla.
          ctx.font = `bold ${f.destacado ? 15 : 12}px Helvetica, Arial, sans-serif`
          ctx.fillStyle = "#000000"
          ctx.fillText(f.valor, x, y, COL - 6)
        }
      }
    } else if (sec.formato === "tabla") {
      // CUATRO COLUMNAS CON ENCABEZADO, como el historial de pagos de la app.
      // Antes las tres cifras iban pegadas dentro de un solo texto a la
      // derecha —"Cta 7   $18.000   $333.000"— y sin titulos: habia que
      // adivinar cual era cual. Con las columnas fijas quedan alineadas de
      // arriba abajo y se comparan de un vistazo, igual que en pantalla.
      const X_FECHA = PAD
      const X_CUOTA = PAD + 84
      const X_PAGADO = W - PAD - 74
      const X_SALDO = W - PAD
      const cols = sec.columnas ?? []

      y += ALTO_FILA
      ctx.font = "bold 10px Helvetica, Arial, sans-serif"
      ctx.fillStyle = "#666666"
      ctx.textAlign = "left"
      if (cols[0]) ctx.fillText(cols[0], X_FECHA, y)
      ctx.textAlign = "center"
      if (cols[1]) ctx.fillText(cols[1], X_CUOTA, y)
      ctx.textAlign = "right"
      if (cols[2]) ctx.fillText(cols[2], X_PAGADO, y)
      if (cols[3]) ctx.fillText(cols[3], X_SALDO, y)
      ctx.textAlign = "left"

      for (const f of sec.filas) {
        y += ALTO_FILA
        const c = f.celdas ?? []
        ctx.font = "11px Helvetica, Arial, sans-serif"
        ctx.fillStyle = "#444444"
        ctx.textAlign = "left"
        ctx.fillText(f.label, X_FECHA, y)
        ctx.textAlign = "center"
        ctx.fillText(c[0] ?? "", X_CUOTA, y)
        ctx.font = "bold 11px Helvetica, Arial, sans-serif"
        ctx.fillStyle = "#000000"
        ctx.textAlign = "right"
        ctx.fillText(c[1] ?? "", X_PAGADO, y)
        ctx.font = "11px Helvetica, Arial, sans-serif"
        ctx.fillStyle = "#444444"
        ctx.fillText(c[2] ?? "", X_SALDO, y)
        ctx.textAlign = "left"
      }
    } else {
      for (const f of sec.filas) {
        y += ALTO_FILA
        parLabelValor(f.label, f.valor, y)
      }
    }
    y += 4
    linea(y, "#eeeeee")
  }

  if (opts.pie) {
    y += 20
    ctx.textAlign = "center"
    ctx.font = "italic 10.5px Helvetica, Arial, sans-serif"
    ctx.fillStyle = "#444444"
    ctx.fillText(opts.pie, W / 2, y)
    ctx.textAlign = "left"
  }

  const dataUrl = canvas.toDataURL("image/png")
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("No se pudo generar la imagen del comprobante"))),
      "image/png",
    )
  })

  return { blob, dataUrl, filename: opts.nombreArchivo }
}
