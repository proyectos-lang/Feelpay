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
import { DollarSign, X, Camera, Edit, FileText, History, User, MoreVertical, Receipt, Loader2, GripVertical, ArrowUp, ArrowDown, CheckCircle2, XCircle, Users, Pencil, RotateCcw, RefreshCw, ShoppingCart, MapPinOff, MapPin, AlertCircle, Play, Share2, FileDown } from "lucide-react"
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
  import { getSupabaseSafe, getSessionIdentity } from "@/lib/api-helper"
import { enviarOEncolar } from "@/lib/offline-queue"
import { SalesTodayList } from "@/components/views/sales-today-list"
// Helper que centraliza la carga del dashboard: prueba la RPC atomica
// `obtener_dashboard_pagos` primero (inmune al patron PgBouncer) y si no
// esta desplegada cae al modo legacy con multiples SELECTs paralelos.
import {
  loadDashboardPagos,
  inyectarGestionEnCache,
  type DashboardPagosResult,
  type PaymentPlanEntry as DashboardPaymentPlanEntry,
} from "@/lib/dashboard-data"
import { parcharCache } from "@/lib/offline-cache"
import {
  todayColombia,
  ayerColombia,
  ahoraColombiaISO,
  nuevaGestionId,
  resumenDelDia,
  colorMora,
  etiquetaMora,
  etiquetaAmortizacion,
  montoEfectivo,
  type Gestion,
} from "@/lib/gestion-core"
import { getRutaUmbrales, excedeUmbral, MENSAJE_REVISION, type RutaUmbrales } from "@/lib/ruta-umbrales"
import { obtenerUbicacion, evaluarGeocerca, formatearDistancia, type ResultadoGeocerca, type UbicacionMedida } from "@/lib/geo"

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

// El shape de una cuota lo define la capa de datos: aquí solo se usa. Antes
// había una copia local que se desincronizaba con la real.
type PaymentPlanEntry = DashboardPaymentPlanEntry

