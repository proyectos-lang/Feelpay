"use client"

/**
 * Control de Pagos
 * ----------------
 * Modulo administrativo que permite visualizar el historial COMPLETO del
 * payment_plan de un prestamo (cuota a cuota) y editar manualmente los
 * campos clave: fecha_pago, valor_cuota, estado y monto_pagado.
 *
 * Flujo:
 *   1. El usuario busca un prestamo por apodo, documento o ID.
 *   2. Selecciona uno de la lista filtrada.
 *   3. Se carga el plan completo (todas las cuotas) y se muestra en tabla.
 *   4. Cada fila puede entrar en modo "edicion" para modificar los 4 campos.
 *   5. Al guardar, se hace UPDATE directo en `payment_plan` (sin RPC).
 *
 * NOTA: La edicion manual NO recalcula saldos del loan ni dispara la logica
 * de cancelacion automatica. Es una herramienta de correccion administrativa
 * y debe usarse con cuidado.
 */

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { getSupabaseSafe } from "@/lib/api-helper"
import {
  Search,
  ChevronLeft,
  Edit2,
  Save,
  X,
  Calendar,
  DollarSign,
  User,
  MapPin,
  CreditCard,
  Loader2,
  AlertCircle,
} from "lucide-react"

interface PaymentControlProps {
  currentRutaId: number
  rutaPais?: string
}

// Estructura plana del listado de prestamos (solo lo que se muestra al
// buscar). Se construye con un join cliente <- loan.
interface LoanSummary {
  id: string
  monto_prestamo: number
  total_cuotas: number
  estado: string
  fecha_inicio: string
  tipo_amortizacion: string | null
  cliente: {
    nombre_completo: string
    apodo: string | null
    documento: string
  }
}

// Una fila de payment_plan tal como se edita.
interface CuotaRow {
  id: string
  numero_cuota: number
  fecha_pago: string
  valor_cuota: number
  estado: string
  monto_pagado: number | null
  fecha_pago_real: string | null
  capital: number | null
}

// Estados visualmente distinguibles (badge color + label).
const ESTADO_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pagado: { label: "Pagado", variant: "default" },
  pendiente: { label: "Pendiente", variant: "secondary" },
  no_pago: { label: "No pago", variant: "destructive" },
  parcial: { label: "Parcial", variant: "outline" },
  cancelada: { label: "Cancelada", variant: "default" },
}

// Helper de formato moneda — Colombia.
const fmtCOP = (n: number | null | undefined) =>
  n == null ? "-" : `$${Number(n).toLocaleString("es-CO")}`

// Convierte un valor de fecha (puede ser ISO date YYYY-MM-DD o timestamp
// con hora YYYY-MM-DDTHH:mm:ss...) a etiqueta humana corta. Cuando solo
// hay fecha la construimos como local para no arrastrar UTC.
const fmtFecha = (s: string | null | undefined) => {
  if (!s) return "-"
  const onlyDate = s.split("T")[0]
  const [y, m, d] = onlyDate.split("-").map(Number)
  if (!y || !m || !d) return "-"
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
}

