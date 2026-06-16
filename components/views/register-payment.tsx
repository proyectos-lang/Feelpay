"use client"

import type React from "react"
import { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DollarSign, X, Camera, Edit, FileText, History, User, MoreVertical, Receipt, Loader2, GripVertical, ArrowUp, ArrowDown, CheckCircle2, XCircle, Users, Pencil, Trash2, RefreshCw, ShoppingCart, MapPinOff, MapPin, AlertCircle, Play } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
// `createClient` ya no se importa directamente: toda interaccion con
  // Supabase: RLS eliminado. `getSupabaseSafe` y `callRpcAtomic` se conservan
  // como atajos delgados sobre `createClient()`.
  import { getSupabaseSafe, callRpcAtomic } from "@/lib/api-helper"
import { SalesTodayList } from "@/components/views/sales-today-list"
// Helper que centraliza la carga del dashboard: prueba la RPC atomica
// `obtener_dashboard_pagos` primero (inmune al patron PgBouncer) y si no
// esta desplegada cae al modo legacy con multiples SELECTs paralelos.
import { loadDashboardPagos } from "@/lib/dashboard-data"
import { todayColombia } from "@/lib/colombia-date"

// Types matching DB schema
type LoanWithClient = {
  id: string
  client_id: string
  valor: number
  saldo: number
  valor_a_pagar: number
  valor_cuota: number
  tasa_interes: number
  numero_cuotas: number
  frecuencia_pago: string
  tipo_amortizacion: string
  estado: string
  ruta: number
  ordenvisita: number
  dia_semana: string | null
  created_at: string
  clients: {
    nombre_completo: string
    apodo: string | null
    documento: string
  }
}

type PaymentPlanEntry = {
  id: string
  loan_id: string
  numero_cuota: number
  fecha_pago: string
  valor_cuota: number
  capital: number
  interes: number
  saldo: number
  estado: string
  fecha_pago_real: string | null
  monto_pagado: number
  ruta: number
}

type DisplayClient = {
  loanId: string
  clientId: string
  nombre: string
  documento: string
  valorVenta: number
  valorCuota: number
  saldo: number
  cuotasPagadas: number
  cuotasTotales: number
  mora: number
  ultimoPago: number
  ultimoPagoFecha: string
  frecuenciaPago: string
  // tipo_amortizacion del prestamo (raw): suele ser "aleman" | "americano" |
  // null/empty cuando no aplica (cuotas fijas tradicionales). Se renderiza
  // como badge pequeno en el listado mapeado a "Capital" / "Intereses".
  tipoAmortizacion: string | null
  tasaInteres: number
  nextPaymentId: string | null
  // OJO: `nextPaymentCuota` historicamente almacena el MONTO (valor) de la
  // proxima cuota a pagar, NO su numero de cuota. Mantenemos el nombre por
  // compatibilidad. Para saber el ordinal usar `nextPaymentNumero`.
  nextPaymentCuota: number
  // Numero de cuota (1..cuotasTotales) de la proxima cuota pendiente. Se usa
  // para detectar si el cliente esta pagando la ULTIMA cuota (necesario para
  // habilitar la opcion de "Extender Cuotas" en prestamos americanos).
  nextPaymentNumero: number
  // Capital y valor_cuota de la PROXIMA cuota pendiente, precargados desde
  // fetchData para no tener que hacer un SELECT extra al registrar el pago.
  // Esto evita un round-trip que ademas era vulnerable a RLS por session var
  // perdida en otra conexion del pool de PgBouncer.
  nextPaymentCapital: number
  nextPaymentValorCuota: number
  // True cuando la cuota objetivo del cliente es FUTURA (todas las
  // anteriores ya estan gestionadas y la proxima cuota pendiente cae
  // despues de hoy). Se usa para mostrarlos en el listado pero
  // bloquear las acciones de pago/no_pago hasta que llegue su dia.
  nextPaymentEsFuturo: boolean
  // Fecha (YYYY-MM-DD) de la cuota objetivo. La usamos para mostrar
  // "Próximo pago el dd/mm" cuando `nextPaymentEsFuturo` es true.
  nextPaymentFecha: string
  ordenvisita: number
  diaSemana: string | null
  valorPrestamo: number
}

type RegisterPaymentProps = {
  onViewChange: (view: string, data?: any) => void
  currentRutaId?: number
  // `rutaPais` se reenvia al subcomponente NewLoan para que aplique la
  // validacion correcta de digitos de telefono por pais (Colombia=10,
  // Peru=9, etc.). Si no se pasa, NewLoan asume Colombia por default.
  rutaPais?: string
  rutaActivaEstado?: "abierta" | "cerrada" | null
  // `rutaActivaResolved` indica si el padre ya tiene una respuesta
  // definitiva sobre el estado de la ruta (true) o sigue resolviendo
  // (false). Si está en false NO debemos renderizar el guard "Ruta no
  // iniciada" porque produce un flash confuso durante ~500ms en cada
  // recarga; en su lugar mostramos un spinner discreto.
  rutaActivaResolved?: boolean
  onRouteStateChange?: (estado: "abierta" | "cerrada" | null) => void
}

const frecuenciaLabel = (freq: string) => {
  switch (freq) {
    case "daily": return "Diario"
    case "weekly": return "Semanal"
    case "biweekly": return "Quincenal"
    case "monthly": return "Mensual"
    default: return freq
  }
}

// Mapea el `tipo_amortizacion` crudo de la BD al label de UI segun la nueva
// nomenclatura del negocio:
//   - "aleman"   → "Capital"   (cuotas a capital fijo)
//   - "americano"→ "Intereses" (solo intereses, capital al final)
// Cualquier otro valor (null, "", "frances", etc.) retorna null para no
// renderizar badge en cuotas tradicionales.
const tipoAmortizacionLabel = (tipo: string | null | undefined): string | null => {
  if (!tipo) return null
  const t = tipo.toLowerCase().trim()
  if (t === "aleman" || t === "alemán") return "Capital"
  if (t === "americano") return "Intereses"
  return null
}

// Get current day of week in Spanish (Colombia timezone)
const getTodayDayName = () => {
  const days = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"]
  const now = new Date()
  const colombiaDate = new Date(now.toLocaleString("en-US", { timeZone: "America/Bogota" }))
  return days[colombiaDate.getDay()]
}

// Check if the payment day matches today
const isPaymentDayToday = (diaSemana: string | null) => {
  if (!diaSemana) return false
  const today = getTodayDayName()
  return diaSemana.toLowerCase() === today
}

type ManagedClient = DisplayClient & { gestionTipo: "pago" | "no_pago"; gestionHora: string; valorAbonado: number; paymentPlanId?: string }

// Helper function to get current geolocation — rejects when unavailable so callers can block.
//
// IMPORTANTE: Para registro de pagos necesitamos coordenadas con alta precision
// (chip GPS) porque sirven como evidencia de gestion en campo. NO cacheamos
// posiciones entre pagos (maximumAge: 0) porque cada gestion es en un punto
// geografico distinto y no queremos persistir la coordenada de un cliente
// anterior. El timeout de 10s da margen al warm-up del chip GPS en moviles.
const getCurrentLocation = (): Promise<{ latitud: number; longitud: number }> => {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("GPS_UNAVAILABLE"))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitud: position.coords.latitude,
          longitud: position.coords.longitude,
        })
      },
      (error) => {
        reject(new Error(error.code === 1 ? "GPS_DENIED" : "GPS_UNAVAILABLE"))
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  })
}

