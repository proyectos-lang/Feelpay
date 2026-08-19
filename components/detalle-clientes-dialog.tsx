"use client"

/**
 * Detalle de clientes
 * -------------------
 * El "ojito" de los informes: convierte un contador en la lista de personas
 * que lo componen.
 *
 * Vive en `components/` y no en `components/views/` porque lo usan varias
 * vistas distintas (Resumen del Día, Monitoreo de Rutas).
 *
 * Recibe los `loanIds` YA resueltos por quien pintó el número. No repite el
 * criterio: así la lista y el contador no pueden discrepar.
 *
 * OJO CON EL MONTAJE: en `daily-summary` la tarjeta usa una transformación 3D
 * (`perspective` + `preserve-3d` + `rotateY`). Este diálogo debe montarse
 * FUERA de ese contenedor, o queda sometido a la rotación y se ve espejado o
 * directamente no se ve.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertCircle, Search } from "lucide-react"
import { getSupabaseSafe } from "@/lib/api-helper"
import { getDetalleClientes, type ClienteDetalleRow } from "@/lib/detalle-clientes"
import { fmtFecha, fmtMoneda, etiquetaMora, colorMora } from "@/lib/gestion-core"

export interface DetalleClientesDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  titulo: string
  subtitulo?: string
  /** Los préstamos que componen el número. */
  loanIds: string[]
  /** Se marcan con una insignia (p. ej. los que ya pagaron hoy). */
  marcados?: Set<string>
  etiquetaMarcado?: string
  /** Agrega la columna del capital prestado (detalle de ventas). */
  mostrarValorVenta?: boolean
}

const TONO_MORA: Record<string, string> = {
  verde: "text-green-700",
  amarillo: "text-amber-600",
  rojo: "text-red-600",
}

