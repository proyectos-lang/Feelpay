"use client"

/**
 * La ruta congelada porque la caja de un día anterior quedó sin cerrar.
 *
 * Son DOS piezas para dos personas distintas, y por eso viven en un archivo:
 * dicen lo mismo y tienen que decirlo igual.
 *
 *   · `RutaCongelada` — la pantalla que ve el cobrador. Le tapa la app, porque
 *     el punto es que no empiece un día nuevo dejando el anterior sin cuadrar.
 *     No lleva botón de desbloquear: si lo llevara, el congelamiento sería una
 *     sugerencia.
 *   · `AvisoJornadaCongelada` — la barra que ve quien SÍ puede desbloquear.
 *     A esa persona no se le tapa nada: se le avisa y se le da el botón, que
 *     es lo que necesita para resolverlo desde donde esté.
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Snowflake, Loader2, Unlock, MessageSquare, Lock } from "lucide-react"
import { fmtFecha } from "@/lib/colombia-date"
import { descongelarJornada, type JornadaPendiente } from "@/lib/jornada-pendiente"
import { useToast } from "@/hooks/use-toast"

interface PantallaProps {
  jornada: JornadaPendiente
  /** El chat no se bloquea nunca: hay que poder pedir que la desbloqueen. */
  onIrAlChat?: () => void
}

export function RutaCongelada({ jornada, onIrAlChat }: PantallaProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-info/10 ring-4 ring-info/20">
        <Snowflake className="h-8 w-8 text-info" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-xl font-bold text-foreground">Ruta congelada</h2>
        <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
          La caja del <strong className="text-foreground">{fmtFecha(jornada.fecha)}</strong> quedó
          sin cerrar. Hasta que se resuelva no se puede empezar un día nuevo.
        </p>
        <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
          Pídele a la secretaría que haga el cierre de ese día. Apenas quede cerrado,
          la ruta se libera sola. El chat sigue disponible.
        </p>
      </div>
      {onIrAlChat && (
        <Button size="lg" variant="outline" className="gap-2" onClick={onIrAlChat}>
          <MessageSquare className="h-4 w-4" />
          Ir al chat
        </Button>
      )}
    </div>
  )
}

interface AvisoProps {
  jornada: JornadaPendiente
  rutaNombre: string
  usuario: { id: number | string; nombre: string }
  /** Se llama cuando la jornada quedó cerrada, para volver a leer el estado. */
  onDescongelada: () => void
  /** Lleva al cierre de caja de ESA jornada. Es el camino normal. */
  onIrAlCierre?: () => void
}

/**
 * DOS SALIDAS, Y NO VALEN LO MISMO.
 *
 * La normal es HACER EL CIERRE de ese día: se abre el cierre de caja con la
 * fecha de la jornada vieja, se cuadra, y al cerrarla la ruta queda libre.
 * Eso es lo que faltaba, y hacerlo deja el día con sus números.
 *
 * La otra —cerrar sin cuadre— existe porque hay casos donde el cierre ya no
 * se puede hacer: una ruta con quince días viejos encima, o un día del que ya
 * nadie se acuerda. Sigue disponible, pero de segunda y con una confirmación,
 * porque deja la jornada cerrada SIN cuadrar: el día queda sin cierre para
 * siempre y solo consta quién lo saltó.
 *
 * Antes era la única salida, y era la que estaba a un toque.
 */
export function AvisoJornadaCongelada({ jornada, rutaNombre, usuario, onDescongelada, onIrAlCierre }: AvisoProps) {
  const { toast } = useToast()
  const [enCurso, setEnCurso] = useState(false)
  // El primer toque avisa, el segundo ejecuta. Un modal para esto seria mucho;
  // un solo toque, muy poco: se pierde el cierre de un dia sin querer.
  const [confirmando, setConfirmando] = useState(false)

  // Se desarma solo. Un boton que se queda armado media hora es peor que uno
  // que no avisa: para cuando alguien lo vuelve a tocar, ya se olvido de que
  // el toque anterior era el aviso.
  useEffect(() => {
    if (!confirmando) return
    const t = setTimeout(() => setConfirmando(false), 6000)
    return () => clearTimeout(t)
  }, [confirmando])

  const cerrarSinCuadre = async () => {
    if (enCurso) return
    if (!confirmando) {
      setConfirmando(true)
      return
    }
    setEnCurso(true)
    const r = await descongelarJornada(jornada.id, usuario)
    setEnCurso(false)
    setConfirmando(false)
    if (!r.ok) {
      toast({ title: "No se pudo desbloquear", description: r.error, variant: "destructive" })
      return
    }
    toast({
      title: "Ruta desbloqueada",
      description: `El ${fmtFecha(jornada.fecha)} quedó cerrado sin cuadre, a tu nombre. Ya se puede trabajar el día de hoy.`,
    })
    onDescongelada()
  }

  return (
    // NO se cierra ni se autooculta, por lo mismo que el aviso de versión
    // nueva: mientras esté congelada hay alguien que no puede trabajar.
    <div className="flex flex-wrap items-center gap-2 border-b border-info/40 bg-info/10 px-3 py-2">
      <Snowflake className="h-4 w-4 shrink-0 text-info" />
      <p className="flex-1 min-w-[12rem] text-[11px] leading-tight text-info md:text-sm">
        <span className="font-semibold">{rutaNombre || "Esta ruta"} está congelada.</span>{" "}
        La caja del {fmtFecha(jornada.fecha)} quedó sin cerrar y el cobrador no puede empezar hoy.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {onIrAlCierre && (
          <Button size="sm" className="gap-1.5" onClick={onIrAlCierre} disabled={enCurso}>
            <Lock className="h-3.5 w-3.5" />
            Hacer el cierre
          </Button>
        )}
        <Button
          size="sm"
          variant={confirmando ? "destructive" : "ghost"}
          className={confirmando ? "gap-1.5" : "gap-1.5 text-info hover:bg-info/15 hover:text-info"}
          onClick={cerrarSinCuadre}
          disabled={enCurso}
          title="Cierra la jornada sin cuadrarla. Ese día queda sin cierre."
        >
          {enCurso ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
          {enCurso ? "Cerrando..." : confirmando ? "¿Seguro? Toca otra vez" : "Sin cuadre"}
        </Button>
      </div>
    </div>
  )
}