export function RegisterPayment({ onViewChange, currentRutaId = 1, rutaPais = "", rutaActivaEstado, rutaActivaResolved = true, onRouteStateChange }: RegisterPaymentProps) {
  const { toast } = useToast()

  // ── Managed-today state (loaded from Supabase payment_plan) ──
  const [managedToday, setManagedToday] = useState<ManagedClient[]>([])
  const TAB_ORDER: Array<"pendientes" | "gestionados" | "ventas"> = ["pendientes", "gestionados", "ventas"]
  const [activeTab, setActiveTab] = useState<"pendientes" | "gestionados" | "ventas">("pendientes")
  // Conteo de ventas registradas HOY en la ruta. Lo recibimos via callback
  // desde `<SalesTodayList>` para evitar duplicar la query y mostrarlo en
  // el badge del tab "Ventas del día" (mismo patron que Pendientes y
  // Gestionados que usan `displayClients.length` / `gestionados.length`).
  const [salesTodayCount, setSalesTodayCount] = useState(0)

  const [editingManaged, setEditingManaged] = useState<ManagedClient | null>(null)
  const [editMonto, setEditMonto] = useState("")
  const [savingManaged, setSavingManaged] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [clients, setClients] = useState<DisplayClient[]>([])
  const [selectedClient, setSelectedClient] = useState<DisplayClient | null>(null)
  // Saldo a Pagar se toma directamente de selectedClient.saldo (ya viene del
  // listado de Clientes Activos). NO se hace fetch adicional para acelerar
  // la apertura del dialogo de Registrar Pago.
  const [numCuotas, setNumCuotas] = useState(1)
  const [isPartialPayment, setIsPartialPayment] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("efectivo")
  const [accountNumber, setAccountNumber] = useState("")
  const [isCancelada, setIsCancelada] = useState(false)
  // ── Extension de plazo (solo prestamos "americano" en su ULTIMA cuota) ──
  // Cuando un prestamo de tipo intereses (americano) llega a su ultima cuota
  // programada, el administrador puede optar por "prorrogar" el plazo: pagar
  // los intereses de la cuota actual y agregar N cuotas mas al final.
  // El registro del pago se hace primero con `registrar_pago_atomico` y, si
  // tiene exito, se invoca la RPC `extender_prestamo_americano` para crear
  // las nuevas cuotas pendientes.
  const [extenderCuotas, setExtenderCuotas] = useState(false)
  const [cantidadCuotasExtender, setCantidadCuotasExtender] = useState("1")

  // ── BLINDAJE BUG cuotas duplicadas ────────────────────────────────────
  // Defensa adicional: si por cualquier motivo (cambio de cliente, refetch,
  // etc.) el flag `extenderCuotas` queda en `true` cuando el cliente
  // seleccionado YA NO cumple las condiciones para extender (no es
  // americano, o la cuota actual no es la ultima del plan), lo forzamos a
  // `false` automaticamente. Esto garantiza que `extender_prestamo_americano`
  // jamas se dispare en un pago de cuota intermedia (ej. cuota 4 de 16).
  useEffect(() => {
    if (!extenderCuotas) return
    if (!selectedClient) {
      setExtenderCuotas(false)
      setCantidadCuotasExtender("1")
      return
    }
    const esAmericano =
      selectedClient.tipoAmortizacion?.toLowerCase().trim() === "americano"
    const esUltimaCuota =
      selectedClient.nextPaymentNumero === selectedClient.cuotasTotales
    if (!esAmericano || !esUltimaCuota) {
      console.warn(
        "[v0] BLINDAJE-EXTENDER apagando flag espurio:",
        {
          loanId: selectedClient.loanId,
          tipoAmortizacion: selectedClient.tipoAmortizacion,
          nextPaymentNumero: selectedClient.nextPaymentNumero,
          cuotasTotales: selectedClient.cuotasTotales,
        },
      )
      setExtenderCuotas(false)
      setCantidadCuotasExtender("1")
    }
  }, [extenderCuotas, selectedClient])
  const [showRenovationDialog, setShowRenovationDialog] = useState(false)
  const [clientForRenovation, setClientForRenovation] = useState<DisplayClient | null>(null)
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [clientForShare, setClientForShare] = useState<DisplayClient | null>(null)
  const [sharingPdf, setSharingPdf] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [paymentPhoto, setPaymentPhoto] = useState<string | null>(null)
  const [isDiario, setIsDiario] = useState(true)
  const [moraFilter, setMoraFilter] = useState<"green" | "yellow" | "red" | null>(null)

  // No-payment dialog state
  const [noPaymentClient, setNoPaymentClient] = useState<DisplayClient | null>(null)
  const [noPaymentObservation, setNoPaymentObservation] = useState("")
  const [noPaymentPhoto, setNoPaymentPhoto] = useState<string | null>(null)

  // Client info dialog
  const [clientInfoDialogOpen, setClientInfoDialogOpen] = useState(false)
  const [selectedClientInfo, setSelectedClientInfo] = useState<DisplayClient | null>(null)

  // Payment history dialog
  const [paymentHistoryOpen, setPaymentHistoryOpen] = useState(false)
  const [paymentHistoryClient, setPaymentHistoryClient] = useState<DisplayClient | null>(null)
  const [paymentHistoryRows, setPaymentHistoryRows] = useState<{
    id: string; fecha_pago: string; valor_cuota: number; estado: string; monto_pagado: number
  }[]>([])
  const [paymentHistoryLoading, setPaymentHistoryLoading] = useState(false)

  // Loan history dialog
  const [loanHistoryOpen, setLoanHistoryOpen] = useState(false)
  const [loanHistoryClient, setLoanHistoryClient] = useState<DisplayClient | null>(null)
  const [loanHistoryRows, setLoanHistoryRows] = useState<{
    id: string; valor: number; numero_cuotas: number; frecuencia_pago: string; estado: string; fecha_creacion: string
  }[]>([])
  const [loanHistoryLoading, setLoanHistoryLoading] = useState(false)

  // Client info dialog — fetched data from clients table
  const [clientInfoFetched, setClientInfoFetched] = useState<{
    nombre_completo: string; apodo: string | null; documento: string; telefono: string | null; direccion: string | null
  } | null>(null)
  const [clientInfoLoading, setClientInfoLoading] = useState(false)

  // Drag-and-drop reorder state
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)

  // GPS permission state
  type GpsStatus = "checking" | "granted" | "denied" | "unavailable"
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("checking")

  // Estado para iniciar la ruta del dia desde el guard
  const [iniciandoRuta, setIniciandoRuta] = useState(false)

  // Token monotonico para descartar respuestas obsoletas / concurrentes de fetchData.
  // Cada llamada incrementa el token; las respuestas con token distinto al actual
  // son ignoradas (evita race conditions cuando dos fetches solapan).
  const fetchDataTokenRef = useRef(0)

  // Ref a toast para no recrear fetchData en cada render (evita disparos
  // duplicados del useEffect que escucha fetchData).
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  }, [toast])

  // On mount: query permission status and listen for changes
  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setGpsStatus("unavailable")
      return
    }

    const applyState = (state: PermissionState) => {
      if (state === "granted") setGpsStatus("granted")
      else if (state === "denied") setGpsStatus("denied")
      else setGpsStatus("checking") // "prompt" — need to ask
    }

    let permResult: PermissionStatus | null = null

    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((result) => {
        permResult = result
        applyState(result.state)
        result.onchange = () => applyState(result.state)
        // If status is "prompt", actively call getCurrentPosition to trigger browser dialog
        if (result.state === "prompt") {
          navigator.geolocation.getCurrentPosition(
            () => setGpsStatus("granted"),
            (e) => setGpsStatus(e.code === 1 ? "denied" : "unavailable"),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
          )
        }
      })
      .catch(() => {
        // Permissions API not available — try directly
        navigator.geolocation.getCurrentPosition(
          () => setGpsStatus("granted"),
          (e) => setGpsStatus(e.code === 1 ? "denied" : "unavailable"),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        )
      })

    return () => {
      if (permResult) permResult.onchange = null
    }
  }, [])

  // Re-request GPS permission manually (called from the banner button)
  const requestGpsPermission = () => {
    setGpsStatus("checking")
    navigator.geolocation.getCurrentPosition(
      () => setGpsStatus("granted"),
      (e) => setGpsStatus(e.code === 1 ? "denied" : "unavailable"),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }

  const managedIds = new Set(managedToday.map((m) => m.loanId))

  const sortedManaged = [...managedToday].sort((a, b) => {
    const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
    const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
    return ordA - ordB
  })

  // Base filtered clients: all filters except mora — used for the circle counts
  // so the totals per category are always visible regardless of active mora filter.
  const preFilteredClients = clients.filter((c) => {
    if (managedIds.has(c.loanId)) return false
    if (c.saldo <= 0) return false
    const isDiarioFreq = c.frecuenciaPago === "daily"
    const matchesFreq = isDiario ? true : !isDiarioFreq
    const matchesSearch = searchTerm === "" ||
      c.nombre.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.documento.includes(searchTerm)
    return matchesFreq && matchesSearch
  })

  const displayClients = preFilteredClients.filter((c) => {
    if (moraFilter === null) return true
    if (moraFilter === "green") return c.mora <= 4
    if (moraFilter === "yellow") return c.mora > 4 && c.mora <= 8
    return c.mora > 8
  }).sort((a, b) => {
    // 1. Clientes con cuota FUTURA siempre al final, sin importar
    //    frecuencia ni dia — son los que no se pueden procesar hoy.
    const aFuturo = a.nextPaymentEsFuturo ? 1 : 0
    const bFuturo = b.nextPaymentEsFuturo ? 1 : 0
    if (aFuturo !== bFuturo) return aFuturo - bFuturo

    // 2. En "No Diario": dentro del grupo procesable, los del dia
    //    de pago de hoy van antes que los de otro dia.
    if (!isDiario) {
      const aIsToday = isPaymentDayToday(a.diaSemana) ? 0 : 1
      const bIsToday = isPaymentDayToday(b.diaSemana) ? 0 : 1
      if (aIsToday !== bIsToday) return aIsToday - bIsToday
    }

    // 3. Dentro de cada subgrupo, ordenvisita (0 se trata como
    //    infinito para no flotar clientes sin orden asignado).
    const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
    const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
    return ordA - ordB
  })
  
  // Helper to determine if a client can be managed (register payment/no-payment)
  const canManageClient = (client: DisplayClient) => {
    // Location must be available to register any action — no exceptions
    if (gpsStatus !== "granted") return false
    // Cuota objetivo es FUTURA: solo se ve, no se procesa hasta que llegue su dia.
    if (client.nextPaymentEsFuturo) return false
    // Daily clients: always allowed once location is confirmed
    if (client.frecuenciaPago === "daily") return true
    // In "No Diario" tab: non-daily clients can always be managed (regardless of payment day)
    if (!isDiario) return true
    // In "Diario" tab: non-daily clients can only be managed if today is their payment day
    return isPaymentDayToday(client.diaSemana)
  }

  // Called when the user taps a payment button but location is not available
  const handleLocationRequired = () => {
    toast({
      title: "Ubicacion requerida",
      description:
        gpsStatus === "denied"
          ? "El permiso de ubicacion esta denegado. Ve a la configuracion de tu navegador y habilita el acceso a la ubicacion para continuar."
          : "No se puede detectar tu ubicacion. Activa la ubicacion en tu dispositivo y vuelve a intentarlo.",
      variant: "destructive",
    })
    // Also re-trigger the browser permission dialog in case it is in "prompt" state
    if (gpsStatus !== "denied" && navigator.geolocation) {
      requestGpsPermission()
    }
  }

  const saveNewOrder = async (reordered: DisplayClient[]) => {
    setSavingOrder(true)
    try {
      const items = reordered.map((c, idx) => ({
        id: c.loanId,
        ordenvisita: idx + 1,
      }))
      const res = await fetch("/api/route-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error("Error saving order")
      // Update local state with new order numbers
      setClients(reordered.map((c, idx) => ({ ...c, ordenvisita: idx + 1 })))
    } catch (error) {
      toast({ title: "Error", description: "No se pudo guardar el orden", variant: "destructive" })
    } finally {
      setSavingOrder(false)
    }
  }

  const handleDragStart = (index: number) => {
    setDragIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }

  const handleDrop = (dropIndex: number) => {
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null)
      setDragOverIndex(null)
      return
    }
    const filtered = clients.filter((c) => {
      const isDiarioFreq = c.frecuenciaPago === "daily"
      const matchesFreq = isDiario ? isDiarioFreq : !isDiarioFreq
      const matchesSearch = searchTerm === "" ||
        c.nombre.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.documento.includes(searchTerm)
      return matchesFreq && matchesSearch
    })
    const reordered = [...filtered]
    const [moved] = reordered.splice(dragIndex, 1)
    reordered.splice(dropIndex, 0, moved)
    saveNewOrder(reordered)
    setDragIndex(null)
    setDragOverIndex(null)
  }

  const handleMoveUp = (index: number) => {
    if (index === 0) return
    const reordered = [...displayClients]
    const temp = reordered[index - 1]
    reordered[index - 1] = reordered[index]
    reordered[index] = temp
    saveNewOrder(reordered)
  }

  const handleMoveDown = (index: number) => {
    if (index >= displayClients.length - 1) return
    const reordered = [...displayClients]
    const temp = reordered[index + 1]
    reordered[index + 1] = reordered[index]
    reordered[index] = temp
    saveNewOrder(reordered)
  }

  // Get today's date in Colombia (YYYY-MM-DD)
  const getTodayColombia = (): string => {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date())
  }

  const fetchData = useCallback(async (options?: { silent?: boolean }) => {
    // silent=true: refresh en background sin tocar el flag `loading` (no se
    // muestra spinner overlay). Lo usamos despues de un pago para sincronizar
    // mora/saldo derivados sin bloquear la UI — el optimistic UI ya tiene
    // los datos correctos visualmente.
    const silent = options?.silent === true

    // Token monotonico para esta llamada. Cualquier respuesta tardia con
    // token diferente sera descartada.
    const myToken = ++fetchDataTokenRef.current

    // Cliente Supabase del navegador (atajo sobre `createClient()`).
    let supabase: Awaited<ReturnType<typeof getSupabaseSafe>>
    try {
      supabase = await getSupabaseSafe()
    } catch (err) {
      // SessionLostError: el listener global en app/page.tsx se encarga
      // del redirect, aqui solo abortamos el fetch limpiamente.
      console.warn("[v0] fetchData abortado por sesion no disponible:", err)
      if (!silent) setLoading(false)
      return
    }

    try {
      if (!silent) setLoading(true)
      const todayColombia = getTodayColombia()

      // ── Carga del dashboard ──────────────────────────────────────────
      // RLS fue eliminado; el helper hace 4 SELECTs directos filtrando por
      // `.eq('ruta', rutaId)`. Sin RPC, sin retries, sin ensureSession.
      const dashboard = await loadDashboardPagos(supabase, {
        rutaId: currentRutaId,
      })
      if (fetchDataTokenRef.current !== myToken) return

      const { loans, saldoMap, moraMap, fechaUltimoPagoMap, allPaymentPlans } = dashboard
      console.log(`[v0] dashboard cargado: ${loans.length} loans`)

      // El helper ya filtro activos + cancelados y armo los mapas. Alias
      // `activeLoans` para no tocar el resto del componente.
      const activeLoans = loans
      const pendingClients: DisplayClient[] = []
      const managedClientsFromDB: ManagedClient[] = []

      // Group payment plans by loan_id
      const paymentPlansByLoan = new Map<string, PaymentPlanEntry[]>()
      for (const pp of allPaymentPlans) {
        const existing = paymentPlansByLoan.get(pp.loan_id) || []
        existing.push(pp)
        paymentPlansByLoan.set(pp.loan_id, existing)
      }
      
      // Process each loan with its payment plan
      for (const loan of activeLoans) {
        // Ocultar préstamos creados hoy — no se cobran el mismo día de la venta.
        if (loan.fecha_creacion) {
          const fechaCreacionColombia = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric", month: "2-digit", day: "2-digit",
          }).format(new Date(loan.fecha_creacion))
          if (fechaCreacionColombia === todayColombia) continue
        }

        const paymentPlan = paymentPlansByLoan.get(loan.id) || []
        const cuotasPagadas = paymentPlan.filter((p) => p.estado === "pagado").length
        const cuotasTotales = paymentPlan.length

        // Sort by fecha_pago to ensure correct order
        const sortedPlan = [...paymentPlan].sort((a, b) => a.fecha_pago.localeCompare(b.fecha_pago))

        // Check if any entry was managed TODAY (by fecha_pago_real containing today's date)
        const managedTodayEntry = sortedPlan.find((p) =>
          (p.estado === "pagado" || p.estado === "no_pago" || p.estado === "parcial" || p.estado === "cancelada") &&
          p.fecha_pago_real && p.fecha_pago_real.startsWith(todayColombia)
        )

        // ------------------------------------------------------------------
        // Regla de seleccion de la cuota objetivo (nextPaymentId)
        // ------------------------------------------------------------------
        // PRIORIDAD (la primera que matchee se usa):
        //   1. Entry gestionada HOY (pagado/no_pago/parcial/cancelada con
        //      fecha_pago_real del dia)  → muestra el resultado de la gestion
        //      actual sin disparar otra escritura.
        //   2. Cuota PENDIENTE cuya `fecha_pago` sea EXACTAMENTE hoy. Esta es
        //      la cuota natural del dia en el flujo de cobranza diaria —
        //      siempre tiene prioridad sobre cuotas vencidas mas viejas.
        //   3. Cuota PENDIENTE mas vieja con `fecha_pago < hoy` (atraso). Se
        //      usa solo si NO existe una cuota pendiente de hoy y el cliente
        //      arrastra una cuota sin gestionar de un dia anterior.
        //
        // Bug previo: el codigo tomaba la cuota pendiente mas vieja sin
        // distinguir si existia tambien una cuota de hoy. Cuando habia dos
        // cuotas pendientes (p.ej. 2026-05-09 y 2026-05-12), apuntaba a la
        // del 2026-05-09 y el UPDATE en el handler de pago caia sobre esa
        // cuota vieja en vez de la cuota del dia que el operador queria pagar.
        // ------------------------------------------------------------------
        const pendingToday = sortedPlan.find(
          (p) => p.estado === "pendiente" && p.fecha_pago === todayColombia,
        )
        const oldestOverduePending = sortedPlan.find(
          (p) => p.estado === "pendiente" && p.fecha_pago < todayColombia,
        )
        // Cuarto fallback: cuota pendiente FUTURA mas cercana. Lo agregamos
        // para que clientes activos cuya proxima cuota cae despues de hoy
        // (p.ej. semanales/quincenales/mensuales en dias intermedios)
        // sigan apareciendo en la lista. La accion de pago se deshabilita
        // mas adelante via `canManageClient` para que no se pueda procesar
        // hasta que llegue su dia.
        const nextFuturePending = sortedPlan.find(
          (p) => p.estado === "pendiente" && p.fecha_pago > todayColombia,
        )

        let targetEntry =
          managedTodayEntry || pendingToday || oldestOverduePending || nextFuturePending || null

        // If no relevant entry found, skip this client (loan sin payment_plan
        // o todas las cuotas ya gestionadas como pagado/cancelada).
        if (!targetEntry) {
          continue
        }

        // Detectar si la cuota objetivo es FUTURA (cayo solo via el
        // cuarto fallback). Sirve para que la UI marque el cliente como
        // "Proximo pago" y bloquee acciones.
        const esFuturo =
          !managedTodayEntry &&
          !pendingToday &&
          !oldestOverduePending &&
          !!nextFuturePending

        // Get mora from v_loan_mora_status view (fallback to calculated if not available)
        let mora = moraMap.get(loan.id) ?? 0
        if (!moraMap.has(loan.id)) {
          // Fallback calculation if view data is not available
          const [hy, hm, hd] = todayColombia().split("-").map(Number)
          const hoy = new Date(hy, hm - 1, hd)
          const fechaPagoDate = new Date(targetEntry.fecha_pago + "T00:00:00")
          const diff = Math.floor((hoy.getTime() - fechaPagoDate.getTime()) / (1000 * 60 * 60 * 24))
          mora = Math.max(0, diff)
        }

        // Find last paid entry
        const pagados = paymentPlan.filter((p) => p.estado === "pagado").sort(
          (a, b) => b.numero_cuota - a.numero_cuota
        )
        const lastPaid = pagados[0]

        // Fuente UNICA de verdad para el saldo: `saldo_prestamos_clientes`.
        // Si tras los reintentos NO tenemos el saldo de la vista para este
        // loan, logueamos un error visible y caemos a `loan.saldo` solo
        // como ultimo recurso para no romper la UI. El log permite detectar
        // y monitorear cuando este fallback se dispara en produccion.
        let saldoReal: number
        if (saldoMap.has(loan.id)) {
          saldoReal = saldoMap.get(loan.id)!
        } else {
          console.error(
            `[v0] FALTA saldo_pendiente para loan ${loan.id} despues de retries — usando loan.saldo como ultimo recurso (puede estar desactualizado)`,
          )
          saldoReal = loan.saldo
        }

        const clientData: DisplayClient = {
          loanId: loan.id,
          clientId: loan.client_id,
          nombre: loan.clients?.apodo || loan.clients?.nombre_completo || "Sin nombre",
          documento: loan.clients?.documento || "",
          valorVenta: loan.tipo_amortizacion?.toLowerCase().trim() === "americano"
            ? loan.valor
            : (loan.valor_a_pagar || loan.valor),
          valorPrestamo: loan.valor,
          valorCuota: loan.valor_cuota,
          saldo: saldoReal,
          cuotasPagadas: cuotasPagadas,
          cuotasTotales: cuotasTotales,
          mora,
          ultimoPago: lastPaid?.monto_pagado || 0,
          ultimoPagoFecha: fechaUltimoPagoMap.get(loan.id) ?? lastPaid?.fecha_pago_real?.split("T")[0] ?? "",
          frecuenciaPago: loan.frecuencia_pago,
          tipoAmortizacion: loan.tipo_amortizacion ?? null,
          tasaInteres: loan.tasa_interes,
          nextPaymentId: targetEntry.id,
          nextPaymentCuota: targetEntry.valor_cuota || loan.valor_cuota,
          // numero_cuota REAL (ordinal) — separado del monto.
          nextPaymentNumero: (targetEntry as { numero_cuota?: number }).numero_cuota ?? 0,
          // Precargar capital y valor_cuota REALES de la cuota objetivo para
          // que handleRegisterPayment NO tenga que hacer un SELECT extra a
          // payment_plan (que era el origen del error "No se encontro la
          // cuota pendiente" cuando la session var de RLS se perdia entre
          // conexiones).
          nextPaymentCapital: (targetEntry as { capital?: number }).capital ?? 0,
          nextPaymentValorCuota: targetEntry.valor_cuota ?? loan.valor_cuota ?? 0,
          nextPaymentEsFuturo: esFuturo,
          nextPaymentFecha: targetEntry.fecha_pago,
          ordenvisita: loan.ordenvisita || 0,
          diaSemana: loan.dia_semana || null,
        }

        // Check if target entry has been managed (pagado, no_pago, parcial, or cancelada)
        const isManaged = targetEntry.estado === "pagado" || targetEntry.estado === "no_pago" || targetEntry.estado === "parcial" || targetEntry.estado === "cancelada"

        if (isManaged) {
          // Extract time from fecha_pago_real if available
          const gestionHora = targetEntry.fecha_pago_real
            ? new Date(targetEntry.fecha_pago_real).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
            : ""

          managedClientsFromDB.push({
            ...clientData,
            gestionTipo: targetEntry.estado === "no_pago" ? "no_pago" : "pago",
            gestionHora,
            valorAbonado: targetEntry.monto_pagado || 0,
            paymentPlanId: targetEntry.id,
          })
        } else {
          // Loans con estado "cancelado" no se muestran en el listado de pendientes.
          if (loan.estado === "cancelado") {
            continue
          }
          pendingClients.push(clientData)
        }
      }

      // Sort: clientes con cuota pendiente procesable primero (ordenvisita),
      // y los que tienen cuota FUTURA (no se pueden procesar hoy) al final.
      pendingClients.sort((a, b) => {
        const aFuturo = a.nextPaymentEsFuturo ? 1 : 0
        const bFuturo = b.nextPaymentEsFuturo ? 1 : 0
        if (aFuturo !== bFuturo) return aFuturo - bFuturo
        return a.ordenvisita - b.ordenvisita
      })
      managedClientsFromDB.sort((a, b) => a.ordenvisita - b.ordenvisita)

      // Solo aplicamos el resultado si este fetch sigue siendo el mas reciente.
      if (fetchDataTokenRef.current !== myToken) return

      setClients(pendingClients)
      setManagedToday(managedClientsFromDB)
    } catch (error) {
      if (fetchDataTokenRef.current !== myToken) return
      console.error("[v0] Error fetching payment data:", error)
      toastRef.current({
        title: "Error",
        description: "No se pudieron cargar los datos. Intenta nuevamente.",
        variant: "destructive",
      })
    } finally {
      // Solo apagamos el loading si seguimos siendo el fetch activo
      // Y si no fue un refresh silencioso (en ese caso nunca lo encendimos).
      if (fetchDataTokenRef.current === myToken && !silent) {
        setLoading(false)
      }
    }
  }, [currentRutaId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSelectClient = (client: DisplayClient) => {
    setSelectedClient(client)
    setNumCuotas(1)
    setIsPartialPayment(false)
    setPaymentAmount(client.nextPaymentCuota.toString())
    setPaymentMethod("efectivo")
    setAccountNumber("")
    setPaymentPhoto(null)
    setIsCancelada(false)
    setExtenderCuotas(false)
    setCantidadCuotasExtender("1")
    // Nota: ya no hacemos fetch de saldo aqui. Usamos client.saldo
    // directamente del listado para que el dialogo abra al instante.
  }

  const handleBack = () => {
    setSelectedClient(null)
    setNumCuotas(1)
    setIsPartialPayment(false)
    setPaymentAmount("")
    setPaymentMethod("efectivo")
    setAccountNumber("")
    setPaymentPhoto(null)
    setIsCancelada(false)
    setExtenderCuotas(false)
    setCantidadCuotasExtender("1")
  }

  const handleRegisterPayment = async () => {
    if (!selectedClient || !selectedClient.nextPaymentId) {
      toast({ title: "Error", description: "No hay cuota pendiente para este cliente", variant: "destructive" })
      return
    }

    // Validaciones sincronicas ANTES de mostrar saving / pedir GPS para no
    // bloquear la UI innecesariamente.
    const monto = Number.parseFloat(paymentAmount)
    if (isNaN(monto) || monto <= 0) {
      toast({ title: "Error", description: "Ingrese un monto valido", variant: "destructive" })
      return
    }

    const saldoDisponible = selectedClient.saldo
    if (monto > saldoDisponible) {
      toast({
        title: "Monto excede el saldo",
        description: `El monto del pago ($${monto.toLocaleString()}) no puede ser mayor al saldo a pagar ($${saldoDisponible.toLocaleString()})`,
        variant: "destructive",
      })
      return
    }

    // GPS primero (puede tardar 1-2s en moviles): si no esta, no abrimos saving.
    let coords: { latitud: number; longitud: number }
    try {
      coords = await getCurrentLocation()
    } catch {
      toast({
        title: "GPS no disponible",
        description: "Activa el GPS del dispositivo para registrar pagos.",
        variant: "destructive",
      })
      return
    }

    const clientSnapshot = selectedClient
    const isCanceladaSnap = isCancelada
    const isPartialSnap = isPartialPayment
    const numCuotasSnap = numCuotas
    // Snapshot del flag de extension. Solo aplica si:
    //   - el prestamo es tipo "americano" (intereses)
    //   - la cuota actual es la ULTIMA del plan
    //   - el admin marco el checkbox y digito una cantidad valida (>=1)
    const extenderSnap =
      extenderCuotas &&
      clientSnapshot.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
      clientSnapshot.nextPaymentNumero === clientSnapshot.cuotasTotales
    const cantidadExtenderSnap = (() => {
      const n = Number.parseInt(cantidadCuotasExtender, 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    })()
    if (extenderSnap && cantidadExtenderSnap === 0) {
      toast({
        title: "Cantidad invalida",
        description: "Ingresa una cantidad valida de cuotas a extender (>= 1).",
        variant: "destructive",
      })
      return
    }

    try {
      setSaving(true)

      // Fecha y timestamp en zona Colombia (UTC-5, sin horario de verano).
      // Construimos el ISO-8601 con offset fijo -05:00 pieza a pieza para
      // garantizar el resultado correcto en cualquier entorno JS, sin
      // depender de que toLocaleString resuelva bien el timezone.
      const now = new Date()
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
      })
      const parts = Object.fromEntries(
        fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
      )
      const fechaPago = `${parts.year}-${parts.month}-${parts.day}`
      const fechaPagoReal = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-05:00`
      const { latitud, longitud } = coords

      // -----------------------------------------------------------------
      // ── PAGO EXTRAORDINARIO desde "No Diarios" ───────────────────────
      // Cuando un cobrador esta en la pestana "No Diarios" y registra un
      // pago para un cliente cuya cuota objetivo NO es de hoy (p.ej. una
      // cuota del miercoles 20 que se paga el jueves 21), el RPC
      // `registrar_pago_atomico` no la reconoce como pago del dia. Para
      // no tocar la RPC atomica, adelantamos la `fecha_pago` de esa
      // cuota a HOY justo antes de invocarla. La RPC entonces la procesa
      // como un pago normal del dia.
      //
      // Solo aplica cuando:
      //   - estamos en la pestana "No Diarios" (`!isDiario`)
      //   - la cuota objetivo tiene una fecha distinta a hoy
      //
      // Para clientes diarios (donde la cuota es de hoy o vencida) este
      // bloque queda inactivo y el flujo es el de siempre.
      const cuotaFechaOriginal = clientSnapshot.nextPaymentFecha
      const esPagoExtraordinario =
        !isDiario && !!cuotaFechaOriginal && cuotaFechaOriginal !== fechaPago
      if (esPagoExtraordinario && clientSnapshot.nextPaymentId) {
        try {
          const supabase = await getSupabaseSafe()
          const { error: fechaErr } = await supabase
            .from("payment_plan")
            .update({ fecha_pago: fechaPago })
            .eq("id", clientSnapshot.nextPaymentId)
          if (fechaErr) {
            console.error(
              "[v0] Error adelantando fecha_pago para pago extraordinario:",
              fechaErr,
            )
            toast({
              title: "Error",
              description:
                "No se pudo registrar el pago extraordinario: " + fechaErr.message,
              variant: "destructive",
            })
            setSaving(false)
            return
          }
          console.log("[v0] Pago extraordinario: cuota movida de", cuotaFechaOriginal, "a", fechaPago)
        } catch (err) {
          console.error("[v0] Excepcion en pago extraordinario:", err)
          toast({
            title: "Error",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          })
          setSaving(false)
          return
        }
      }

      // -----------------------------------------------------------------
      // ── DOBLE CANDADO de extension (blindaje anti-bug) ───────────────
      // El RPC `extender_prestamo_americano` SOLO puede dispararse si las
      // 3 condiciones se cumplen simultaneamente. Re-evaluamos aqui las
      // condiciones literales (no confiamos solo en `extenderSnap`) para
      // que un pago normal de cuotas intermedias jamas toque la rama de
      // extension. Si algun guard fallara, abortamos la extension con un
      // log explicito en lugar de silenciosamente dispararla.
      const debeExtender =
        extenderCuotas === true &&
        clientSnapshot.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
        clientSnapshot.nextPaymentNumero === clientSnapshot.cuotasTotales

      if (extenderSnap !== debeExtender) {
        console.warn(
          "[v0] BLINDAJE-EXTENDER mismatch entre snapshot y guard literal:",
          { extenderSnap, debeExtender, extenderCuotas, clientSnapshot },
        )
      }

      // Pre-steps (solo para extension de americano):
      //
      // 1) Ajustar el `valor_cuota` de la ULTIMA cuota original.
      //    Antes valia `intereses + capital` (cierre del prestamo); ahora
      //    pasa a ser un pago normal de intereses, asi que lo bajamos a
      //    `loan.valor_cuota`.
      //
      // 2) Crear las N cuotas adicionales (extension) ANTES de registrar
      //    el pago. Esto es CRITICO para evitar que el `registrar_pago_atomico`
      //    marque el prestamo como `cancelado`: la RPC cancela el loan
      //    cuando ya no quedan cuotas en estado 'pendiente'. Si la
      //    extension corriera DESPUES del pago, habria una ventana donde
      //    el loan queda en estado 'cancelado' (con `tiene_prestamo_activo
      //    = false` en el cliente) y solo despues se reactivaria — lo cual
      //    es exactamente lo que queremos evitar.
      //
      //    Al insertar primero las nuevas cuotas pendientes, cuando la RPC
      //    procese la cuota actual quedaran cuotas pendientes y el loan
      //    se mantendra en estado 'activo' sin pasar nunca por 'cancelado'.
      // -----------------------------------------------------------------
      if (debeExtender && clientSnapshot.nextPaymentId) {
        try {
          const supabase = await getSupabaseSafe()

          // 1) Bajar valor_cuota de la cuota actual a solo intereses.
          const { error: updErr } = await supabase
            .from("payment_plan")
            .update({ valor_cuota: clientSnapshot.valorCuota })
            .eq("id", clientSnapshot.nextPaymentId)
          if (updErr) {
            console.error("[v0] Error ajustando valor_cuota antes de extender:", updErr)
            toast({
              title: "Error",
              description: "No se pudo ajustar el valor de la cuota: " + updErr.message,
              variant: "destructive",
            })
            setSaving(false)
            return
          }

          // 2) Crear cuotas adicionales via RPC. Lo hacemos ANTES del pago
          //    para que el loan nunca quede en estado 'cancelado'.
          const { error: extError } = await supabase.rpc(
            "extender_prestamo_americano",
            {
              p_loan_id: clientSnapshot.loanId,
              p_nuevas_cuotas: cantidadExtenderSnap,
              p_ruta_id: currentRutaId,
            },
          )
          if (extError) {
            console.error("[v0] extender_prestamo_americano error:", extError)
            toast({
              title: "Error al extender el préstamo",
              description: extError.message ?? "No se pudo extender el préstamo.",
              variant: "destructive",
            })
            setSaving(false)
            return
          }
        } catch (err) {
          console.error("[v0] Excepcion durante extension:", err)
          toast({
            title: "Error",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          })
          setSaving(false)
          return
        }
      }

      // -----------------------------------------------------------------
      // Llamada al RPC atomico `registrar_pago_atomico`.
      //
      // La RPC envuelve en una sola transaccion todos los UPDATEs que
      // antes corrian con `Promise.all` separados, garantizando atomicidad
      // (rollback completo si algun paso falla). El payload va como `jsonb`
      // con una firma estable y la funcion deriva `tipo` para decidir si
      // paga 1 cuota, varias, cancelacion total o no_pago.
      // -----------------------------------------------------------------
      const tipoOperacion: "pago_normal" | "pago_parcial" | "cancelacion_total" =
        isCanceladaSnap ? "cancelacion_total" : isPartialSnap ? "pago_parcial" : "pago_normal"

      const rpcResult = await callRpcAtomic("registrar_pago_atomico", {
        tipo: tipoOperacion,
        loan_id: clientSnapshot.loanId,
        client_id: clientSnapshot.clientId,
        monto,
        num_cuotas: numCuotasSnap,
        fecha_pago: fechaPago,
        fecha_pago_real: fechaPagoReal,
        latitud,
        longitud,
      })

      // Valores derivados desde la respuesta autoritativa del RPC.
      // Los usamos para el optimistic UI inmediato (sin esperar al refetch).
      const nuevoSaldo = (rpcResult.nuevo_saldo as number | undefined) ?? clientSnapshot.saldo
      void rpcResult.loan_estado_final
      void rpcResult.cliente_marcado_sin_prestamo

      // Optimistic UI: quitar al cliente de la lista de pendientes localmente
      // y agregarlo a managedToday con la forma correcta de ManagedClient
      // (DisplayClient & { gestionTipo, gestionHora, valorAbonado, paymentPlanId? }).
      const gestionHora = new Date().toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
      })
      setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
      setManagedToday((prev) => [
        {
          ...clientSnapshot,
          saldo: nuevoSaldo,
          gestionTipo: "pago",
          gestionHora,
          valorAbonado: isCanceladaSnap ? clientSnapshot.saldo : monto,
          paymentPlanId: clientSnapshot.nextPaymentId ?? undefined,
        },
        ...prev,
      ])

      if (isCanceladaSnap) {
        toast({
          title: "Préstamo cancelado",
          description: `Se canceló el préstamo de ${clientSnapshot.nombre} con un pago de $${monto.toLocaleString()}`,
        })
        setClientForRenovation(clientSnapshot)
        setShowRenovationDialog(true)
      } else if (debeExtender) {
        // La extension ya se ejecuto ANTES del pago (ver pre-steps), asi
        // que aqui solo informamos el resultado al usuario.
        toast({
          title: "Pago registrado y préstamo extendido",
          description: `Pago registrado y préstamo extendido exitosamente por ${cantidadExtenderSnap} cuota${cantidadExtenderSnap === 1 ? "" : "s"} más`,
        })
      } else {
        toast({
          title: esPagoExtraordinario ? "Pago extraordinario registrado" : "Pago registrado",
          description: esPagoExtraordinario
            ? `Se registró el pago extraordinario por $${monto.toLocaleString()} para ${clientSnapshot.nombre} (cuota originalmente del ${cuotaFechaOriginal}).`
            : `Se registró el pago por $${monto.toLocaleString()} para ${clientSnapshot.nombre}`,
        })
      }

      // Refetch SILENCIOSO en background para sincronizar mora/saldos calculados.
      void fetchData({ silent: true })

      // Preguntar si desea compartir el comprobante antes de volver al listado.
      setClientForShare(clientSnapshot)
      setShowShareDialog(true)
    } catch (error) {
      console.error("[v0] Error registering payment:", error)
      toast({ title: "Error", description: "No se pudo registrar el pago", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handleRegisterNoPayment = async () => {
    if (!noPaymentClient || !noPaymentClient.nextPaymentId) return

    // GPS antes de mostrar saving para no bloquear la UI si falla
    let coords: { latitud: number; longitud: number }
    try {
      coords = await getCurrentLocation()
    } catch {
      toast({
        title: "GPS no disponible",
        description: "Activa el GPS del dispositivo para registrar no pagos.",
        variant: "destructive",
      })
      return
    }

    const clientSnapshot = noPaymentClient

    try {
      setSaving(true)

      const now = new Date()
      const fmtNp = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
      })
      const partsNp = Object.fromEntries(
        fmtNp.formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
      )
      const colombiaDateStr = `${partsNp.year}-${partsNp.month}-${partsNp.day}`
      const fechaPagoReal = `${partsNp.year}-${partsNp.month}-${partsNp.day}T${partsNp.hour}:${partsNp.minute}:${partsNp.second}-05:00`
      const { latitud, longitud } = coords

      // Mismo razonamiento que `handleRegisterPayment`: el RPC atomico
      // `registrar_pago_atomico` con tipo=no_pago corre dentro de UNA
      // transaccion que fija las session vars con `SET LOCAL`, eliminando
      // la carrera con PgBouncer. El RPC marca la cuota como `no_pago` y
      // NO modifica `loans.saldo` ni `clients` (eso lo maneja internamente
      // segun el contrato definido en scripts/010-fn-registrar-pago-atomico.sql).
      await callRpcAtomic("registrar_pago_atomico", {
        tipo: "no_pago",
        loan_id: clientSnapshot.loanId,
        client_id: clientSnapshot.clientId,
        monto: 0,
        num_cuotas: 1,
        fecha_pago: colombiaDateStr,
        fecha_pago_real: fechaPagoReal,
        latitud,
        longitud,
      })

      // Optimistic UI: quitar de pendientes y agregar a managedToday
      const gestionHora = now.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
      setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
      setManagedToday((prev) => [
        {
          ...clientSnapshot,
          gestionTipo: "no_pago",
          gestionHora,
          valorAbonado: 0,
          paymentPlanId: clientSnapshot.nextPaymentId ?? undefined,
        },
        ...prev,
      ])

      toast({
        title: "No pago registrado",
        description: `Se registró que ${clientSnapshot.nombre} no realizó el pago`,
      })

      setNoPaymentClient(null)
      // Refetch SILENCIOSO en background sin bloquear el cierre del dialogo
      // ni mostrar spinner overlay (el optimistic UI ya muestra al cliente
      // como gestionado).
      void fetchData({ silent: true })
    } catch (error) {
      console.error("[v0] Error registering no-payment:", error)
      toast({ title: "Error", description: "No se pudo registrar el no pago", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const handlePartialPaymentChange = (checked: boolean) => {
    setIsPartialPayment(checked)
    if (checked && selectedClient) {
      setPaymentAmount("")
    } else if (!checked && selectedClient) {
      setPaymentAmount((selectedClient.nextPaymentCuota * numCuotas).toString())
    }
  }

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => setPaymentPhoto(reader.result as string)
      reader.readAsDataURL(file)
    }
  }

  const handleNoPaymentPhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => setNoPaymentPhoto(reader.result as string)
      reader.readAsDataURL(file)
    }
  }

  // ── Historial de pagos: fetch payment_plan por loan_id ────────────────
  useEffect(() => {
    if (!paymentHistoryOpen || !paymentHistoryClient) return
    let cancelled = false
    setPaymentHistoryLoading(true)
    setPaymentHistoryRows([]);
    (async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("payment_plan")
          .select("id, fecha_pago, valor_cuota, estado, monto_pagado")
          .eq("loan_id", paymentHistoryClient.loanId)
          .order("numero_cuota", { ascending: true })
        if (cancelled) return
        if (error) throw error
        setPaymentHistoryRows(data ?? [])
      } catch (e) {
        console.error("[v0] paymentHistory fetch error:", e)
      } finally {
        if (!cancelled) setPaymentHistoryLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [paymentHistoryOpen, paymentHistoryClient])

  // ── Historial de préstamos: fetch loans por client_id ─────────────────
  useEffect(() => {
    if (!loanHistoryOpen || !loanHistoryClient) return
    let cancelled = false
    setLoanHistoryLoading(true)
    setLoanHistoryRows([]);
    (async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("loans")
          .select("id, valor, numero_cuotas, frecuencia_pago, estado, fecha_creacion, created_at")
          .eq("client_id", loanHistoryClient.clientId)
          .order("created_at", { ascending: false })
        if (cancelled) return
        if (error) throw error
        setLoanHistoryRows(
          (data ?? []).map((r: any) => ({
            id: r.id,
            valor: r.valor,
            numero_cuotas: r.numero_cuotas,
            frecuencia_pago: r.frecuencia_pago,
            estado: r.estado,
            fecha_creacion: (r.fecha_creacion || r.created_at || "").split("T")[0],
          }))
        )
      } catch (e) {
        console.error("[v0] loanHistory fetch error:", e)
      } finally {
        if (!cancelled) setLoanHistoryLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [loanHistoryOpen, loanHistoryClient])

  // ── Info del cliente: fetch clients table por client_id ───────────────
  useEffect(() => {
    if (!clientInfoDialogOpen || !selectedClientInfo) return
    let cancelled = false
    setClientInfoLoading(true)
    setClientInfoFetched(null);
    (async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("clients")
          .select("nombre_completo, apodo, documento, telefono, direccion")
          .eq("id", selectedClientInfo.clientId)
          .single()
        if (cancelled) return
        if (error) throw error
        setClientInfoFetched(data)
      } catch (e) {
        console.error("[v0] clientInfo fetch error:", e)
      } finally {
        if (!cancelled) setClientInfoLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [clientInfoDialogOpen, selectedClientInfo])

  // ── Generar recibo PDF con jspdf ──────────────────────────────────────
  const buildReciboPdf = async (client: DisplayClient) => {
    const supabase = await getSupabaseSafe()
    const [saldoRes, clientRes] = await Promise.all([
      supabase
        .from("saldo_prestamos_clientes")
        .select("monto_original, total_con_intereses, total_recaudado, saldo_pendiente")
        .eq("loan_id", client.loanId)
        .single(),
      supabase
        .from("clients")
        .select("nombre_completo")
        .eq("id", client.clientId)
        .single(),
    ])

    const saldo = saldoRes.data
    const nombreCompleto = clientRes.data?.nombre_completo ?? client.nombre

    const { jsPDF } = await import("jspdf")
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [80, 140] })

    const now = new Date()
    const fechaStr = now.toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" })
    const horaStr = now.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })

    const pageW = 80
    let y = 8

    doc.setFontSize(10)
    doc.setFont("helvetica", "bold")
    doc.text("RECIBO DE PAGO", pageW / 2, y, { align: "center" })
    y += 6

    doc.setFontSize(7)
    doc.setFont("helvetica", "normal")
    doc.text(`Fecha: ${fechaStr}  Hora: ${horaStr}`, pageW / 2, y, { align: "center" })
    y += 5

    doc.setLineWidth(0.3)
    doc.line(5, y, pageW - 5, y)
    y += 4

    doc.setFontSize(8)
    doc.setFont("helvetica", "bold")
    doc.text("Cliente:", 5, y)
    doc.setFont("helvetica", "normal")
    doc.text(nombreCompleto, 25, y)
    y += 5

    doc.setFont("helvetica", "bold")
    doc.text("Documento:", 5, y)
    doc.setFont("helvetica", "normal")
    doc.text(client.documento || "-", 25, y)
    y += 5

    doc.line(5, y, pageW - 5, y)
    y += 4

    const fmt = (n: number | null | undefined) =>
      n != null ? `$${Math.round(n).toLocaleString("es-CO")}` : "-"

    const rows: [string, string][] = [
      ["Monto original:", fmt(saldo?.monto_original)],
      ["Total c/intereses:", fmt(saldo?.total_con_intereses)],
      ["Total recaudado:", fmt(saldo?.total_recaudado)],
      ["Saldo pendiente:", fmt(saldo?.saldo_pendiente ?? client.saldo)],
      ["Cuotas:", `${client.cuotasPagadas} / ${client.cuotasTotales}`],
      ["Frecuencia:", frecuenciaLabel(client.frecuenciaPago)],
    ]

    doc.setFontSize(8)
    for (const [label, val] of rows) {
      doc.setFont("helvetica", "bold")
      doc.text(label, 5, y)
      doc.setFont("helvetica", "normal")
      doc.text(val, pageW - 5, y, { align: "right" })
      y += 5
    }

    doc.line(5, y, pageW - 5, y)
    y += 4

    doc.setFontSize(6.5)
    doc.setFont("helvetica", "italic")
    doc.text("Este documento es un comprobante informativo.", pageW / 2, y, { align: "center" })

    const filename = `recibo_${client.nombre.replace(/\s+/g, "_")}_${fechaStr.replace(/\//g, "-")}.pdf`
    return { doc, filename }
  }

  const handleGenerarRecibo = async (client: DisplayClient) => {
    try {
      const { doc, filename } = await buildReciboPdf(client)
      doc.save(filename)
    } catch (e) {
      console.error("[v0] handleGenerarRecibo error:", e)
      toast({ title: "Error", description: "No se pudo generar el recibo.", variant: "destructive" })
    }
  }

  const handleShareComprobante = async (client: DisplayClient) => {
    setSharingPdf(true)
    try {
      const { doc, filename } = await buildReciboPdf(client)
      const pdfBlob = doc.output("blob")
      const file = new File([pdfBlob], filename, { type: "application/pdf" })

      if (
        typeof navigator !== "undefined" &&
        navigator.share &&
        navigator.canShare &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({ files: [file], title: "Recibo de pago" })
      } else {
        // Fallback: descarga directa si Web Share API no soporta archivos
        doc.save(filename)
      }
    } catch (e: unknown) {
      // El usuario canceló el share — no es un error real
      if (e instanceof Error && e.name !== "AbortError") {
        console.error("[v0] handleShareComprobante error:", e)
        toast({ title: "Error", description: "No se pudo compartir el comprobante.", variant: "destructive" })
      }
    } finally {
      setSharingPdf(false)
    }
  }

  const handleRenovationConfirm = () => {
    setShowRenovationDialog(false)
    if (onViewChange && clientForRenovation) {
      onViewChange("new-loan", clientForRenovation)
    }
    setClientForRenovation(null)
  }

  const handleRenovationCancel = async () => {
    // When user declines renovation after cancelada, mark client as no longer having active loan
    if (clientForRenovation) {
      try {
        await fetch("/api/clients", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: clientForRenovation.clientId,
            tiene_prestamo_activo: false,
          }),
        })
      } catch (e) {
        console.error("[v0] Error updating client tiene_prestamo_activo:", e)
      }
    }
    setShowRenovationDialog(false)
    setClientForRenovation(null)
  }

  // No longer needed - clients are automatically moved to managed when payment_plan is updated
  // fetchData() will reload from DB and properly categorize clients

  // Resolve the paymentPlanId for a managed client — use stored one or fetch from DB
  const resolvePaymentPlanId = async (m: ManagedClient): Promise<string | null> => {
    if (m.paymentPlanId) return m.paymentPlanId
    // Fetch today's payment plan row for this loan via safeQuery: garantiza
    // RLS aplicada antes de la lectura y dispara session-lost si falla.
    try {
      const supabase = await getSupabaseSafe()
      const today = todayColombia()
      const { data } = await supabase
        .from("payment_plan")
        .select("id")
        .eq("loan_id", m.loanId)
        .eq("fecha_pago", today)
        .limit(1)
        .single()
      return data?.id ?? null
    } catch (_e) {
      return null
    }
  }

  // Edit a managed payment: update monto_pagado in payment_plan
  const handleEditManagedSave = async () => {
    if (!editingManaged) return
    const newMonto = Number.parseFloat(editMonto)
    if (isNaN(newMonto) || newMonto <= 0) return
    setSavingManaged(true)
    try {
      const resolvedId = await resolvePaymentPlanId(editingManaged)
      if (!resolvedId) throw new Error("No payment plan row found")
      await fetch("/api/payment-plan", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: resolvedId, monto_pagado: newMonto }),
      })
      setEditingManaged(null)
      toast({ title: "Pago actualizado", description: `Monto actualizado a $${newMonto.toLocaleString()}` })
      // Refresh silencioso: el cambio es menor (solo monto), no vale la pena
      // bloquear toda la lista con un spinner.
      void fetchData({ silent: true })
    } catch (_e) {
      toast({ title: "Error", description: "No se pudo actualizar el pago", variant: "destructive" })
    } finally {
      setSavingManaged(false)
    }
  }

  // Delete a managed payment: clear fecha_pago_real and monto_pagado so it returns to pending
  const handleDeleteManagedPayment = async (m: ManagedClient) => {
    setSavingManaged(true)
    try {
      const resolvedId = m.paymentPlanId || (await resolvePaymentPlanId(m))
      if (!resolvedId) throw new Error("No payment plan row found")

      // ----------------------------------------------------------------
      // Llamada al RPC atomico `registrar_pago_revertir`.
      //
      // El RPC revierte los 4 efectos del pago original en UNA transaccion:
      //   1. payment_plan.estado → 'pendiente' (limpia monto_pagado, fecha)
      //   2. loans.saldo         → += capital de la cuota
      //   3. loans.estado        → 'activo' si estaba 'cancelado'
      //   4. clients.tiene_prestamo_activo → true si el loan se reactiva
      //
      // Como SET LOCAL aplica para toda la transaccion del RPC, no hay
      // condicion de carrera con PgBouncer transaccional. La respuesta
      // incluye `nuevo_saldo` para el optimistic UI sin necesidad de un
      // SELECT adicional.
      // ----------------------------------------------------------------
      const rpcResult = await callRpcAtomic("registrar_pago_revertir", {
        payment_plan_id: resolvedId,
      })

      const nuevoSaldo = (rpcResult.nuevo_saldo as number | undefined) ?? m.saldo
      const capitalARevertir = Math.max(0, nuevoSaldo - m.saldo)

      // Optimistic UI: mover de managed → pending sin esperar refetch.
      // ManagedClient extiende DisplayClient, asi que el spread es seguro.
      const restored: DisplayClient = {
        loanId: m.loanId,
        clientId: m.clientId,
        nombre: m.nombre,
        documento: m.documento,
        valorVenta: m.valorVenta,
        valorCuota: m.valorCuota,
        saldo: nuevoSaldo,
        cuotasPagadas: Math.max(0, m.cuotasPagadas - 1),
        cuotasTotales: m.cuotasTotales,
        mora: m.mora,
        ultimoPago: m.ultimoPago,
        ultimoPagoFecha: m.ultimoPagoFecha,
        frecuenciaPago: m.frecuenciaPago,
        tipoAmortizacion: m.tipoAmortizacion,
        tasaInteres: m.tasaInteres,
        nextPaymentId: resolvedId,
        nextPaymentCuota: m.nextPaymentCuota,
        nextPaymentNumero: m.nextPaymentNumero,
        nextPaymentCapital: capitalARevertir,
        nextPaymentValorCuota: m.nextPaymentValorCuota,
        ordenvisita: m.ordenvisita,
        diaSemana: m.diaSemana,
      }
      setManagedToday((prev) => prev.filter((x) => x.loanId !== m.loanId))
      setClients((prev) => {
        const next = prev.filter((x) => x.loanId !== m.loanId)
        next.push(restored)
        return next.sort((a, b) => a.ordenvisita - b.ordenvisita)
      })

      // Refresh silencioso en background para sincronizar derivados
      // (mora, saldo_prestamos_clientes) sin bloquear la UI.
      void fetchData({ silent: true })
      toast({ title: "Pago eliminado", description: `${m.nombre} volvió a la lista de pendientes` })
    } catch (e) {
      console.error("[v0] handleDeleteManagedPayment error:", e)
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : "No se pudo eliminar el pago",
        variant: "destructive",
      })
    } finally {
      setSavingManaged(false)
    }
  }

  const getMoraColor = (mora: number) => {
    // 0 to 4 days: green
    if (mora <= 4) return "text-green-700 bg-green-100"
    // 5 to 8 days: yellow
    if (mora <= 8) return "text-yellow-700 bg-yellow-100"
    // More than 8 days: red
    return "text-red-700 bg-red-100"
  }

  // Iniciar ruta del dia. Es idempotente: si ya existe la fila en rutas_diarias
  // (porque otro flujo, otra pestana o Resumen del Dia ya la creo) recupera el
  // estado real con SELECT y sincroniza el guard, en vez de fallar al usuario.
  const handleIniciarRutaInline = async () => {
    if (iniciandoRuta) return
    try {
      setIniciandoRuta(true)
      // Centralizado en `safeQuery`: garantiza RLS lista o redirige al login.
      const supabase = await getSupabaseSafe()
      // Fecha hoy en zona Colombia (YYYY-MM-DD)
      const fechaHoy = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date())

      // 1) Verificar primero si ya existe una fila para hoy.
      const { data: existente, error: errorSelect } = await supabase
        .from("rutas_diarias")
        .select("id, estado")
        .eq("ruta_id", currentRutaId)
        .eq("fecha", fechaHoy)
        .maybeSingle()

      if (errorSelect) {
        console.error("[v0] Error consultando rutas_diarias:", errorSelect.message)
      }

      if (existente) {
        const estadoExistente = existente.estado as "abierta" | "cerrada" | null
        // Si ya esta abierta, simplemente sincronizamos el guard.
        if (estadoExistente === "abierta") {
          onRouteStateChange?.("abierta")
          toast({
            title: "Ruta ya iniciada",
            description: "La ruta ya estaba abierta para hoy. Sincronizando...",
          })
          return
        }
        // Si esta cerrada, no podemos reabrir desde aqui — informar al usuario.
        if (estadoExistente === "cerrada") {
          onRouteStateChange?.("cerrada")
          toast({
            title: "La ruta del dia esta cerrada",
            description: "Contacta al administrador para reabrir la ruta.",
            variant: "destructive",
          })
          return
        }
      }

      // 2) No existe — insertar normalmente.
      const { data, error } = await supabase
        .from("rutas_diarias")
        .insert({
          ruta_id: currentRutaId,
          fecha: fechaHoy,
          estado: "abierta",
        })
        .select("id, estado")
        .single()

      if (error) {
        // Si el INSERT falla con duplicate key (codigo 23505) significa que otra
        // peticion la creo entre nuestro SELECT y nuestro INSERT — releemos.
        const isDuplicate =
          (error as { code?: string }).code === "23505" ||
          /unique_ruta_por_dia|duplicate key/i.test(error.message)

        if (isDuplicate) {
          const { data: refetch } = await supabase
            .from("rutas_diarias")
            .select("estado")
            .eq("ruta_id", currentRutaId)
            .eq("fecha", fechaHoy)
            .maybeSingle()
          const estado = (refetch?.estado ?? null) as "abierta" | "cerrada" | null
          if (estado) onRouteStateChange?.(estado)
          toast({
            title: estado === "abierta" ? "Ruta ya iniciada" : "Sincronizando estado de ruta",
            description:
              estado === "abierta"
                ? "La ruta ya estaba abierta para hoy."
                : "Se actualizo el estado actual de la ruta.",
          })
          return
        }

        console.error("[v0] Error iniciando ruta:", error.message)
        toast({
          title: "No se pudo iniciar la ruta",
          description: error.message,
          variant: "destructive",
        })
        return
      }

      if (data) {
        onRouteStateChange?.("abierta")
        toast({
          title: "Ruta iniciada",
          description: "Ya puedes registrar pagos y no pagos.",
        })
      }
    } catch (err) {
      console.error("[v0] Unexpected error iniciando ruta:", err)
    } finally {
      setIniciandoRuta(false)
    }
  }

  // Mientras el padre todavia no haya resuelto el estado de rutas_diarias,
  // mostramos un spinner neutro (no el guard "Ruta no iniciada") para
  // evitar el flash confuso de ~500ms en cada recarga. El guard solo se
  // renderiza con respuesta DEFINITIVA del servidor o de cache local.
  if (!rutaActivaResolved && rutaActivaEstado === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Verificando estado de la ruta...</p>
      </div>
    )
  }

  // Guard: ruta must be in "abierta" state before allowing payments
  if (rutaActivaEstado !== "abierta") {
    return (
      <div className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-card px-6 py-16 text-center shadow-steel">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-warning/10 ring-4 ring-warning/20">
          <AlertCircle className="h-8 w-8 text-warning" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-xl font-bold text-foreground">Ruta no iniciada</h2>
          <p className="max-w-sm text-sm text-muted-foreground leading-relaxed">
            Para registrar pagos o no pagos primero debes iniciar la ruta del dia. Tambien puedes hacerlo desde la pestana{" "}
            <strong className="text-foreground">Resumen del Dia</strong>.
          </p>
        </div>
        <div className="flex flex-col items-center gap-2 sm:flex-row">
          <Button
            size="lg"
            className="gap-2 bg-success text-success-foreground hover:bg-success/90"
            onClick={handleIniciarRutaInline}
            disabled={iniciandoRuta}
          >
            {iniciandoRuta ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {iniciandoRuta ? "Iniciando..." : "Iniciar Ruta"}
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="gap-2"
            onClick={() => onViewChange("daily-summary")}
            disabled={iniciandoRuta}
          >
            Ir a Resumen del Dia
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 md:space-y-6">
      {/* ── GPS permission banner ─────────────────────────────────────────── */}
      {gpsStatus !== "granted" && gpsStatus !== "checking" && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <MapPinOff className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold leading-tight">
              {gpsStatus === "denied"
                ? "Permiso de ubicación denegado"
                : "GPS no disponible en este dispositivo"}
            </p>
            <p className="mt-0.5 text-xs text-destructive/80">
              {gpsStatus === "denied"
                ? "Debes permitir el acceso a la ubicación en la configuración del navegador para registrar pagos o no pagos."
                : "No es posible obtener la ubicación. Verifica que el GPS esté activado."}
            </p>
          </div>
          {gpsStatus !== "denied" && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 gap-1.5 text-xs"
              onClick={requestGpsPermission}
            >
              <MapPin className="h-3.5 w-3.5" />
              Solicitar permiso
            </Button>
          )}
        </div>
      )}
      {gpsStatus === "checking" && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span>Verificando acceso a GPS...</span>
        </div>
      )}

      {!selectedClient ? (
        <Card>
          <CardHeader className="p-3 md:p-6 sticky top-0 z-10 bg-card border-b border-border">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
              <div className="flex items-center gap-2">
                <CardTitle className="text-base md:text-2xl">Clientes Activos</CardTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 md:h-9 md:w-9"
                  onClick={() => {
                    setLoading(true)
                    fetchData()
                  }}
                  disabled={loading}
                >
                  <RefreshCw className={`h-4 w-4 md:h-5 md:w-5 ${loading ? "animate-spin" : ""}`} />
                </Button>
                {/* Mora filter buttons — show totals from preFilteredClients so counts
                    don't change while a filter is active. Click to filter/deactivate. */}
                {(() => {
                  const greenCount = preFilteredClients.filter(c => c.mora <= 4).length
                  const yellowCount = preFilteredClients.filter(c => c.mora > 4 && c.mora <= 8).length
                  const redCount = preFilteredClients.filter(c => c.mora > 8).length
                  const items = [
                    { id: "green" as const, bg: "bg-green-500", ring: "ring-green-400", count: greenCount, label: "0-4 días de mora" },
                    { id: "yellow" as const, bg: "bg-yellow-500", ring: "ring-yellow-400", count: yellowCount, label: "5-8 días de mora" },
                    { id: "red" as const, bg: "bg-red-500", ring: "ring-red-400", count: redCount, label: "Más de 8 días de mora" },
                  ]
                  return (
                    <div className="flex items-center gap-1.5 ml-1">
                      {items.map(({ id, bg, ring, count, label }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setMoraFilter(prev => prev === id ? null : id)}
                          className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-all cursor-pointer
                            ${moraFilter === id ? "bg-muted" : ""}
                            ${moraFilter !== null && moraFilter !== id ? "opacity-40" : "opacity-100"}
                          `}
                          title={`${count} clientes · ${label}${moraFilter === id ? " · Clic para quitar filtro" : " · Clic para filtrar"}`}
                        >
                          <span className={`h-3 w-3 rounded-full shrink-0 ${bg} ${moraFilter === id ? `ring-2 ring-offset-1 ${ring}` : ""}`} />
                          <span className={`text-[11px] md:text-xs font-medium ${moraFilter === id ? "text-foreground" : "text-muted-foreground"}`}>
                            {count}
                          </span>
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={isDiario ? "default" : "outline"}
                  className="text-[12px] md:text-sm h-7 md:h-10 px-2 md:px-4"
                  onClick={() => { setIsDiario(true); setMoraFilter(null) }}
                >
                  Diario
                </Button>
                <Button
                  variant={!isDiario ? "default" : "outline"}
                  className="text-[12px] md:text-sm h-7 md:h-10 px-2 md:px-4"
                  onClick={() => { setIsDiario(false); setMoraFilter(null) }}
                >
                  No Diario
                </Button>
                <Button
                  className="h-7 md:h-10 gap-1.5 px-2 md:px-4 text-[12px] md:text-sm"
                  onClick={() => onViewChange("new-loan")}
                >
                  <ShoppingCart className="h-3.5 w-3.5 md:h-4 md:w-4" />
                  <span className="hidden sm:inline">Nueva Venta</span>
                </Button>
              </div>
            </div>

            {/* Tab bar: Pendientes / Gestionados / Ventas
                Los dots debajo de la barra (solo en móvil) refuerzan la
                affordance de swipe horizontal. */}
            {/* Tab bar: cada botón ocupa 1/3 del ancho disponible para
                que los tres quepan exactamente en cualquier móvil sin
                desbordarse ni necesitar scroll. El texto largo se acorta
                en móvil con versiones compactas visibles solo en <md. */}
            <div className="grid grid-cols-3 mt-2 border-b border-border w-full">
              <button
                onClick={() => setActiveTab("pendientes")}
                className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] md:text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "pendientes"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Users className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Pendientes</span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  activeTab === "pendientes" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}>
                  {displayClients.length}
                </span>
              </button>
              <button
                onClick={() => setActiveTab("gestionados")}
                className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] md:text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "gestionados"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {/* Etiqueta corta en móvil, completa en md+ */}
                <span className="truncate md:hidden">Gestionados</span>
                <span className="truncate hidden md:inline">Clientes gestionados</span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  activeTab === "gestionados" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}>
                  {managedToday.length}
                </span>
              </button>
              <button
                onClick={() => setActiveTab("ventas")}
                className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] md:text-sm font-medium border-b-2 transition-colors rounded-t-md bg-green-100 dark:bg-green-900/30 ${
                  activeTab === "ventas"
                    ? "border-green-600 text-green-700 dark:text-green-400"
                    : "border-transparent text-green-700 dark:text-green-500 hover:border-green-400"
                }`}
              >
                <ShoppingCart className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">Ventas del día</span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  activeTab === "ventas" ? "bg-green-600 text-white" : "bg-muted text-muted-foreground"
                }`}>
                  {salesTodayCount}
                </span>
              </button>
            </div>
            {/* Dots de navegación — visibles solo en móvil como indicador de swipe */}
            <div className="flex md:hidden justify-center gap-1.5 pt-1.5 pb-0.5">
              {TAB_ORDER.map((tab) => (
                <button
                  key={tab}
                  aria-label={`Ir a ${tab}`}
                  onClick={() => setActiveTab(tab)}
                  className={`rounded-full transition-all duration-200 ${
                    activeTab === tab
                      ? "w-4 h-1.5 bg-primary"
                      : "w-1.5 h-1.5 bg-muted-foreground/30"
                  }`}
                />
              ))}
            </div>
          </CardHeader>

          {/* ── Contenedor deslizable ──────────────────────────────────────
               En desktop el overflow está oculto y la transición es
               instantánea. En móvil permite swipe horizontal con
               touchstart/touchend; el `translateX` mueve los 3 paneles
               (100 % de ancho cada uno) según el índice activo.
               Se usa `will-change: transform` para que el GPU compuesto
               no repinte el contenido de las otras pestañas durante el
               deslizamiento. ─────────────────────────────────────────── */}
          <div className="overflow-hidden">
          <div
            className="flex transition-transform duration-300 ease-in-out will-change-transform"
            style={{ transform: `translateX(${-TAB_ORDER.indexOf(activeTab) * 100}%)` }}
          >

          {/* ── Panel 0: Pendientes ────────────────────────────────────── */}
          <div className="w-full shrink-0 p-2 md:p-6">
            {(
              <div className="mb-3 md:mb-4">
                <Input
                  placeholder="Buscar cliente por nombre o documento..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="max-w-sm h-8 md:h-10 text-[12px] md:text-sm"
                />
              </div>
            )}
            {loading && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Cargando...</span>
              </div>
            )}
            {!loading && (
              // overflow-hidden (en lugar de overflow-x-auto): la tabla DEBE
              // caber dentro del viewport móvil sin scroll horizontal. El
              // nombre del cliente puede partirse en 2 líneas vía `break-words`
              // en la celda correspondiente.
              <div className="rounded-md border overflow-hidden">
                <Table className="w-full table-fixed">
                  <TableHeader>
                    <TableRow>
                      {/* Anchos fijos suman ~ Orden 38 + Accion 80 = 118 px en
                          móvil, dejando el resto para Cliente (flex) y Monto
                          (alineado a la derecha). table-fixed asegura que el
                          contenido se ajuste a esos anchos sin desbordar. */}
                      {/* Orden ensanchado a 48 px para que el título "Orden"
                          no se cruce visualmente con el de "Acción". */}
                      <TableHead className="w-[48px] md:w-[64px] text-center text-[12px] md:text-base whitespace-nowrap py-1 md:py-3 px-0.5 md:px-1">Orden</TableHead>
                      {/* Acción en desktop necesita caber 3 botones de
                          36 px (h-9 w-9) + gaps en flex-row → ~130 px.
                          Antes era 100 px y los botones se montaban sobre
                          la columna Cliente. */}
                      <TableHead className="w-[52px] md:w-[140px] text-[12px] md:text-base whitespace-nowrap py-1 md:py-3 px-0.5 md:px-2">Accion</TableHead>
                      <TableHead className="text-[12px] md:text-base whitespace-nowrap py-1 md:py-3 px-0.5 md:px-1">Cliente</TableHead>
                      <TableHead className="w-[96px] md:w-[180px] text-right text-[12px] md:text-base whitespace-nowrap py-1 md:py-3 px-1 md:px-2">Monto / Detalle</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayClients.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground text-[12px] md:text-base py-2 md:py-4">
                          No se encontraron clientes activos
                        </TableCell>
                      </TableRow>
                    ) : (
                      displayClients.map((client, index) => {
                        const canManage = canManageClient(client)
                        return (
                        <TableRow
                          key={client.loanId}
                          draggable
                          onDragStart={() => handleDragStart(index)}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
                          onDrop={() => handleDrop(index)}
                          className={`${index % 2 === 0 ? "bg-card" : "bg-muted/40"} border-b border-border hover:bg-accent/30 transition-colors ${
                            dragIndex === index ? "opacity-50" : ""
                          } ${dragOverIndex === index ? "border-t-2 border-t-brand" : ""} ${
                            !canManage ? "opacity-60" : ""
                          }`}
                        >
                          <TableCell className="py-1.5 md:py-3 px-0.5 md:px-1">
                            <div className="flex flex-col items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => handleMoveUp(index)}
                                disabled={index === 0 || savingOrder}
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30 p-0"
                              >
                                <ArrowUp className="h-3 w-3 md:h-3.5 md:w-3.5" />
                              </button>
                              <div className="cursor-grab active:cursor-grabbing flex items-center gap-0.5">
                                <GripVertical className="h-3.5 w-3.5 md:h-4 md:w-4 text-muted-foreground" />
                                <span className="text-[12px] md:text-sm font-bold text-muted-foreground">{client.ordenvisita}</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleMoveDown(index)}
                                disabled={index >= displayClients.length - 1 || savingOrder}
                                className="text-muted-foreground hover:text-foreground disabled:opacity-30 p-0"
                              >
                                <ArrowDown className="h-3 w-3 md:h-3.5 md:w-3.5" />
                              </button>
                            </div>
                          </TableCell>
                          <TableCell className="py-1 md:py-3 px-0.5 md:px-2">
                            <div className="flex flex-col gap-0.5 md:flex-row md:gap-1">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button size="icon" variant="outline" className="h-5 w-5 md:h-9 md:w-9 bg-transparent">
                                    <MoreVertical className="h-2.5 w-2.5 md:h-4 md:w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-48">
                                  <DropdownMenuItem
                                    className="text-xs md:text-base cursor-pointer"
                                    onClick={() => {
                                      setPaymentHistoryClient(client)
                                      setPaymentHistoryOpen(true)
                                    }}
                                  >
                                    <History className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                    Historial de pagos
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-xs md:text-base cursor-pointer"
                                    onClick={() => {
                                      setLoanHistoryClient(client)
                                      setLoanHistoryOpen(true)
                                    }}
                                  >
                                    <FileText className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                    Historial de prestamos
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-xs md:text-base cursor-pointer"
                                    onClick={() => {
                                      setSelectedClientInfo(client)
                                      setClientInfoDialogOpen(true)
                                    }}
                                  >
                                    <User className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                    Info del cliente
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="text-xs md:text-base cursor-pointer"
                                    onClick={() => handleGenerarRecibo(client)}
                                  >
                                    <Receipt className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                    Generar recibo
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>

                              <Button
                                size="icon"
                                className="bg-destructive hover:bg-destructive/80 text-destructive-foreground h-9 w-9 md:h-10 md:w-10 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                                onClick={() =>
                                  gpsStatus !== "granted"
                                    ? handleLocationRequired()
                                    : setNoPaymentClient(client)
                                }
                                disabled={canManage === false && gpsStatus === "granted"}
                                title={
                                  gpsStatus !== "granted"
                                    ? "Debes habilitar la ubicacion para registrar no pagos"
                                    : client.nextPaymentEsFuturo
                                    ? `Aun no es el dia de pago de este cliente (proxima cuota: ${client.nextPaymentFecha})`
                                    : !canManage
                                    ? "No es el dia de pago de este cliente"
                                    : "Registrar No Pago"
                                }
                                aria-label="Registrar No Pago"
                              >
                                <X className="h-5 w-5" />
                              </Button>

                              <Button
                                size="icon"
                                className="bg-success hover:bg-success/80 text-card h-9 w-9 md:h-10 md:w-10 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                                onClick={() =>
                                  gpsStatus !== "granted"
                                    ? handleLocationRequired()
                                    : handleSelectClient(client)
                                }
                                disabled={canManage === false && gpsStatus === "granted"}
                                title={
                                  gpsStatus !== "granted"
                                    ? "Debes habilitar la ubicacion para registrar pagos"
                                    : client.nextPaymentEsFuturo
                                    ? `Aun no es el dia de pago de este cliente (proxima cuota: ${client.nextPaymentFecha})`
                                    : !canManage
                                    ? "No es el dia de pago de este cliente"
                                    : "Registrar Pago"
                                }
                                aria-label="Registrar Pago"
                              >
                                <DollarSign className="h-5 w-5 md:h-5 md:w-5" />
                              </Button>
                            </div>
                          </TableCell>
<TableCell className="py-1.5 md:py-3 px-1 md:px-2 overflow-hidden align-top">
                            {/* min-w-0 en el flex container es CRITICO: sin
                                eso, el contenido (el span del nombre) impone
                                su ancho intrinseco al flex item, desborda la
                                celda y se solapa con la columna Monto a la
                                derecha. Con min-w-0 + table-fixed el span
                                respeta el ancho de la columna y envuelve. */}
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="font-medium text-[12px] md:text-base leading-tight break-words [overflow-wrap:anywhere] min-w-0">{client.nombre}</span>
                              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                                <span className="text-[11px] md:text-sm text-muted-foreground">{frecuenciaLabel(client.frecuenciaPago)}</span>
                                {client.frecuenciaPago !== "daily" && client.diaSemana && (
                                  <span className={`text-[9px] md:text-xs px-1.5 py-0.5 rounded font-semibold ${
                                    isPaymentDayToday(client.diaSemana) 
                                      ? "bg-success text-success-foreground" 
                                      : "bg-muted text-muted-foreground"
                                  }`}>
                                    {client.diaSemana.charAt(0).toUpperCase() + client.diaSemana.slice(1)}
                                  </span>
                                )}
                                {/* Badge de tipo_amortizacion: "Capital" para
                                    aleman, "Intereses" para americano. Solo se
                                    renderiza si la venta tiene tipo definido
                                    (los prestamos de cuotas tradicionales
                                    quedan sin badge). */}
                                {tipoAmortizacionLabel(client.tipoAmortizacion) && (
                                  <span className="text-[9px] md:text-xs px-1.5 py-0.5 rounded font-semibold bg-secondary text-secondary-foreground">
                                    {tipoAmortizacionLabel(client.tipoAmortizacion)}
                                  </span>
                                )}
                                {/* Badge "Proximo pago": se muestra solo cuando
                                    la cuota objetivo es FUTURA (todas las
                                    anteriores ya estan gestionadas y la
                                    siguiente cae despues de hoy). Indica
                                    visualmente al cobrador que el cliente
                                    esta al dia y no se puede procesar
                                    todavia. */}
                                {client.nextPaymentEsFuturo && (
                                  <span className="text-[9px] md:text-xs px-1.5 py-0.5 rounded font-semibold bg-info text-info-foreground">
                                    {(() => {
                                      const [, mm, dd] = client.nextPaymentFecha.split("-")
                                      return `Próx. pago ${dd}/${mm}`
                                    })()}
                                  </span>
                                )}
                              </div>
                              <div className={`inline-flex items-center justify-center w-fit px-1.5 py-0.5 rounded text-[10px] md:text-sm font-semibold ${getMoraColor(client.mora)}`}>
                                {client.mora}d mora
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="py-1.5 md:py-3 px-1 md:px-2 align-top">
                            <div className="flex flex-col items-end gap-0.5">
                              {/* Primera fila: Monto Venta + tasa */}
                              <div className="flex items-baseline justify-end gap-1">
                                <span className="text-[12px] md:text-base font-semibold text-right">
                                  ${client.valorVenta.toLocaleString()}
                                </span>
                                <span className="text-[10px] md:text-xs text-muted-foreground">
                                  {client.tasaInteres}%
                                </span>
                              </div>
                              {/* Segunda fila: Cuota · Valor Cuota · Saldo
                                  En movil cada dato queda en su propia
                                  linea (flex-col); en md+ vuelven a
                                  estar en fila horizontal (md:flex-row). */}
                              <div className="flex flex-col md:flex-row md:flex-wrap justify-end md:items-center gap-y-0.5 md:gap-x-2 text-[10px] md:text-xs text-muted-foreground">
                                <span className="whitespace-nowrap text-right">
                                  Cta{" "}
                                  <strong className="text-foreground tabular-nums">
                                    {client.cuotasPagadas}/{client.cuotasTotales}
                                  </strong>
                                </span>
                                <span className="whitespace-nowrap text-right">
                                  Vlr{" "}
                                  <strong className="text-foreground tabular-nums">
                                    ${client.valorCuota.toLocaleString()}
                                  </strong>
                                </span>
                                <span className="whitespace-nowrap text-right">
                                  Saldo{" "}
                                  <strong className="text-foreground tabular-nums">
                                    ${Math.round(client.saldo).toLocaleString()}
                                  </strong>
                                </span>
                              </div>
                              {/* Fecha último pago — solo visible cuando existe */}
                              {client.ultimoPagoFecha && (
                                <span className="text-[10px] md:text-xs text-muted-foreground whitespace-nowrap text-right">
                                  Últ. pago{" "}
                                  <strong className="text-foreground tabular-nums">
                                    {(() => {
                                      const [y, m, d] = client.ultimoPagoFecha.split("-")
                                      return `${d}/${m}/${y.slice(2)}`
                                    })()}
                                  </strong>
                                </span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        )
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>{/* fin Panel 0: Pendientes */}

          {/* ── Panel 1: Gestionados ────────────────────────────────────── */}
          <div className="w-full shrink-0 p-2 md:p-6">
            <div className="space-y-2">
                {managedToday.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                    <Users className="h-8 w-8 opacity-30" />
                    <p className="text-xs md:text-sm">No hay clientes gestionados hoy</p>
                  </div>
                ) : (
                  <>
                  <div className="space-y-1.5">
                    {sortedManaged.map((m, index) => (
                      <div
                        key={m.loanId}
                        className={`rounded-lg border px-3 py-2 ${index % 2 === 0 ? "bg-card" : "bg-muted/40"}`}
                      >
                        {/* Línea 1: nombre · estado · hora · acciones */}
                        <div className="flex items-center gap-1.5">
                          <span className="flex-1 font-medium text-sm leading-tight truncate">{m.nombre}</span>
                          {m.gestionTipo === "pago" ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-600 bg-green-50 px-1.5 py-0.5 rounded-full shrink-0">
                              <CheckCircle2 className="h-2.5 w-2.5" />Pago
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full shrink-0">
                              <XCircle className="h-2.5 w-2.5" />No pago
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground shrink-0">{m.gestionHora}</span>
                          <div className="flex items-center gap-0.5 shrink-0">
                            {m.gestionTipo === "pago" && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-info hover:text-info/80 hover:bg-info-light"
                                onClick={() => { setEditingManaged(m); setEditMonto((m.valorAbonado ?? 0).toString()) }}
                                disabled={savingManaged}
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 text-destructive hover:text-destructive/80 hover:bg-destructive-light"
                              onClick={() => handleDeleteManagedPayment(m)}
                              disabled={savingManaged}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" className="h-6 w-6">
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem
                                  className="text-xs md:text-base cursor-pointer"
                                  onClick={() => { setPaymentHistoryClient(m); setPaymentHistoryOpen(true) }}
                                >
                                  <History className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                  Historial de pagos
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-xs md:text-base cursor-pointer"
                                  onClick={() => { setLoanHistoryClient(m); setLoanHistoryOpen(true) }}
                                >
                                  <FileText className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                  Historial de prestamos
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-xs md:text-base cursor-pointer"
                                  onClick={() => { setSelectedClientInfo(m); setClientInfoDialogOpen(true) }}
                                >
                                  <User className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                  Info del cliente
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-xs md:text-base cursor-pointer"
                                  onClick={() => handleGenerarRecibo(m)}
                                >
                                  <Receipt className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                  Generar recibo
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                        {/* Línea 2: cuota · préstamo · abonado · saldo */}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                          <span className="text-[11px] text-muted-foreground">Cuota: <span className="font-semibold text-foreground">${m.valorCuota.toLocaleString()}</span></span>
                          <span className="text-[11px] text-muted-foreground">Préstamo: <span className="font-semibold text-info">${m.valorPrestamo.toLocaleString()}</span></span>
                          <span className="text-[11px] text-muted-foreground">Abonado: <span className="font-semibold text-success">${(m.valorAbonado ?? 0).toLocaleString()}</span></span>
                          <span className="text-[11px] text-muted-foreground">Saldo: <span className="font-semibold text-warning">${Math.round(m.saldo).toLocaleString()}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>

                  </>
                )}
              </div>
          </div>{/* fin Panel 1: Gestionados */}

          {/* ── Panel 2: Registrar Ventas ───────────────────────────────── */}
          {/* Vista informativa: listado de ventas creadas HOY en la ruta.
              El formulario de creación vive en la pantalla "Nueva Venta"
              del menú principal — aquí solo se consulta lo registrado. */}
          <div className="w-full shrink-0 p-2 md:p-6">
            <SalesTodayList currentRutaId={currentRutaId} onCountChange={setSalesTodayCount} />
          </div>{/* fin Panel 2: Ventas */}

          </div>{/* fin flex deslizable */}
          </div>{/* fin overflow-hidden */}
        </Card>
      ) : (
        <Card>
          <CardHeader className="p-3 md:p-6">
            <CardTitle className="text-sm md:text-lg">Informacion del Pago</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 md:space-y-3 p-3 md:p-6">
            {/* Alerta: última cuota programada de préstamo americano */}
            {selectedClient.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
              selectedClient.nextPaymentNumero === selectedClient.cuotasTotales && (
                <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning/10 px-3 py-2">
                  <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                  <p className="text-sm font-semibold text-warning">
                    Última cuota programada — ¿extender cuotas?
                  </p>
                </div>
              )}
            {/* Primera fila: Apodo, Saldo y Ultima Pago */}
            <div className="grid gap-2 md:gap-3 grid-cols-3">
              <div className="space-y-1 md:space-y-1.5">
                <Label htmlFor="apodo" className="text-xs md:text-sm">Apodo</Label>
                <Input id="apodo" type="text" value={selectedClient.nombre} readOnly className="h-7 md:h-10 text-xs md:text-sm bg-muted" />
              </div>
              <div className="space-y-1 md:space-y-1.5">
                <Label htmlFor="saldoCliente" className="text-xs md:text-sm">Saldo a Pagar</Label>
                <Input
                  id="saldoCliente"
                  type="text"
                  value={`$${Math.round(selectedClient.saldo).toLocaleString()}`}
                  readOnly
                  className="h-7 md:h-10 text-xs md:text-sm font-semibold bg-amber-50 text-amber-800 border-amber-300"
                />
              </div>
              <div className="space-y-1 md:space-y-1.5">
                <Label htmlFor="lastPaymentDate" className="text-xs md:text-sm">Ult. Pago</Label>
                <Input id="lastPaymentDate" type="text" value={selectedClient.ultimoPagoFecha || "N/A"} readOnly className="h-7 md:h-10 text-xs md:text-sm bg-muted" />
              </div>
            </div>

            {/* Segunda fila: Monto del Pago + Nuevo Saldo */}
            <div className="grid grid-cols-2 gap-2 md:gap-3">
              <div className="space-y-1 md:space-y-1.5">
                <Label htmlFor="paymentAmount" className="text-xs md:text-sm">Monto del Pago</Label>
                <Input
                  id="paymentAmount"
                  type="number"
                  value={paymentAmount}
                  onChange={(e) => {
                      const value = e.target.value
                      const saldoDisponible = selectedClient.saldo
                    const numValue = Number.parseFloat(value)
                    if (!isNaN(numValue) && numValue > saldoDisponible) {
                      toast({
                        title: "Monto excede el saldo",
                        description: `El monto del pago no puede ser mayor al saldo a pagar ($${saldoDisponible.toLocaleString()})`,
                        variant: "destructive",
                      })
                      setPaymentAmount(saldoDisponible.toString())
                      return
                    }
                    setPaymentAmount(value)
                  }}
                  readOnly={!isPartialPayment}
                  className={`h-7 md:h-10 text-xs md:text-sm ${!isPartialPayment ? "bg-muted" : ""}`}
                />
              </div>
              <div className="space-y-1 md:space-y-1.5">
                <Label className="text-xs md:text-sm">Nuevo Saldo</Label>
                <div className="h-7 md:h-10 flex items-center px-3 rounded-md border bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800">
                  <span className="text-xs md:text-sm font-semibold text-green-700 dark:text-green-400">
                    ${Math.max(0, selectedClient.saldo - (Number.parseFloat(paymentAmount) || 0)).toLocaleString("es-CO")}
                  </span>
                </div>
              </div>
            </div>

            {/* Tercera fila: Numero de Cuotas y Metodo de Pago */}
            <div className="grid gap-2 md:gap-3 grid-cols-2">
              <div className="space-y-1 md:space-y-1.5">
                <Label htmlFor="numCuotas" className="text-xs md:text-sm">Nro Cuotas</Label>
                <Select
                  value={numCuotas.toString()}
                  onValueChange={(value) => {
                    const n = Number.parseInt(value)
                    setNumCuotas(n)
                    if (!isPartialPayment && selectedClient) {
                      setPaymentAmount((selectedClient.nextPaymentCuota * n).toString())
                    }
                  }}
                  disabled={isPartialPayment}
                >
                  <SelectTrigger className="h-7 md:h-10 text-xs md:text-base">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                      <SelectItem key={num} value={num.toString()} className="text-xs md:text-base">{num}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1 md:space-y-1.5">
                <Label htmlFor="paymentMethod" className="text-xs md:text-base">Metodo de Pago</Label>
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger className="h-7 md:h-10 text-xs md:text-base">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="efectivo" className="text-xs md:text-base">Efectivo</SelectItem>
                    <SelectItem value="transferencia" className="text-xs md:text-base">Transferencia</SelectItem>
                    <SelectItem value="tarjeta" className="text-xs md:text-base">Tarjeta</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Cuenta bancaria si transferencia */}
            {paymentMethod === "transferencia" && (
              <div className="space-y-1 md:space-y-1.5">
                <Label htmlFor="accountNumber" className="text-xs md:text-base">Numero de Cuenta</Label>
                <Select value={accountNumber} onValueChange={setAccountNumber}>
                  <SelectTrigger className="h-7 md:h-10 text-xs md:text-base">
                    <SelectValue placeholder="Seleccionar cuenta..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="davivienda-123456789" className="text-xs md:text-base">Davivienda - 123456789</SelectItem>
                    <SelectItem value="bancolombia-123456789" className="text-xs md:text-base">Bancolombia - 123456789</SelectItem>
                    <SelectItem value="nequi-123456789" className="text-xs md:text-base">Nequi - 123456789</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Checkboxes y Foto */}
            <div className="grid gap-2 md:gap-3 grid-cols-2">
              <div className="flex gap-2 flex-wrap">
                <div className="flex items-center space-x-1.5">
                  <Checkbox id="partialPayment" checked={isPartialPayment} onCheckedChange={(c) => handlePartialPaymentChange(c as boolean)} className="h-4 w-4 border-2 border-gray-400 dark:border-gray-500" />
                  <Label htmlFor="partialPayment" className="text-[11px] md:text-sm font-normal cursor-pointer whitespace-nowrap">Pago manual</Label>
                </div>
                <div className="flex items-center space-x-1.5">
                  <Checkbox
                    id="cancelada"
                    checked={isCancelada}
                    onCheckedChange={(c) => {
                      const checked = c as boolean
                      setIsCancelada(checked)
                      if (checked && selectedClient) {
                  // Set payment amount to full remaining saldo
                  const saldo = selectedClient.saldo
                        setPaymentAmount(saldo.toString())
                      }
                    }}
                    className="h-4 w-4 border-2 border-gray-400 dark:border-gray-500"
                  />
                  <Label htmlFor="cancelada" className="text-[11px] md:text-sm font-normal cursor-pointer whitespace-nowrap">Cancelada</Label>
                </div>
                {/* Checkbox de extension de plazo: solo visible para
                    prestamos tipo "americano" en su ULTIMA cuota. */}
                {selectedClient &&
                  selectedClient.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
                  selectedClient.nextPaymentNumero === selectedClient.cuotasTotales && (
                    <div className="flex items-center space-x-1.5">
                      <Checkbox
                        id="extenderCuotas"
                        checked={extenderCuotas}
                        onCheckedChange={(c) => {
                          const checked = c as boolean
                          setExtenderCuotas(checked)
                          // Cuando se prorroga el prestamo, esta cuota deja
                          // de ser "la final" y pasa a ser un pago normal de
                          // intereses. Por eso el monto sugerido cambia del
                          // saldo TOTAL (intereses + capital) al simple
                          // `valorCuota` del prestamo (solo intereses).
                          if (checked && selectedClient) {
                            setPaymentAmount(selectedClient.valorCuota.toString())
                            // Tambien apagamos los flags de cancelada/parcial
                            // por si estaban activos: extender es excluyente.
                            setIsCancelada(false)
                            setIsPartialPayment(false)
                          } else if (!checked) {
                            setPaymentAmount("")
                          }
                        }}
                        className="h-4 w-4"
                      />
                      <Label
                        htmlFor="extenderCuotas"
                        className="text-[11px] md:text-sm font-normal cursor-pointer whitespace-nowrap"
                      >
                        Extender Cuotas (Prórroga)
                      </Label>
                    </div>
                  )}
              </div>
              <div className="flex justify-end">
                <input type="file" accept="image/*" capture="environment" onChange={handlePhotoCapture} className="hidden" id="payment-photo" />
                <Label htmlFor="payment-photo" className="cursor-pointer m-0">
                  <Button type="button" size="icon" variant={paymentPhoto ? "default" : "outline"} className={`h-7 w-7 md:h-10 md:w-10 ${paymentPhoto ? "bg-green-600 hover:bg-green-700" : ""}`} asChild>
                    <span><Camera className="h-3.5 w-3.5 md:h-5 md:w-5" /></span>
                  </Button>
                </Label>
              </div>
            </div>

            {/* Input para cantidad de cuotas a extender. Solo aparece si el
                checkbox "Extender Cuotas" esta activo. */}
            {extenderCuotas && (
              <div className="space-y-1.5 md:space-y-2">
                <Label htmlFor="cantidadCuotasExtender" className="text-xs md:text-base">
                  Cantidad de cuotas a extender
                </Label>
                <Input
                  id="cantidadCuotasExtender"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={cantidadCuotasExtender}
                  onChange={(e) => setCantidadCuotasExtender(e.target.value)}
                  className="h-8 md:h-10 text-xs md:text-sm"
                  placeholder="Ej: 3"
                />
              </div>
            )}

            {paymentPhoto && (
              <div className="space-y-1.5 md:space-y-2">
                <Label className="text-xs md:text-sm">Foto Adjunta</Label>
                <div className="relative rounded-lg border overflow-hidden">
                  <img src={paymentPhoto} alt="Comprobante de pago" className="w-full h-auto max-h-[150px] md:max-h-[200px] object-contain" />
                  <Button type="button" size="icon" variant="destructive" className="absolute top-1 right-1 md:top-2 md:right-2 h-6 w-6 md:h-8 md:w-8" onClick={() => setPaymentPhoto(null)}>
                    <X className="h-3 w-3 md:h-4 md:w-4" />
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-1.5 md:space-y-2">
              <Label htmlFor="notes" className="text-xs md:text-base">Notas (Opcional)</Label>
              <Textarea id="notes" placeholder="Agregar comentarios sobre el pago..." className="min-h-[60px] md:min-h-[100px] text-xs md:text-sm" />
            </div>

            <div className="flex gap-2 md:gap-4 pt-2 md:pt-4">
              <Button variant="outline" className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent" onClick={handleBack}>
                Cancelar
              </Button>
              <Button className="flex-1 h-8 md:h-10 text-xs md:text-base bg-green-600 hover:bg-green-700 text-white" onClick={handleRegisterPayment} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                {extenderCuotas ? "Registrar Pago y Extender Plazo" : "Registrar Pago"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* No Payment Dialog */}
      <Dialog open={!!noPaymentClient} onOpenChange={(open) => { if (!open) { setNoPaymentClient(null); setNoPaymentPhoto(null) } }}>
        <DialogContent className="sm:max-w-[425px] p-4 md:p-6">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Confirmar no pago</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Registrar que el cliente {noPaymentClient?.nombre} no realizo el pago del dia.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 md:space-y-4 py-2 md:py-4">
            <div className="space-y-1.5 md:space-y-2">
              <Label htmlFor="last-payment-date" className="text-xs md:text-sm">Fecha del Ultimo Pago</Label>
              <Input id="last-payment-date" type="text" value={noPaymentClient?.ultimoPagoFecha || "N/A"} readOnly className="bg-muted text-xs md:text-sm h-7 md:h-10" />
            </div>

            <div className="space-y-1.5 md:space-y-2">
              <Label htmlFor="mora-days" className="text-xs md:text-sm">Mora</Label>
              <div className={`text-xs md:text-sm font-semibold px-2 py-1 rounded h-7 md:h-10 flex items-center justify-center ${
                noPaymentClient?.mora === 0 ? "bg-green-500/60" : (noPaymentClient?.mora ?? 0) < 10 ? "bg-yellow-500/60" : "bg-red-500/60"
              }`}>
                {noPaymentClient?.mora} {noPaymentClient?.mora === 1 ? "dia" : "dias"}
              </div>
            </div>

            <div className="space-y-1.5 md:space-y-2">
              <Label htmlFor="observation" className="text-xs md:text-sm">Notas</Label>
              <Textarea id="observation" placeholder="Escriba el motivo o comentarios sobre el no pago..." value={noPaymentObservation} onChange={(e) => setNoPaymentObservation(e.target.value)} className="min-h-[60px] md:min-h-[100px] text-xs md:text-sm" />
            </div>

            {noPaymentPhoto && (
              <div className="space-y-1.5 md:space-y-2">
                <Label className="text-xs md:text-sm">Foto Adjunta</Label>
                <div className="relative rounded-lg border overflow-hidden">
                  <img src={noPaymentPhoto} alt="Foto de no pago" className="w-full h-auto max-h-[150px] md:max-h-[200px] object-contain" />
                  <Button type="button" size="icon" variant="destructive" className="absolute top-1 right-1 md:top-2 md:right-2 h-6 w-6 md:h-8 md:w-8" onClick={() => setNoPaymentPhoto(null)}>
                    <X className="h-3 w-3 md:h-4 md:w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-1.5 md:gap-2">
            <div className="flex gap-1.5 md:gap-2 flex-wrap">
              <div className="relative">
                <input type="file" accept="image/*" capture="environment" onChange={handleNoPaymentPhotoCapture} className="hidden" id="no-payment-photo" />
                <Label htmlFor="no-payment-photo" className="cursor-pointer m-0">
                  <Button type="button" size="icon" variant={noPaymentPhoto ? "default" : "outline"} className={`h-8 w-8 md:h-10 md:w-10 ${noPaymentPhoto ? "bg-green-600 hover:bg-green-700" : ""}`} asChild>
                    <span><Camera className="h-3.5 w-3.5 md:h-5 md:w-5" /></span>
                  </Button>
                </Label>
              </div>
              <Button onClick={handleRegisterNoPayment} disabled={saving} className="bg-red-400 hover:bg-red-500 text-white h-8 md:h-10 text-xs md:text-base">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Registrar No Pago
              </Button>
            </div>
            <Button variant="outline" onClick={() => { setNoPaymentClient(null); setNoPaymentPhoto(null) }} className="h-8 md:h-10 text-xs md:text-base">
              Cancelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Renovation Dialog */}
      <Dialog open={showRenovationDialog} onOpenChange={setShowRenovationDialog}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Confirmar Renovacion</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 md:space-y-4">
            <p className="text-xs md:text-sm text-muted-foreground">
              El prestamo ha sido cancelado. Desea realizar una renovacion para el cliente{" "}
              <span className="font-semibold">{clientForRenovation?.nombre}</span>?
            </p>
          </div>
          <div className="flex gap-2 md:gap-3 pt-2 md:pt-4">
            <Button variant="outline" onClick={handleRenovationCancel} className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent">No</Button>
            <Button onClick={handleRenovationConfirm} className="flex-1 h-8 md:h-10 text-xs md:text-base">Si, Renovar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Client Info Dialog */}
      <Dialog open={clientInfoDialogOpen} onOpenChange={(open) => { setClientInfoDialogOpen(open); if (!open) setClientInfoFetched(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Info del Cliente</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">Datos registrados en el sistema</DialogDescription>
          </DialogHeader>
          {clientInfoLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : clientInfoFetched ? (
            <div className="space-y-2">
              {[
                ["Nombre completo", clientInfoFetched.nombre_completo],
                ["Apodo", clientInfoFetched.apodo ?? "—"],
                ["Documento", clientInfoFetched.documento],
                ["Teléfono", clientInfoFetched.telefono ?? "—"],
                ["Dirección", clientInfoFetched.direccion ?? "—"],
              ].map(([label, val]) => (
                <div key={label}>
                  <p className="text-[10px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
                  <p className="text-sm md:text-base font-medium">{val}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-4 text-center">No se pudieron cargar los datos.</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Payment History Dialog */}
      <Dialog open={paymentHistoryOpen} onOpenChange={(open) => { setPaymentHistoryOpen(open); if (!open) { setPaymentHistoryClient(null); setPaymentHistoryRows([]) } }}>
        <DialogContent className="p-4 md:p-6 max-w-[95vw] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Historial de Pagos</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {paymentHistoryClient?.nombre} — todas las cuotas del préstamo
            </DialogDescription>
          </DialogHeader>
          {paymentHistoryLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : paymentHistoryRows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sin registros.</p>
          ) : (
            <div className="overflow-auto max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3">Fecha</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-right">Cuota</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-right">Abono</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-center">Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paymentHistoryRows.map((row) => {
                    const isNoPago = row.estado === "no_pago"
                    const rowClass = isNoPago ? "bg-red-50 dark:bg-red-950/30" : ""
                    const textClass = isNoPago ? "text-red-600 dark:text-red-400" : ""
                    const [y, m, d] = row.fecha_pago.split("-")
                    const fechaFmt = `${d}/${m}/${y.slice(2)}`
                    const estadoLabel: Record<string, string> = {
                      pagado: "Pagado", no_pago: "No pago", pendiente: "Pendiente",
                      parcial: "Parcial", cancelada: "Cancelada",
                    }
                    return (
                      <TableRow key={row.id} className={rowClass}>
                        <TableCell className={`text-[10px] md:text-xs px-1 md:px-3 ${textClass}`}>{fechaFmt}</TableCell>
                        <TableCell className={`text-[10px] md:text-xs px-1 md:px-3 text-right ${textClass}`}>
                          ${Math.round(row.valor_cuota).toLocaleString("es-CO")}
                        </TableCell>
                        <TableCell className={`text-[10px] md:text-xs px-1 md:px-3 text-right ${textClass}`}>
                          {row.monto_pagado > 0 ? `$${Math.round(row.monto_pagado).toLocaleString("es-CO")}` : "—"}
                        </TableCell>
                        <TableCell className={`text-[10px] md:text-xs px-1 md:px-3 text-center font-medium ${textClass}`}>
                          {estadoLabel[row.estado] ?? row.estado}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Managed Payment Dialog */}
      <Dialog open={!!editingManaged} onOpenChange={(open) => { if (!open) setEditingManaged(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Editar pago — {editingManaged?.nombre}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-xs md:text-sm text-muted-foreground">Nuevo monto abonado</label>
            <Input
              type="number"
              step="0.01"
              value={editMonto}
              onChange={(e) => setEditMonto(e.target.value)}
              className="h-9 text-sm"
              autoFocus
            />
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => setEditingManaged(null)}>Cancelar</Button>
            <Button size="sm" onClick={handleEditManagedSave} disabled={savingManaged}>
              {savingManaged ? <Loader2 className="h-3 w-3 animate-spin" /> : "Guardar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Share Comprobante Dialog */}
      <Dialog open={showShareDialog} onOpenChange={(open) => { if (!open) { setShowShareDialog(false); setClientForShare(null); handleBack() } }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">¿Compartir comprobante?</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              El pago de <span className="font-semibold">{clientForShare?.nombre}</span> fue registrado. ¿Deseas compartir el comprobante?
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 md:gap-3 pt-2 md:pt-4">
            <Button
              variant="outline"
              className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent"
              disabled={sharingPdf}
              onClick={() => { setShowShareDialog(false); setClientForShare(null); handleBack() }}
            >
              No
            </Button>
            <Button
              className="flex-1 h-8 md:h-10 text-xs md:text-base"
              disabled={sharingPdf}
              onClick={async () => {
                if (!clientForShare) return
                await handleShareComprobante(clientForShare)
                setShowShareDialog(false)
                setClientForShare(null)
                handleBack()
              }}
            >
              {sharingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sí, compartir"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Loan History Dialog */}
      <Dialog open={loanHistoryOpen} onOpenChange={(open) => { setLoanHistoryOpen(open); if (!open) { setLoanHistoryClient(null); setLoanHistoryRows([]) } }}>
        <DialogContent className="p-4 md:p-6 max-w-[95vw] md:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Historial de Préstamos</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {loanHistoryClient?.nombre} — todos los préstamos registrados
            </DialogDescription>
          </DialogHeader>
          {loanHistoryLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : loanHistoryRows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sin registros.</p>
          ) : (
            <div className="overflow-auto max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3">Fecha</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-right">Valor</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-center">Cuotas</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-center">Frec.</TableHead>
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-center">Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loanHistoryRows.map((row) => {
                    const [y, m, d] = (row.fecha_creacion || "").split("-")
                    const fechaFmt = y ? `${d}/${m}/${y.slice(2)}` : "—"
                    const estadoColor = row.estado === "activo"
                      ? "text-green-600 dark:text-green-400"
                      : row.estado === "cancelado"
                      ? "text-muted-foreground"
                      : "text-yellow-600 dark:text-yellow-400"
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3">{fechaFmt}</TableCell>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-right">
                          ${Math.round(row.valor).toLocaleString("es-CO")}
                        </TableCell>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-center">{row.numero_cuotas}</TableCell>
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-center">{frecuenciaLabel(row.frecuencia_pago)}</TableCell>
                        <TableCell className={`text-[10px] md:text-xs px-1 md:px-3 text-center font-medium capitalize ${estadoColor}`}>
                          {row.estado}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
