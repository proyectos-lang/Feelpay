"use client"

import { useState, useCallback, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Search,
  RefreshCw,
  Trash2,
  Loader2,
  ShoppingCart,
  AlertTriangle,
  Calendar,
  User,
} from "lucide-react"

// ── Types ────────────────────────────────────────────────────────────────────
type LoanRow = {
  id: string
  client_id: string
  valor: number
  saldo: number
  valor_a_pagar: number
  valor_cuota: number
  tasa_interes: number
  numero_cuotas: number
  frecuencia_pago: string
  dia_semana: string | null
  tipo_venta: string | null
  estado: string | null
  fecha_creacion: string | null
  clients: {
    nombre_completo: string | null
    apodo: string | null
  } | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatCurrency(val: number | null | undefined): string {
  if (val == null) return "$0"
  return `$${Number(val).toLocaleString("es-CO")}`
}

function formatFecha(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return d.toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Bogota",
  })
}

function capitalize(str: string | null | undefined): string {
  if (!str) return "—"
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

// ── Component ────────────────────────────────────────────────────────────────
interface ViewLoansProps {
  currentRutaId?: number
}

export function ViewLoans({ currentRutaId }: ViewLoansProps) {
  const [loans, setLoans] = useState<LoanRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [filterEstado, setFilterEstado] = useState<"todos" | "activo" | "cancelado">("todos")

  // Delete confirm dialog
  const [deleteTarget, setDeleteTarget] = useState<LoanRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchLoans = useCallback(async () => {
    try {
      setLoading(true)
      const supabase = createClient()

      let query = supabase
        .from("loans")
        .select(
          `id, client_id, valor, saldo, valor_a_pagar, valor_cuota,
           tasa_interes, numero_cuotas, frecuencia_pago, dia_semana,
           tipo_venta, estado, fecha_creacion,
           clients:clients(nombre_completo, apodo)`,
        )
        .order("fecha_creacion", { ascending: false })

      if (currentRutaId) {
        query = query.eq("ruta", currentRutaId)
      }

      if (filterEstado !== "todos") {
        query = query.eq("estado", filterEstado)
      }

      const { data, error } = await query

      if (error) {
        console.error("[v0] Error fetching loans:", error.message)
        setLoans([])
      } else {
        setLoans((data ?? []) as unknown as LoanRow[])
      }
    } catch (err) {
      console.error("[v0] fetchLoans exception:", err)
      setLoans([])
    } finally {
      setLoading(false)
    }
  }, [currentRutaId, filterEstado])

  useEffect(() => {
    fetchLoans()
  }, [fetchLoans])

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      setDeleteError(null)
      const supabase = createClient()
      const { error } = await supabase.from("loans").delete().eq("id", deleteTarget.id)
      if (error) {
        console.error("[v0] Error deleting loan:", error.message)
        setDeleteError("No se pudo eliminar la venta. " + error.message)
        return
      }
      setLoans((prev) => prev.filter((l) => l.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (err) {
      console.error("[v0] handleDelete exception:", err)
      setDeleteError("Ocurrió un error inesperado.")
    } finally {
      setDeleting(false)
    }
  }

  // ── Filtered list ──────────────────────────────────────────────────────────
  const filtered = loans.filter((l) => {
    const nombre =
      l.clients?.apodo || l.clients?.nombre_completo || ""
    return nombre.toLowerCase().includes(search.toLowerCase())
  })

  const totalVentas = filtered.length
  const totalValor = filtered.reduce((acc, l) => acc + Number(l.valor_a_pagar), 0)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground md:text-2xl">Ver Ventas</h2>
          <p className="text-sm text-muted-foreground">
            {totalVentas} {totalVentas === 1 ? "venta" : "ventas"} ·{" "}
            Total {formatCurrency(totalValor)}
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={fetchLoans}
          disabled={loading}
          title="Actualizar"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Filters */}
      <Card className="border-border/60">
        <CardHeader className="pb-3 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por nombre de cliente..."
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Estado filter */}
            <div className="flex gap-1.5">
              {(["todos", "activo", "cancelado"] as const).map((e) => (
                <Button
                  key={e}
                  size="sm"
                  variant={filterEstado === e ? "default" : "outline"}
                  className="capitalize"
                  onClick={() => setFilterEstado(e)}
                >
                  {e === "todos" ? "Todos" : capitalize(e)}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading ? (
            <div className="flex h-[300px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-[300px] flex-col items-center justify-center gap-2 text-center">
              <ShoppingCart className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm font-medium text-muted-foreground">
                No se encontraron ventas
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cliente</TableHead>
                    <TableHead className="text-right">Valor Venta</TableHead>
                    <TableHead className="text-right">Vlr Cuota</TableHead>
                    <TableHead className="text-center">Tasa %</TableHead>
                    <TableHead className="text-center">Cuotas</TableHead>
                    <TableHead>Frecuencia</TableHead>
                    <TableHead>Día</TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-center w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((loan) => {
                    const nombre =
                      loan.clients?.apodo ||
                      loan.clients?.nombre_completo ||
                      "Sin nombre"
                    const isActivo =
                      (loan.estado ?? "").toLowerCase() === "activo"

                    return (
                      <TableRow key={loan.id} className="group">
                        {/* Cliente */}
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10">
                              <User className="h-3.5 w-3.5 text-brand" />
                            </div>
                            <div className="flex flex-col">
                              <span className="text-sm font-semibold leading-tight">
                                {nombre}
                              </span>
                              {loan.clients?.apodo &&
                                loan.clients?.nombre_completo && (
                                  <span className="text-[11px] text-muted-foreground leading-tight">
                                    {loan.clients.nombre_completo}
                                  </span>
                                )}
                            </div>
                          </div>
                        </TableCell>

                        {/* Valor venta */}
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatCurrency(loan.valor_a_pagar)}
                        </TableCell>

                        {/* Valor cuota */}
                        <TableCell className="text-right tabular-nums text-sm">
                          {formatCurrency(loan.valor_cuota)}
                        </TableCell>

                        {/* Tasa */}
                        <TableCell className="text-center tabular-nums text-sm">
                          {loan.tasa_interes}%
                        </TableCell>

                        {/* Cuotas */}
                        <TableCell className="text-center tabular-nums text-sm font-medium">
                          {loan.numero_cuotas}
                        </TableCell>

                        {/* Frecuencia */}
                        <TableCell className="text-sm capitalize">
                          {capitalize(loan.frecuencia_pago)}
                        </TableCell>

                        {/* Día semana */}
                        <TableCell className="text-sm capitalize">
                          {capitalize(loan.dia_semana)}
                        </TableCell>

                        {/* Fecha creación */}
                        <TableCell>
                          <div className="flex items-center gap-1 text-sm text-muted-foreground">
                            <Calendar className="h-3.5 w-3.5 shrink-0" />
                            {formatFecha(loan.fecha_creacion)}
                          </div>
                        </TableCell>

                        {/* Estado */}
                        <TableCell>
                          <Badge
                            className={
                              isActivo
                                ? "border-0 bg-success/15 text-success"
                                : "border-0 bg-muted text-muted-foreground"
                            }
                          >
                            {capitalize(loan.estado)}
                          </Badge>
                        </TableCell>

                        {/* Eliminar */}
                        <TableCell className="text-center">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                              setDeleteError(null)
                              setDeleteTarget(loan)
                            }}
                            title="Eliminar venta"
                            aria-label="Eliminar venta"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Eliminar Venta
            </DialogTitle>
            <DialogDescription>
              ¿Estás seguro de que deseas eliminar la venta de{" "}
              <strong>
                {deleteTarget?.clients?.apodo ||
                  deleteTarget?.clients?.nombre_completo ||
                  "este cliente"}
              </strong>{" "}
              por{" "}
              <strong>{formatCurrency(deleteTarget?.valor_a_pagar)}</strong>?
              Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              <p className="text-xs text-destructive">{deleteError}</p>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              className="flex-1 gap-1.5"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              {deleting ? "Eliminando..." : "Eliminar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
