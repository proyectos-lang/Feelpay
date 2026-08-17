"use client"

/**
 * El guard de "Ruta no iniciada" y el botón que la abre.
 *
 * Vive acá y no dentro de una pantalla porque ahora lo usan dos: el módulo de
 * pagos (que además exige la ruta ABIERTA para poder cobrar) y el bloqueo
 * global de los vendedores, que no pueden entrar a ningún módulo antes de
 * iniciar la jornada. Dos copias de esta lógica terminarían discrepando en
 * cuándo se considera abierta una ruta.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AlertCircle, Loader2, Play } from "lucide-react"
import { getSupabaseSafe } from "@/lib/api-helper"
import { useToast } from "@/hooks/use-toast"
import { todayColombia } from "@/lib/colombia-date"

export type EstadoRuta = "abierta" | "cerrada" | null

interface Props {
  rutaId: number
  /** false = el padre todavía no sabe el estado: se muestra un spinner. */
  resuelto: boolean
  estado: EstadoRuta
  onEstadoChange?: (estado: EstadoRuta) => void
  /** Qué se está bloqueando, para que el mensaje diga algo concreto. */
  mensaje: string
  /** Si viene, se ofrece el atajo al Resumen del Día. */
  onIrAResumen?: () => void
}

export function RutaNoIniciada({
  rutaId, resuelto, estado, onEstadoChange, mensaje, onIrAResumen,
}: Props) {
  const { toast } = useToast()
  const [iniciando, setIniciando] = useState(false)

  /**
   * Abrir la jornada. Es idempotente: si la fila ya existe (otra pestaña, otro
   * dispositivo, o el Resumen del Día) recupera el estado real con un SELECT y
   * sincroniza el guard, en vez de fallarle al usuario.
   */
  const iniciarRuta = async () => {
    if (iniciando) return

    // Abrir la jornada SÍ necesita servidor: es la fila que después consultan
    // el cierre de caja y el monitoreo del admin, y encolarla dejaría a dos
    // dispositivos creyendo cada uno que abrió la ruta. Lo que sí funciona sin
    // señal es SEGUIR trabajando una ruta ya abierta.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      toast({
        title: "Sin conexión",
        description:
          "Para iniciar la ruta necesitas señal. Si ya la habías iniciado hoy, vuelve a abrir la app con señal una vez y podrás seguir trabajando sin conexión.",
        variant: "destructive",
      })
      return
    }

    try {
      setIniciando(true)
      const supabase = await getSupabaseSafe()
      const fechaHoy = todayColombia()

      // 1) ¿Ya existe una fila para hoy?
      const { data: existente, error: errorSelect } = await supabase
        .from("rutas_diarias")
        .select("id, estado")
        .eq("ruta_id", rutaId)
        .eq("fecha", fechaHoy)
        .maybeSingle()

      if (errorSelect) {
        console.error("[v0] Error consultando rutas_diarias:", errorSelect.message)
      }

      if (existente) {
        const estadoExistente = (existente as { estado: string | null }).estado as EstadoRuta
        if (estadoExistente === "abierta") {
          onEstadoChange?.("abierta")
          toast({ title: "Ruta ya iniciada", description: "La ruta ya estaba abierta para hoy. Sincronizando..." })
          return
        }
        if (estadoExistente === "cerrada") {
          onEstadoChange?.("cerrada")
          toast({
            title: "La ruta del día está cerrada",
            description: "Contacta al administrador para reabrir la ruta.",
            variant: "destructive",
          })
          return
        }
      }

      // 2) No existe — insertar.
      const { data, error } = await supabase
        .from("rutas_diarias")
        .insert({ ruta_id: rutaId, fecha: fechaHoy, estado: "abierta" })
        .select("id, estado")
        .single()

      if (error) {
        // 23505 = otra petición la creó entre nuestro SELECT y nuestro INSERT.
        const esDuplicado =
          (error as { code?: string }).code === "23505" ||
          /unique_ruta_por_dia|duplicate key/i.test(error.message)

        if (esDuplicado) {
          const { data: refetch } = await supabase
            .from("rutas_diarias")
            .select("estado")
            .eq("ruta_id", rutaId)
            .eq("fecha", fechaHoy)
            .maybeSingle()
          const e = ((refetch as { estado: string | null } | null)?.estado ?? null) as EstadoRuta
          if (e) onEstadoChange?.(e)
          toast({
            title: e === "abierta" ? "Ruta ya iniciada" : "Sincronizando estado de ruta",
            description:
              e === "abierta"
                ? "La ruta ya estaba abierta para hoy."
                : "Se actualizó el estado actual de la ruta.",
          })
          return
        }

        console.error("[v0] Error iniciando ruta:", error.message)
        toast({ title: "No se pudo iniciar la ruta", description: error.message, variant: "destructive" })
        return
      }

      if (data) {
        onEstadoChange?.("abierta")
        toast({ title: "Ruta iniciada", description: "Ya puedes trabajar normalmente." })
      }
    } catch (err) {
      console.error("[v0] Unexpected error iniciando ruta:", err)
    } finally {
      setIniciando(false)
    }
  }

  // Mientras el padre no haya resuelto el estado se muestra un spinner neutro
  // y no el guard: si no, cada recarga hace un flash de "Ruta no iniciada"
  // sobre una ruta que sí está abierta.
  if (!resuelto && estado === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Verificando estado de la ruta...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/10 ring-4 ring-warning/20">
        <AlertCircle className="h-8 w-8 text-warning" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-xl font-bold text-foreground">
          {estado === "cerrada" ? "Ruta cerrada" : "Ruta no iniciada"}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
          {estado === "cerrada"
            ? "La jornada de hoy ya se cerró. Contacta al administrador si necesitas reabrirla."
            : mensaje}
        </p>
      </div>
      {estado !== "cerrada" && (
        <div className="flex flex-col items-center gap-2 sm:flex-row">
          <Button
            size="lg"
            className="gap-2 bg-success text-success-foreground hover:bg-success/90"
            onClick={iniciarRuta}
            disabled={iniciando}
          >
            {iniciando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {iniciando ? "Iniciando..." : "Iniciar Ruta"}
          </Button>
          {onIrAResumen && (
            <Button size="lg" variant="outline" className="gap-2" onClick={onIrAResumen} disabled={iniciando}>
              Ir a Resumen del Día
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
