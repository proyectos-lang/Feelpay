"use client"

import { TableCell } from "@/components/ui/table"
import { TableBody } from "@/components/ui/table"
import { TableHead } from "@/components/ui/table"
import { TableRow } from "@/components/ui/table"
import { TableHeader } from "@/components/ui/table"
import { Table } from "@/components/ui/table"
import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Check, X, Eye, FileText } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { createClient } from "@/lib/supabase/client"
import { approveTransaction } from "@/lib/actions/approve-transaction"
import { ImageIcon } from "lucide-react" // Added import for ImageIcon

interface PendingTransaction {
  id: number
  fechahorasol: string
  concepto: string
  valor: number
  tipo: string
  ruta: number
  limite?: number
  observacion?: string
  foto?: string
  admin_name?: string
  country?: string
}

interface FilterOptions {
  ruta: string
  admin: string
  country: string
  fecha: string
}

export function PendingAuthorizations() {
  const [transactions, setTransactions] = useState<PendingTransaction[]>([])
  const [filteredTransactions, setFilteredTransactions] = useState<PendingTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<number | null>(null)
  const [photoDialog, setPhotoDialog] = useState<{ open: boolean; url?: string }>({ open: false })
  const [observationDialog, setObservationDialog] = useState<{ open: boolean; observation?: string }>({ open: false })

  // Filter states
  const [filters, setFilters] = useState<FilterOptions>({
    ruta: "",
    admin: "",
    country: "",
    fecha: "",
  })

  const [rutas, setRutas] = useState<Array<{ id: number; name: string }>>([])
  const [admins, setAdmins] = useState<Array<{ id: number; name: string }>>([])
  const [countries, setCountries] = useState<string[]>([])

  useEffect(() => {
    fetchPendingTransactions()
    fetchFilterOptions()
  }, [])

  useEffect(() => {
    applyFilters()
  }, [filters, transactions])

  const fetchPendingTransactions = async () => {
    try {
      const supabase = createClient()
      
      // Fetch all transactions that need approval with admin id
      const { data: transactionsData, error: transactionsError } = await supabase
        .from("gastosregistros")
        .select("id, fechahorasol, concepto, valor, tipo, ruta, limite, observacion, foto, adminid")
        .eq("estadoadmin", "por aprobar")
        .order("fechahorasol", { ascending: false })

      if (transactionsError) {
        console.error("[v0] Error fetching transactions:", transactionsError)
        return
      }

      // Fetch admin data
      const { data: adminsData, error: adminsError } = await supabase.from("admin").select("id, nombre, pais")
      console.log("[v0] Admins data:", { adminsData, adminsError })

      // Create a map of admin id to admin info
      const adminsMap = new Map()
      if (adminsData) {
        for (const admin of adminsData) {
          console.log("[v0] Storing admin in map:", { id: admin.id, nombre: admin.nombre, pais: admin.pais })
          adminsMap.set(admin.id, { nombre: admin.nombre, pais: admin.pais })
        }
      }

      // Map transactions with admin and country info using adminid
      const mappedData = (transactionsData || []).map((item: any) => {
        const adminInfo = adminsMap.get(item.adminid)

        console.log("[v0] Mapping transaction:", {
          transactionId: item.id,
          adminId: item.adminid,
          adminInfo,
          adminMapSize: adminsMap.size,
        })

        return {
          id: item.id,
          fechahorasol: item.fechahorasol,
          concepto: item.concepto,
          valor: item.valor,
          tipo: item.tipo,
          ruta: item.ruta,
          limite: item.limite,
          observacion: item.observacion,
          foto: item.foto,
          admin_name: adminInfo?.nombre || "N/A",
          country: adminInfo?.pais || "N/A",
        }
      })

      setTransactions(mappedData)
      setFilteredTransactions(mappedData)
      console.log("[v0] Transactions loaded:", mappedData)
    } catch (error) {
      console.error("[v0] Error in fetchPendingTransactions:", error)
    } finally {
      setLoading(false)
    }
  }

  const fetchFilterOptions = async () => {
    try {
      const supabase = createClient()

      // Fetch rutas - only id since numero might not exist
      const { data: rutasData, error: rutasError } = await supabase.from("rutas").select("id").order("id")
      console.log("[v0] Rutas fetch result:", { rutasData, rutasError })

      if (rutasData) {
        const rutasList = rutasData.map((r: any) => ({ id: r.id, name: r.id.toString() }))
        console.log("[v0] Setting rutas:", rutasList)
        setRutas(rutasList)
      }

      // Fetch admins
      const { data: adminsData, error: adminsError } = await supabase.from("admin").select("id, nombre").order("nombre")
      console.log("[v0] Admins fetch result:", { adminsData, adminsError })

      if (adminsData) {
        setAdmins(adminsData.map((a: any) => ({ id: a.id, name: a.nombre })))
      }

      // Fetch unique countries
      const { data: countriesData, error: countriesError } = await supabase.from("admin").select("pais").order("pais")
      console.log("[v0] Countries fetch result:", { countriesData, countriesError })

      if (countriesData) {
        const uniqueCountries = [...new Set(countriesData.map((c: any) => c.pais).filter(Boolean))]
        setCountries(uniqueCountries as string[])
      }
    } catch (error) {
      console.error("[v0] Error fetching filter options:", error)
    }
  }

  const applyFilters = () => {
    let filtered = transactions

    // Only filter ruta if a specific ruta is selected (not empty string which means "all")
    if (filters.ruta !== "") {
      filtered = filtered.filter((t) => t.ruta.toString() === filters.ruta)
    }

    // Only filter admin if a specific admin is selected (not empty string which means "all")
    if (filters.admin !== "") {
      filtered = filtered.filter((t) => t.admin_name === filters.admin)
    }

    // Only filter country if a specific country is selected (not empty string which means "all")
    if (filters.country !== "") {
      filtered = filtered.filter((t) => t.country === filters.country)
    }

    // Only filter fecha if a specific date is selected (not empty string which means "all")
    if (filters.fecha !== "") {
      filtered = filtered.filter((t) => {
        const transactionDate = new Date(t.fechahorasol).toLocaleDateString("es-CO")
        return transactionDate === filters.fecha
      })
    }

    console.log("[v0] Applying filters:", { filters, resultCount: filtered.length })
    setFilteredTransactions(filtered)
  }

  const handleFilterChange = (filterName: keyof FilterOptions, value: string) => {
    setFilters((prev) => ({ ...prev, [filterName]: value }))
  }

  const clearFilters = () => {
    setFilters({ ruta: "", admin: "", country: "", fecha: "" })
  }

  const handleApprove = async (transactionId: number) => {
    setActionLoading(transactionId)
    try {
      const result = await approveTransaction({
        id: transactionId,
        status: "aprobado",
        adminName: "Admin User",
      })

      if (result.success) {
        setTransactions(transactions.filter((t) => t.id !== transactionId))
        alert("Transacción aprobada exitosamente")
      } else {
        alert(`Error: ${result.error}`)
      }
    } catch (error) {
      console.error("[v0] Error approving transaction:", error)
      alert("Error al aprobar la transacción")
    } finally {
      setActionLoading(null)
    }
  }

  const handleReject = async (transactionId: number) => {
    setActionLoading(transactionId)
    try {
      const result = await approveTransaction({
        id: transactionId,
        status: "rechazado",
        adminName: "Admin User",
      })

      if (result.success) {
        setTransactions(transactions.filter((t) => t.id !== transactionId))
        alert("Transacción rechazada exitosamente")
      } else {
        alert(`Error: ${result.error}`)
      }
    } catch (error) {
      console.error("[v0] Error rejecting transaction:", error)
      alert("Error al rechazar la transacción")
    } finally {
      setActionLoading(null)
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl md:text-2xl font-bold text-card-foreground">Autorizaciones Administrador</h2>

      {/* Filters Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base md:text-lg">Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-[12px] md:text-sm font-medium mb-2 block">Ruta</label>
              <Select value={filters.ruta} onValueChange={(value) => handleFilterChange("ruta", value)}>
                <SelectTrigger className="h-8 md:h-10 text-[12px] md:text-sm">
                  <SelectValue placeholder="Todas las rutas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las rutas</SelectItem>
                  {rutas.map((ruta) => (
                    <SelectItem key={ruta.id} value={ruta.id.toString()}>
                      Ruta {ruta.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-[12px] md:text-sm font-medium mb-2 block">Administrador</label>
              <Select value={filters.admin} onValueChange={(value) => handleFilterChange("admin", value)}>
                <SelectTrigger className="h-8 md:h-10 text-[12px] md:text-sm">
                  <SelectValue placeholder="Todos los admins" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos los administradores</SelectItem>
                  {admins.map((admin) => (
                    <SelectItem key={admin.id} value={admin.name}>
                      {admin.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-[12px] md:text-sm font-medium mb-2 block">País</label>
              <Select value={filters.country} onValueChange={(value) => handleFilterChange("country", value)}>
                <SelectTrigger className="h-8 md:h-10 text-[12px] md:text-sm">
                  <SelectValue placeholder="Todos los países" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos los países</SelectItem>
                  {countries.map((country) => (
                    <SelectItem key={country} value={country}>
                      {country}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-[12px] md:text-sm font-medium mb-2 block">Fecha</label>
              <Input
                type="date"
                value={filters.fecha}
                onChange={(e) => handleFilterChange("fecha", e.target.value)}
                className="h-8 md:h-10 text-[12px] md:text-sm"
              />
            </div>

            <div className="flex items-end">
              <Button
                onClick={clearFilters}
                variant="outline"
                className="w-full h-8 md:h-10 text-[12px] md:text-sm bg-transparent"
              >
                Limpiar Filtros
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base md:text-lg">Registros que Requieren Aprobación</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {loading ? (
              <div className="text-center text-muted-foreground text-[12px] md:text-sm py-8">
                Cargando...
              </div>
            ) : filteredTransactions.length === 0 ? (
              <div className="text-center text-muted-foreground text-[12px] md:text-sm py-8">
                No hay autorizaciones pendientes
              </div>
            ) : (
              filteredTransactions.map((transaction) => (
                <div key={transaction.id} className="border-2 border-gray-400 rounded-lg p-2 md:p-3 space-y-2">
                  {/* Primera fila */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-3">
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">Ruta</p>
                      <p className="text-[11px] md:text-sm font-medium">{transaction.ruta}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">Administrador</p>
                      <p className="text-[11px] md:text-sm">{transaction.admin_name}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">País</p>
                      <p className="text-[11px] md:text-sm">{transaction.country}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">Tipo</p>
                      <Badge
                        variant="outline"
                        className={`text-[8px] md:text-xs w-fit ${
                          transaction.tipo === "Ingreso"
                            ? "bg-green-100 text-green-800"
                            : transaction.tipo === "Gasto"
                              ? "bg-orange-100 text-orange-800"
                              : "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {transaction.tipo}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">Concepto</p>
                      <p className="text-[11px] md:text-sm font-medium">{transaction.concepto}</p>
                    </div>
                  </div>

                  {/* Segunda fila */}
                  <div className="border-t border-gray-300 pt-2 grid grid-cols-4 md:grid-cols-5 gap-2 md:gap-3 items-end">
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">Límite</p>
                      <p className="text-[11px] md:text-sm">
                        {transaction.limite ? `$${transaction.limite.toLocaleString("es-CO")}` : "N/A"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">Monto</p>
                      <p className="text-[11px] md:text-sm font-semibold">
                        ${transaction.valor.toLocaleString("es-CO")}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-muted-foreground font-semibold">Fecha/Hora</p>
                      <p className="text-[11px] md:text-sm whitespace-nowrap text-xs">
                        {new Date(transaction.fechahorasol).toLocaleDateString("es-CO")}
                        <br />
                        {new Date(transaction.fechahorasol).toLocaleTimeString("es-CO")}
                      </p>
                    </div>
                    <div className="col-span-1 md:col-span-2">
                      <p className="text-[9px] text-muted-foreground font-semibold mb-1">Acciones</p>
                      <div className="flex gap-1 md:gap-2 flex-wrap justify-end">
                        {transaction.observacion && (
                          <Button
                            size="sm"
                            onClick={() => setObservationDialog({ open: true, observation: transaction.observacion })}
                            className="h-8 text-[11px] md:text-xs bg-blue-500 hover:bg-blue-600 text-white flex items-center gap-1"
                          >
                            <FileText className="h-4 w-4" />
                            Observación
                          </Button>
                        )}
                        {transaction.foto && (
                          <Button
                            size="sm"
                            onClick={() => setPhotoDialog({ open: true, url: transaction.foto })}
                            className="h-8 text-[11px] md:text-xs bg-purple-500 hover:bg-purple-600 text-white flex items-center gap-1"
                          >
                            <Eye className="h-4 w-4" />
                            Foto
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => handleApprove(transaction.id)}
                          disabled={actionLoading === transaction.id}
                          className="h-8 w-8 p-0 bg-green-600 hover:bg-green-700"
                          title="Aprobar"
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleReject(transaction.id)}
                          disabled={actionLoading === transaction.id}
                          className="h-8 w-8 p-0 bg-red-600 hover:bg-red-700"
                          title="Rechazar"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={photoDialog.open} onOpenChange={(open) => setPhotoDialog({ ...photoDialog, open })}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Foto del Comprobante</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center p-6">
            {photoDialog.url ? (
              <img src={photoDialog.url || "/placeholder.svg"} alt="Comprobante" className="max-w-full max-h-96 rounded-lg" />
            ) : (
              <p className="text-muted-foreground">No hay foto disponible</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={observationDialog.open} onOpenChange={(open) => setObservationDialog({ ...observationDialog, open })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Observación</DialogTitle>
          </DialogHeader>
          <div className="p-6">
            <p className="text-[12px] md:text-sm text-muted-foreground whitespace-pre-wrap">
              {observationDialog.observation || "No hay observaciones"}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
