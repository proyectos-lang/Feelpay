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

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Snowflake, Loader2, Unlock, MessageSquare } from "lucide-react"
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
          Pídele a la secretaría que la desbloquee. El chat sigue disponible.
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
}

export function AvisoJornadaCongelada({ jornada, rutaNombre, usuario, onDescongelada }: AvisoProps) {
  const { toast } = useToast()
  const [enCurso, setEnCurso] = useState(false)

  const desbloquear = async () => {
    if (enCurso) return
    setEnCurso(true)
    const r = await descongelarJornada(jornada.id, usuario)
    setEnCurso(false)
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
      <Button size="sm" className="gap-1.5 shrink-0" onClick={desbloquear} disabled={enCurso}>
        {enCurso ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
        {enCurso ? "Desbloqueando..." : "Desbloquear"}
      </Button>
    </div>
  )
}