export function PaymentControl({ currentRutaId, rutaPais }: PaymentControlProps) {
  const { toast } = useToast()

  // ── Estado de busqueda y lista ────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState("")
  const [loans, setLoans] = useState<LoanSummary[]>([])
  const [loadingLoans, setLoadingLoans] = useState(true)

  // ── Estado del prestamo seleccionado ─────────────────────────────────
  const [selectedLoan, setSelectedLoan] = useState<LoanSummary | null>(null)
  const [cuotas, setCuotas] = useState<CuotaRow[]>([])
  const [loadingCuotas, setLoadingCuotas] = useState(false)

  // Edicion: id de la fila en edicion + buffer del form.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState<Partial<CuotaRow>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  // ── Cargar lista de prestamos de la ruta ─────────────────────────────
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoadingLoans(true)
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("loans")
          .select(
            "id, valor, numero_cuotas, estado, fecha_creacion, tipo_amortizacion, clients:clients(nombre_completo, apodo, documento)",
          )
          .eq("ruta", currentRutaId)
          .order("fecha_creacion", { ascending: false })

        if (cancelled) return
        if (error) throw error

        const mapped: LoanSummary[] = (data ?? []).map((l: any) => ({
          id: l.id,
          // Esquema real:
          //   loans.valor          → monto del prestamo
          //   loans.numero_cuotas  → cantidad de cuotas
          //   loans.fecha_creacion → timestamp de creacion (lo usamos como
          //                          "fecha de inicio" en la UI)
          monto_prestamo: Number(l.valor ?? 0),
          total_cuotas: Number(l.numero_cuotas ?? 0),
          estado: l.estado ?? "",
          fecha_inicio: l.fecha_creacion ?? "",
          tipo_amortizacion: l.tipo_amortizacion ?? null,
          cliente: {
            nombre_completo: l.clients?.nombre_completo ?? "",
            apodo: l.clients?.apodo ?? null,
            documento: l.clients?.documento ?? "",
          },
        }))
        setLoans(mapped)
      } catch (err) {
        console.error("[v0] PaymentControl loadLoans error:", err)
        toast({
          title: "Error",
          description: err instanceof Error ? err.message : "No se pudieron cargar los préstamos.",
          variant: "destructive",
        })
      } finally {
        if (!cancelled) setLoadingLoans(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [currentRutaId, toast])

  // ── Filtrado en cliente por apodo/documento/ID ────────────────────────
  const filteredLoans = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return loans.slice(0, 50) // limite sano cuando no hay busqueda
    return loans.filter((l) => {
      return (
        l.cliente.apodo?.toLowerCase().includes(term) ||
        l.cliente.nombre_completo.toLowerCase().includes(term) ||
        l.cliente.documento.toLowerCase().includes(term) ||
        l.id.toLowerCase().includes(term)
      )
    })
  }, [loans, searchTerm])

  // ── Cargar cuotas del prestamo seleccionado ──────────────────────────
  const loadCuotas = async (loanId: string) => {
    setLoadingCuotas(true)
    setEditingId(null)
    setEditBuffer({})
    try {
      const supabase = await getSupabaseSafe()
      const { data, error } = await supabase
        .from("payment_plan")
        .select("id, numero_cuota, fecha_pago, valor_cuota, estado, monto_pagado, fecha_pago_real, capital")
        .eq("loan_id", loanId)
        .order("numero_cuota", { ascending: true })

      if (error) throw error

      const mapped: CuotaRow[] = (data ?? []).map((r: any) => ({
        id: r.id,
        numero_cuota: Number(r.numero_cuota ?? 0),
        fecha_pago: r.fecha_pago ?? "",
        valor_cuota: Number(r.valor_cuota ?? 0),
        estado: r.estado ?? "pendiente",
        monto_pagado: r.monto_pagado != null ? Number(r.monto_pagado) : null,
        fecha_pago_real: r.fecha_pago_real ?? null,
        capital: r.capital != null ? Number(r.capital) : null,
      }))
      setCuotas(mapped)
    } catch (err) {
      console.error("[v0] PaymentControl loadCuotas error:", err)
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "No se pudieron cargar las cuotas.",
        variant: "destructive",
      })
    } finally {
      setLoadingCuotas(false)
    }
  }

  const handleSelectLoan = (l: LoanSummary) => {
    setSelectedLoan(l)
    loadCuotas(l.id)
  }

  const handleBack = () => {
    setSelectedLoan(null)
    setCuotas([])
    setEditingId(null)
    setEditBuffer({})
  }

  // ── Iniciar edicion de una fila ───────────────────────────────────────
  const startEdit = (row: CuotaRow) => {
    setEditingId(row.id)
    setEditBuffer({
      fecha_pago: row.fecha_pago,
      valor_cuota: row.valor_cuota,
      estado: row.estado,
      monto_pagado: row.monto_pagado,
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditBuffer({})
  }

  // ── Guardar cambios de la fila editada ───────────────────────────────
  const saveEdit = async (row: CuotaRow) => {
    setSavingId(row.id)
    try {
      // Validacion basica: si el estado es "pagado" o "parcial" debe haber
      // monto_pagado > 0; si es "pendiente" forzamos monto_pagado a null
      // para mantener consistencia.
      const newEstado = (editBuffer.estado as string) ?? row.estado
      let newMonto = editBuffer.monto_pagado as number | null | undefined
      if (typeof newMonto === "string") newMonto = Number(newMonto)
      if (Number.isNaN(newMonto as number)) newMonto = null

      if (newEstado === "pendiente") {
        newMonto = null
      } else if ((newEstado === "pagado" || newEstado === "parcial") && (!newMonto || newMonto <= 0)) {
        toast({
          title: "Monto requerido",
          description: 'Para estado "Pagado" o "Parcial" el monto pagado debe ser mayor a 0.',
          variant: "destructive",
        })
        setSavingId(null)
        return
      }

      const newValor = Number(editBuffer.valor_cuota ?? row.valor_cuota)
      if (!Number.isFinite(newValor) || newValor < 0) {
        toast({
          title: "Valor inválido",
          description: "El valor de la cuota debe ser un número >= 0.",
          variant: "destructive",
        })
        setSavingId(null)
        return
      }

      const newFecha = (editBuffer.fecha_pago as string) ?? row.fecha_pago
      if (!newFecha) {
        toast({
          title: "Fecha requerida",
          description: "Debes ingresar una fecha de pago válida.",
          variant: "destructive",
        })
        setSavingId(null)
        return
      }

      const supabase = await getSupabaseSafe()
      const updatePayload: Record<string, unknown> = {
        fecha_pago: newFecha,
        valor_cuota: newValor,
        estado: newEstado,
        monto_pagado: newMonto,
      }
      // Si pasamos a "pagado" y no habia fecha real, sembramos hoy.
      if (newEstado === "pagado" && !row.fecha_pago_real) {
        const today = new Date().toLocaleDateString("en-CA")
        updatePayload.fecha_pago_real = today
      }
      // Si volvemos a "pendiente", limpiamos la fecha real para no
      // dejar registros incoherentes.
      if (newEstado === "pendiente") {
        updatePayload.fecha_pago_real = null
      }

      const { error } = await supabase
        .from("payment_plan")
        .update(updatePayload)
        .eq("id", row.id)

      if (error) throw error

      toast({
        title: "Cuota actualizada",
        description: `La cuota #${row.numero_cuota} se actualizó correctamente.`,
      })
      setEditingId(null)
      setEditBuffer({})
      // Refrescamos solo este loan.
      if (selectedLoan) await loadCuotas(selectedLoan.id)
    } catch (err) {
      console.error("[v0] PaymentControl saveEdit error:", err)
      toast({
        title: "Error al guardar",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      })
    } finally {
      setSavingId(null)
    }
  }

  // ── Resumen del prestamo seleccionado ────────────────────────────────
  const resumen = useMemo(() => {
    if (!selectedLoan || cuotas.length === 0) return null
    const pagadas = cuotas.filter((c) => c.estado === "pagado" || c.estado === "cancelada").length
    const pendientes = cuotas.filter((c) => c.estado === "pendiente").length
    const totalPagado = cuotas.reduce((s, c) => s + (c.monto_pagado ?? 0), 0)
    const totalProgramado = cuotas.reduce((s, c) => s + c.valor_cuota, 0)
    return { pagadas, pendientes, totalPagado, totalProgramado }
  }, [selectedLoan, cuotas])

  // ─────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────

  // --- Vista DETALLE: cuotas del prestamo seleccionado ------------------
  if (selectedLoan) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1">
            <ChevronLeft className="h-4 w-4" />
            Volver
          </Button>
          <h1 className="text-xl md:text-2xl font-bold">Control de Pagos</h1>
        </div>

        {/* Tarjeta resumen del prestamo */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base md:text-lg">
              <CreditCard className="h-5 w-5" />
              Información del préstamo
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="flex items-start gap-2">
                <User className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-[11px] text-muted-foreground">Cliente</div>
                  <div className="font-semibold truncate">
                    {selectedLoan.cliente.apodo || selectedLoan.cliente.nombre_completo}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {selectedLoan.cliente.documento}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div>
                  <div className="text-[11px] text-muted-foreground">Ruta</div>
                  <div className="font-semibold">{rutaPais ?? `#${currentRutaId}`}</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <DollarSign className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div>
                  <div className="text-[11px] text-muted-foreground">Monto / Plazo</div>
                  <div className="font-semibold">{fmtCOP(selectedLoan.monto_prestamo)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {selectedLoan.total_cuotas} cuotas
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Calendar className="h-4 w-4 mt-0.5 text-muted-foreground" />
                <div>
                  <div className="text-[11px] text-muted-foreground">Estado</div>
                  <Badge variant={selectedLoan.estado === "activo" ? "default" : "secondary"}>
                    {selectedLoan.estado}
                  </Badge>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Inicio: {fmtFecha(selectedLoan.fecha_inicio)}
                  </div>
                </div>
              </div>
            </div>

            {resumen && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-4 border-t text-sm">
                <div>
                  <div className="text-[11px] text-muted-foreground">Cuotas pagadas</div>
                  <div className="font-semibold text-green-600">{resumen.pagadas}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Pendientes</div>
                  <div className="font-semibold text-amber-600">{resumen.pendientes}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Total pagado</div>
                  <div className="font-semibold">{fmtCOP(resumen.totalPagado)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Total programado</div>
                  <div className="font-semibold">{fmtCOP(resumen.totalProgramado)}</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tabla de cuotas */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base md:text-lg">Historial de cuotas</CardTitle>
          </CardHeader>
          <CardContent className="px-0 md:px-6">
            {loadingCuotas ? (
              <div className="space-y-2 px-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : cuotas.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground flex flex-col items-center gap-2">
                <AlertCircle className="h-8 w-8" />
                <span>Este préstamo no tiene cuotas registradas.</span>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs md:text-sm">
                  <thead className="bg-muted/40 text-left">
                    <tr>
                      <th className="px-3 py-2 font-semibold">#</th>
                      <th className="px-3 py-2 font-semibold">Fecha pago</th>
                      <th className="px-3 py-2 font-semibold">Valor cuota</th>
                      <th className="px-3 py-2 font-semibold">Estado</th>
                      <th className="px-3 py-2 font-semibold">Monto pagado</th>
                      <th className="px-3 py-2 font-semibold">Fecha real</th>
                      <th className="px-3 py-2 font-semibold text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cuotas.map((row) => {
                      const isEditing = editingId === row.id
                      const isSaving = savingId === row.id
                      const estadoMeta = ESTADO_LABELS[row.estado] ?? {
                        label: row.estado,
                        variant: "outline" as const,
                      }
                      return (
                        <tr key={row.id} className="border-t hover:bg-muted/30 transition-colors">
                          <td className="px-3 py-2 font-semibold">{row.numero_cuota}</td>

                          {/* Fecha pago */}
                          <td className="px-3 py-2">
                            {isEditing ? (
                              <Input
                                type="date"
                                value={(editBuffer.fecha_pago as string) ?? ""}
                                onChange={(e) =>
                                  setEditBuffer((b) => ({ ...b, fecha_pago: e.target.value }))
                                }
                                className="h-8 w-36"
                              />
                            ) : (
                              fmtFecha(row.fecha_pago)
                            )}
                          </td>

                          {/* Valor cuota */}
                          <td className="px-3 py-2">
                            {isEditing ? (
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                step="1"
                                value={
                                  editBuffer.valor_cuota === undefined
                                    ? ""
                                    : String(editBuffer.valor_cuota)
                                }
                                onChange={(e) =>
                                  setEditBuffer((b) => ({
                                    ...b,
                                    valor_cuota: e.target.value === "" ? 0 : Number(e.target.value),
                                  }))
                                }
                                className="h-8 w-28"
                              />
                            ) : (
                              fmtCOP(row.valor_cuota)
                            )}
                          </td>

                          {/* Estado */}
                          <td className="px-3 py-2">
                            {isEditing ? (
                              <Select
                                value={(editBuffer.estado as string) ?? row.estado}
                                onValueChange={(v) =>
                                  setEditBuffer((b) => ({ ...b, estado: v }))
                                }
                              >
                                <SelectTrigger className="h-8 w-32">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="pendiente">Pendiente</SelectItem>
                                  <SelectItem value="pagado">Pagado</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant={estadoMeta.variant}>{estadoMeta.label}</Badge>
                            )}
                          </td>

                          {/* Monto pagado */}
                          <td className="px-3 py-2">
                            {isEditing ? (
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                step="1"
                                value={
                                  editBuffer.monto_pagado == null
                                    ? ""
                                    : String(editBuffer.monto_pagado)
                                }
                                onChange={(e) =>
                                  setEditBuffer((b) => ({
                                    ...b,
                                    monto_pagado:
                                      e.target.value === "" ? null : Number(e.target.value),
                                  }))
                                }
                                className="h-8 w-28"
                                placeholder="0"
                              />
                            ) : (
                              fmtCOP(row.monto_pagado)
                            )}
                          </td>

                          {/* Fecha real (solo lectura) */}
                          <td className="px-3 py-2 text-muted-foreground">
                            {fmtFecha(row.fecha_pago_real)}
                          </td>

                          {/* Acciones */}
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1">
                              {isEditing ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="default"
                                    className="h-7 px-2"
                                    onClick={() => saveEdit(row)}
                                    disabled={isSaving}
                                  >
                                    {isSaving ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Save className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2"
                                    onClick={cancelEdit}
                                    disabled={isSaving}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2"
                                  onClick={() => startEdit(row)}
                                  disabled={editingId !== null}
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // --- Vista LISTA: buscar y elegir un prestamo ------------------------
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl md:text-2xl font-bold">Control de Pagos</h1>
        <p className="text-sm text-muted-foreground">
          Visualiza y edita el plan de pagos de cualquier préstamo de la ruta.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <Label htmlFor="search" className="text-sm">
            Buscar préstamo
          </Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="search"
              placeholder="Apodo, nombre, documento o ID del préstamo..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
        </CardHeader>
        <CardContent className="px-0 md:px-6">
          {loadingLoans ? (
            <div className="space-y-2 px-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredLoans.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground flex flex-col items-center gap-2">
              <AlertCircle className="h-8 w-8" />
              <span>
                {searchTerm
                  ? "No se encontraron préstamos para esa búsqueda."
                  : "No hay préstamos en esta ruta."}
              </span>
            </div>
          ) : (
            <ul className="divide-y">
              {filteredLoans.map((l) => (
                <li
                  key={l.id}
                  className="px-3 py-2.5 hover:bg-muted/40 cursor-pointer transition-colors"
                  onClick={() => handleSelectLoan(l)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm truncate">
                          {l.cliente.apodo || l.cliente.nombre_completo}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {l.cliente.documento}
                        </span>
                        <Badge
                          variant={l.estado === "activo" ? "default" : "secondary"}
                          className="text-[10px]"
                        >
                          {l.estado}
                        </Badge>
                        {l.tipo_amortizacion && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground font-semibold">
                            {l.tipo_amortizacion === "aleman"
                              ? "Capital"
                              : l.tipo_amortizacion === "americano"
                                ? "Intereses"
                                : l.tipo_amortizacion}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {fmtCOP(l.monto_prestamo)} · {l.total_cuotas} cuotas · Inicio{" "}
                        {fmtFecha(l.fecha_inicio)}
                      </div>
                    </div>
                    <ChevronLeft className="h-4 w-4 text-muted-foreground rotate-180 flex-shrink-0" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
