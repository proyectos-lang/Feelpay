"use client"

/**
 * El aviso y el botón de "traer la versión nueva".
 *
 * Son dos piezas de lo mismo y por eso viven en un archivo:
 *
 *   · `AvisoVersionNueva` — la barra que aparece sola cuando se despliega algo
 *     mientras la app está abierta. Es la que arregla el caso de David: nadie
 *     tiene que acordarse de nada.
 *   · `BotonActualizar` — el botón de siempre, en el menú. Para cuando algo se
 *     ve raro y uno quiere forzarlo sin esperar a que nadie avise.
 *
 * Ver `lib/actualizar-app.ts` para por qué el service worker no bastaba.
 */

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { RefreshCw, Loader2, ArrowDownToLine } from "lucide-react"
import { actualizarApp, hayVersionNueva } from "@/lib/actualizar-app"

/** Cada cuánto se pregunta si hay algo nuevo. */
const CADA_MS = 10 * 60 * 1000

export function AvisoVersionNueva() {
  const [hay, setHay] = useState(false)
  const [actualizando, setActualizando] = useState(false)

  useEffect(() => {
    let vivo = true
    const revisar = () => {
      // No se pregunta con la app en segundo plano: gastaría datos del
      // teléfono para un aviso que nadie va a ver hasta que vuelva.
      if (document.visibilityState !== "visible") return
      hayVersionNueva().then((n) => { if (vivo && n) setHay(true) })
    }
    revisar()
    const reloj = setInterval(revisar, CADA_MS)
    // Al volver al frente se revisa de una: es cuando la persona va a mirar.
    document.addEventListener("visibilitychange", revisar)
    window.addEventListener("focus", revisar)
    return () => {
      vivo = false
      clearInterval(reloj)
      document.removeEventListener("visibilitychange", revisar)
      window.removeEventListener("focus", revisar)
    }
  }, [])

  if (!hay) return null

  return (
    // NO se cierra ni se autooculta. La versión vieja puede estar cobrando mal
    // y esconder el aviso sería dejar a alguien trabajando con ella todo el
    // día, que es justo lo que pasó.
    <div className="flex items-center gap-2 border-b border-info/40 bg-info/10 px-3 py-2">
      <ArrowDownToLine className="h-4 w-4 shrink-0 text-info" />
      <p className="flex-1 text-[11px] leading-tight text-info md:text-sm">
        <span className="font-semibold">Hay una versión nueva de la app.</span>{" "}
        Actualiza para trabajar con los últimos cambios.
      </p>
      <Button
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
        disabled={actualizando}
        onClick={() => { setActualizando(true); void actualizarApp() }}
      >
        {actualizando
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <RefreshCw className="h-3.5 w-3.5" />}
        Actualizar
      </Button>
    </div>
  )
}

export function BotonActualizar({ className = "" }: { className?: string }) {
  const [actualizando, setActualizando] = useState(false)
  const alTocar = useCallback(() => {
    setActualizando(true)
    void actualizarApp()
  }, [])

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={alTocar}
      disabled={actualizando}
      title="Traer la última versión de la app"
      className={`w-full gap-2 font-semibold ${className}`}
    >
      {actualizando
        ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        : <RefreshCw className="h-4 w-4 shrink-0" />}
      {actualizando ? "Actualizando…" : "Actualizar aplicación"}
    </Button>
  )
}
