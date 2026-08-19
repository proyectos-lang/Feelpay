/**
 * lib/detalle-clientes.ts
 * ---------------------------------------------------------------------------
 * Quiénes son las personas detrás de un número.
 *
 * Los informes muestran contadores —"12 en mora", "5 ventas", "8 diarios"— y
 * hasta ahora ahí se acababa la historia: no había forma de saber a quiénes
 * correspondían. Este helper convierte un conjunto de préstamos en la lista de
 * clientes, con lo que hace falta para reconocerlos y decidir.
 *
 * SE CONSULTA POR `loan_id`, NO POR CRITERIO. Quien pinta el contador ya sabe
 * exactamente qué préstamos lo componen; si acá se repitiera el criterio con
 * una consulta paralela, la lista y el número podrían discrepar — que es
 * justamente lo que un informe no se puede permitir.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

export interface ClienteDetalleRow {
  loanId: string
  clientId: string
  nombre: string
  apodo: string | null
  documento: string
  /** Fecha de la venta, "YYYY-MM-DD". */
  fechaVenta: string | null
  /** Tasa en puntos porcentuales, tal como se guarda. */
  tasaInteres: number
  cuotasCubiertas: number
  cuotasTotales: number
  /** Lo que el cliente debe HOY. */
  saldo: number
  ultimoPago: string | null
  cuotasMora: number
  frecuencia: string | null
  tipoAmortizacion: string | null
  /** Capital prestado — el "valor de la venta". */
  valorVenta: number
  origen: string | null
}

/**
 * PostgREST manda el `.in()` en la URL, y una banda de cartera de una ruta
 * grande puede pasar de 200 UUID: por encima de cierto largo la petición
 * falla, y falla en silencio. Se pide por tandas.
 */
const TANDA = 150

function trocear<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * Devuelve los datos de los clientes de esos préstamos, ordenados por nombre.
 *
 * Nunca lanza: si algo falla devuelve lo que haya podido traer. Un detalle que
 * revienta no puede tumbar la tarjeta que lo abrió.
 */
export async function getDetalleClientes(
  supabase: SupabaseClient,
  loanIds: string[],
): Promise<ClienteDetalleRow[]> {
  const ids = Array.from(new Set(loanIds.filter(Boolean)))
  if (ids.length === 0) return []

  const filas = new Map<string, ClienteDetalleRow>()

  for (const tanda of trocear(ids, TANDA)) {
    try {
      // El join embebido a `clients` funciona desde `loans` porque hay FK
      // real. Desde `v_loan_financiero` NO funcionaría: es una vista y
      // PostgREST no resuelve embeds sin llave foránea.
      const [prestamos, financiero] = await Promise.all([
        supabase
          .from("loans")
          .select(
            "id, client_id, valor, tasa_interes, fecha_creacion, frecuencia_pago, " +
              "tipo_amortizacion, origen, clients:clients(nombre_completo, apodo, documento)",
          )
          .in("id", tanda),
        supabase
          .from("v_loan_financiero")
          .select("loan_id, saldo_hoy, cuotas_mora, cuotas_cubiertas, cuotas_totales, fecha_ultimo_pago")
          .in("loan_id", tanda),
      ])

      if (prestamos.error) throw prestamos.error
      if (financiero.error) console.error("[v0] detalle-clientes financiero:", financiero.error.message)

      const fin = new Map<string, Record<string, unknown>>()
      for (const f of (financiero.data ?? []) as Record<string, unknown>[]) {
        fin.set(String(f.loan_id), f)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const l of (prestamos.data ?? []) as any[]) {
        const f = fin.get(l.id) ?? {}
        filas.set(l.id, {
          loanId: l.id,
          clientId: l.client_id,
          nombre: l.clients?.nombre_completo ?? "Sin nombre",
          apodo: l.clients?.apodo ?? null,
          documento: l.clients?.documento ?? "",
          fechaVenta: l.fecha_creacion ? String(l.fecha_creacion).split("T")[0] : null,
          tasaInteres: Number(l.tasa_interes) || 0,
          cuotasCubiertas: Number(f.cuotas_cubiertas) || 0,
          cuotasTotales: Number(f.cuotas_totales) || 0,
          saldo: Number(f.saldo_hoy) || 0,
          ultimoPago: f.fecha_ultimo_pago ? String(f.fecha_ultimo_pago).split("T")[0] : null,
          cuotasMora: Number(f.cuotas_mora) || 0,
          frecuencia: l.frecuencia_pago ?? null,
          tipoAmortizacion: l.tipo_amortizacion ?? null,
          valorVenta: Number(l.valor) || 0,
          origen: l.origen ?? null,
        })
      }
    } catch (err) {
      console.error("[v0] getDetalleClientes:", err)
    }
  }

  return Array.from(filas.values()).sort((a, b) =>
    (a.apodo || a.nombre).localeCompare(b.apodo || b.nombre, "es"),
  )
}
