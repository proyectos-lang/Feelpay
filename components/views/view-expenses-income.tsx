"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Search, TrendingDown, TrendingUp, Wallet } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

type Transaction = {
  id: number
  tipo: string
  fechahorasol: string
  concepto: string
  valor: number
  estadoadmin: string
  estadosecre: string
  limite: string
}

export function ViewExpensesIncome() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [filterType, setFilterType] = useState("all")
  const [filterAdminStatus, setFilterAdminStatus] = useState("all")
  const [filterSecreStatus, setFilterSecreStatus] = useState("all")
  const todayColombia = (() => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
    return now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0")
  })()

  const [startDate, setStartDate] = useState(todayColombia)
  const [endDate, setEndDate] = useState(todayColombia)

  useEffect(() => {
    fetchTransactions()
  }, [])

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

    // Search by description or limite
    if (searchTerm) {
      filtered = filtered.filter(
        (t) =>
          t.concepto.toLowerCase().includes(searchTerm.toLowerCase()) ||
          t.limite.toLowerCase().includes(searchTerm.toLowerCase())
      )
    }

    // Filter by date range — convert transaction timestamp to Colombia date
    const toColombiaDate = (ts: string) => {
      const d = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "America/Bogota" }))
      return d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0")
    }

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
      case "ingreso":
        return <TrendingUp className="h-4 w-4 md:h-5 md:w-5 text-green-600" />
      case "gasto":
        return <TrendingDown className="h-4 w-4 md:h-5 md:w-5 text-red-600" />
      case "retiro":
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
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base md:text-2xl font-bold text-card-foreground">Ver Gastos e Ingresos</h2>
      </div>

      {/* Filters Section */}
      <Card>
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
                    placeholder="Descripción o item..."
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
                  <SelectItem value="ingreso" className="text-xs md:text-sm">
                    Ingresos
                  </SelectItem>
                  <SelectItem value="gasto" className="text-xs md:text-sm">
                    Gastos
                  </SelectItem>
                  <SelectItem value="retiro" className="text-xs md:text-sm">
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

      {/* Transactions Table */}
      <Card>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTransactions.map((transaction) => (
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
                      <TableCell className="text-[9px] md:text-sm max-w-[150px] md:max-w-xs truncate">
                        {transaction.concepto}
                      </TableCell>
                      <TableCell className="text-[9px] md:text-sm text-right font-semibold">
                        {formatCurrency(transaction.valor)}
                      </TableCell>
                      <TableCell>{getStatusBadge(transaction.estadoadmin)}</TableCell>
                      <TableCell>{getStatusBadge(transaction.estadosecre)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
