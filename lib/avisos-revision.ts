"use client"

/**
 * lib/avisos-revision.ts
 * ---------------------------------------------------------------------------
 * Avisar por push a quien puede aprobar un movimiento que quedó en revisión.
 *
 * Es el único canal que llega con la app CERRADA: el badge y el toast del
 * módulo solo funcionan si la persona la tiene abierta en ese momento, y una
 * venta podía quedarse días esperando sin que nadie se enterara.
 *
 * Vivía dentro de `new-loan.tsx`. Salió acá cuando la decisión del umbral bajó
 * al servidor (script 061): ahora una venta capturada SIN SEÑAL se decide al
 * drenar la cola, y ese aviso tiene que salir desde la cola, no desde el
 * formulario que ya se cerró hace horas.
 *
 * De mejor esfuerzo a propósito: si el push falla, la solicitud YA quedó
 * registrada y sigue visible en la bandeja. Nunca debe romper la operación.
 */

import { createClient } from "@/lib/supabase/client"

const ROLES_APROBADORES = ["secretaria", "secretario", "admin", "administrador"]

export async function avisarSolicitudPendiente(args: {
  /** "Venta", "Renovación", "Abono"… encabeza la notificación. */
  etiqueta: string
  monto?: number
  cliente?: string
  rutaId?: number
  /** Reemplaza el cuerpo armado con monto/cliente/ruta. */
  detalle?: string
}): Promise<void> {
  try {
    const { data } = await createClient()
      .from("usuarios")
      .select("id")
      .in("rol", ROLES_APROBADORES)
      .eq("activo", true)
    const ids = (data ?? []).map((u: { id: number }) => u.id)
    if (ids.length === 0) return

    const cuerpo =
      args.detalle ??
      [
        args.cliente,
        args.monto !== undefined ? `$${args.monto.toLocaleString()}` : null,
        args.rutaId !== undefined ? `(ruta ${args.rutaId})` : null,
      ]
        .filter(Boolean)
        .join(" — ")

    await fetch("/api/push/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_ids: ids,
        title: `${args.etiqueta} por aprobar`,
        body: cuerpo,
        tag: "solicitudes-revision",
        url: "/?view=movimientos-revision",
      }),
    })
  } catch (err) {
    console.error("[v0] No se pudo avisar de la solicitud pendiente:", err)
  }
}