type DisplayClient = {
  loanId: string
  clientId: string
  nombre: string
  documento: string
  valorVenta: number
  valorCuota: number
  saldo: number
  // Conteos sobre las cuotas BASE del plan (excluyen cuotas extra de
  // extensiones/prorrogas/pagos de hoy). cuotasExtra cuenta esas aparte
  // para mostrarlas como sufijo "+N extra".
  cuotasPagadas: number
  cuotasTotales: number
  cuotasExtra: number
  // True cuando la cuota objetivo esta pendiente Y es la unica pendiente
  // del plan — es decir, resolverla agota el plan de pagos. Inmune a la
  // numeracion y alineado con lo que evalua registrar_pago_atomico.
  esUltimaCuotaPendiente: boolean
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
  // despues de hoy) — o sea, el cliente esta al dia. NO bloquea nada:
  // cobrarle es un pago ADELANTADO, que es valido. Solo gobierna el
  // badge "Prox. pago dd/mm" y el orden (van al final de la lista).
  nextPaymentEsFuturo: boolean
  // Fecha (YYYY-MM-DD) de la cuota objetivo. La usamos para mostrar
  // "Próximo pago el dd/mm" cuando `nextPaymentEsFuturo` es true.
  nextPaymentFecha: string
  ordenvisita: number
  diaSemana: string | null
  valorPrestamo: number
  /** Fecha de la venta (YYYY-MM-DD). Se imprime en el recibo. */
  fechaVenta: string
  // Multa pendiente del prestamo (null si no tiene). Generada automaticamente
  // cuando el cliente cruza el umbral de cuotas en mora configurado por ruta.
  multaPendiente: { id: string; valor: number; cuotasMora: number | null } | null
  // Ubicacion de referencia del cliente para la geocerca. null mientras no
  // haya sido georreferenciado — su proximo cobro se la captura.
  clienteLatitud: number | null
  clienteLongitud: number | null
  // Cuota mas antigua de un dia ANTERIOR que quedo sin gestionar (ni pago ni
  // no pago). Dispara la pregunta "¿a que dia aplico esta gestion?" y es el
  // ancla cuando el cobrador elige aplicarla a ese dia.
  cuotaVencidaId: string | null
  cuotaVencidaFecha: string | null
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

// Badge del método de interés en la tarjeta del cliente. El nombre sale de
// lib/gestion-core.ts; aquí solo se decide si se muestra o no (un valor raro
// o vacío no pinta badge).
const tipoAmortizacionLabel = (tipo: string | null | undefined): string | null => {
  if (!tipo) return null
  const t = tipo.toLowerCase().trim()
  if (t === "aleman" || t === "alemán") return etiquetaAmortizacion("aleman")
  if (t === "americano") return etiquetaAmortizacion("americano")
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

type ManagedClient = DisplayClient & {
  gestionTipo: "pago" | "no_pago"
  gestionHora: string
  /** Suma de lo cobrado HOY en este prestamo, no el monto de una sola cuota. */
  valorAbonado: number
  /** Cuantas cuotas cubrio el cobro de hoy. Se imprime en el recibo. */
  cuotasAbonadas: number
  paymentPlanId?: string
}

// La obtencion de la posicion vive en lib/geo.ts porque Nueva Venta tambien
// la necesita (para dejar la ubicacion de referencia del cliente) y ahi mismo
// esta la regla de la geocerca.

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
  // Gestión que se está por anular. Se pide confirmación porque deshace un
  // movimiento de plata y devuelve el cliente a la lista de cobro.
  const [anularManaged, setAnularManaged] = useState<ManagedClient | null>(null)
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

  // "Pagar multa": cobrar la multa pendiente del cliente junto con el pago.
  // Solo visible cuando el cliente seleccionado tiene multaPendiente.
  const [pagarMulta, setPagarMulta] = useState(false)

  // "Agregar cuota adicional si el cliente aun debe": pregunta que aparece
  // cuando la cuota actual es la ULTIMA del plan (cualquier tipo de
  // amortizacion, a diferencia de "Extender Cuotas" que es solo para
  // americano). Si se marca y tras el pago/no-pago el cliente aun debe
  // (segun saldo_prestamos_clientes), el RPC genera una cuota extra en vez
  // de dejar el prestamo sin fechas a las que caer para seguir cobrando.
  // Activado por defecto: mas seguro, evita que el cliente desaparezca del
  // listado por descuido si no se desmarca a proposito.
  const [agregarCuotaSiDebe, setAgregarCuotaSiDebe] = useState(true)
  const [agregarCuotaSiDebeNoPago, setAgregarCuotaSiDebeNoPago] = useState(true)

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
    const esUltimaCuota = selectedClient.esUltimaCuotaPendiente
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

  // Umbral de aprobacion de abonos por ruta (secretaria). Si el monto lo
  // supera, el pago se envia a revision en vez de aplicarse.
  const [umbrales, setUmbrales] = useState<RutaUmbrales | null>(null)
  useEffect(() => {
    getRutaUmbrales(currentRutaId).then(setUmbrales)
  }, [currentRutaId])
  const [showRevisionDialog, setShowRevisionDialog] = useState(false)
  const revisionResolveRef = useRef<((v: boolean) => void) | null>(null)
  const confirmRevision = () =>
    new Promise<boolean>((resolve) => {
      revisionResolveRef.current = resolve
      setShowRevisionDialog(true)
    })
  const handleRevisionChoice = (confirmado: boolean) => {
    setShowRevisionDialog(false)
    revisionResolveRef.current?.(confirmado)
    revisionResolveRef.current = null
  }

  // ── Geocerca ──────────────────────────────────────────────────────────
  // Cuando el cobrador esta lejos del cliente, la gestion se detiene y solo
  // continua si escribe un motivo, que queda guardado junto con la distancia
  // real para que secretaria lo revise.
  const [geocercaBloqueo, setGeocercaBloqueo] = useState<{ nombre: string; distancia: number; radio: number } | null>(null)
  const [geocercaMotivo, setGeocercaMotivo] = useState("")
  // Ultima posicion tomada al abrir una gestion, para no volver a encender el
  // GPS al confirmar. Se guarda con el cliente y el momento para no reusarla
  // con otro cliente ni cuando ya envejecio.
  const ubicacionRecienteRef = useRef<{ loanId: string; coords: UbicacionMedida; tomadaEn: number } | null>(null)
  const geocercaResolveRef = useRef<((motivo: string | null) => void) | null>(null)
  const pedirJustificacionGeocerca = (nombre: string, distancia: number, radio: number) =>
    new Promise<string | null>((resolve) => {
      geocercaResolveRef.current = resolve
      setGeocercaMotivo("")
      setGeocercaBloqueo({ nombre, distancia, radio })
    })
  const handleGeocercaChoice = (motivo: string | null) => {
    setGeocercaBloqueo(null)
    geocercaResolveRef.current?.(motivo)
    geocercaResolveRef.current = null
  }

  /**
   * Toma la posicion actual y decide si la gestion puede seguir.
   *
   * Devuelve null cuando hay que detenerse: el GPS no responde, o el cobrador
   * esta fuera de rango y no quiso justificar.
   */
  const resolverGeocerca = async (
    cliente: DisplayClient,
    accion: "pagos" | "no pagos",
  ): Promise<{ coords: UbicacionMedida; geo: ResultadoGeocerca; motivo: string | null } | null> => {
    let coords: UbicacionMedida
    try {
      // Se reusa la lectura que se tomo al ABRIR la gestion si es del mismo
      // cliente y tiene menos de 45s: entre abrir la pantalla y confirmar el
      // cobro el cobrador no se movio, y encender el chip GPS dos veces por
      // cliente cuesta segundos y bateria en un telefono de gama baja.
      const previa = ubicacionRecienteRef.current
      const fresca =
        previa &&
        previa.loanId === cliente.loanId &&
        Date.now() - previa.tomadaEn < 45_000
      coords = fresca ? previa.coords : await obtenerUbicacion()
    } catch {
      toast({
        title: "GPS no disponible",
        description: `Activa el GPS del dispositivo para registrar ${accion}.`,
        variant: "destructive",
      })
      return null
    }

    const radio = umbrales?.geocerca_radio_metros ?? 100
    const geo = evaluarGeocerca({
      cobrador: coords,
      cliente:
        cliente.clienteLatitud != null && cliente.clienteLongitud != null
          ? { latitud: cliente.clienteLatitud, longitud: cliente.clienteLongitud }
          : null,
      radioMetros: radio,
    })

    // Se evalua aunque la geocerca este apagada: asi la distancia queda
    // registrada desde el primer dia y secretaria puede ver, con datos
    // reales de la ruta, que radio le sirve antes de encenderla.
    if (!umbrales?.geocerca_habilitada || !geo.bloquea) {
      return { coords, geo, motivo: null }
    }

    const motivo = await pedirJustificacionGeocerca(cliente.nombre, geo.distancia ?? 0, radio)
    if (!motivo) return null
    return { coords, geo, motivo }
  }

  // Aviso de proximidad que se muestra al ABRIR la gestion, para que el
  // cobrador sepa como esta parado antes de llenar el formulario. Es
  // informativo: la decision que manda es la que se toma al guardar, con
  // una lectura fresca del GPS.
  const [geocercaAviso, setGeocercaAviso] = useState<ResultadoGeocerca | null>(null)

  const renderAvisoGeocerca = () => {
    if (!umbrales?.geocerca_habilitada || !geocercaAviso) return null
    const { estado, distancia } = geocercaAviso
    const texto =
      estado === "dentro"
        ? `Ubicación verificada — estás a ${formatearDistancia(distancia ?? 0)} del cliente.`
        : estado === "fuera"
          ? `Estás a ${formatearDistancia(distancia ?? 0)} del cliente. Para registrar tendrás que justificarlo.`
          : estado === "sin_referencia"
            ? "Este cliente aún no tiene ubicación guardada. Se tomará la de esta gestión."
            : "No se pudo verificar la ubicación: la señal del GPS es demasiado imprecisa aquí."
    const estilo =
      estado === "dentro"
        ? "border-green-200 bg-green-50 text-green-800"
        : estado === "fuera"
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-amber-200 bg-amber-50 text-amber-800"
    const Icono = estado === "dentro" ? MapPin : MapPinOff
    return (
      <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] md:text-xs ${estilo}`}>
        <Icono className="h-4 w-4 shrink-0 mt-px" />
        <span>{texto}</span>
      </div>
    )
  }

  // Dialogo "fecha distinta a la cuota pendiente": cuando se va a pagar/no
  // pagar en una fecha que no coincide con la cuota objetivo (tipico al
  // ponerse al dia con un cliente atrasado), se pregunta si el pago se
  // asocia a esa cuota pendiente (comportamiento de siempre) o si se
  // registra como un pago de hoy en una linea nueva, dejando la cuota
  // atrasada intacta.
  const [fechaChoiceInfo, setFechaChoiceInfo] = useState<{ fechaOriginal: string; fechaHoy: string } | null>(null)
  const fechaChoiceResolveRef = useRef<((v: "pendiente" | "hoy" | null) => void) | null>(null)
  const askFechaChoice = (fechaOriginal: string, fechaHoy: string) =>
    new Promise<"pendiente" | "hoy" | null>((resolve) => {
      fechaChoiceResolveRef.current = resolve
      setFechaChoiceInfo({ fechaOriginal, fechaHoy })
    })
  const handleFechaChoice = (choice: "pendiente" | "hoy" | null) => {
    setFechaChoiceInfo(null)
    fechaChoiceResolveRef.current?.(choice)
    fechaChoiceResolveRef.current = null
  }
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [clientForShare, setClientForShare] = useState<DisplayClient | null>(null)
  const [sharingPdf, setSharingPdf] = useState(false)
  // true = el dialogo se abrio tras registrar un pago (al cerrarlo hay que
  // volver al listado). false = se abrio desde "Generar recibo" del menu,
  // donde no hay formulario abierto que cerrar.
  const [shareTrasPago, setShareTrasPago] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [paymentPhoto, setPaymentPhoto] = useState<string | null>(null)
  const [isDiario, setIsDiario] = useState(true)
  const [moraFilter, setMoraFilter] = useState<"green" | "yellow" | "red" | null>(null)

  // No-payment dialog state
  const [noPaymentClient, setNoPaymentClient] = useState<DisplayClient | null>(null)
  const [noPaymentObservation, setNoPaymentObservation] = useState("")
  const [noPaymentPhoto, setNoPaymentPhoto] = useState<string | null>(null)

  // Al abrir una gestion (pago o no pago) se mide la proximidad para avisar
  // de entrada. Si el GPS falla aca no se dice nada: el guard de guardar ya
  // avisa, y no tiene sentido molestar dos veces por lo mismo.
  const clienteEnGestion = selectedClient ?? noPaymentClient
  const loanEnGestion = clienteEnGestion?.loanId ?? null
  useEffect(() => {
    setGeocercaAviso(null)
    ubicacionRecienteRef.current = null
    if (!clienteEnGestion) return
    let cancelado = false
    // La lectura se toma SIEMPRE, este la geocerca encendida o no: de todos
    // modos el cobro necesita coordenadas, y adelantarla aqui hace que al
    // confirmar no haya que esperar otra vez al chip GPS.
    obtenerUbicacion()
      .then((coords) => {
        if (cancelado) return
        ubicacionRecienteRef.current = {
          loanId: clienteEnGestion.loanId,
          coords,
          tomadaEn: Date.now(),
        }
        if (!umbrales?.geocerca_habilitada) return
        setGeocercaAviso(
          evaluarGeocerca({
            cobrador: coords,
            cliente:
              clienteEnGestion.clienteLatitud != null && clienteEnGestion.clienteLongitud != null
                ? { latitud: clienteEnGestion.clienteLatitud, longitud: clienteEnGestion.clienteLongitud }
                : null,
            radioMetros: umbrales.geocerca_radio_metros,
          }),
        )
      })
      .catch(() => {})
    return () => { cancelado = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanEnGestion, umbrales?.geocerca_habilitada, umbrales?.geocerca_radio_metros])

  // Client info dialog
  const [clientInfoDialogOpen, setClientInfoDialogOpen] = useState(false)
  const [selectedClientInfo, setSelectedClientInfo] = useState<DisplayClient | null>(null)

  // Payment history dialog
  const [paymentHistoryOpen, setPaymentHistoryOpen] = useState(false)
  const [paymentHistoryClient, setPaymentHistoryClient] = useState<DisplayClient | null>(null)
  const [paymentHistoryRows, setPaymentHistoryRows] = useState<{
    id: string; fecha_pago: string; valor_cuota: number; estado: string
    monto_pagado: number; fecha_pago_real: string | null; numero_cuota: number
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
  // Cuando la lista se sirve desde el dispositivo (sin señal), guarda el
  // momento en que esos datos se trajeron del servidor. null = datos frescos.
  const [datosDesdeCache, setDatosDesdeCache] = useState<string | null>(null)

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
    //    frecuencia ni dia. Se pueden cobrar (adelanto), pero no son la
    //    ruta del dia: primero lo que vence hoy o esta atrasado.
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
    // Cuota objetivo FUTURA: NO bloquea. El cliente que esta al dia puede
    // adelantar la cuota que vence manana, y esa es su decision, no la de la
    // app. El servidor la acepta igual: `cuota_objetivo` es una pista y la
    // cascada asigna la plata a la cuota mas antigua sin cubrir.
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
      // Día de negocio. `hoy` es un string; la función que lo calcula sigue
      // importada como `todayColombia` y no se sombrea (antes se declaraba
      // una constante con ese mismo nombre y cualquier llamada a la función
      // reventaba con "todayColombia is not a function").
      const hoy = todayColombia()
      const ayer = ayerColombia()

      // ── Carga del módulo ─────────────────────────────────────────────
      // Trae préstamos, el financiero derivado, el cronograma y el libro de
      // eventos de hoy y ayer. Sin RLS: cada consulta filtra por ruta.
      const dashboard = await loadDashboardPagos(supabase, {
        rutaId: currentRutaId,
      })
      if (fetchDataTokenRef.current !== myToken) return

      const { loans, saldoMap, moraMap, fechaUltimoPagoMap, finMap, gestiones, allPaymentPlans } = dashboard
      console.log(`[v0] dashboard cargado: ${loans.length} loans (${dashboard.source})`)
      // Si los datos vienen del dispositivo, avisamos desde cuándo son: el
      // cobrador debe saber que puede haber gestiones de otros que aún no ve.
      setDatosDesdeCache(dashboard.source === "cache" ? (dashboard.cacheGuardadoEn ?? null) : null)

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

      // ── Multas por mora ──────────────────────────────────────────────
      // La generacion vive en el servidor (`generar_multas_ruta`, script 047).
      // Antes corria aqui: cada dispositivo que abria esta pantalla evaluaba
      // e INSERTABA multas dentro del camino de lectura, con el indice unico
      // parcial como unica proteccion contra duplicados. Ademas contaba las
      // fallas sobre estados de cuota, asi que una fila sintetica de valor 0
      // producia multas de $0 que se descartaban en silencio.
      //
      // La app solo pide la evaluacion y lee el resultado. Si la RPC falla,
      // el listado carga igual: cobrar nunca puede depender de las multas.
      const multasMap = new Map<string, { id: string; valor: number; cuotasMora: number | null }>()
      try {
        const { error: genErr } = await supabase.rpc("generar_multas_ruta", {
          p_ruta_id: currentRutaId,
        })
        if (genErr) console.error("[v0] generar_multas_ruta:", genErr.message)

        const { data: multasData, error: multasErr } = await supabase
          .from("multas")
          .select("id, loan_id, valor, cuotas_mora")
          .eq("ruta_id", currentRutaId)
          .eq("estado", "pendiente")
        if (multasErr) throw multasErr
        for (const m of (multasData ?? []) as { id: string; loan_id: string; valor: number; cuotas_mora: number | null }[]) {
          multasMap.set(m.loan_id, { id: m.id, valor: m.valor, cuotasMora: m.cuotas_mora })
        }
      } catch (err) {
        console.error("[v0] Error cargando multas:", err)
      }

      // Process each loan with its payment plan
      for (const loan of activeLoans) {
        // Las ventas del dia no se cobran el mismo dia... salvo que se hayan
        // registrado con "Inicia pagos hoy", en cuyo caso su primera cuota
        // vence justamente hoy y el cliente TIENE que aparecer en la lista.
        // Sin esta excepcion, la casilla no serviria de nada: el plan
        // arrancaria hoy pero el cobrador no veria al cliente.
        if (loan.fecha_creacion) {
          const fechaCreacionColombia = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric", month: "2-digit", day: "2-digit",
          }).format(new Date(loan.fecha_creacion))
          const cobraDesdeHoy = !!loan.fecha_primer_pago && loan.fecha_primer_pago <= hoy
          if (fechaCreacionColombia === hoy && !cobraDesdeHoy) continue
        }

        const paymentPlan = paymentPlansByLoan.get(loan.id) || []
        // Conteos sobre cuotas BASE (las extra de extensiones se muestran
        // aparte como "+N extra" y no alteran el X/Y del prestamo).
        // Una cuota saldada por CANCELACION TOTAL queda en estado 'cancelada',
        // no en 'pagado'. Contando solo 'pagado', un cliente que pagaba su
        // prestamo completo aparecia con "0 de 24 cuotas" — como si no
        // hubiera abonado nunca. Se cuentan las dos: en ambos casos la cuota
        // quedo saldada.
        const fin = finMap.get(loan.id)
        const cuotasPagadas = fin?.cuotas_cubiertas ?? paymentPlan.filter(
          (p) => !p.es_extra && (p.estado === "pagado" || p.estado === "cancelada"),
        ).length
        const cuotasTotales = fin?.cuotas_totales ?? paymentPlan.filter((p) => !p.es_extra).length
        const cuotasExtra = fin?.cuotas_extra ?? paymentPlan.filter((p) => p.es_extra).length

        // Sort by fecha_pago (vencimiento) to ensure correct order
        const sortedPlan = [...paymentPlan].sort((a, b) => a.fecha_pago.localeCompare(b.fecha_pago))

        // ── Gestionado HOY ───────────────────────────────────────────────
        // UNA sola regla: existe un evento aplicado con fecha_gestion = hoy.
        //
        // Antes esto se deducia de las cuotas (estado + fecha_pago + hora de
        // fecha_pago_real). Como cada gestion pisaba la fecha de la cuota, la
        // deduccion fallaba: aplicar un pago al dia anterior consumia el dia
        // de hoy del cliente — se iba a Gestionados sin salir en los
        // indicadores, y ya no se le podia registrar la gestion del dia.
        const gestionHoy = resumenDelDia(gestiones, loan.id, hoy)
        const gestionAyer = resumenDelDia(gestiones, loan.id, ayer)

        // ------------------------------------------------------------------
        // Cuota objetivo: la que el cobrador va a cobrar (nextPaymentId)
        // ------------------------------------------------------------------
        // Con el cronograma ya inmutable, `fecha_pago` es el vencimiento y la
        // eleccion es directa:
        //   1. La cuota que vence HOY, si sigue sin cubrir.
        //   2. La vencida mas vieja sin cubrir (atraso).
        //   3. La proxima futura — el cliente esta al dia. Sigue visible y
        //      SI se puede cobrar: es un pago adelantado.
        //
        // La cuota objetivo es una PISTA que viaja con la gestion: si al
        // sincronizar ya no aplica, el servidor asigna la plata a la cuota
        // mas antigua sin cubrir. Ya no existe el conflicto "esa cuota ya
        // fue gestionada".
        const sinCubrir = (p: PaymentPlanEntry) =>
          p.estado === "pendiente" || p.estado === "parcial" || p.estado === "no_pago"

        const pendingToday = sortedPlan.find((p) => sinCubrir(p) && p.fecha_pago === hoy)
        const oldestOverduePending = sortedPlan.find((p) => sinCubrir(p) && p.fecha_pago < hoy)
        const nextFuturePending = sortedPlan.find((p) => sinCubrir(p) && p.fecha_pago > hoy)

        const targetEntry = pendingToday || oldestOverduePending || nextFuturePending || null

        // Sin cuota por cobrar y sin gestion hoy: el prestamo esta saldado.
        if (!targetEntry && !gestionHoy.gestionado) {
          continue
        }

        // Cuota FUTURA: el cliente esta al dia. Cobrarle hoy es ADELANTAR.
        // Solo gobierna el badge y el orden en la lista, no el permiso.
        const esFuturo = !pendingToday && !oldestOverduePending && !!nextFuturePending

        // "Ultima cuota": la objetivo es la UNICA sin cubrir del plan —
        // resolverla agota el cronograma. Gobierna los checkboxes de
        // extension y cuota adicional.
        const sinCubrirRestantes = paymentPlan.filter(sinCubrir).length
        const esUltimaCuotaPendiente = !!targetEntry && sinCubrirRestantes === 1

        // Mora en CUOTAS vencidas sin cubrir, derivada del cronograma intacto.
        const mora = moraMap.get(loan.id) ?? 0

        // Ultimo abono: sale del libro de eventos.
        const pagosDelLoan = gestiones
          .filter((g) => g.loan_id === loan.id && Number(g.monto) > 0
            && (g.tipo === "pago" || g.tipo === "cancelacion" || g.tipo === "abono_venta"))
          .sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora))
        const ultimoEvento = pagosDelLoan[pagosDelLoan.length - 1]

        // Saldo: lo que el cliente debe HOY, derivado del libro. `loan.saldo`
        // es un cache de la misma cuenta; solo se usa si la vista no
        // respondio, y se avisa para poder detectarlo en produccion.
        let saldoReal: number
        if (saldoMap.has(loan.id)) {
          saldoReal = saldoMap.get(loan.id)!
        } else {
          console.error(
            `[v0] FALTA v_loan_financiero para loan ${loan.id} — usando loans.saldo como ultimo recurso`,
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
          // Fecha en que se hizo la venta — se imprime en el recibo.
          fechaVenta: (loan.fecha_creacion || loan.created_at || "").split("T")[0],
          valorCuota: loan.valor_cuota,
          saldo: saldoReal,
          cuotasPagadas: cuotasPagadas,
          cuotasTotales: cuotasTotales,
          cuotasExtra: cuotasExtra,
          esUltimaCuotaPendiente,
          mora,
          ultimoPago: Number(ultimoEvento?.monto) || 0,
          ultimoPagoFecha: fechaUltimoPagoMap.get(loan.id) ?? ultimoEvento?.fecha_gestion ?? "",
          frecuenciaPago: loan.frecuencia_pago,
          tipoAmortizacion: loan.tipo_amortizacion ?? null,
          tasaInteres: loan.tasa_interes,
          // La cuota objetivo viaja como PISTA con la gestion. Si el plan ya
          // se agoto (cliente gestionado hoy sin cuotas por cobrar) queda
          // vacia: el servidor no la necesita para aplicar la plata.
          nextPaymentId: targetEntry?.id ?? "",
          nextPaymentCuota: targetEntry?.valor_cuota || loan.valor_cuota,
          nextPaymentNumero: targetEntry?.numero_cuota ?? 0,
          nextPaymentCapital: targetEntry?.capital ?? 0,
          nextPaymentValorCuota: targetEntry?.valor_cuota ?? loan.valor_cuota ?? 0,
          nextPaymentEsFuturo: esFuturo,
          nextPaymentFecha: targetEntry?.fecha_pago ?? hoy,
          ordenvisita: loan.ordenvisita || 0,
          diaSemana: loan.dia_semana || null,
          multaPendiente: multasMap.get(loan.id) ?? null,
          clienteLatitud: loan.clients?.latitud ?? null,
          clienteLongitud: loan.clients?.longitud ?? null,
          // Día anterior sin gestionar: hay cuota vencida Y ayer no se
          // registró nada. Es lo que dispara la pregunta "¿a qué fecha
          // aplico esta gestión?".
          cuotaVencidaId: !gestionAyer.gestionado ? (oldestOverduePending?.id ?? null) : null,
          cuotaVencidaFecha: !gestionAyer.gestionado && oldestOverduePending ? ayer : null,
        }

        if (gestionHoy.gestionado) {
          managedClientsFromDB.push({
            ...clientData,
            gestionTipo: gestionHoy.tipo === "pago" ? "pago" : "no_pago",
            gestionHora: gestionHoy.hora,
            valorAbonado: gestionHoy.monto,
            cuotasAbonadas: gestionHoy.cuotas,
            paymentPlanId: targetEntry?.id ?? "",
          })
        } else {
          // Loans con estado "cancelado" no se muestran en el listado de pendientes.
          if (loan.estado === "cancelado") {
            continue
          }
          pendingClients.push(clientData)
        }
      }

      // Sort: primero lo que vence hoy o esta atrasado (ordenvisita), y los
      // que estan al dia (cuota FUTURA, cobrarlos seria adelantar) al final.
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
    setPagarMulta(false)
    setAgregarCuotaSiDebe(true)
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
    setPagarMulta(false)
    setAgregarCuotaSiDebe(true)
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

    // GPS y geocerca primero (el GPS puede tardar 1-2s en moviles): si no
    // esta, o el cobrador esta lejos y no justifica, no abrimos saving.
    const geocerca = await resolverGeocerca(selectedClient, "pagos")
    if (!geocerca) return
    const coords = geocerca.coords

    const clientSnapshot = selectedClient
    const isCanceladaSnap = isCancelada
    const isPartialSnap = isPartialPayment
    const numCuotasSnap = numCuotas
    // Snapshot de "pagar multa": solo valido si el cliente tiene multa pendiente.
    const pagarMultaSnap = pagarMulta && !!clientSnapshot.multaPendiente
    // Snapshot del flag de extension. Solo aplica si:
    //   - el prestamo es tipo "americano" (intereses)
    //   - la cuota actual es la ULTIMA del plan
    //   - el admin marco el checkbox y digito una cantidad valida (>=1)
    const extenderSnap =
      extenderCuotas &&
      clientSnapshot.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
      clientSnapshot.esUltimaCuotaPendiente
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
    // Snapshot de "agregar cuota adicional si debe": recalculado desde la
    // condicion real (no solo el checkbox) para que jamas se dispare fuera
    // de la ultima cuota, ni mezclado con cancelacion total o con la
    // extension manual de americano.
    const agregarCuotaSnap =
      agregarCuotaSiDebe &&
      !isCanceladaSnap &&
      !extenderSnap &&
      clientSnapshot.esUltimaCuotaPendiente

    try {
      setSaving(true)

      // Día de negocio y hora exacta, ambos en zona Colombia y de la misma
      // fuente (ver lib/gestion-core.ts).
      const fechaPago = todayColombia()
      const fechaPagoReal = ahoraColombiaISO()
      const { latitud, longitud } = coords

      // -----------------------------------------------------------------
      // ── ¿Quedo un dia anterior sin gestionar? ────────────────────────
      // Si el cliente arrastra una cuota vencida y AYER no se le registro
      // nada, se pregunta a que dia va esta gestion.
      //
      //  · "Al dia anterior": el evento queda fechado AYER — cuenta en los
      //    registros e indicadores de ese dia — y el cliente sigue
      //    disponible para la gestion de HOY.
      //  · "Para hoy": el evento queda fechado hoy, y ayer sigue sin
      //    gestionar (mañana vuelve a preguntar).
      //
      // Cancelacion y extension se excluyen: son operaciones de hoy por
      // naturaleza (la cancelacion cubre tambien lo vencido).
      //
      // Va ANTES del umbral para que, si el pago termina en la cola de
      // secretaria, lleve la misma fecha que el cobrador eligio.
      let fechaAplicacion = fechaPago
      let numCuotasEfectivo = numCuotasSnap
      let retroAplicado = false
      if (
        clientSnapshot.cuotaVencidaId &&
        clientSnapshot.cuotaVencidaFecha &&
        !isCanceladaSnap &&
        !extenderSnap
      ) {
        const choice = await askFechaChoice(clientSnapshot.cuotaVencidaFecha, fechaPago)
        if (choice === null) {
          setSaving(false)
          return
        }
        if (choice === "pendiente") {
          fechaAplicacion = clientSnapshot.cuotaVencidaFecha
          numCuotasEfectivo = 1
          retroAplicado = true
        }
      }

      // Llave del evento: se genera AQUI, al capturar. Es la misma que se
      // usa ahora o dentro de dos horas al drenar la cola, y es la llave
      // primaria del libro — reintentar no puede duplicar la plata.
      const gestionId = nuevaGestionId()

      // -----------------------------------------------------------------
      // ── Umbral de aprobacion de abonos por ruta ──────────────────────
      // El umbral compara la CANTIDAD DE CUOTAS pagadas de una sola vez
      // (selector "Nro Cuotas"), no el monto en pesos. Solo aplica a pago
      // normal -- pago parcial (siempre 1 cuota) y cancelacion total (paga
      // todo el prestamo) nunca disparan este umbral. Si se dispara, el
      // pago se envia a revision ANTES de tocar cualquier tabla real
      // (incluidos los pre-pasos de "pago extraordinario" y "extension de
      // americano" de mas abajo, que tambien quedan en espera).
      // payment_plan/loans no se modifican hasta que secretaria apruebe.
      // El chequeo de aquí es solo un AVISO: se le advierte al cobrador que
      // el abono va a necesitar el visto bueno de secretaría y se le pide
      // confirmar. Quien DECIDE es el servidor, que compara contra la
      // configuración de la ruta dentro de la misma transacción.
      //
      // Antes este camino armaba a mano una solicitud de revisión y no
      // registraba el pago: eran dos formas distintas de payload y dos
      // caminos que podían comportarse distinto. Peor: si la configuración
      // de umbrales no había alcanzado a cargar, el chequeo daba negativo y
      // el abono se aplicaba directo, saltándose la aprobación sin que
      // nadie se enterara. Ahora el pago viaja siempre igual y el servidor
      // lo marca "en revisión" si corresponde — la plata queda registrada
      // desde el primer momento, pero no cuenta hasta que la aprueben.
      if (
        !isCanceladaSnap && !isPartialSnap &&
        excedeUmbral(umbrales?.abono_habilitado ?? false, umbrales?.abono_umbral_cuotas ?? null, numCuotasEfectivo)
      ) {
        const confirmado = await confirmRevision()
        if (!confirmado) { setSaving(false); return }
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
        clientSnapshot.esUltimaCuotaPendiente

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
      // La prorroga de americano ya NO se ejecuta aqui: viaja en el payload
      // (`extender_cuotas`) y la RPC la aplica dentro de la misma transaccion
      // del pago. Antes eran 2 escrituras sueltas ANTES del pago cuyo orden
      // era critico — si el pago fallaba despues, el prestamo quedaba
      // extendido sin cobrar.

      // -----------------------------------------------------------------
      // Llamada al RPC atomico `registrar_pago_atomico`.
      //
      // La RPC envuelve en una sola transaccion todos los UPDATEs que
      // antes corrian con `Promise.all` separados, garantizando atomicidad
      // (rollback completo si algun paso falla). El payload va como `jsonb`
      // con una firma estable y la funcion deriva `tipo` para decidir si
      // paga 1 cuota, varias, cancelacion total o no_pago.
      // -----------------------------------------------------------------
      // El evento viaja por la cola: sin señal queda en el teléfono y se
      // sincroniza solo. Su `id` es la llave primaria del libro, así que
      // sincronizar horas después no puede duplicar la plata.
      const { encolado, resultado } = await enviarOEncolar({
        tipo: "gestion",
        id: gestionId,
        descripcion: `Pago — ${clientSnapshot.nombre} ($${monto.toLocaleString()})`,
        payload: {
          id: gestionId,
          tipo: isCanceladaSnap ? "cancelacion" : "pago",
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          monto,
          num_cuotas: numCuotasEfectivo,
          fecha_gestion: fechaAplicacion,
          fecha_hora: fechaPagoReal,
          latitud,
          longitud,
          // Resultado de la geocerca al momento de capturar. La distancia NO
          // se manda: el servidor la recalcula contra la ubicacion guardada
          // del cliente, porque un numero venido del dispositivo no prueba
          // nada (el payload offline se guarda tal cual y nadie lo revisa).
          geocerca_estado: geocerca.geo.estado,
          geocerca_motivo: geocerca.motivo,
          generar_cuota_si_debe: agregarCuotaSnap,
          // Pista de a qué cuota apuntaba el cobrador. Si al sincronizar ya
          // no aplica, el servidor asigna la plata a la más antigua sin
          // cubrir: nunca se rechaza un pago por una cuota desactualizada.
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          // La multa y la prórroga entran en la misma transacción.
          multa_id: pagarMultaSnap ? clientSnapshot.multaPendiente?.id ?? null : null,
          metodo_pago: paymentMethod,
          cliente_nombre: clientSnapshot.nombre,
          extender_cuotas: debeExtender ? cantidadExtenderSnap : 0,
        },
      })

      if (encolado) {
        // El cliente sale de Pendientes IGUAL que con señal, y el evento se
        // inyecta en el cache del dispositivo.
        //
        // Antes la rama offline no tocaba nada: el cliente se quedaba en la
        // lista y, si el cobrador cerraba y reabría la app, volvía a
        // aparecer. Cobrarle otra vez generaba una SEGUNDA operación con
        // otra llave — dos cobros que el servidor no podía reconocer como
        // el mismo. Es el peor agujero que tenía el modo sin señal.
        const gestionLocal: Gestion = {
          id: gestionId,
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          ruta: currentRutaId,
          user_id: null,
          tipo: isCanceladaSnap ? "cancelacion" : "pago",
          estado: "aplicada",
          fecha_gestion: fechaAplicacion,
          monto,
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          num_cuotas: numCuotasEfectivo,
          fecha_hora: fechaPagoReal,
          metodo_pago: paymentMethod,
          origen: "campo",
          referencia_gestion_id: null,
          observacion: null,
        }
        void parcharCache<DashboardPagosResult>("dashboard-pagos", currentRutaId, (datos) =>
          inyectarGestionEnCache(datos, gestionLocal),
        )

        if (!retroAplicado) {
          setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
          setManagedToday((prev) => [
            {
              ...clientSnapshot,
              saldo: Math.max(0, clientSnapshot.saldo - monto),
              multaPendiente: pagarMultaSnap ? null : clientSnapshot.multaPendiente,
              gestionTipo: "pago",
              gestionHora: fechaPagoReal.slice(11, 16),
              valorAbonado: monto,
              cuotasAbonadas: numCuotasEfectivo,
              paymentPlanId: clientSnapshot.nextPaymentId || undefined,
            },
            ...prev,
          ])
        }

        toast({
          title: "Pago guardado sin conexión",
          description: retroAplicado
            ? `Se registró $${monto.toLocaleString()} con fecha ${fechaAplicacion} en el teléfono. ${clientSnapshot.nombre} sigue disponible para la gestión de hoy.`
            : `Se registró el pago de ${clientSnapshot.nombre} en el teléfono. Se enviará solo cuando vuelva la señal.`,
        })
        handleBack()
        return
      }

      const rpcResult = resultado!

      // Valores derivados desde la respuesta autoritativa del RPC.
      // Los usamos para el optimistic UI inmediato (sin esperar al refetch).
      const nuevoSaldo = (rpcResult.nuevo_saldo as number | undefined) ?? clientSnapshot.saldo
      void rpcResult.loan_estado_final
      void rpcResult.cliente_marcado_sin_prestamo

      // El evento SIEMPRE quedó escrito. Si algo no cuadraba (préstamo ya
      // cancelado, fecha de hace más de un día, abono sobre el umbral de la
      // ruta), entró como "en revisión": la plata está registrada pero no
      // cuenta hasta que secretaría la apruebe. No se mueve a Gestionados.
      if (rpcResult.enviado_a_revision || rpcResult.estado_gestion === "en_revision") {
        toast({
          title: "Pago enviado a revisión",
          description: `${rpcResult.motivo ?? "El pago necesita aprobación"}. Secretaría lo revisará; el cobro ya quedó registrado.`,
        })
        void fetchData({ silent: true })
        handleBack()
        return
      }

      // Recibió más de lo que debía: el excedente se registró igual (nunca
      // se descarta plata), pero conviene que el cobrador lo sepa.
      const sobrepago = Number(rpcResult.sobrepago ?? 0)
      if (sobrepago > 0) {
        toast({
          title: "El abono superó el saldo",
          description: `El saldo de ${clientSnapshot.nombre} quedó en $0 y sobraron $${sobrepago.toLocaleString()}. Verifica con secretaría si hay que devolverlos.`,
        })
      }

      // El cobro de la multa ya viene resuelto por la RPC, dentro de la misma
      // transaccion del pago: o entran los dos, o no entra ninguno. Antes eran
      // dos escrituras sueltas y si la segunda fallaba, la multa quedaba
      // cobrada pero el dinero nunca llegaba a la caja de la ruta.
      const multaCobrada = rpcResult.multa_cobrada === true

      // ── Gestion aplicada al dia anterior ─────────────────────────────
      // NO se mueve a Gestionados: la gestion quedo fechada en ese dia y el
      // cliente sigue vigente para la gestion de HOY. El refetch recalcula
      // su cuota objetivo (la de hoy) y lo deja en la lista de pendientes.
      if (retroAplicado) {
        const multaSufijoRetro = multaCobrada && clientSnapshot.multaPendiente
          ? ` + multa de $${clientSnapshot.multaPendiente.valor.toLocaleString()}`
          : ""
        toast({
          title: `Pago aplicado al ${fechaAplicacion}`,
          description: `Se registró $${monto.toLocaleString()}${multaSufijoRetro} a la cuota del ${fechaAplicacion} de ${clientSnapshot.nombre}. El cliente sigue disponible para la gestión de hoy.`,
        })
        void fetchData({ silent: true })
        handleBack()
        return
      }

      // Optimistic UI con los números que devolvió el servidor (saldo y
      // cuotas cubiertas son derivados, no estimaciones del dispositivo).
      const gestionHora = fechaPagoReal.slice(11, 16)
      setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
      setManagedToday((prev) => [
        {
          ...clientSnapshot,
          saldo: nuevoSaldo,
          cuotasPagadas: Number(rpcResult.cuotas_cubiertas ?? clientSnapshot.cuotasPagadas),
          multaPendiente: multaCobrada ? null : clientSnapshot.multaPendiente,
          gestionTipo: "pago",
          gestionHora,
          valorAbonado: monto,
          cuotasAbonadas: isCanceladaSnap
            ? Math.max(1, Number(rpcResult.cuotas_cubiertas ?? 0) - clientSnapshot.cuotasPagadas)
            : numCuotasEfectivo,
          paymentPlanId: clientSnapshot.nextPaymentId || undefined,
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
      } else if (debeExtender && rpcResult.extension_aplicada) {
        // La extension corrio dentro de la misma transaccion del pago.
        toast({
          title: "Pago registrado y préstamo extendido",
          description: `Pago registrado y préstamo extendido exitosamente por ${cantidadExtenderSnap} cuota${cantidadExtenderSnap === 1 ? "" : "s"} más`,
        })
      } else if (debeExtender && rpcResult.extension_motivo) {
        // El pago SÍ entró; solo la extensión no aplicaba. La plata nunca
        // queda de rehén de una validación.
        toast({
          title: "Pago registrado, extensión no aplicada",
          description: String(rpcResult.extension_motivo),
        })
      } else if (rpcResult.cuota_adicional_generada) {
        // El cliente aun debia al agotarse el plan de pagos: se generó una
        // cuota adicional en vez de cancelar el prestamo (confirmado por el
        // checkbox "Agregar cuota adicional si aún debe").
        toast({
          title: "Pago registrado — cuota adicional agregada",
          description: `Se registró el pago para ${clientSnapshot.nombre}. Como aún debe, se agregó una cuota adicional al plan de pagos.`,
        })
      } else {
        const multaSuffix = multaCobrada && clientSnapshot.multaPendiente
          ? ` + multa de $${clientSnapshot.multaPendiente.valor.toLocaleString()}`
          : ""
        toast({
          title: "Pago registrado",
          description: `Se registró el pago por $${monto.toLocaleString()}${multaSuffix} para ${clientSnapshot.nombre}`,
        })
      }

      // Refetch SILENCIOSO en background para sincronizar mora/saldos calculados.
      void fetchData({ silent: true })

      // Preguntar si desea compartir el comprobante antes de volver al listado.
      setClientForShare(clientSnapshot)
      setShareTrasPago(true)
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

    // GPS y geocerca antes de mostrar saving para no bloquear la UI si falla
    const geocerca = await resolverGeocerca(noPaymentClient, "no pagos")
    if (!geocerca) return
    const coords = geocerca.coords

    const clientSnapshot = noPaymentClient
    // Igual que en handleRegisterPayment: recalculado desde la condicion
    // real, no solo el checkbox.
    const agregarCuotaSnapNoPago =
      agregarCuotaSiDebeNoPago &&
      clientSnapshot.esUltimaCuotaPendiente

    try {
      setSaving(true)

      const colombiaDateStr = todayColombia()
      const fechaPagoReal = ahoraColombiaISO()
      const { latitud, longitud } = coords

      // Igual que en el pago: si quedó un día anterior sin gestionar se
      // pregunta a qué día va este no pago. "Al día anterior" lo fecha ese
      // día y deja al cliente vigente para la gestión de hoy.
      let fechaAplicacionNp = colombiaDateStr
      let retroAplicadoNp = false
      if (clientSnapshot.cuotaVencidaId && clientSnapshot.cuotaVencidaFecha) {
        const choice = await askFechaChoice(clientSnapshot.cuotaVencidaFecha, colombiaDateStr)
        if (choice === null) {
          setSaving(false)
          return
        }
        if (choice === "pendiente") {
          fechaAplicacionNp = clientSnapshot.cuotaVencidaFecha
          retroAplicadoNp = true
        }
      }

      const gestionIdNp = nuevaGestionId()

      // Un no pago es una VISITA: queda registrada pase lo que pase. Antes,
      // si la cuota ancla ya no estaba pendiente, el servidor devolvía "ok"
      // sin escribir nada y la visita desaparecía en silencio.
      const { encolado: encoladoNoPago, resultado: resNoPago } = await enviarOEncolar({
        tipo: "gestion",
        id: gestionIdNp,
        descripcion: `No pago — ${clientSnapshot.nombre}`,
        payload: {
          id: gestionIdNp,
          tipo: "no_pago",
          loan_id: clientSnapshot.loanId,
          client_id: clientSnapshot.clientId,
          monto: 0,
          num_cuotas: 1,
          fecha_gestion: fechaAplicacionNp,
          fecha_hora: fechaPagoReal,
          latitud,
          longitud,
          geocerca_estado: geocerca.geo.estado,
          geocerca_motivo: geocerca.motivo,
          generar_cuota_si_debe: agregarCuotaSnapNoPago,
          cuota_objetivo: clientSnapshot.nextPaymentId || null,
          cliente_nombre: clientSnapshot.nombre,
          observacion: noPaymentObservation.trim() || null,
        },
      })

      const gestionLocalNp: Gestion = {
        id: gestionIdNp,
        loan_id: clientSnapshot.loanId,
        client_id: clientSnapshot.clientId,
        ruta: currentRutaId,
        user_id: null,
        tipo: "no_pago",
        estado: "aplicada",
        fecha_gestion: fechaAplicacionNp,
        monto: 0,
        cuota_objetivo: clientSnapshot.nextPaymentId || null,
        num_cuotas: 1,
        fecha_hora: fechaPagoReal,
        metodo_pago: null,
        origen: "campo",
        referencia_gestion_id: null,
        observacion: noPaymentObservation.trim() || null,
      }

      if (encoladoNoPago) {
        // Mismo tratamiento que el pago: el cliente sale de pendientes y el
        // evento entra al cache, para que reabrir la app sin señal no lo
        // vuelva a ofrecer.
        void parcharCache<DashboardPagosResult>("dashboard-pagos", currentRutaId, (datos) =>
          inyectarGestionEnCache(datos, gestionLocalNp),
        )
        if (!retroAplicadoNp) {
          setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
          setManagedToday((prev) => [
            {
              ...clientSnapshot,
              gestionTipo: "no_pago",
              gestionHora: fechaPagoReal.slice(11, 16),
              valorAbonado: 0,
              cuotasAbonadas: 0,
              paymentPlanId: clientSnapshot.nextPaymentId || undefined,
            },
            ...prev,
          ])
        }
        toast({
          title: "No pago guardado sin conexión",
          description: retroAplicadoNp
            ? `Quedó con fecha ${fechaAplicacionNp}. ${clientSnapshot.nombre} sigue disponible para la gestión de hoy.`
            : "Se registró en el teléfono. Se enviará solo cuando vuelva la señal.",
        })
        setNoPaymentClient(null)
        setNoPaymentObservation("")
        return
      }

      const rpcResultNoPago = resNoPago!

      if (rpcResultNoPago.enviado_a_revision || rpcResultNoPago.estado_gestion === "en_revision") {
        toast({
          title: "No pago enviado a revisión",
          description: `${rpcResultNoPago.motivo ?? "Necesita aprobación"}. La visita ya quedó registrada.`,
        })
        setNoPaymentClient(null)
        setNoPaymentObservation("")
        void fetchData({ silent: true })
        return
      }

      // ── No pago aplicado al dia anterior ─────────────────────────────
      // NO se mueve a Gestionados: quedo fechado ese dia y el cliente sigue
      // vigente para la gestion de hoy.
      if (retroAplicadoNp) {
        toast({
          title: `No pago aplicado al ${fechaAplicacionNp}`,
          description: `La visita del ${fechaAplicacionNp} de ${clientSnapshot.nombre} quedó como no pago. El cliente sigue disponible para la gestión de hoy.`,
        })
        setNoPaymentClient(null)
        setNoPaymentObservation("")
        void fetchData({ silent: true })
        return
      }

      // Optimistic UI: quitar de pendientes y agregar a managedToday
      setClients((prev) => prev.filter((c) => c.loanId !== clientSnapshot.loanId))
      setManagedToday((prev) => [
        {
          ...clientSnapshot,
          gestionTipo: "no_pago",
          gestionHora: fechaPagoReal.slice(11, 16),
          valorAbonado: 0,
          cuotasAbonadas: 0,
          paymentPlanId: clientSnapshot.nextPaymentId || undefined,
        },
        ...prev,
      ])

      toast(
        rpcResultNoPago.cuota_adicional_generada
          ? {
              title: "No pago registrado — cuota adicional agregada",
              description: `Se registró que ${clientSnapshot.nombre} no realizó el pago. Como aún debe, se agregó una cuota adicional al plan de pagos.`,
            }
          : {
              title: "No pago registrado",
              description: `Se registró que ${clientSnapshot.nombre} no realizó el pago`,
            },
      )

      setNoPaymentClient(null)
      setNoPaymentObservation("")
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

  // ── Historial de gestiones del cliente ────────────────────────────────
  // Sale del LIBRO DE EVENTOS, no del cronograma: lo que el cobrador quiere
  // ver es qué pasó cada día que se visitó al cliente. Antes se leían las
  // cuotas gestionadas, que era una aproximación — un abono de tres cuotas
  // aparecía como tres líneas y una cancelación como muchas.
  useEffect(() => {
    if (!paymentHistoryOpen || !paymentHistoryClient) return
    let cancelled = false
    setPaymentHistoryLoading(true)
    setPaymentHistoryRows([]);
    (async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("gestiones")
          .select("id, tipo, estado, fecha_gestion, monto, num_cuotas, fecha_hora, observacion")
          .eq("loan_id", paymentHistoryClient.loanId)
          .eq("estado", "aplicada")
          .in("tipo", ["pago", "no_pago", "cancelacion", "abono_venta"])
          .order("fecha_gestion", { ascending: true })
        if (cancelled) return
        if (error) throw error
        // Se mapea a la forma que ya renderiza el diálogo.
        setPaymentHistoryRows(
          (data ?? []).map((g: Record<string, unknown>) => ({
            id: String(g.id),
            fecha_pago: String(g.fecha_gestion),
            valor_cuota: Number(g.monto) || 0,
            estado: g.tipo === "no_pago" ? "no_pago" : "pagado",
            monto_pagado: Number(g.monto) || 0,
            fecha_pago_real: g.fecha_hora ? String(g.fecha_hora) : null,
            numero_cuota: Number(g.num_cuotas) || 1,
          })),
        )
      } catch (e) {
        console.error("[v0] historial de gestiones error:", e)
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

  /** Descarga el logo y lo devuelve como data URL para poder pintarlo. */
  const cargarLogoBase64 = async (url: string): Promise<string | null> => {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const blob = await res.blob()
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }

  // -- Generar recibo como IMAGEN ---------------------------------------
  // Se dibuja en un canvas y se exporta PNG, en vez del PDF de antes.
  //
  // Por que imagen: compartido por WhatsApp o correo, un PNG se ve dentro
  // del chat y el cliente lo lee de una; un PDF llega como adjunto que hay
  // que abrir aparte. Se usa Canvas 2D y no una libreria: el recibo son
  // filas de texto, dos lineas y el logo, o sea lo mismo que se hacia con
  // jsPDF pero con fillText/drawImage. Sin dependencias nuevas y sigue
  // funcionando sin senal.
  const buildReciboImagen = async (
    client: DisplayClient,
    gestionHoy?: ManagedClient,
  ): Promise<{ blob: Blob; filename: string; dataUrl: string }> => {
    const supabase = await getSupabaseSafe()
    const [finRes, clientRes] = await Promise.all([
      supabase
        .from("v_loan_financiero")
        .select("total_a_pagar, total_pagado, saldo_hoy, cuotas_mora, cuotas_cubiertas, cuotas_totales, cuotas_extra")
        .eq("loan_id", client.loanId)
        .maybeSingle(),
      supabase
        .from("clients")
        .select("nombre_completo, apodo")
        .eq("id", client.clientId)
        .maybeSingle(),
    ])

    const finRow = finRes.data as {
      total_a_pagar?: number | null
      total_pagado?: number | null
      saldo_hoy?: number | null
      cuotas_mora?: number | null
      cuotas_cubiertas?: number | null
      cuotas_totales?: number | null
      cuotas_extra?: number | null
    } | null
    // Se conservan los nombres viejos para no reescribir el dibujo del recibo.
    const saldo = finRow && {
      total_con_intereses: finRow.total_a_pagar,
      total_recaudado: finRow.total_pagado,
      saldo_pendiente: finRow.saldo_hoy,
    }
    // El recibo lleva el nombre del cliente, sin el apodo.
    //
    // En muchos registros el apodo (el oficio o el negocio) quedo guardado
    // DENTRO de `nombre_completo`, y salia impreso en la mitad del nombre:
    // "EDUARDO MECANICO RODRIGUEZ". Aca se le quita si esta como palabra
    // aparte, sin tocar la base.
    //
    // Dos salvaguardas para no dejar a nadie sin nombre: si el apodo ES el
    // nombre completo no hay nada que quitar, y si al quitarlo queda una
    // sola palabra se prefiere el original. Ver
    // scripts/diagnostico-nombres-clientes.sql para limpiar el dato de raiz.
    const sinApodo = (completo: string, apodo: string | null | undefined): string => {
      const a = (apodo ?? "").trim()
      if (!a || a.toLowerCase() === completo.trim().toLowerCase()) return completo
      const escapado = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const limpio = completo
        .replace(new RegExp(escapado, "gi"), " ")
        .replace(/\s+/g, " ")
        .trim()
      return limpio.split(" ").filter(Boolean).length >= 2 ? limpio : completo
    }

    const datosCliente = clientRes.data as { nombre_completo?: string | null; apodo?: string | null } | null
    const nombreCompleto = datosCliente?.nombre_completo
      ? sinApodo(datosCliente.nombre_completo, datosCliente.apodo)
      : client.nombre

    // Abono de hoy: si el cliente ya fue gestionado viene en el objeto (que
    // ya trae la SUMA del dia); si no, se consulta lo gestionado hoy.
    let abonoHoy = gestionHoy?.valorAbonado ?? null
    let cuotasAbonadas = gestionHoy?.cuotasAbonadas ?? 0
    let fechaAbono: string | null = gestionHoy ? todayColombia() : null
    if (abonoHoy == null) {
      // Del libro de eventos: los movimientos de hoy de este préstamo.
      const { data: eventosHoy } = await supabase
        .from("gestiones")
        .select("tipo, monto, num_cuotas")
        .eq("loan_id", client.loanId)
        .eq("fecha_gestion", todayColombia())
        .eq("estado", "aplicada")
      const evs = (eventosHoy ?? []) as { tipo: string; monto: number | null; num_cuotas: number | null }[]
      if (evs.length > 0) {
        abonoHoy = evs.reduce((acc, e) => acc + montoEfectivo({ tipo: e.tipo as Gestion["tipo"], monto: Number(e.monto) || 0 }), 0)
        cuotasAbonadas = evs
          .filter((e) => e.tipo !== "no_pago" && Number(e.monto) > 0)
          .reduce((s, e) => s + (Number(e.num_cuotas) || 1), 0)
        fechaAbono = todayColombia()
      }
    }

    // Logo propio de la ruta; si no hay, el de la app.
    const umbralesRuta = await getRutaUmbrales(currentRutaId)
    const logoUrl = umbralesRuta.logo_url || `${window.location.origin}/opad-logo.png`
    const logoBase64 = await cargarLogoBase64(logoUrl)
    const logoImg = logoBase64
      ? await new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => resolve(null)
          img.src = logoBase64
        })
      : null

    const now = new Date()
    const fechaStr = now.toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" })
    const horaStr = now.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })

    const fmt = (n: number | null | undefined) =>
      n != null ? `$${Math.round(n).toLocaleString("es-CO")}` : "-"
    const fmtFechaCorta = (iso: string | null | undefined) => {
      if (!iso) return "-"
      const [yy, mm, dd] = iso.split("-")
      return dd && mm && yy ? `${dd}/${mm}/${yy}` : "-"
    }

    // El conteo de cuotas y la mora salen de la MISMA consulta que trajo los
    // totales, o sea del estado ya recalculado tras el pago.
    //
    // Antes se leían del objeto `client`, que es la foto que tenía la pantalla
    // ANTES de cobrar: el recibo que se le entregaba al cliente decía "8/24" y
    // "3 cuotas en mora" cuando acababa de pagar y ya iba en 9/24 con 2 de
    // mora. Justo los dos números que el cliente revisa.
    const cuotasCubiertas = finRow?.cuotas_cubiertas ?? client.cuotasPagadas
    const cuotasTotales = finRow?.cuotas_totales ?? client.cuotasTotales
    const cuotasExtra = finRow?.cuotas_extra ?? client.cuotasExtra
    const moraActual = finRow?.cuotas_mora ?? client.mora

    const rows: [string, string][] = [
      ["Fecha venta:", fmtFechaCorta(client.fechaVenta)],
      ["Total a pagar:", fmt(saldo?.total_con_intereses)],
      ["Total recaudado:", fmt(saldo?.total_recaudado)],
      ["Saldo pendiente:", fmt(saldo?.saldo_pendiente ?? client.saldo)],
      ["Cuotas:", `${cuotasCubiertas} / ${cuotasTotales}${Number(cuotasExtra) > 0 ? ` (+${cuotasExtra} extra)` : ""}`],
      ["Frecuencia:", frecuenciaLabel(client.frecuenciaPago)],
      // Antes esta fila decía "Fallas" pero imprimía la mora, que es otra
      // cosa (cuotas vencidas sin cubrir, no visitas incumplidas).
      ["Cuotas en mora:", `${moraActual}`],
      ["Saldo por sancion:", client.multaPendiente ? fmt(client.multaPendiente.valor) : "$0"],
    ]

    // El bloque del abono solo aparece si hubo movimiento; un recibo de
    // consulta no lo lleva. Aca va cuantas cuotas cubrio el cobro de hoy.
    if (abonoHoy != null && abonoHoy > 0) {
      rows.splice(1, 0,
        ["Fecha del abono:", fmtFechaCorta(fechaAbono)],
        ["Cuotas abonadas:", `${cuotasAbonadas}`],
        ["Valor pagado:", fmt(abonoHoy)],
      )
    }

    // -- Dibujo ---------------------------------------------------------
    // Medidas en puntos logicos (ancho de tirilla 80mm ~ 300pt) y se escala
    // x3 al pintar para que se vea nitido en la pantalla del celular.
    const ESCALA = 3
    const W = 300
    const PAD = 18
    const ALTO_FILA = 20
    const ALTO_LOGO = logoImg ? 72 : 0

    const H =
      PAD + ALTO_LOGO + 30 + 20 + 14 +
      ALTO_FILA * 2 + 14 +
      ALTO_FILA * rows.length + 14 +
      26 + PAD

    const canvas = document.createElement("canvas")
    canvas.width = W * ESCALA
    canvas.height = H * ESCALA
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("No se pudo preparar el lienzo del recibo")
    ctx.scale(ESCALA, ESCALA)

    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = "#000000"
    ctx.textBaseline = "alphabetic"

    const linea = (yy: number) => {
      ctx.strokeStyle = "#000000"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(PAD, yy)
      ctx.lineTo(W - PAD, yy)
      ctx.stroke()
    }

    const parLabelValor = (label: string, valor: string, yy: number) => {
      ctx.font = "bold 12.5px Helvetica, Arial, sans-serif"
      ctx.textAlign = "left"
      ctx.fillText(label, PAD, yy)
      // Se mide la etiqueta con SU fuente (negrita, mas ancha) antes de
      // cambiarla, para saber cuanto espacio queda de verdad.
      const anchoLibre = W - PAD * 2 - ctx.measureText(label).width - 8
      ctx.font = "12.5px Helvetica, Arial, sans-serif"
      ctx.textAlign = "right"
      // El ancho maximo evita que un nombre largo se monte sobre la etiqueta
      // o se salga del recibo: el navegador lo condensa para que quepa.
      ctx.fillText(valor, W - PAD, yy, Math.max(40, anchoLibre))
      ctx.textAlign = "left"
    }

    let y = PAD

    if (logoImg) {
      const lado = 64
      ctx.drawImage(logoImg, W / 2 - lado / 2, y, lado, lado)
      y += ALTO_LOGO
    }

    ctx.font = "bold 17px Helvetica, Arial, sans-serif"
    ctx.textAlign = "center"
    ctx.fillText("RECIBO DE PAGO", W / 2, y + 14)
    y += 30

    ctx.font = "12px Helvetica, Arial, sans-serif"
    ctx.fillText(`Fecha: ${fechaStr}   Hora: ${horaStr}`, W / 2, y + 10)
    y += 20

    linea(y)
    y += 14

    parLabelValor("Cliente:", nombreCompleto, y + 11)
    y += ALTO_FILA
    parLabelValor("Documento:", client.documento || "-", y + 11)
    y += ALTO_FILA

    linea(y)
    y += 14

    for (const [label, val] of rows) {
      parLabelValor(label, val, y + 11)
      y += ALTO_FILA
    }

    linea(y)
    y += 14

    ctx.font = "italic 10.5px Helvetica, Arial, sans-serif"
    ctx.textAlign = "center"
    ctx.fillStyle = "#444444"
    ctx.fillText("Este documento es un comprobante informativo.", W / 2, y + 9)

    const filename = `recibo_${client.nombre.replace(/\s+/g, "_")}_${fechaStr.replace(/\//g, "-")}.png`
    const dataUrl = canvas.toDataURL("image/png")
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo generar la imagen del recibo"))), "image/png")
    })
    return { blob, filename, dataUrl }
  }

  /**
   * "Generar recibo" del menu: abre el mismo dialogo de compartir que sale
   * tras registrar un pago, en vez de descargar el PDF directo. Funciona
   * tambien para clientes sin gestion de hoy (recibo de consulta).
   */
  /** Cierra el dialogo; si venia de registrar un pago, vuelve al listado. */
  const cerrarShare = () => {
    setShowShareDialog(false)
    setClientForShare(null)
    if (shareTrasPago) handleBack()
    setShareTrasPago(false)
  }

  const handleGenerarRecibo = (client: DisplayClient) => {
    setClientForShare(client)
    setShareTrasPago(false)
    setShowShareDialog(true)
  }

  const handleDescargarRecibo = async (client: DisplayClient) => {
    setSharingPdf(true)
    try {
      const { dataUrl, filename } = await buildReciboImagen(client, gestionDe(client))
      const a = document.createElement("a")
      a.href = dataUrl
      a.download = filename
      a.click()
    } catch (e) {
      console.error("[v0] handleDescargarRecibo error:", e)
      toast({ title: "Error", description: "No se pudo generar el recibo.", variant: "destructive" })
    } finally {
      setSharingPdf(false)
    }
  }

  /** Si el cliente ya fue gestionado hoy, devuelve esa gestion (trae el abono). */
  const gestionDe = (client: DisplayClient): ManagedClient | undefined =>
    managedToday.find((m) => m.loanId === client.loanId)

  const handleShareComprobante = async (client: DisplayClient) => {
    setSharingPdf(true)
    try {
      const { blob, dataUrl, filename } = await buildReciboImagen(client, gestionDe(client))
      const file = new File([blob], filename, { type: "image/png" })

      if (
        typeof navigator !== "undefined" &&
        navigator.share &&
        navigator.canShare &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({ files: [file], title: "Recibo de pago" })
      } else {
        // Fallback: descarga directa si Web Share API no soporta archivos
        const a = document.createElement("a")
        a.href = dataUrl
        a.download = filename
        a.click()
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

  const handleRenovationCancel = () => {
    // El cliente dijo que no quiere renovar. No hay nada que escribir: la
    // bandera `tiene_prestamo_activo` la mantiene `recalcular_prestamo` a
    // partir de si le queda algún crédito activo.
    //
    // Antes esto hacía un PATCH suelto por REST que la ponía en false sin
    // mirar los otros créditos del cliente: quien tenía dos préstamos perdía
    // la bandera al cerrar uno.
    setShowRenovationDialog(false)
    setClientForRenovation(null)
  }

  /**
   * Busca en el libro el evento de HOY de este cliente.
   *
   * Antes esto resolvía una fila de `payment_plan` por fecha y estado, y con
   * varias filas del mismo día (la cuota + una línea extra) podía devolver la
   * equivocada. Un evento es una unidad: no hay ambigüedad.
   */
  const resolveGestionHoy = async (m: ManagedClient): Promise<Gestion | null> => {
    try {
      const supabase = await getSupabaseSafe()
      const { data } = await supabase
        .from("gestiones")
        .select("id, loan_id, tipo, monto, fecha_gestion, cuota_objetivo, num_cuotas, metodo_pago")
        .eq("loan_id", m.loanId)
        .eq("fecha_gestion", todayColombia())
        .eq("estado", "aplicada")
        .in("tipo", ["pago", "no_pago", "cancelacion"])
        .order("fecha_hora", { ascending: false })
        .limit(1)
        .maybeSingle()
      return (data as unknown as Gestion) ?? null
    } catch (_e) {
      return null
    }
  }

  /**
   * Corregir el monto de una gestión de hoy = anular la anterior y registrar
   * la corregida. El evento original nunca se modifica: queda en el historial
   * junto con su anulación, así que la Auditoría 360 puede mostrar qué se
   * cambió, cuándo y por quién.
   */
  const handleEditManagedSave = async () => {
    if (!editingManaged) return
    const newMonto = Number.parseFloat(editMonto)
    if (isNaN(newMonto) || newMonto <= 0) return
    const m = editingManaged
    setSavingManaged(true)
    try {
      const original = await resolveGestionHoy(m)
      if (!original) throw new Error("No se encontró la gestión de hoy de este cliente")

      const idReversa = nuevaGestionId()
      await enviarOEncolar({
        tipo: "gestion",
        id: idReversa,
        descripcion: `Corrección — ${m.nombre}`,
        payload: {
          id: idReversa,
          tipo: "reversa",
          loan_id: m.loanId,
          client_id: m.clientId,
          referencia_gestion_id: original.id,
          fecha_gestion: todayColombia(),
          fecha_hora: ahoraColombiaISO(),
          cliente_nombre: m.nombre,
          observacion: "Corrección del monto desde el módulo de pagos",
        },
      })

      const idNuevo = nuevaGestionId()
      await enviarOEncolar({
        tipo: "gestion",
        id: idNuevo,
        descripcion: `Pago corregido — ${m.nombre} ($${newMonto.toLocaleString()})`,
        payload: {
          id: idNuevo,
          tipo: "pago",
          loan_id: m.loanId,
          client_id: m.clientId,
          monto: newMonto,
          num_cuotas: original.num_cuotas ?? 1,
          fecha_gestion: todayColombia(),
          fecha_hora: ahoraColombiaISO(),
          cuota_objetivo: original.cuota_objetivo,
          metodo_pago: original.metodo_pago,
          cliente_nombre: m.nombre,
          observacion: "Monto corregido desde el módulo de pagos",
        },
      })

      setEditingManaged(null)
      setManagedToday((prev) =>
        prev.map((x) => (x.loanId === m.loanId ? { ...x, valorAbonado: newMonto } : x)),
      )
      toast({ title: "Pago corregido", description: `Monto actualizado a $${newMonto.toLocaleString()}` })
      void fetchData({ silent: true })
    } catch (e) {
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : "No se pudo corregir el pago",
        variant: "destructive",
      })
    } finally {
      setSavingManaged(false)
    }
  }

  /**
   * Anular la gestión de hoy: se registra un evento de REVERSA que la
   * compensa. Nada se borra — el historial conserva el pago y su anulación.
   */
  const handleDeleteManagedPayment = async (m: ManagedClient) => {
    setSavingManaged(true)
    try {
      const original = await resolveGestionHoy(m)
      if (!original) throw new Error("No se encontró la gestión de hoy de este cliente")

      const idReversa = nuevaGestionId()
      const { resultado } = await enviarOEncolar({
        tipo: "gestion",
        id: idReversa,
        descripcion: `Anulación — ${m.nombre}`,
        payload: {
          id: idReversa,
          tipo: "reversa",
          loan_id: m.loanId,
          client_id: m.clientId,
          referencia_gestion_id: original.id,
          fecha_gestion: todayColombia(),
          fecha_hora: ahoraColombiaISO(),
          cliente_nombre: m.nombre,
          observacion: "Gestión anulada desde el módulo de pagos",
        },
      })

      if (resultado?.enviado_a_revision || resultado?.estado_gestion === "en_revision") {
        toast({
          title: "Anulación enviada a revisión",
          description: String(resultado.motivo ?? "Secretaría debe autorizarla."),
        })
        void fetchData({ silent: true })
        return
      }

      const nuevoSaldo = Number(resultado?.nuevo_saldo ?? m.saldo + m.valorAbonado)

      // Optimistic UI: mover de managed → pending sin esperar refetch.
      // ManagedClient extiende DisplayClient, asi que el spread es seguro.
      const restored: DisplayClient = {
        loanId: m.loanId,
        clientId: m.clientId,
        nombre: m.nombre,
        documento: m.documento,
        fechaVenta: m.fechaVenta,
        valorVenta: m.valorVenta,
        valorCuota: m.valorCuota,
        saldo: nuevoSaldo,
        cuotasPagadas: Math.max(0, m.cuotasPagadas - 1),
        cuotasTotales: m.cuotasTotales,
        cuotasExtra: m.cuotasExtra,
        // Al revertir vuelve a existir al menos una pendiente; el refetch
        // silencioso de abajo corrige el valor exacto.
        esUltimaCuotaPendiente: m.esUltimaCuotaPendiente,
        mora: m.mora,
        ultimoPago: m.ultimoPago,
        ultimoPagoFecha: m.ultimoPagoFecha,
        frecuenciaPago: m.frecuenciaPago,
        tipoAmortizacion: m.tipoAmortizacion,
        tasaInteres: m.tasaInteres,
        nextPaymentId: original.cuota_objetivo ?? m.nextPaymentId,
        nextPaymentCuota: m.nextPaymentCuota,
        nextPaymentNumero: m.nextPaymentNumero,
        nextPaymentCapital: m.nextPaymentCapital,
        nextPaymentValorCuota: m.nextPaymentValorCuota,
        nextPaymentEsFuturo: false,
        nextPaymentFecha: m.nextPaymentFecha,
        valorPrestamo: m.valorPrestamo,
        multaPendiente: m.multaPendiente,
        ordenvisita: m.ordenvisita,
        diaSemana: m.diaSemana,
        clienteLatitud: m.clienteLatitud,
        clienteLongitud: m.clienteLongitud,
        cuotaVencidaId: m.cuotaVencidaId,
        cuotaVencidaFecha: m.cuotaVencidaFecha,
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
      toast({ title: "Gestión anulada", description: `${m.nombre} volvió a la lista de pendientes` })
    } catch (e) {
      console.error("[v0] handleDeleteManagedPayment error:", e)
      toast({
        title: "Error",
        description: e instanceof Error ? e.message : "No se pudo anular la gestión",
        variant: "destructive",
      })
    } finally {
      setSavingManaged(false)
    }
  }

  // Colores de la lista de cobro. La escala vive en lib/gestion-core.ts para
  // que todas las pantallas usen los mismos cortes.
  const getMoraColor = (mora: number) => {
    const banda = colorMora(mora)
    if (banda === "verde") return "text-green-700 bg-green-100"
    if (banda === "amarillo") return "text-yellow-700 bg-yellow-100"
    return "text-red-700 bg-red-100"
  }

  // Iniciar ruta del dia. Es idempotente: si ya existe la fila en rutas_diarias
  // (porque otro flujo, otra pestana o Resumen del Dia ya la creo) recupera el
  // estado real con SELECT y sincroniza el guard, en vez de fallar al usuario.
  const handleIniciarRutaInline = async () => {
    if (iniciandoRuta) return
    // Abrir la jornada SI necesita servidor: es la fila que despues consultan
    // el cierre de caja y el monitoreo del admin, y encolarla dejaria a dos
    // dispositivos creyendo cada uno que abrio la ruta. Lo que si funciona
    // sin señal es SEGUIR trabajando una ruta ya abierta: el estado queda
    // guardado en el dispositivo.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      toast({
        title: "Sin conexión",
        description: "Para iniciar la ruta necesitas señal. Si ya la habías iniciado hoy, vuelve a abrir la app con señal una vez y podrás seguir trabajando sin conexión.",
        variant: "destructive",
      })
      return
    }
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
      {datosDesdeCache && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold leading-tight">Trabajando sin conexión</p>
            <p className="mt-0.5 text-xs text-amber-700">
              Estás viendo los datos guardados en el teléfono desde las{" "}
              {new Date(datosDesdeCache).toLocaleTimeString("es-CO", {
                timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit",
              })}
              . Puede haber gestiones de otros cobradores que aún no ves. Lo que
              registres se enviará solo cuando vuelva la señal.
            </p>
          </div>
        </div>
      )}

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

            {/* Avance de la ruta.
                Antes, para saber cuanto llevaba recaudado y cuantos clientes
                le faltaban, el cobrador tenia que salirse a Resumen del Dia y
                volver. Esto se lo deja a la vista sin dejar la pantalla. */}
            {(() => {
              const gestionados = managedToday.length
              const total = gestionados + displayClients.length
              if (total === 0) return null
              const recaudado = managedToday.reduce((s, m) => s + (m.valorAbonado || 0), 0)
              const pct = Math.round((gestionados / total) * 100)
              return (
                <div className="px-1 pb-2 space-y-1">
                  <div className="flex items-baseline justify-between text-[11px] md:text-xs">
                    <span className="text-muted-foreground">
                      <strong className="text-foreground">{gestionados}</strong> de {total} gestionados
                    </span>
                    <span className="font-semibold tabular-nums">
                      ${recaudado.toLocaleString("es-CO")}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-green-500 transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })()}

            {/* Buscador.
                Va DENTRO de la cabecera fija a proposito. Estaba dentro del
                panel, debajo de todo esto, y como la cabecera es `sticky` con
                fondo opaco, apenas el cobrador hacia scroll para ver la lista
                la cabecera se le montaba encima: el campo quedaba tapado y el
                toque se lo comia la cabecera. Aca queda siempre a la mano,
                que es justo para lo que sirve buscar en una lista larga. */}
            {activeTab === "pendientes" && (
              <Input
                placeholder="Buscar cliente por nombre o documento..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="mt-2 h-8 md:h-10 text-[12px] md:text-sm md:max-w-sm"
              />
            )}

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
                                onClick={() => {
                                  if (gpsStatus !== "granted") {
                                    handleLocationRequired()
                                    return
                                  }
                                  setAgregarCuotaSiDebeNoPago(true)
                                  setNoPaymentClient(client)
                                }}
                                disabled={canManage === false && gpsStatus === "granted"}
                                title={
                                  gpsStatus !== "granted"
                                    ? "Debes habilitar la ubicacion para registrar no pagos"
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
                                    : !canManage
                                    ? "No es el dia de pago de este cliente"
                                    : client.nextPaymentEsFuturo
                                    ? `Adelantar la cuota del ${client.nextPaymentFecha.split("-").reverse().slice(0, 2).join("/")}`
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
                                    siguiente cae despues de hoy). El cliente
                                    esta al dia; cobrarle hoy es ADELANTAR esa
                                    cuota. El badge dice de cuando es la cuota
                                    que se estaria adelantando — no bloquea. */}
                                {client.nextPaymentEsFuturo && (
                                  <span className="text-[9px] md:text-xs px-1.5 py-0.5 rounded font-semibold bg-info text-info-foreground">
                                    {(() => {
                                      const [, mm, dd] = client.nextPaymentFecha.split("-")
                                      return `Próx. pago ${dd}/${mm}`
                                    })()}
                                  </span>
                                )}
                              </div>
                              {/* Mora en CUOTAS vencidas sin cubrir. Se venía
                                  mostrando como "3d mora", que se leía como
                                  días y no lo era. */}
                              <div className={`inline-flex items-center justify-center w-fit px-1.5 py-0.5 rounded text-[10px] md:text-sm font-semibold ${getMoraColor(client.mora)}`}>
                                {client.mora > 0 ? `${etiquetaMora(client.mora)} en mora` : "al día"}
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
                                  {client.cuotasExtra > 0 && (
                                    <span className="text-amber-700"> +{client.cuotasExtra} extra</span>
                                  )}
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
                                {client.multaPendiente && (
                                  <span className="whitespace-nowrap text-right">
                                    Multa{" "}
                                    <strong className="text-red-600 tabular-nums">
                                      ${client.multaPendiente.valor.toLocaleString()}
                                    </strong>
                                  </span>
                                )}
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
                            {/* ANULAR, no eliminar: nada se borra. Queda el
                                evento original y su anulación en el historial,
                                y el cliente vuelve a Pendientes para
                                gestionarlo bien. */}
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Anular esta gestión"
                              aria-label="Anular esta gestión"
                              className="h-6 w-6 text-destructive hover:text-destructive/80 hover:bg-destructive-light"
                              onClick={() => setAnularManaged(m)}
                              disabled={savingManaged}
                            >
                              <RotateCcw className="h-3 w-3" />
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
            {renderAvisoGeocerca()}
            {/* Alerta: última cuota programada de préstamo americano */}
            {selectedClient.tipoAmortizacion?.toLowerCase().trim() === "americano" &&
              selectedClient.esUltimaCuotaPendiente && (
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

            {/* Multa pendiente: valor y origen (fallas que la generaron).
                Informativo — se muestra siempre que exista, independientemente
                de si el checkbox "Pagar multa" de abajo está marcado. */}
            {selectedClient.multaPendiente && (
              <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-1.5">
                <span className="text-[11px] md:text-sm text-red-700">
                  Multa por fallas
                  {selectedClient.multaPendiente.cuotasMora != null
                    ? ` — generada por ${selectedClient.multaPendiente.cuotasMora} falla${selectedClient.multaPendiente.cuotasMora !== 1 ? "s" : ""}`
                    : ""}
                </span>
                <span className="text-xs md:text-sm font-bold text-red-700 shrink-0">
                  ${selectedClient.multaPendiente.valor.toLocaleString("es-CO")}
                </span>
              </div>
            )}

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
                  selectedClient.esUltimaCuotaPendiente && (
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
                {/* Checkbox "Pagar multa": solo visible si el cliente tiene
                    una multa pendiente por mora. Al marcarse, la multa se
                    cobra junto con el pago (se marca pagada + ingreso en
                    los movimientos de la ruta). */}
                {selectedClient?.multaPendiente && (
                  <div className="flex items-center space-x-1.5">
                    <Checkbox
                      id="pagarMulta"
                      checked={pagarMulta}
                      onCheckedChange={(c) => setPagarMulta(c as boolean)}
                      className="h-4 w-4 border-2 border-red-400"
                    />
                    <Label htmlFor="pagarMulta" className="text-[11px] md:text-sm font-normal cursor-pointer whitespace-nowrap text-red-700">
                      Pagar multa (${selectedClient.multaPendiente.valor.toLocaleString("es-CO")})
                    </Label>
                  </div>
                )}
                {/* Checkbox "Agregar cuota adicional si el cliente aun debe":
                    solo visible cuando la cuota actual es la ULTIMA del plan
                    de pagos (cualquier tipo de amortizacion). Se excluye si
                    ya se esta usando "Extender Cuotas" (americano) o si se
                    va a cancelar el prestamo por completo, para no mezclar
                    con esos flujos. */}
                {selectedClient &&
                  selectedClient.esUltimaCuotaPendiente &&
                  !extenderCuotas &&
                  !isCancelada && (
                    <div className="flex items-center space-x-1.5">
                      <Checkbox
                        id="agregarCuotaSiDebe"
                        checked={agregarCuotaSiDebe}
                        onCheckedChange={(c) => setAgregarCuotaSiDebe(c as boolean)}
                        className="h-4 w-4 border-2 border-amber-400"
                      />
                      <Label htmlFor="agregarCuotaSiDebe" className="text-[11px] md:text-sm font-normal cursor-pointer whitespace-nowrap text-amber-700">
                        Agregar cuota adicional si aún debe (última cuota)
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

            {/* Total a cobrar cuando se paga tambien la multa */}
            {pagarMulta && selectedClient?.multaPendiente && (
              <p className="text-[11px] md:text-sm font-semibold text-red-700 bg-red-50 rounded-lg px-3 py-1.5">
                Total a cobrar: ${((Number.parseFloat(paymentAmount) || 0) + selectedClient.multaPendiente.valor).toLocaleString("es-CO")} (pago + multa)
              </p>
            )}

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
              {/* El monto va EN el boton: es lo ultimo que ve el cobrador
                  antes de confirmar y evita cobrar una cifra distinta a la
                  que acordo con el cliente. Incluye la multa si la va a
                  cobrar en el mismo movimiento. */}
              <Button className="flex-1 h-8 md:h-10 text-xs md:text-base bg-green-600 hover:bg-green-700 text-white" onClick={handleRegisterPayment} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                {(() => {
                  const base = Number.parseFloat(paymentAmount) || 0
                  const conMulta = base + (pagarMulta && selectedClient?.multaPendiente ? selectedClient.multaPendiente.valor : 0)
                  if (conMulta <= 0) return extenderCuotas ? "Registrar y extender plazo" : "Registrar pago"
                  const monto = `$${conMulta.toLocaleString("es-CO")}`
                  return extenderCuotas ? `Cobrar ${monto} y extender` : `Cobrar ${monto}`
                })()}
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
            {renderAvisoGeocerca()}
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

            {/* Solo visible cuando la cuota actual es la ULTIMA del plan de
                pagos: si el cliente aun debe tras este no-pago, agrega una
                cuota adicional en vez de dejar el prestamo sin fechas. */}
            {noPaymentClient && noPaymentClient.esUltimaCuotaPendiente && (
              <div className="flex items-center space-x-1.5">
                <Checkbox
                  id="agregarCuotaSiDebeNoPago"
                  checked={agregarCuotaSiDebeNoPago}
                  onCheckedChange={(c) => setAgregarCuotaSiDebeNoPago(c as boolean)}
                  className="h-4 w-4 border-2 border-amber-400"
                />
                <Label htmlFor="agregarCuotaSiDebeNoPago" className="text-[11px] md:text-sm font-normal cursor-pointer text-amber-700">
                  Agregar cuota adicional si aún debe (última cuota)
                </Label>
              </div>
            )}

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

      {/* Dialog de confirmacion: el abono supera el umbral de la ruta */}
      <Dialog open={showRevisionDialog} onOpenChange={(open) => { if (!open) handleRevisionChoice(false) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-amber-100 mx-auto mb-2">
              <AlertCircle className="h-6 w-6 text-amber-600" />
            </div>
            <DialogTitle className="text-sm md:text-lg text-center">Abono supera el umbral de la ruta</DialogTitle>
            <DialogDescription className="text-xs md:text-sm text-center">
              {MENSAJE_REVISION}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 md:gap-3 pt-2 md:pt-4">
            <Button variant="outline" onClick={() => handleRevisionChoice(false)} className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent">Cancelar</Button>
            <Button onClick={() => handleRevisionChoice(true)} className="flex-1 h-8 md:h-10 text-xs md:text-base">Continuar</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: el cobrador esta fuera del rango del cliente */}
      <Dialog open={!!geocercaBloqueo} onOpenChange={(open) => { if (!open) handleGeocercaChoice(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mx-auto mb-2">
              <MapPinOff className="h-6 w-6 text-red-600" />
            </div>
            <DialogTitle className="text-sm md:text-lg text-center">Estás fuera del rango del cliente</DialogTitle>
            <DialogDescription className="text-xs md:text-sm text-center">
              Estás a <strong>{geocercaBloqueo ? formatearDistancia(geocercaBloqueo.distancia) : ""}</strong> de donde
              quedó ubicado <strong>{geocercaBloqueo?.nombre}</strong>, y el máximo permitido en esta ruta es de{" "}
              {geocercaBloqueo?.radio} m. Si aun así necesitas registrar la gestión, escribe por qué.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="geocerca-motivo" className="text-xs md:text-sm">Motivo</Label>
            <Textarea
              id="geocerca-motivo"
              placeholder="Ej: el cliente se trasladó de local, o me pagó en otro punto"
              value={geocercaMotivo}
              onChange={(e) => setGeocercaMotivo(e.target.value)}
              className="min-h-[70px] text-xs md:text-sm"
            />
            <p className="text-[11px] md:text-xs text-muted-foreground">
              Queda registrado junto con la distancia real para que secretaría lo revise.
            </p>
          </div>
          <div className="flex gap-2 md:gap-3 pt-2">
            <Button variant="outline" onClick={() => handleGeocercaChoice(null)} className="flex-1 h-8 md:h-10 text-xs md:text-base bg-transparent">
              Cancelar
            </Button>
            <Button
              onClick={() => handleGeocercaChoice(geocercaMotivo.trim())}
              disabled={geocercaMotivo.trim().length < 10}
              className="flex-1 h-8 md:h-10 text-xs md:text-base"
            >
              Continuar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog: elegir a que fecha se asocia un pago/no-pago con atraso */}
      <Dialog open={!!fechaChoiceInfo} onOpenChange={(open) => { if (!open) handleFechaChoice(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-12 w-12 rounded-full bg-amber-100 mx-auto mb-2">
              <AlertCircle className="h-6 w-6 text-amber-600" />
            </div>
            <DialogTitle className="text-sm md:text-lg text-center">Quedó un día sin gestionar</DialogTitle>
            <DialogDescription className="text-xs md:text-sm text-center">
              La cuota del <strong>{fechaChoiceInfo?.fechaOriginal}</strong> no tiene pago ni no pago registrado.
              ¿Para qué día registro esta gestión?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 pt-2 md:pt-4">
            <Button variant="outline" onClick={() => handleFechaChoice("pendiente")} className="h-auto py-2 text-xs md:text-sm whitespace-normal">
              Aplicar al {fechaChoiceInfo?.fechaOriginal} — queda en los registros de ese día y el cliente sigue disponible para gestionar hoy
            </Button>
            <Button onClick={() => handleFechaChoice("hoy")} className="h-auto py-2 text-xs md:text-sm whitespace-normal">
              Registrar para hoy ({fechaChoiceInfo?.fechaHoy}) — la cuota del {fechaChoiceInfo?.fechaOriginal} seguirá pendiente
            </Button>
            <Button variant="ghost" onClick={() => handleFechaChoice(null)} className="h-8 text-xs md:text-sm">
              Cancelar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Anular una gestión del día */}
      <Dialog open={!!anularManaged} onOpenChange={(o) => { if (!o) setAnularManaged(null) }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Anular la gestión de hoy</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {anularManaged && (
                <>
                  {anularManaged.gestionTipo === "pago"
                    ? `Se anulará el pago de $${(anularManaged.valorAbonado ?? 0).toLocaleString()} de ${anularManaged.nombre}.`
                    : `Se anulará el no pago de ${anularManaged.nombre}.`}
                  {" "}El cliente vuelve a la lista de pendientes para gestionarlo de nuevo.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <p className="text-[11px] md:text-xs text-muted-foreground">
            Nada se borra: en el historial del cliente quedan la gestión y su anulación,
            con la hora y quién la hizo.
          </p>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="flex-1 h-8 md:h-10 text-xs md:text-base"
              onClick={() => setAnularManaged(null)}
              disabled={savingManaged}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              className="flex-1 h-8 md:h-10 text-xs md:text-base"
              disabled={savingManaged}
              onClick={async () => {
                const m = anularManaged
                setAnularManaged(null)
                if (m) await handleDeleteManagedPayment(m)
              }}
            >
              {savingManaged ? <Loader2 className="h-4 w-4 animate-spin" /> : "Anular"}
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
              {paymentHistoryClient?.nombre} — días con pago o no pago registrado
            </DialogDescription>
          </DialogHeader>
          {paymentHistoryLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : paymentHistoryRows.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Sin registros.</p>
          ) : (
            <div className="overflow-auto max-h-[60vh] space-y-3">
              {(() => {
                // El historial se agrupa POR DIA de negocio, lo mas reciente
                // primero. Cada fila es un EVENTO del libro, asi que un abono
                // de tres cuotas es una sola linea y no tres.
                const gestionadas = paymentHistoryRows

                const porDia = new Map<string, typeof gestionadas>()
                for (const r of gestionadas) {
                  const dia = (r.fecha_pago_real ?? "").split("T")[0] || r.fecha_pago
                  if (!porDia.has(dia)) porDia.set(dia, [])
                  porDia.get(dia)!.push(r)
                }
                const dias = [...porDia.entries()].sort((a, b) => b[0].localeCompare(a[0]))

                const fechaLarga = (iso: string) => {
                  const [yy, mm, dd] = iso.split("-")
                  return dd && mm && yy ? `${dd}/${mm}/${yy}` : iso
                }
                const estadoLabel: Record<string, string> = {
                  pagado: "Pagado", no_pago: "No pago", pendiente: "Pendiente",
                  parcial: "Parcial", cancelada: "Cancelada",
                }

                return (
                  <>
                    {dias.map(([dia, filas]) => {
                      const totalDia = filas.reduce((acc, r) => acc + (Number(r.monto_pagado) || 0), 0)
                      return (
                        <div key={dia} className="rounded-lg border overflow-hidden">
                          <div className="flex items-center justify-between bg-muted px-3 py-1.5">
                            <span className="text-[11px] md:text-sm font-semibold">{fechaLarga(dia)}</span>
                            <span className="text-[11px] md:text-sm font-bold tabular-nums">
                              {totalDia > 0 ? `$${Math.round(totalDia).toLocaleString("es-CO")}` : "Sin abono"}
                            </span>
                          </div>
                          <div className="divide-y">
                            {filas.map((r) => {
                              const isNoPago = r.estado === "no_pago"
                              return (
                                <div
                                  key={r.id}
                                  className={`flex items-center justify-between gap-2 px-3 py-1.5 ${isNoPago ? "bg-red-50 dark:bg-red-950/30" : ""}`}
                                >
                                  <span className={`text-[10px] md:text-xs ${isNoPago ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
                                    Cuota {r.numero_cuota} · {estadoLabel[r.estado] ?? r.estado}
                                  </span>
                                  <span className={`text-[10px] md:text-xs font-medium tabular-nums ${isNoPago ? "text-red-600 dark:text-red-400" : ""}`}>
                                    {Number(r.monto_pagado) > 0
                                      ? `$${Math.round(Number(r.monto_pagado)).toLocaleString("es-CO")}`
                                      : "—"}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </>
                )
              })()}
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
      <Dialog open={showShareDialog} onOpenChange={(open) => { if (!open) cerrarShare() }}>
        <DialogContent className="p-4 md:p-6 max-w-[90vw] md:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm md:text-lg">Comprobante de {clientForShare?.nombre}</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {shareTrasPago
                ? "El pago fue registrado. ¿Deseas compartir el comprobante?"
                : "Puedes compartirlo por WhatsApp, correo o cualquier app del teléfono, o descargarlo."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 pt-2 md:pt-4">
            <Button
              className="h-9 md:h-10 text-xs md:text-base gap-1.5"
              disabled={sharingPdf}
              onClick={async () => {
                if (!clientForShare) return
                await handleShareComprobante(clientForShare)
                cerrarShare()
              }}
            >
              {sharingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              Compartir
            </Button>
            <Button
              variant="outline"
              className="h-9 md:h-10 text-xs md:text-base gap-1.5"
              disabled={sharingPdf}
              onClick={async () => {
                if (!clientForShare) return
                await handleDescargarRecibo(clientForShare)
                cerrarShare()
              }}
            >
              <FileDown className="h-4 w-4" />
              Descargar
            </Button>
            <Button
              variant="ghost"
              className="h-8 text-xs md:text-sm"
              disabled={sharingPdf}
              onClick={cerrarShare}
            >
              Cerrar
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
