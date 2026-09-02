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
import { descongelarJornada, habilitarCierreAtrasado, type JornadaPendiente } from "@/lib/jornada-pendiente"
import { useToast } from "@/hooks/use-toast"

interface PantallaProps {
  jornada: JornadaPendiente
  /** El chat no se bloquea nunca: hay que poder pedir que la desbloqueen. */
  onIrAlChat?: () => void
  /**
   * Abre el cierre de caja DE ESE DÍA.
   *
   * Solo llega con valor cuando la secretaría ya descongeló la jornada — o
   * sea, cuando el cobrador tiene permiso para cerrarla él mismo. Ver
   * `desbloqueada`.
   */
  onIrAlCierre?: () => void
  /**
   * ALGUIEN YA LEVANTÓ EL CANDADO.
   *
   * La secretaría desbloquea desde el aviso de arriba o desde el Monitoreo, y
   * a partir de ahí el que cierra la caja es EL COBRADOR: es el que tiene la
   * plata contada. Antes ese desbloqueo cerraba la jornada sin cuadre y el día
   * se perdía; ahora abre la puerta y el cierre se hace de verdad.
   */
  desbloqueada?: boolean
}

export function RutaCongelada({ jornada, onIrAlChat, onIrAlCierre, desbloqueada }: PantallaProps) {
  const puedeCerrar = !!desbloqueada && !!onIrAlCierre
  return (
    <div className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
      <div
        className={`flex h-16 w-16 items-center justify-center rounded-full ring-4 ${
          puedeCerrar ? "bg-success/10 ring-success/20" : "bg-info/10 ring-info/20"
        }`}
      >
        {puedeCerrar ? (
          <Lock className="h-8 w-8 text-success" />
        ) : (
          <Snowflake className="h-8 w-8 text-info" />
        )}
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-xl font-bold text-foreground">
          {puedeCerrar ? "Cierra la caja del día anterior" : "Ruta congelada"}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
          La caja del <strong className="text-foreground">{fmtFecha(jornada.fecha)}</strong> quedó
          sin cerrar. Hasta que se resuelva no se puede empezar un día nuevo.
        </p>
        <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
          {puedeCerrar
            ? "La secretaría ya te habilitó. Cierra esa caja y la ruta queda lista para trabajar hoy."
            : "Pídele a la secretaría que te habilite. Apenas lo haga, tú mismo cierras ese día y la ruta se libera. El chat sigue disponible."}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {puedeCerrar && (
          <Button size="lg" className="gap-2" onClick={onIrAlCierre}>
            <Lock className="h-4 w-4" />
            Hacer el cierre del {fmtFecha(jornada.fecha)}
          </Button>
        )}
        {onIrAlChat && (
          <Button size="lg" variant="outline" className="gap-2" onClick={onIrAlChat}>
            <MessageSquare className="h-4 w-4" />
            Ir al chat
          </Button>
        )}
      </div>
    </div>
  )
}

interface AvisoProps {
  jornada: JornadaPendiente
  rutaNombre: string
  usuario: { id: number | string; nombre: string }
  /** Se llama cuando la jornada cambió de estado, para volver a leerlo. */
  onDescongelada: () => void
  /** Lleva al cierre de caja de ESA jornada. Es el camino normal. */
  onIrAlCierre?: () => void
}

/**
 * TRES SALIDAS, Y NO VALEN LO MISMO.
 *
 *  1. HABILITAR AL COBRADOR. Es la normal. No cierra nada: marca la jornada y
 *     el cobrador ve el día viejo en su teléfono con el botón para hacer SU
 *     cierre. Es el que tiene la plata contada, así que es el que cuadra.
 *
 *  2. HACER EL CIERRE acá mismo, si quien está parado en esta ruta es quien va
 *     a cuadrarla.
 *
 *  3. CERRAR SIN CUADRE. La salida de emergencia: una ruta con quince días
 *     viejos encima, o un día del que ya nadie se acuerda. Queda de segunda y
 *     con confirmación de dos toques, porque ese día se pierde — queda cerrado
 *     sin cuadrar para siempre y solo consta quién lo saltó.
 *
 * La 3 era la única que existía, y estaba a un toque.
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

  const [habilitando, setHabilitando] = useState(false)

  const habilitar = async () => {
    if (habilitando || enCurso) return
    setHabilitando(true)
    const r = await habilitarCierreAtrasado(jornada.id, usuario)
    setHabilitando(false)
    if (!r.ok) {
      toast({ title: "No se pudo habilitar", description: r.error, variant: "destructive" })
      return
    }
    toast({
      title: r.modo === "habilitada" ? "Cobrador habilitado" : "Ruta desbloqueada",
      description:
        r.modo === "habilitada"
          ? `Ya puede cerrar la caja del ${fmtFecha(jornada.fecha)} desde su teléfono. Al cerrarla, la ruta queda lista para hoy.`
          : `El ${fmtFecha(jornada.fecha)} quedó cerrado sin cuadre, a tu nombre. Falta correr el script 096.`,
    })
    onDescongelada()
  }

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
        <span className="font-semibold">
          {rutaNombre || "Esta ruta"} {jornada.desbloqueada ? "espera el cierre." : "está congelada."}
        </span>{" "}
        {jornada.desbloqueada
          ? `El cobrador ya está habilitado para cerrar la caja del ${fmtFecha(jornada.fecha)}.`
          : `La caja del ${fmtFecha(jornada.fecha)} quedó sin cerrar y el cobrador no puede empezar hoy.`}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {/* HABILITAR es lo primero y lo normal: no cierra el día, deja que lo
            cierre quien tiene la plata contada. Desaparece una vez hecho. */}
        {!jornada.desbloqueada && (
          <Button size="sm" className="gap-1.5" onClick={habilitar} disabled={habilitando || enCurso}>
            {habilitando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
            {habilitando ? "Habilitando..." : "Habilitar cierre"}
          </Button>
        )}
        {onIrAlCierre && (
          <Button
            size="sm"
            variant={jornada.desbloqueada ? "default" : "outline"}
            className="gap-1.5"
            onClick={onIrAlCierre}
            disabled={enCurso}
          >
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
