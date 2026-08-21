"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Search, TrendingDown, TrendingUp, Wallet, Pencil, PencilLine, Trash2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { todayColombia, tsToColombiaDate } from "@/lib/colombia-date"
import { fmtMoneda, fmtFechaHora } from "@/lib/gestion-core"
import {
  getUsuarioSesion, puedeEditarComoAsesor, puedeEliminar, movimientoEditado, type Movimiento,
} from "@/lib/movimientos"
import { EditMovimientoDialog } from "@/components/views/edit-movimiento-dialog"
import { EliminarMovimientoDialog } from "@/components/views/eliminar-movimiento-dialog"

type Transaction = Movimiento

interface ViewExpensesIncomeProps {
  /** Ruta activa. Sin esto la pantalla mostraba los movimientos de TODAS
   *  las rutas: no hay RLS, el filtro tiene que ponerlo la consulta. */
  currentRutaId: number
}

export function ViewExpensesIncome({ currentRutaId }: ViewExpensesIncomeProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [filterAdminStatus, setFilterAdminStatus] = useState("all")
  const [filterSecreStatus, setFilterSecreStatus] = useState("all")
  const todayCol = todayColombia()
  const [startDate, setStartDate] = useState(todayCol)
  const [endDate, setEndDate] = useState(todayCol)
  // Corregir un movimiento mal registrado. El asesor solo alcanza los suyos,
  // de hoy y sin resolver — `puedeEditarComoAsesor` es quien lo decide, y el
  // servidor lo vuelve a validar por si la pantalla está vieja.
  const [editando, setEditando] = useState<Transaction | null>(null)
  const [eliminando, setEliminando] = useState<Transaction | null>(null)
  const [usuarioId, setUsuarioId] = useState<number | null>(null)

  useEffect(() => { setUsuarioId(getUsuarioSesion().id) }, [])

  useEffect(() => {
    fetchTransactions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRutaId])

  useEffect(() => {
    applyFilters()
  }, [transactions, searchTerm, filterType, filterAdminStatus, filterSecreStatus, startDate, endDate])

  const fetchTransactions = async () => {
    const supabase = createClient()
    setLoading(true)

    try {
      const { data, error } = await supabase
        .from("gastosregistros")
        .select("*")
        .eq("ruta", currentRutaId)
        .order("fechahorasol", { ascending: false })

      if (error) {
        console.error("Error fetching transactions:", error)
      } else {
        setTransactions(data || [])
      }
    } catch (error) {
      console.error("Error:", error)
    } finally {
      setLoading(false)
    }
  }

  const applyFilters = () => {
    let filtered = [...transactions]

    // Filter by type
    if (filterType !== "all") {
      filtered = filtered.filter((t) => t.tipo === filterType)
    }

    // Filter by admin status
    if (filterAdminStatus !== "all") {
      filtered = filtered.filter((t) => t.estadoadmin === filterAdminStatus)
    }

    // Filter by secretary status
    if (filterSecreStatus !== "all") {
      filtered = filtered.filter((t) => t.estadosecre === filterSecreStatus)
    }

    // Busqueda por concepto u observacion.
    //
    // Antes el segundo campo era `limite`, que es NUMERICO y casi siempre
    // null: en cuanto el termino no coincidia con el concepto, la segunda
    // condicion hacia `null.toLowerCase()` y reventaba el filtro entero.
    // Ademas buscar por el limite del item nunca fue util — lo que uno busca
    // es lo que escribio en la observacion.
    if (searchTerm) {
      const t0 = searchTerm.toLowerCase()
      filtered = filtered.filter(
        (t) =>
          (t.concepto ?? "").toLowerCase().includes(t0) ||
          (t.observacion ?? "").toLowerCase().includes(t0)
      )
    }

    // Filter by date range — convert transaction timestamp to Colombia date
    const toColombiaDate = tsToColombiaDate

    if (startDate) {
      filtered = filtered.filter((t) => toColombiaDate(t.fechahorasol) >= startDate)
    }

    if (endDate) {
      filtered = filtered.filter((t) => toColombiaDate(t.fechahorasol) <= endDate)
    }

    setFilteredTransactions(filtered)
  }

  const getTypeIcon = (tipo: string) => {
    switch (tipo) {
      case "Ingreso":
        return <TrendingUp className="h-4 w-4 md:h-5 md:w-5 text-green-600" />
      case "Gasto":
        return <TrendingDown className="h-4 w-4 md:h-5 md:w-5 text-red-600" />
      case "Retiro":
        return <Wallet className="h-4 w-4 md:h-5 md:w-5 text-blue-600" />
      default:
        return null
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "aprobado":
        return <Badge className="bg-green-500 text-white text-[8px] md:text-xs">Aprobado</Badge>
      case "rechazado":
        return <Badge className="bg-red-500 text-white text-[8px] md:text-xs">Rechazado</Badge>
      case "por aprobar":
        return <Badge className="bg-yellow-500 text-white text-[8px] md:text-xs">Pendiente</Badge>
      default:
        return <Badge className="bg-gray-500 text-white text-[8px] md:text-xs">{status}</Badge>
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
    }).format(amount)
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("es-CO", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
  }

  return (
    // `flex flex-col gap-*` en vez de `space-y-*`: mas abajo se reordenan dos
    // tarjetas en movil, y `space-y` reparte los margenes segun el orden del
    // HTML, no del que se ve — quedaria el espacio del lado equivocado.
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base md:text-2xl font-bold text-card-foreground">Ver Gastos e Ingresos</h2>
      </div>

      {/* Filtros.
          En MOVIL van DESPUES del listado (`max-md:order-2`). Ocupan casi una
          pantalla entera, asi que abrir el modulo y encontrarse con los
          filtros obliga a bajar cada vez solo para ver lo que se registro, que
          es a lo que se entra. En pantalla grande caben los dos a la vez y
          quedan como estaban.

          Se reordena con CSS y no moviendo el codigo: el orden del HTML es el
          que siguen el teclado y los lectores de pantalla, y ahi el filtro
          antes del resultado es lo correcto. */}
      <Card className="max-md:order-2">
        <CardHeader className="pb-3 md:pb-4">
          <CardTitle className="text-sm md:text-lg">Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 md:space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
              {/* Date From */}
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="startDate" className="text-xs md:text-sm">
                  Desde
                </Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-8 md:h-10 text-xs md:text-sm"
                />
              </div>

              {/* Date To */}
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="endDate" className="text-xs md:text-sm">
                  Hasta
                </Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="h-8 md:h-10 text-xs md:text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 md:gap-4">
              {/* Search */}
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="search" className="text-xs md:text-sm">
                  Buscar
                </Label>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="search"
                    placeholder="Concepto u observación..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-8 h-8 md:h-10 text-xs md:text-sm"
                  />
                </div>
              </div>

            {/* Filter by Type */}
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="filterType" className="text-xs md:text-sm">
                Tipo
              </Label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="h-8 md:h-10 text-xs md:text-sm">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs md:text-sm">
                    Todos
                  </SelectItem>
                  {/* Los valores tienen que coincidir EXACTO con lo que
                      guarda saveTransaction ("Ingreso"/"Gasto"/"Retiro").
                      En minuscula el filtro no devolvia jamas una fila. */}
                  <SelectItem value="Ingreso" className="text-xs md:text-sm">
                    Ingresos
                  </SelectItem>
                  <SelectItem value="Gasto" className="text-xs md:text-sm">
                    Gastos
                  </SelectItem>
                  <SelectItem value="Retiro" className="text-xs md:text-sm">
                    Retiros
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Filter by Admin Status */}
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="filterAdmin" className="text-xs md:text-sm">
                Estado Admin
              </Label>
              <Select value={filterAdminStatus} onValueChange={setFilterAdminStatus}>
                <SelectTrigger className="h-8 md:h-10 text-xs md:text-sm">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs md:text-sm">
                    Todos
                  </SelectItem>
                  <SelectItem value="por aprobar" className="text-xs md:text-sm">
                    Pendiente
                  </SelectItem>
                  <SelectItem value="aprobado" className="text-xs md:text-sm">
                    Aprobado
                  </SelectItem>
                  <SelectItem value="rechazado" className="text-xs md:text-sm">
                    Rechazado
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Filter by Secretary Status */}
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="filterSecre" className="text-xs md:text-sm">
                Estado Secretaria
              </Label>
              <Select value={filterSecreStatus} onValueChange={setFilterSecreStatus}>
                <SelectTrigger className="h-8 md:h-10 text-xs md:text-sm">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs md:text-sm">
                    Todos
                  </SelectItem>
                  <SelectItem value="por aprobar" className="text-xs md:text-sm">
                    Pendiente
                  </SelectItem>
                  <SelectItem value="aprobado" className="text-xs md:text-sm">
                    Aprobado
                  </SelectItem>
                  <SelectItem value="rechazado" className="text-xs md:text-sm">
                    Rechazado
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* El listado. En movil sube al primer lugar (`max-md:order-1`), que es
          a lo que se entra al modulo. */}
      <Card className="max-md:order-1">
        <CardHeader className="pb-3 md:pb-4">
          <CardTitle className="text-sm md:text-lg">
            Transacciones ({filteredTransactions.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-sm md:text-base text-muted-foreground">
              Cargando transacciones...
            </div>
          ) : filteredTransactions.length === 0 ? (
            <div className="text-center py-8 text-sm md:text-base text-muted-foreground">
              No se encontraron transacciones
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] md:text-sm">Fecha</TableHead>
                    <TableHead className="text-[10px] md:text-sm">Tipo</TableHead>
                    <TableHead className="text-[10px] md:text-sm">Descripción</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Monto</TableHead>
                    <TableHead className="text-[10px] md:text-sm">Admin</TableHead>
                    <TableHead className="text-[10px] md:text-sm">Secretaria</TableHead>
                    <TableHead className="text-[10px] md:text-sm" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTransactions.map((transaction) => {
                    const permiso = puedeEditarComoAsesor(transaction, usuarioId)
                    const permisoBorrar = puedeEliminar(transaction, usuarioId, { comoAsesor: true })
                    return (
                    <TableRow key={transaction.id}>
                      <TableCell className="text-[9px] md:text-sm">
                        {formatDate(transaction.fechahorasol)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 md:gap-2">
                          {getTypeIcon(transaction.tipo)}
                          <span className="text-[9px] md:text-sm capitalize">{transaction.tipo}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-[9px] md:text-sm max-w-[150px] md:max-w-xs">
                        <span className="block truncate">{transaction.concepto}</span>
                        {movimientoEditado(transaction) && (
                          <span
                            className="mt-0.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[8px] md:text-[9px] font-semibold bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
                            title={`Editado por ${transaction.editado_por} el ${fmtFechaHora(transaction.fechahoraedicion)}${
                              transaction.valor_anterior !== null ? ` · antes: ${fmtMoneda(transaction.valor_anterior)}` : ""
                            }`}
                          >
                            <PencilLine className="h-2.5 w-2.5" /> editado
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-[9px] md:text-sm text-right font-semibold">
                        {formatCurrency(transaction.valor)}
                      </TableCell>
                      <TableCell>{getStatusBadge(transaction.estadoadmin)}</TableCell>
                      <TableCell>{getStatusBadge(transaction.estadosecre)}</TableCell>
                      <TableCell>
                        {/* Se muestra solo si de verdad se puede: un botón
                            deshabilitado en cada fila sería puro ruido, porque
                            la mayoría de movimientos no son editables. El
                            `title` explica el porqué cuando sí aparece. */}
                        <div className="flex items-center gap-0.5">
                          {permiso.puede && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Editar este movimiento"
                              onClick={() => setEditando(transaction)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {permisoBorrar.puede && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                              title="Eliminar este movimiento"
                              onClick={() => setEliminando(transaction)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
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

      <EditMovimientoDialog
        movimiento={editando}
        open={editando !== null}
        onOpenChange={(o) => !o && setEditando(null)}
        comoAsesor
        onSaved={fetchTransactions}
      />

      <EliminarMovimientoDialog
        movimiento={eliminando}
        open={eliminando !== null}
        onOpenChange={(o) => !o && setEliminando(null)}
        comoAsesor
        onDeleted={fetchTransactions}
      />
    </div>
  )
}