export function DetalleClientesDialog({
  open,
  onOpenChange,
  titulo,
  subtitulo,
  loanIds,
  marcados,
  etiquetaMarcado = "Pagó",
  mostrarValorVenta = false,
}: DetalleClientesDialogProps) {
  const [filas, setFilas] = useState<ClienteDetalleRow[]>([])
  const [cargando, setCargando] = useState(false)
  const [busqueda, setBusqueda] = useState("")
  // Token monotónico: si el usuario abre un ojito y enseguida otro, la
  // respuesta lenta del primero no debe pisar la del segundo.
  const tokenRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const mio = ++tokenRef.current
    setBusqueda("")
    setCargando(true)
    ;(async () => {
      try {
        const supabase = await getSupabaseSafe()
        const data = await getDetalleClientes(supabase, loanIds)
        if (tokenRef.current === mio) setFilas(data)
      } catch (err) {
        console.error("[v0] DetalleClientesDialog:", err)
        if (tokenRef.current === mio) setFilas([])
      } finally {
        if (tokenRef.current === mio) setCargando(false)
      }
    })()
  }, [open, loanIds])

  const visibles = useMemo(() => {
    const t = busqueda.trim().toLowerCase()
    if (!t) return filas
    return filas.filter(
      (f) =>
        (f.apodo ?? "").toLowerCase().includes(t) ||
        f.nombre.toLowerCase().includes(t) ||
        f.documento.includes(t),
    )
  }, [filas, busqueda])

  const saldoTotal = visibles.reduce((s, f) => s + f.saldo, 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col p-4">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-base md:text-lg">{titulo}</DialogTitle>
          <DialogDescription className="text-xs md:text-sm">
            {subtitulo ?? `${loanIds.length} ${loanIds.length === 1 ? "cliente" : "clientes"}`}
          </DialogDescription>
        </DialogHeader>

        {/* El buscador solo aparece cuando la lista es larga: con 5 filas
            estorba más de lo que ayuda. */}
        {filas.length > 15 && (
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nombre o documento..."
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
        )}

        <div className="flex-1 overflow-auto -mx-1 px-1">
          {cargando ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : visibles.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <AlertCircle className="h-8 w-8 opacity-40" />
              <span className="text-sm">
                {busqueda ? "Ningún cliente coincide con la búsqueda." : "No hay clientes en este grupo."}
              </span>
            </div>
          ) : (
            <>
              {/* Escritorio: tabla completa */}
              <table className="hidden md:table w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-2 font-medium">Cliente</th>
                    <th className="py-1.5 px-2 font-medium">Venta</th>
                    <th className="py-1.5 px-2 font-medium text-right">%</th>
                    {mostrarValorVenta && <th className="py-1.5 px-2 font-medium text-right">Prestado</th>}
                    <th className="py-1.5 px-2 font-medium text-center">Cuotas</th>
                    <th className="py-1.5 px-2 font-medium text-right">Saldo</th>
                    <th className="py-1.5 px-2 font-medium">Último pago</th>
                    <th className="py-1.5 pl-2 font-medium text-right">Mora</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((f) => (
                    <tr key={f.loanId} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="py-1.5 pr-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium">{f.apodo || f.nombre}</span>
                          {marcados?.has(f.loanId) && (
                            <Badge className="bg-green-100 text-green-800 border-green-200 text-[9px] px-1.5 py-0">
                              {etiquetaMarcado}
                            </Badge>
                          )}
                          {f.origen === "homologado" && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-violet-300 text-violet-700">
                              homologada
                            </Badge>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground">{f.documento}</span>
                      </td>
                      <td className="py-1.5 px-2 text-xs">{fmtFecha(f.fechaVenta)}</td>
                      <td className="py-1.5 px-2 text-right text-xs">{f.tasaInteres}%</td>
                      {mostrarValorVenta && (
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtMoneda(f.valorVenta)}</td>
                      )}
                      <td className="py-1.5 px-2 text-center text-xs tabular-nums">
                        {f.cuotasCubiertas}/{f.cuotasTotales}
                      </td>
                      <td className="py-1.5 px-2 text-right font-semibold tabular-nums">{fmtMoneda(f.saldo)}</td>
                      <td className="py-1.5 px-2 text-xs">{f.ultimoPago ? fmtFecha(f.ultimoPago) : "—"}</td>
                      <td className={`py-1.5 pl-2 text-right text-xs font-medium ${TONO_MORA[colorMora(f.cuotasMora)]}`}>
                        {f.cuotasMora > 0 ? etiquetaMora(f.cuotasMora) : "al día"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Móvil: los mismos datos apilados. Siete columnas en 360px
                  son ilegibles, y esto se usa sobre todo en el teléfono. */}
              <ul className="md:hidden divide-y">
                {visibles.map((f) => (
                  <li key={f.loanId} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-medium truncate">{f.apodo || f.nombre}</span>
                          {marcados?.has(f.loanId) && (
                            <Badge className="bg-green-100 text-green-800 border-green-200 text-[9px] px-1.5 py-0">
                              {etiquetaMarcado}
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {f.documento} · venta {fmtFecha(f.fechaVenta)} · {f.tasaInteres}%
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold tabular-nums">{fmtMoneda(f.saldo)}</p>
                        <p className={`text-[10px] font-medium ${TONO_MORA[colorMora(f.cuotasMora)]}`}>
                          {f.cuotasMora > 0 ? `${etiquetaMora(f.cuotasMora)} en mora` : "al día"}
                        </p>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Cuotas {f.cuotasCubiertas}/{f.cuotasTotales}
                      {mostrarValorVenta && ` · prestado ${fmtMoneda(f.valorVenta)}`}
                      {" · último pago "}
                      {f.ultimoPago ? fmtFecha(f.ultimoPago) : "—"}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {!cargando && visibles.length > 0 && (
          <div className="flex items-center justify-between border-t pt-2 text-xs">
            <span className="text-muted-foreground">
              {visibles.length} {visibles.length === 1 ? "cliente" : "clientes"}
              {busqueda && filas.length !== visibles.length && ` de ${filas.length}`}
            </span>
            <span className="font-semibold">Saldo total {fmtMoneda(saldoTotal)}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
