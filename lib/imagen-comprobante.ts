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
  filas: { label: string; valor: string }[]
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

  const totalFilas = opts.secciones.reduce((s, x) => s + x.filas.length, 0)
  // El alto se calcula ANTES de crear el canvas: con el canvas ya creado no
  // se puede redimensionar sin perder lo dibujado.
  const H =
    PAD + ALTO_LOGO + 26 + (opts.subtitulo ? 18 : 0) + (opts.meta ? 16 : 0) + 12 +
    opts.secciones.length * ALTO_SECCION +
    totalFilas * ALTO_FILA +
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
    for (const f of sec.filas) {
      y += ALTO_FILA
      parLabelValor(f.label, f.valor, y)
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
