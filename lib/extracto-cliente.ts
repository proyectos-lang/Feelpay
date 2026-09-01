"use client"

/**
 * lib/extracto-cliente.ts
 * ---------------------------------------------------------------------------
 * Los movimientos de un crédito, tal como se le muestran a una persona.
 *
 * SOLO EL MOVIMIENTO FINAL, NO CADA CAMBIO
 * El libro (`gestiones`) es INSERT-only: corregir un cobro no edita nada, deja
 * el original, una reversa que lo anula y el valor nuevo. Eso es lo correcto
 * para auditar y es lo que salía en el historial — un pago corregido aparecía
 * dos veces, con dos montos distintos, y el cobrador no tenía cómo saber cuál
 * valía. Acá se descarta lo anulado y queda lo que quedó.
 *
 * Quien necesite ver las correcciones sigue teniéndolas en la base: no se
 * borra nada, solo se deja de mostrar lo que ya no vale.
 *
 * A QUÉ CUOTA PERTENECE CADA MOVIMIENTO
 * A la de SU DÍA, no a la que el evento trae apuntada. Es la regla de oro de
 * los scripts 084 y 085 —la plata se queda en el día en que se pagó— y acá hay
 * que espejarla exactamente, porque `cuota_objetivo` dejó de decidir dónde cae
 * el dinero.
 *
 * No es teórico: el crédito de jorge ricardo herrera tiene un pago del 28/08
 * apuntando a la cuota #22, cuando la del 28/08 es la #11. Mostrar el puntero
 * decía que ese cobro fue de una cuota que vence tres semanas después.
 *
 * La ÚNICA excepción, igual que en la vista: cuando la secretaría clavó la
 * cuota a mano desde Control de Pagos (`origen = 'ajuste'`). Eso es una
 * persona decidiendo, y manda sobre la fecha.
 *
 * VIVE ACÁ Y NO EN LA PANTALLA porque lo usan dos: la lista que se lee en el
 * teléfono y la imagen que se comparte. Si cada una lo armara por su cuenta,
 * el extracto que se manda por WhatsApp podría decir algo distinto del que se
 * está mirando.
 */

import { getSupabaseSafe } from "@/lib/api-helper"

export interface MovimientoExtracto {
  id: string
  /** El día de negocio al que pertenece (YYYY-MM-DD). */
  fecha: string
  /** Número de cuota que el evento saldó. `null` en un abono de venta. */
  numeroCuota: number | null
  /** Lo que vale esa cuota. `null` si el evento no apunta a ninguna. */
  valorCuota: number | null
  /** Lo que entró. 0 en un no pago. */
  pagado: number
  tipo: "pago" | "no_pago" | "cancelacion" | "abono_venta"
}

const CON_PLATA = ["pago", "cancelacion", "abono_venta"] as const

/**
 * Los movimientos que siguen en pie, del más reciente al más viejo.
 *
 * Devuelve `[]` ante cualquier fallo en vez de lanzar: un extracto vacío se
 * entiende, una pantalla rota no.
 */
export async function cargarMovimientosExtracto(loanId: string): Promise<MovimientoExtracto[]> {
  try {
    const supabase = await getSupabaseSafe()

    // Se piden TAMBIÉN las reversas, que no se muestran: son las que dicen
    // qué eventos dejaron de valer. Sin ellas no hay forma de saberlo.
    const [gesRes, planRes] = await Promise.all([
      supabase
        .from("gestiones")
        .select("id, tipo, estado, fecha_gestion, fecha_hora, monto, cuota_objetivo, referencia_gestion_id, origen")
        .eq("loan_id", loanId)
        .eq("estado", "aplicada")
        .order("fecha_gestion", { ascending: false })
        .order("fecha_hora", { ascending: false }),
      supabase
        .from("payment_plan")
        .select("id, numero_cuota, valor_cuota, fecha_pago")
        .eq("loan_id", loanId),
    ])

    if (gesRes.error) throw new Error(gesRes.error.message)

    type Fila = {
      id: string; tipo: string; fecha_gestion: string; fecha_hora: string
      monto: number | null; cuota_objetivo: string | null
      referencia_gestion_id: string | null; origen: string | null
    }
    const eventos = (gesRes.data ?? []) as unknown as Fila[]

    type Cuota = { numero: number; valor: number }
    const porId = new Map<string, Cuota>()
    const porDia = new Map<string, Cuota>()
    for (const p of (planRes.data ?? []) as unknown as
         { id: string; numero_cuota: number; valor_cuota: number; fecha_pago: string }[]) {
      const c: Cuota = { numero: p.numero_cuota, valor: Number(p.valor_cuota) || 0 }
      porId.set(p.id, c)
      porDia.set(p.fecha_pago, c)
    }

    // Lo anulado sale. Un evento con una reversa aplicada apuntándole ya no
    // vale, y la reversa tampoco se muestra: no es un movimiento del cliente,
    // es la corrección de uno.
    const anulados = new Set(
      eventos.filter((g) => g.tipo === "reversa" && g.referencia_gestion_id)
             .map((g) => g.referencia_gestion_id as string),
    )

    return eventos
      .filter((g) => (CON_PLATA as readonly string[]).includes(g.tipo) || g.tipo === "no_pago")
      .filter((g) => !anulados.has(g.id))
      .map((g) => {
        // El mismo criterio de `v_cobertura_cuotas`: manda el día, salvo que
        // la secretaría haya clavado la cuota a mano.
        const c =
          g.origen === "ajuste" && g.cuota_objetivo
            ? porId.get(g.cuota_objetivo)
            : porDia.get(g.fecha_gestion)
        return {
          id: g.id,
          fecha: g.fecha_gestion,
          numeroCuota: c?.numero ?? null,
          valorCuota: c?.valor ?? null,
          pagado: g.tipo === "no_pago" ? 0 : Number(g.monto) || 0,
          tipo: g.tipo as MovimientoExtracto["tipo"],
        }
      })
  } catch (err) {
    console.error("[v0] cargarMovimientosExtracto falló:", err)
    return []
  }
}

/** "01/09/2026" a partir de un YYYY-MM-DD. */
export function fechaCorta(iso: string): string {
  if (!iso || iso.length < 10) return "—"
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
}

export const ETIQUETA_MOVIMIENTO: Record<MovimientoExtracto["tipo"], string> = {
  pago: "Pago",
  no_pago: "No pago",
  cancelacion: "Cancelación",
  abono_venta: "Abono de venta",
}
