"use client"

import type React from "react"
import { Fragment, useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DollarSign, X, Check, Eye, Clock, ArrowLeftRight, Camera, Edit, FileText, History, User, MoreVertical, Receipt, Loader2, GripVertical, ArrowUp, ArrowDown, CheckCircle2, XCircle, Users, Pencil, Trash2, RefreshCw, ShoppingCart, MapPinOff, MapPin, AlertCircle, Play, Share2, FileDown, ChevronUp, ChevronDown } from "lucide-react"
import { RutaNoIniciada } from "@/components/views/ruta-no-iniciada"
import { leerAplazados, aplazar, quitarAplazado } from "@/lib/aplazados"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
// `createClient` ya no se importa directamente: toda interaccion con
  // Supabase: RLS eliminado. `getSupabaseSafe` y `callRpcAtomic` se conservan
  // como atajos delgados sobre `createClient()`.
import { getSupabaseSafe, getSessionIdentity } from "@/lib/api-helper"
import { abriendoAlgoDelSistema } from "@/lib/pin-lock"
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
  montoEfectivo,
  type Gestion,
} from "@/lib/gestion-core"
import { getRutaUmbrales, excedeUmbral, MENSAJE_REVISION, type RutaUmbrales } from "@/lib/ruta-umbrales"
import { obtenerUbicacion, evaluarGeocerca, formatearDistancia, type ResultadoGeocerca, type UbicacionMedida } from "@/lib/geo"
import { useEstadoGps } from "@/lib/use-gps"

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
  /** Como lo llama el cobrador: el apodo si lo tiene, si no el nombre real.
   *  Es lo que va en el recibo, los dialogos y el buscador — NO se le pega el
   *  otro dato encima, o se propagaria a todos esos sitios. */
  nombre: string
  /** El apodo, ya limpio. null si no tiene o si es igual al nombre real. */
  apodo: string | null
  /** El nombre real, SIN el apodo incrustado. Ver `sinApodo`. */
  nombreCompleto: string
  documento: string
  valorVenta: number
  /**
   * Lo que el cliente termina pagando: capital + intereses. Sale de
   * `v_loan_financiero.total_a_pagar`, la misma cuenta de la que sale el
   * saldo, así que no puede discrepar con él.
   *
   * Es distinto de `valorVenta`, que es el capital prestado a secas. Los dos
   * hacen falta en el extracto: uno dice cuánto se le prestó y el otro cuánto
   * va a devolver.
   */
  totalAPagar: number
  /** Lo que lleva pagado del crédito entero (`total_pagado`). */
  abonado: number
  valorCuota: number
  saldo: number
  // Conteos sobre las cuotas BASE del plan (excluyen cuotas extra de
  // extensiones/prorrogas/pagos de hoy). `cuotasExtra` cuenta esas aparte.
  //
  // OJO: en ESTE modulo `cuotasExtra` ya no se muestra en ningun lado — ni en
  // la lista de cobro ni en el recibo. Se conserva porque es parte de la foto
  // financiera del prestamo y lo consumen las pantallas de revision
  // (Auditoria 360 y Control Total), que lo leen de la vista, no de aqui.
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

/**
 * Quita el apodo de adentro del nombre completo.
 *
 * En muchos registros el apodo (el oficio o el negocio) quedó guardado TAMBIÉN
 * dentro de `nombre_completo`: "EDUARDO MECANICO RODRIGUEZ" con apodo
 * "MECANICO". Mostrar los dos tal cual daría "MECANICO · EDUARDO MECANICO
 * RODRIGUEZ", que es justo el ruido que hace ilegible la lista al sol.
 *
 * Dos salvaguardas para no dejar a nadie sin nombre: si el apodo ES el nombre
 * completo no hay nada que quitar, y si al quitarlo queda una sola palabra se
 * prefiere el original. Ver scripts/diagnostico-nombres-clientes.sql para
 * limpiar el dato de raíz.
 *
 * Vivía dentro de `handleGenerarRecibo`. Salió acá cuando la lista de cobro
 * empezó a mostrar los dos nombres: si el recibo y la lista limpiaran distinto,
 * el papel y la pantalla dirían cosas distintas del mismo cliente.
 */
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

const frecuenciaLabel = (freq: string) => {
  switch (freq) {
    case "daily": return "Diario"
    case "weekly": return "Semanal"
    case "biweekly": return "Quincenal"
    case "monthly": return "Mensual"
    default: return freq
  }
}

// Get current day of week in Spanish (Colombia timezone)
const getTodayDayName = () => {
  const days = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"]
  const now = new Date()
  const colombiaDate = new Date(now.toLocaleString("en-US", { timeZone: "America/Bogota" }))
  return days[colombiaDate.getDay()]
}

// Check if the payment day matches today
/**
 * ¿Es un iPhone o un iPad?
 *
 * Se usa SOLO para escribir las instrucciones correctas cuando el permiso de
 * ubicación está negado: en iOS no alcanza con volver a pedirlo —Safari no
 * vuelve a preguntar una vez que se dijo que no— y hay que ir a Ajustes. Sin
 * decírselo, el cobrador toca "Solicitar permiso" una y otra vez sin que pase
 * nada.
 *
 * El iPad moderno se identifica como Mac, por eso el segundo chequeo.
 */
const esIOS = () => {
  if (typeof navigator === "undefined") return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

const isPaymentDayToday = (diaSemana: string | null) => {
  if (!diaSemana) return false
  const today = getTodayDayName()
  return diaSemana.toLowerCase() === today
}

/**
 * Una gestión con el lugar donde ocurrió.
 *
 * `Gestion` (gestion-core) no trae coordenadas porque casi nadie las necesita.
 * Acá sí: una corrección tiene que poder repetir el lugar del evento que
 * corrige, o el servidor la toma por una visita sin prueba.
 */
type GestionConUbicacion = Gestion & {
  referencia_gestion_id: string | null
  latitud: number | null
  longitud: number | null
  geocerca_estado: string | null
  geocerca_motivo: string | null
}

type ManagedClient = DisplayClient & {
  /**
   * Qué pasó hoy con este cliente.
   *
   * `aplazado` NO sale del libro de eventos —no hay gestión que lo respalde—:
   * es la marca del teléfono (`lib/aplazados.ts`) convertida en una fila más
   * de esta lista. Se hace así para que el cobrador vea al que dejó pendiente
   * EN SU SITIO de la ruta, entre los que ya resolvió, y no en un apartado al
   * final por el que hay que bajar cinco pantallas.
   */
  gestionTipo: "pago" | "no_pago" | "aplazado"
  gestionHora: string
  /** Suma de lo cobrado HOY en este prestamo, no el monto de una sola cuota. */
  valorAbonado: number
  /** Cuantas cuotas cubrio el cobro de hoy. Se imprime en el recibo. */
  cuotasAbonadas: number
  /**
   * Con qué pagó hoy. `null` en un no pago.
   *
   * Existe para poder marcar las transferencias EN LA LISTA. Un cobrador que
   * cuadra su bolsillo al final del día necesita separar lo que recibió en
   * billetes de lo que le entró a la cuenta, y hasta ahora las dos cosas se
   * veían igual: "Pago $20.000".
   */
  metodoPago: "efectivo" | "transferencia" | "mixto" | null
  paymentPlanId?: string
}

// La obtencion de la posicion vive en lib/geo.ts porque Nueva Venta tambien
// la necesita (para dejar la ubicacion de referencia del cliente) y ahi mismo
// esta la regla de la geocerca.

export function RegisterPayment({ onViewChange, currentRutaId = 1, rutaPais = "", rutaActivaEstado, rutaActivaResolved = true, onRouteStateChange }: RegisterPaymentProps) {
  const { toast } = useToast()

  // ── Managed-today state (loaded from Supabase payment_plan) ──
  const [managedToday, setManagedToday] = useState<ManagedClient[]>([])
  // "pendientes" es la pestaña de la RUTA (así se llama por dentro desde
  // siempre; en pantalla dice "Ruta"). "aplazados" es la de los que quedaron
  // para después, que en pantalla dice "Pendientes".
  const TAB_ORDER: Array<"pendientes" | "aplazados" | "gestionados" | "ventas"> =
    ["pendientes", "aplazados", "gestionados", "ventas"]
  const [activeTab, setActiveTab] = useState<"pendientes" | "aplazados" | "gestionados" | "ventas">("pendientes")

  /**
   * Los que hoy quedaron PARA DESPUÉS. Ni pago ni no pago: no pasó nada
   * todavía y hay que volver. Ver `lib/aplazados.ts`.
   */
  // `loanId → hora`. La hora se muestra en la tarjeta de Gestionados, donde
  // todas las demás la llevan.
  const [aplazados, setAplazados] = useState<Map<string, string>>(new Map())
  useEffect(() => { setAplazados(leerAplazados(currentRutaId)) }, [currentRutaId])

  /**
   * DE GESTIONADO A PENDIENTE.
   *
   * Es "me equivoqué, este quedó a medias": se anula la gestión —con su
   * reversa, como manda el libro— y el cliente queda marcado para volver a
   * visitarlo. Sin esto había que anular, buscarlo otra vez en la ruta y
   * aplazarlo: tres pasos para deshacer uno.
   *
   * El orden importa. Primero la anulación, que es la que puede fallar (red,
   * revisión de secretaría); la marca de aplazado se pone solo si el servidor
   * aceptó. Al revés, un cliente con la gestión intacta aparecería además en
   * Pendientes.
   */
  const gestionadoAPendiente = async (m: ManagedClient) => {
    await handleDeleteManagedPayment(m)
    setAplazados(new Map(aplazar(currentRutaId, m.loanId)))
  }

  const marcarAplazado = (client: DisplayClient) => {
    setAplazados(new Map(aplazar(currentRutaId, client.loanId)))
    toast({
      title: "Queda pendiente",
      description: `${client.nombre} pasó a la pestaña Pendientes para volver a visitarlo.`,
    })
  }

  const devolverALaRuta = (client: DisplayClient) => {
    setAplazados(new Map(quitarAplazado(currentRutaId, client.loanId)))
    toast({ title: "Vuelve a la ruta", description: `${client.nombre} salió de Pendientes.` })
  }
  // Conteo de ventas registradas HOY en la ruta. Lo recibimos via callback
  // desde `<SalesTodayList>` para evitar duplicar la query y mostrarlo en
  // el badge del tab "Ventas del día" (mismo patron que Pendientes y
  // Gestionados que usan `displayClients.length` / `gestionados.length`).
  const [salesTodayCount, setSalesTodayCount] = useState(0)

  const [editingManaged, setEditingManaged] = useState<ManagedClient | null>(null)
  const [editMonto, setEditMonto] = useState("")
  /** A que se quiere convertir la gestion abierta en el editor. */
  const [editTipo, setEditTipo] = useState<"pago" | "no_pago">("pago")
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
    } catch (err) {
      // Se distingue el permiso negado de que el chip no enganche: son dos
      // problemas distintos y se arreglan de forma distinta. Con un solo
      // mensaje —"activa el GPS"— el cobrador que ya lo tenia activado se
      // quedaba mirando la pantalla sin saber que hacer.
      const negado = err instanceof Error && err.message === "GPS_DENIED"
      toast({
        title: negado ? "Sin permiso de ubicación" : "No se pudo leer la ubicación",
        description: negado
          ? `Este teléfono tiene bloqueada la ubicación para la app. Hay que habilitarla en la configuración del sistema para registrar ${accion}.`
          : `El teléfono no logró ubicarse. Salí a un lugar más despejado y volvé a intentar; si estás bajo techo puede tardar. (Se intenta dos veces: primero con el GPS y después por antenas.)`,
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
  const [showShareDialog, setShowShareDialog] = useState(false)
  const [clientForShare, setClientForShare] = useState<DisplayClient | null>(null)
  const [sharingPdf, setSharingPdf] = useState(false)
  // El comprobante ya dibujado y listo para mandar. Se prepara al ABRIR el
  // dialogo para que el boton de compartir no tenga que esperar nada: ver el
  // comentario largo sobre la activacion del usuario en `handleShareComprobante`.
  const [reciboListo, setReciboListo] = useState<
    { file: File; dataUrl: string; filename: string } | null
  >(null)
  const [preparandoRecibo, setPreparandoRecibo] = useState(false)
  // true = el dialogo se abrio tras registrar un pago (al cerrarlo hay que
  // volver al listado). false = se abrio desde "Generar recibo" del menu,
  // donde no hay formulario abierto que cerrar.
  const [shareTrasPago, setShareTrasPago] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [paymentPhoto, setPaymentPhoto] = useState<string | null>(null)
  const [isDiario, setIsDiario] = useState(true)

  // Encabezado plegado (solo movil). En un telefono el bloque de arriba
  // —titulo, refrescar, circulos de mora, Diario/No Diario, Nueva Venta,
  // avance y buscador— se come casi un tercio de la pantalla, y el cobrador lo
  // que necesita ver es la lista.
  //
  // Se recuerda entre sesiones: el modulo se abre y se cierra muchas veces al
  // dia, y volver a plegarlo cada vez seria peor que no tener el boton.
  //
  // Arranca DESPLEGADO y se lee el guardado en un efecto, no en el estado
  // inicial: leer localStorage al construir el estado hace que el servidor y
  // el navegador rendericen cosas distintas.
  const CLAVE_ENCABEZADO = "pagos_encabezado_plegado"
  const [encabezadoPlegado, setEncabezadoPlegado] = useState(false)
  useEffect(() => {
    try {
      if (localStorage.getItem(CLAVE_ENCABEZADO) === "1") setEncabezadoPlegado(true)
    } catch { /* modo privado */ }
  }, [])
  const alternarEncabezado = () => {
    setEncabezadoPlegado((prev) => {
      const siguiente = !prev
      try { localStorage.setItem(CLAVE_ENCABEZADO, siguiente ? "1" : "0") } catch { /* modo privado */ }
      return siguiente
    })
  }
  // `max-md:hidden` y no `hidden md:flex`: los elementos que se ocultan ya
  // traen su propio `display` (flex, block), y poner `hidden` al lado deja dos
  // reglas peleando por la misma propiedad — gana el orden del CSS generado,
  // no el orden en que se escriban las clases. Con la variante `max-md:` no
  // hay pelea (Tailwind emite las variantes DESPUÉS) y de paso el escritorio
  // queda exactamente como estaba, sin tener que redeclararle el display.
  const ocultoEnMovil = () => (encabezadoPlegado ? "max-md:hidden" : "")
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

  // ── Extracto del cliente ────────────────────────────────────────────────
  // Lo que se sacó de la fila para que quepan más clientes: fecha de venta,
  // total a pagar, interés, abonado y multa. No se perdió, se agrupó — el
  // ojito de cada fila lo abre.
  const [extractoClient, setExtractoClient] = useState<DisplayClient | null>(null)
  // Cuántos movimientos tiene el crédito. Se pide al abrir el extracto porque
  // es un número que solo se mira ahí, y traerlo para las 40 filas de la lista
  // serían 40 consultas para un dato que casi nadie abre.
  const [extractoMovimientos, setExtractoMovimientos] = useState<number | null>(null)
  const [paymentHistoryRows, setPaymentHistoryRows] = useState<{
    id: string; fecha_pago: string; valor_cuota: number; estado: string
    monto_pagado: number; fecha_pago_real: string | null; numero_cuota: number
  }[]>([])
  const [paymentHistoryLoading, setPaymentHistoryLoading] = useState(false)

  // Loan history dialog
  const [loanHistoryOpen, setLoanHistoryOpen] = useState(false)
  const [loanHistoryClient, setLoanHistoryClient] = useState<DisplayClient | null>(null)
  const [loanHistoryRows, setLoanHistoryRows] = useState<{
    id: string; valor: number; numero_cuotas: number; frecuencia_pago: string; estado: string
    fecha_creacion: string; tasa_interes: number | null
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

  // El estado del permiso sale de `lib/use-gps.ts`, el MISMO que usa el
  // encabezado. Antes cada pantalla lo averiguaba por su cuenta y podian
  // contradecirse: la pastilla roja de "Sin ubicacion" arriba mientras aca los
  // botones estaban habilitados, o al reves.
  //
  // Ese modulo tambien resuelve lo que costo encontrar en iPhone: que
  // `navigator.permissions` puede no existir y revienta SINCRONO, que Safari
  // no soporta 'geolocation' en esa API, que preguntar con alta precision solo
  // para saber si hay permiso se pasa de tiempo bajo techo, y que volver de
  // Ajustes tiene que notarse sin recargar la pagina.
  const { estado: gpsStatus, volverAPedir: requestGpsPermission } = useEstadoGps()
  // Cuando la lista se sirve desde el dispositivo (sin señal), guarda el
  // momento en que esos datos se trajeron del servidor. null = datos frescos.
  const [datosDesdeCache, setDatosDesdeCache] = useState<string | null>(null)

  // Token monotonico para descartar respuestas obsoletas / concurrentes de fetchData.
  // Cada llamada incrementa el token; las respuestas con token distinto al actual
  // son ignoradas (evita race conditions cuando dos fetches solapan).
  const fetchDataTokenRef = useRef(0)

  // Candado contra el DOBLE TOQUE al registrar una gestion.
  //
  // No basta con el estado `saving`: entre el primer toque y `setSaving(true)`
  // hay un `await` del GPS que en movil tarda 1-2s, y en esa ventana el boton
  // sigue habilitado. El cobrador ve que "no pasa nada", vuelve a tocar, y
  // cada toque genera su PROPIA llave de idempotencia — asi que el candado del
  // servidor no los atrapa: no son reenvios de la misma captura, son capturas
  // distintas, y las escribe todas.
  //
  // Paso de verdad el 17/08/2026 en la ruta 190: cuatro pagos identicos de
  // $6.500 con la misma marca de tiempo al segundo. $19.500 de plata que
  // nunca entro, contados en la caja del dia.
  //
  // Es un ref y no un estado porque `setState` es asincrono: dos toques en el
  // mismo tick leerian ambos el valor viejo y los dos pasarian.
  const enviandoRef = useRef(false)

  // Ref a toast para no recrear fetchData en cada render (evita disparos
  // duplicados del useEffect que escucha fetchData).
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  }, [toast])

  const managedIds = new Set(managedToday.map((m) => m.loanId))

  // Un solo predicado de busqueda para las dos pestanas: si Gestionados
  // buscara distinto que Pendientes, el mismo cliente aparece en una y se
  // esconde en la otra.
  // Busca por apodo Y por nombre real. Antes solo miraba `nombre`, que es el
  // apodo cuando lo hay: buscar a alguien por su nombre de cedula no lo
  // encontraba, aunque ahora ese nombre este a la vista en la lista.
  const coincideBusqueda = (c: { nombre: string; nombreCompleto?: string; documento: string }) => {
    if (searchTerm === "") return true
    const q = searchTerm.toLowerCase()
    return (
      c.nombre.toLowerCase().includes(q) ||
      (c.nombreCompleto ?? "").toLowerCase().includes(q) ||
      c.documento.includes(searchTerm)
    )
  }

  // Base filtered clients: all filters except mora — used for the circle counts
  // so the totals per category are always visible regardless of active mora filter.
  // Los que le faltan al cobrador, SIN la busqueda: es el denominador del
  // avance de la ruta. Antes el avance salia de la lista ya buscada, asi que
  // escribir tres letras hacia saltar el porcentaje al 90% — el trabajo del
  // dia no cambia porque alguien escriba en un campo de texto.
  // Todos los que le faltan al cobrador, aplazados incluidos: es el
  // denominador del avance del día. Un aplazado NO está gestionado — sigue
  // siendo trabajo pendiente — así que sacarlo de esta cuenta haría que el
  // avance subiera solo por posponer clientes.
  const sinGestionar = clients.filter((c) => {
    if (managedIds.has(c.loanId)) return false
    if (c.saldo <= 0) return false
    const isDiarioFreq = c.frecuenciaPago === "daily"
    return isDiario ? true : !isDiarioFreq
  })

  /**
   * LA RUTA DE HOY: TODO EL QUE DEBA PLATA, HAYA PAGADO ADELANTADO O NO.
   *
   * Pagar de más NO compra días libres. Si la cuota es de $1.000 y el cliente
   * paga $3.000, ese día pagó tres cuotas y ahí queda registrado — pero mañana
   * vuelve a salir en la ruta, pendiente, y el cobrador le hace la gestión
   * desde cero. Es la regla del negocio: se pasa todos los días.
   *
   * Se probó lo contrario (01/09/2026) y se deshizo el mismo día. Sacar de la
   * ruta al que tenía la cuota de hoy cubierta dejaba la 190 recién abierta,
   * sin una sola visita hecha, mostrando 13 clientes en Gestionados. La
   * insignia decía 13 y nadie había gestionado a nadie.
   *
   * Lo único que sale de la ruta es lo APLAZADO, que vive en su pestaña.
   */
  const pendientesDeLaRuta = sinGestionar.filter((c) => !aplazados.has(c.loanId))
  const aplazadosDeLaRuta = sinGestionar
    .filter((c) => aplazados.has(c.loanId))
    .filter(coincideBusqueda)
    .sort((a, b) => {
      const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
      const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
      return ordA - ordB
    })

  /**
   * LIMPIAR LOS APLAZADOS QUE YA SE RESOLVIERON.
   *
   * Cuando a un aplazado se le registra el pago, sale de `sinGestionar` y las
   * listas dejan de mostrarlo — pero la marca sigue en el teléfono. Si después
   * se anula ese pago, el cliente volvería a "Pendientes" en vez de a la ruta,
   * arrastrando una decisión de hace tres horas que ya se cumplió.
   *
   * Se hace acá y no en cada camino de éxito porque los caminos son varios
   * —pago, no pago, cancelación, la cola offline— y el que se olvide es el que
   * deja la marca colgada.
   */
  useEffect(() => {
    if (aplazados.size === 0) return
    const vivos = new Set(sinGestionar.map((c) => c.loanId))
    const resueltos = [...aplazados.keys()].filter((id) => !vivos.has(id))
    if (resueltos.length === 0) return
    let m = aplazados
    for (const id of resueltos) m = quitarAplazado(currentRutaId, id)
    setAplazados(new Map(m))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, managedToday, currentRutaId])


  /**
   * LOS APLAZADOS, COMO UNA FILA MAS DE GESTIONADOS.
   *
   * El mismo cliente sale en las DOS pestañas a propósito: en "Pendientes"
   * porque hay que volver a visitarlo, y en "Gestionados" porque el cobrador
   * YA pasó por él hoy. Sin esto, a media tarde no había forma de distinguir
   * al que se aplazó del que todavía no se ha tocado.
   *
   * Antes vivían en un apartado al final de la pestaña. Medido con 30
   * gestionados: el encabezado quedaba a 4.986px de una página de 5.164 —el
   * 97% hacia abajo, cinco pantallas y media de scroll—. Estar ahí abajo y no
   * estar es lo mismo. Ahora van MEZCLADOS y ordenados por orden de visita,
   * que es como el cobrador recorre la ruta.
   *
   * No inventan plata: `valorAbonado` en 0 y `metodoPago` en null, porque un
   * aplazado no movió un peso. Y no tocan el avance del día —"30 de 43"— que
   * sigue saliendo de `managedToday`: contar como resuelto al que se pospuso
   * haría subir el porcentaje por posponer clientes.
   */
  const aplazadosComoGestion: ManagedClient[] = sinGestionar
    .filter((c) => aplazados.has(c.loanId))
    .map((c) => ({
      ...c,
      gestionTipo: "aplazado" as const,
      gestionHora: aplazados.get(c.loanId) ?? "",
      valorAbonado: 0,
      cuotasAbonadas: 0,
      metodoPago: null,
    }))

  const sortedManaged = [...managedToday, ...aplazadosComoGestion].sort((a, b) => {
    const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
    const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
    return ordA - ordB
  })

  // Gestionados tambien se busca. Al final del dia esta lista tiene tantos
  // clientes como la otra, y encontrar a alguien para corregirle un cobro
  // obligaba a bajar por toda la ruta a ojo.
  const filteredManaged = sortedManaged.filter(coincideBusqueda)

  const preFilteredClients = pendientesDeLaRuta.filter(coincideBusqueda)

  const displayClients = preFilteredClients.filter((c) => {
    if (moraFilter === null) return true
    if (moraFilter === "green") return c.mora <= 4
    if (moraFilter === "yellow") return c.mora > 4 && c.mora <= 8
    return c.mora > 8
  }).sort((a, b) => {
    // 1. EL ORDEN DE LA RUTA MANDA, Y ES LO UNICO QUE ORDENA.
    //
    //    Antes era el ultimo criterio de tres, y los dos de arriba lo
    //    deshacian: primero se mandaban al final los clientes con cuota
    //    FUTURA, y en "No Diario" se subian los del dia de cobro. En la ruta
    //    190, 28 de 44 clientes caen en el primer grupo — o sea que quien
    //    acomodaba su ruta en "Ordenar Ruta" abria Pagos y veia OTRA cosa.
    //
    //    Y esa reorganizacion era invisible: el badge "Próx. pago" que la
    //    explicaba se quito hace unas semanas, asi que la lista se reordenaba
    //    sola sin nada en pantalla que dijera por que.
    //
    //    El orden de visita es GEOGRAFICO: es la calle, en el orden en que se
    //    camina. Mandarle al final a los que estan al dia obliga a pasar de
    //    largo y volver.
    const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
    const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
    if (ordA !== ordB) return ordA - ordB

    // 2. Los que TODAVIA no tienen orden asignado van al final, y entre
    //    ellos se ordenan por algo FIJO: la fecha de la venta y, si empatan,
    //    el id del prestamo.
    //
    //    No se usa la cuota futura ni el dia de cobro, aunque sean criterios
    //    mas "inteligentes": esos cambian solos de un dia para el otro, y una
    //    lista que se reacomoda sola es justo lo que se vino a arreglar. Con
    //    la fecha de venta, el cobrador ve siempre la misma secuencia hasta
    //    que decida ordenarla el.
    if (a.fechaVenta !== b.fechaVenta) return a.fechaVenta < b.fechaVenta ? -1 : 1
    return a.loanId < b.loanId ? -1 : a.loanId > b.loanId ? 1 : 0
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

  /**
   * Guarda el orden de la ruta.
   *
   * `reordered` son SOLO los que estan en pantalla. Renumerarlos 1..N a secas
   * —que es lo que hacia antes— pisaba los numeros de los que no se ven: si a
   * media manana ya hay diez clientes gestionados, los treinta y uno restantes
   * quedaban 1..31 y los diez de la manana conservaban numeros dentro de ese
   * mismo rango. Al dia siguiente, con todos visibles otra vez, el orden tenia
   * empates y la ruta que alguien acomodo a mano se desarmaba sola.
   *
   * Asi que se renumera la ruta COMPLETA: se toman todos los clientes en su
   * orden actual y se reemplaza, en los puestos que ocupaban los visibles, la
   * secuencia nueva. Los que no se ven no se mueven de su lugar relativo, y
   * el resultado es 1..N sin repetidos.
   */
  const saveNewOrder = async (reordered: DisplayClient[]) => {
    setSavingOrder(true)
    try {
      const porOrden = (c: DisplayClient) => (c.ordenvisita > 0 ? c.ordenvisita : 99999)
      const idsMovidos = new Set(reordered.map((c) => c.loanId))
      const todos = [...clients].sort((a, b) => porOrden(a) - porOrden(b))

      let k = 0
      const rutaCompleta = todos.map((c) => (idsMovidos.has(c.loanId) ? reordered[k++] : c))

      const items = rutaCompleta.map((c, idx) => ({
        id: c.loanId,
        ordenvisita: idx + 1,
      }))
      const res = await fetch("/api/route-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error("Error saving order")
      // El estado local recibe los MISMOS numeros que se acaban de guardar.
      //
      // Antes esto era `setClients(reordered...)`, que reemplazaba la lista
      // completa por el subconjunto reordenado: todo cliente que no estuviera
      // en pantalla en ese momento desaparecia del estado hasta el siguiente
      // refresco.
      const nuevoOrden = new Map(items.map((it) => [it.id, it.ordenvisita]))
      setClients((prev) =>
        prev.map((c) => {
          const orden = nuevoOrden.get(c.loanId)
          return orden === undefined ? c : { ...c, ordenvisita: orden }
        }),
      )
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
    // Se reordena SOBRE LA LISTA QUE SE VE, igual que hacen las flechas.
    //
    // Antes se rearmaba aca una lista aparte con un filtro que NO coincidia
    // con el de la pantalla: no descartaba a los ya gestionados ni a los de
    // saldo cero, en modo Diario se quedaba solo con los diarios (la lista
    // muestra todos), ignoraba el filtro de mora y ni siquiera aplicaba el
    // mismo orden. Los indices del arrastre venian de la lista visible, asi
    // que apuntaban a otro cliente: arrastrar movia a alguien mas.
    const reordered = [...displayClients]
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

      // El helper ya devolvio el conjunto correcto: los activos de la ruta MAS
      // los que se movieron desde ayer, aunque hayan quedado cancelados. Esos
      // ultimos se filtran mas abajo de Pendientes por su estado, asi que solo
      // pueden salir en Gestionados — que es donde tienen que estar el dia que
      // se cancelan. Alias para no tocar el resto del componente.
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
        // Conteos sobre cuotas BASE: las extra de extensiones no alteran el
        // X/Y del prestamo, que es lo que el cliente pacto.
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
          // Los dos por separado para poder pintarlos en dos lineas. El apodo
          // se descarta cuando es identico al nombre real: repetirlo no agrega
          // nada y ocupa una linea entera.
          apodo: (() => {
            const a = (loan.clients?.apodo ?? "").trim()
            const n = (loan.clients?.nombre_completo ?? "").trim()
            return a && a.toLowerCase() !== n.toLowerCase() ? a : null
          })(),
          nombreCompleto: loan.clients?.nombre_completo
            ? sinApodo(loan.clients.nombre_completo, loan.clients.apodo)
            : (loan.clients?.apodo || "Sin nombre"),
          documento: loan.clients?.documento || "",
          // VALOR DE LA VENTA = el capital prestado, sin intereses.
          //
          // Antes dependia del tipo de credito: en americano mostraba el
          // capital y en los demas `valor_a_pagar`, que es capital + interes.
          // O sea que dos ventas del mismo monto se veian distinto segun el
          // metodo, y la que decia "Monto Venta" en realidad mostraba lo que
          // el cliente iba a terminar pagando.
          valorVenta: loan.valor,
          valorPrestamo: loan.valor,
          // Del MISMO sitio que el saldo. Con `total_a_pagar` y `saldo` de
          // fuentes distintas, el extracto podría mostrar un abonado que no
          // cuadra con la resta que el cliente hace de cabeza.
          totalAPagar: Number(fin?.total_a_pagar) || 0,
          abonado: Number(fin?.total_pagado) || 0,
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
            metodoPago: gestionHoy.metodo,
            paymentPlanId: targetEntry?.id ?? "",
          })
        } else {
          // Solo los ACTIVOS entran a la lista de cobro.
          //
          // Antes preguntaba `=== "cancelado"`, que era lo mismo mientras
          // `estado` solo tuviera esos dos valores. Con 'anulado' (script 068)
          // dejo de serlo: una venta anulada se colaba en la ruta como si nada.
          // Preguntar por lo que SI se quiere, y no por lo que no, aguanta el
          // proximo estado que aparezca.
          if (loan.estado !== "activo") {
            continue
          }
          pendingClients.push(clientData)
        }
      }

      // Mismo criterio que la lista visible: manda `ordenvisita`, y solo
      // entre los que no lo tienen asignado decide la cuota futura. Si los dos
      // ordenes no coincidieran, la lista daria un salto al terminar de
      // cargar.
      pendingClients.sort((a, b) => {
        const ordA = a.ordenvisita > 0 ? a.ordenvisita : 99999
        const ordB = b.ordenvisita > 0 ? b.ordenvisita : 99999
        if (ordA !== ordB) return ordA - ordB
        if (a.fechaVenta !== b.fechaVenta) return a.fechaVenta < b.fechaVenta ? -1 : 1
        return a.loanId < b.loanId ? -1 : a.loanId > b.loanId ? 1 : 0
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
    // El candado se toma ANTES de cualquier `await` y se suelta en el finally
    // de mas abajo, que cubre TODAS las salidas de esta funcion.
    if (enviandoRef.current) return
    enviandoRef.current = true
    // Deshabilita el boton de una vez, sin esperar al GPS: el ref evita el
    // duplicado, pero el cobrador tambien necesita ver que su toque entro.
    setSaving(true)
    try {
    if (!selectedClient || !selectedClient.nextPaymentId) {
      toast({ title: "Error", description: "No hay cuota pendiente para este cliente", variant: "destructive" })
      return
    }

    // Validaciones sincronicas ANTES de pedir GPS.
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

      // La gestion se registra SIEMPRE con la fecha de hoy.
      //
      // Aca se abria un dialogo —"Quedó un día sin gestionar"— preguntando si
      // el pago iba para ayer o para hoy. Se quito a pedido del dueno: saltaba
      // en cada cliente que arrastrara una cuota vencida, o sea en media ruta
      // los lunes, y en la calle se contesta lo primero que aparezca. La plata
      // se recibe HOY y se registra HOY, que ademas es lo que respondia el 99%
      // de las veces.
      //
      // Lo que se dejo de decidir aca no se pierde: la cuota vieja sigue
      // pendiente y la cascada le asigna la plata igual, porque reparte de la
      // mas vieja hacia adelante. Y si hay que fechar algo en un dia anterior,
      // ese es el trabajo de Control de Pagos.
      const fechaAplicacion = fechaPago
      const numCuotasEfectivo = numCuotasSnap
      const retroAplicado = false

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
              // El método que se acaba de elegir en el formulario: la lista lo
              // marca al instante, sin esperar al refetch.
              metodoPago: paymentMethod === "transferencia" ? "transferencia" : "efectivo",
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
          // El método que se acaba de elegir: la lista lo marca al instante,
          // sin esperar al refetch.
          metodoPago: paymentMethod === "transferencia" ? "transferencia" : "efectivo",
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
    } finally {
      // Cubre todas las salidas, incluidas las validaciones que retornan
      // temprano y el caso en que el cobrador cancela el aviso de geocerca.
      enviandoRef.current = false
      setSaving(false)
    }
  }

  const handleRegisterNoPayment = async () => {
    // Mismo candado que en el pago: este flujo tambien espera al GPS antes de
    // deshabilitar el boton. No mueve plata, pero un doble toque dejaba dos
    // "no pago" del mismo cliente el mismo dia.
    if (enviandoRef.current) return
    enviandoRef.current = true
    setSaving(true)
    try {
    if (!noPaymentClient || !noPaymentClient.nextPaymentId) return

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

      // Igual que en el pago: la visita se registra con la fecha de HOY, sin
      // preguntar. Ver el comentario en `handleConfirmPayment`.
      const fechaAplicacionNp = colombiaDateStr
      const retroAplicadoNp = false

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
              // Un no pago no tiene forma de pago.
              metodoPago: null,
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
          metodoPago: null,
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
    } finally {
      enviandoRef.current = false
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
  // Cuántos movimientos lleva el crédito. Se pide SOLO al abrir el extracto:
  // traerlo para las cuarenta filas de la lista serían cuarenta consultas por
  // un número que se mira de vez en cuando. `head: true` no baja las filas,
  // solo el conteo.
  useEffect(() => {
    if (!extractoClient) { setExtractoMovimientos(null); return }
    let cancelado = false
    ;(async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { count, error } = await supabase
          .from("gestiones")
          .select("id", { count: "exact", head: true })
          .eq("loan_id", extractoClient.loanId)
          .eq("estado", "aplicada")
        if (cancelado) return
        if (error) throw error
        setExtractoMovimientos(count ?? 0)
      } catch (err) {
        // Sin conteo el extracto se abre igual; lo que no se puede es que el
        // ojito no responda por una consulta de adorno.
        console.error("[v0] conteo de movimientos del extracto:", err)
        if (!cancelado) setExtractoMovimientos(null)
      }
    })()
    return () => { cancelado = true }
  }, [extractoClient])

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
          .select("id, valor, numero_cuotas, frecuencia_pago, estado, fecha_creacion, created_at, tasa_interes")
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
            tasa_interes: r.tasa_interes ?? null,
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
    // El recibo lleva el nombre REAL del cliente, sin el apodo. `sinApodo`
    // vive a nivel de modulo: la lista de cobro usa el mismo, para que el
    // papel y la pantalla no digan cosas distintas del mismo cliente.
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
    const moraActual = finRow?.cuotas_mora ?? client.mora

    const rows: [string, string][] = [
      ["Fecha venta:", fmtFechaCorta(client.fechaVenta)],
      ["Total a pagar:", fmt(saldo?.total_con_intereses)],
      ["Total recaudado:", fmt(saldo?.total_recaudado)],
      ["Saldo pendiente:", fmt(saldo?.saldo_pendiente ?? client.saldo)],
      // Sin el sufijo "(+N extra)": el recibo es lo que el cliente se lleva a
      // la mano y las cuotas extra de extensiones y prorrogas le agregaban un
      // numero que no sabe leer. El X/Y sigue siendo sobre las cuotas BASE del
      // plan, que es lo que el cliente pacto.
      ["Cuotas:", `${cuotasCubiertas} / ${cuotasTotales}`],
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
    ctx.fillText("COMPROBANTE DE PAGO", W / 2, y + 14)
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

    const filename = `comprobante_${client.nombre.replace(/\s+/g, "_")}_${fechaStr.replace(/\//g, "-")}.png`
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
    setReciboListo(null)
    if (shareTrasPago) handleBack()
    setShareTrasPago(false)
  }

  const handleGenerarRecibo = (client: DisplayClient) => {
    setClientForShare(client)
    setShareTrasPago(false)
    setShowShareDialog(true)
  }

  // `handleDescargarRecibo` vivía acá y volvía a dibujar el comprobante para
  // descargarlo. Ya no hace falta: el diálogo lo prepara al abrir y el botón
  // de Descargar usa esa misma imagen, sin pedirle otra vez los datos al
  // servidor.

  /** Si el cliente ya fue gestionado hoy, devuelve esa gestion (trae el abono). */
  const gestionDe = (client: DisplayClient): ManagedClient | undefined =>
    managedToday.find((m) => m.loanId === client.loanId)

  /**
   * EL COMPROBANTE SE DIBUJA AL ABRIR EL DIÁLOGO, NO AL TOCAR "COMPARTIR".
   *
   * Esto es lo que hacía que el menú para elegir app no apareciera.
   * `navigator.share()` solo se puede llamar mientras dura la ACTIVACIÓN que
   * deja el toque del usuario, y armar el recibo son CUATRO viajes de red
   * —financiero del crédito, datos del cliente, eventos del día y el logo de
   * la ruta— más el dibujo del canvas. Con señal de calle eso son segundos.
   * Para cuando terminaba, la activación ya había caducado: el navegador
   * rechazaba la llamada y Safari lo hace sin decir nada útil. El cobrador
   * tocaba Compartir y no pasaba nada.
   *
   * Preparándolo antes, el botón llama a `share()` en el mismo gesto y el menú
   * sale siempre.
   */
  useEffect(() => {
    if (!showShareDialog || !clientForShare) return
    let vigente = true
    setReciboListo(null)
    setPreparandoRecibo(true)
    ;(async () => {
      try {
        const { blob, dataUrl, filename } = await buildReciboImagen(
          clientForShare,
          gestionDe(clientForShare),
        )
        if (vigente) setReciboListo({ file: new File([blob], filename, { type: "image/png" }), dataUrl, filename })
      } catch (e) {
        console.error("[v0] No se pudo preparar el comprobante:", e)
        if (vigente) {
          toast({
            title: "Error",
            description: "No se pudo preparar el comprobante.",
            variant: "destructive",
          })
        }
      } finally {
        if (vigente) setPreparandoRecibo(false)
      }
    })()
    return () => { vigente = false }
    // Solo depende de QUÉ comprobante hay que dibujar. `buildReciboImagen` y
    // `gestionDe` se redefinen en cada render y meterlos acá lo dibujaría sin
    // parar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showShareDialog, clientForShare?.loanId])

  /**
   * OJO AL ORDEN: no es `async` y no puede serlo. Entre el toque y
   * `navigator.share()` no puede haber ni un `await`, o se pierde el menú.
   */
  const handleShareComprobante = () => {
    if (!reciboListo) return
    const { file, dataUrl, filename } = reciboListo

    if (
      typeof navigator !== "undefined" &&
      navigator.share &&
      navigator.canShare &&
      navigator.canShare({ files: [file] })
    ) {
      // El menu nativo tambien manda la app a segundo plano. Es la app
      // abriendolo, no la persona yendose: no cuenta como salir.
      abriendoAlgoDelSistema()
      navigator
        .share({ files: [file], title: "Comprobante de pago" })
        .then(() => cerrarShare())
        .catch((e: unknown) => {
          // Cancelar el menú lanza AbortError: es el usuario diciendo que no,
          // y el diálogo se queda abierto por si quiere reintentar.
          if (e instanceof Error && e.name !== "AbortError") {
            console.error("[v0] handleShareComprobante error:", e)
            toast({ title: "Error", description: "No se pudo compartir el comprobante.", variant: "destructive" })
          }
        })
      return
    }

    // Este teléfono no sabe compartir archivos: se descarga y se dice por qué,
    // en vez de dejar la sensación de que el botón no hizo nada.
    const a = document.createElement("a")
    a.href = dataUrl
    a.download = filename
    a.click()
    toast({
      title: "Comprobante descargado",
      description: "Este dispositivo no permite elegir la app para compartir.",
    })
    cerrarShare()
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
  /**
   * La gestión de hoy que TODAVÍA ESTÁ EN PIE.
   *
   * Antes esto tomaba la más reciente del día y ya. El problema: una gestión
   * ya anulada sigue siendo un evento aplicado, y si era la última, era la que
   * salía elegida. Cada intento de anular volvía a apuntarle a ella, el
   * servidor respondía "esa gestión ya fue reversada" y la mandaba a revisión,
   * mientras el pago que SÍ estaba vivo seguía intacto y el cliente seguía en
   * Gestionados.
   *
   * Pasó de verdad: MARTINEZ EMILCE, ruta 197, el 25/08. El día tenía un pago
   * de 48.000 (anulado), uno de 192.000 (vivo) y uno de 9.600 (anulado). El
   * de 9.600 era el último, así que las VEINTE anulaciones que se intentaron
   * le pegaron a él, y las veinte se apilaron en la bandeja de secretaría.
   *
   * Se traen TODOS los eventos aplicados del préstamo, no solo los de hoy: una
   * reversa puede llevar la fecha de la cuota que corrige y no la de hoy
   * (`ajustar_cuota_control_pagos`), y filtrando por fecha se escapaba.
   */
  const resolveGestionHoy = async (m: ManagedClient): Promise<GestionConUbicacion | null> => {
    try {
      const supabase = await getSupabaseSafe()
      const { data } = await supabase
        .from("gestiones")
        .select(
          "id, loan_id, tipo, monto, fecha_gestion, cuota_objetivo, num_cuotas, " +
            "metodo_pago, referencia_gestion_id, fecha_hora, " +
            // DÓNDE OCURRIÓ LA VISITA. Se traen para que la corrección pueda
            // llevarlas: el servidor trata un pago o un no pago SIN
            // coordenadas como una visita que nadie puede probar (script
            // 064), y una corrección se escribe desde el escritorio.
            "latitud, longitud, geocerca_estado, geocerca_motivo",
        )
        .eq("loan_id", m.loanId)
        .eq("estado", "aplicada")
        .order("fecha_hora", { ascending: false })

      const filas = (data ?? []) as unknown as GestionConUbicacion[]

      // Las que ya tienen una reversa aplicada apuntándoles. Solo cuentan las
      // reversas APLICADAS: una en revisión todavía no anuló nada.
      const anuladas = new Set(
        filas
          .filter((g) => g.tipo === "reversa" && g.referencia_gestion_id)
          .map((g) => g.referencia_gestion_id as string),
      )

      // La más reciente de HOY que sea una visita y siga en pie.
      const hoy = todayColombia()
      return (
        filas.find(
          (g) =>
            g.fecha_gestion === hoy &&
            (g.tipo === "pago" || g.tipo === "no_pago" || g.tipo === "cancelacion") &&
            !anuladas.has(g.id),
        ) ?? null
      )
    } catch (_e) {
      return null
    }
  }

  /**
   * Corregir la gestión de hoy = anular la anterior y registrar la corregida.
   * Sirve para las tres correcciones:
   *
   *   · pago → pago      cambiar el monto
   *   · pago → no pago   se marcó pago y el cliente no pagó
   *   · no pago → pago   se marcó no pago y el cliente sí pagó
   *
   * Las dos últimas antes obligaban a anular y volver a gestionar al cliente
   * entero, con el viaje a Pendientes de por medio.
   *
   * EL EVENTO ORIGINAL NUNCA SE MODIFICA. Se registra su reversa y después el
   * evento nuevo, que es la única forma de escribir plata en este sistema: en
   * el historial quedan los tres y la Auditoría 360 puede mostrar qué se
   * cambió, cuándo y por quién. Cambiar `gestiones.tipo` con un UPDATE haría
   * desaparecer el error sin dejar rastro, y de todos modos el trigger
   * `trg_gestiones_inmutables` lo rechaza.
   */
  const handleEditManagedSave = async () => {
    if (!editingManaged) return
    const m = editingManaged
    const destino = editTipo
    const newMonto = destino === "pago" ? Number.parseFloat(editMonto) : 0
    if (destino === "pago" && (isNaN(newMonto) || newMonto <= 0)) return

    // Sin cambios no se escribe nada: dos eventos de más en el libro por un
    // "Guardar" sin querer ensucian el historial y no corrigen nada.
    const igual =
      destino === m.gestionTipo &&
      (destino === "no_pago" || newMonto === (m.valorAbonado ?? 0))
    if (igual) { setEditingManaged(null); return }

    setSavingManaged(true)
    try {
      const original = await resolveGestionHoy(m)
      if (!original) throw new Error("No se encontró la gestión de hoy de este cliente")

      const queCambio =
        destino === m.gestionTipo
          ? "Monto corregido desde el módulo de pagos"
          : destino === "pago"
            ? "Corregido de no pago a pago desde el módulo de pagos"
            : "Corregido de pago a no pago desde el módulo de pagos"

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
          observacion: queCambio,
        },
      })

      const idNuevo = nuevaGestionId()
      await enviarOEncolar({
        tipo: "gestion",
        id: idNuevo,
        descripcion:
          destino === "pago"
            ? `Pago corregido — ${m.nombre} ($${newMonto.toLocaleString()})`
            : `No pago corregido — ${m.nombre}`,
        payload: {
          id: idNuevo,
          tipo: destino,
          loan_id: m.loanId,
          client_id: m.clientId,
          monto: newMonto,
          // Al convertir a no pago la gestión vale por UNA visita, no por las
          // cuotas que cubría el pago que se está deshaciendo.
          num_cuotas: destino === "pago" ? (original.num_cuotas ?? 1) : 1,
          fecha_gestion: todayColombia(),
          fecha_hora: ahoraColombiaISO(),
          cuota_objetivo: original.cuota_objetivo,
          metodo_pago: destino === "pago" ? original.metodo_pago : null,
          // LAS COORDENADAS DE LA VISITA QUE SE CORRIGE.
          //
          // Sin esto la corrección no entra. El servidor trata un `pago` o un
          // `no_pago` sin GPS como una visita sin prueba de que ocurrió: al
          // pago lo manda `en_revision` —no suma, y el cliente se devuelve a
          // Pendientes— y al no pago lo RECHAZA con una excepción, después de
          // que su reversa ya se aplicó. De ahí salían los dos defectos que
          // se reportaron.
          //
          // No es inventar un dato: son las coordenadas que midió el teléfono
          // en ESA visita. Lo que se corrige es el monto o el tipo, no el
          // lugar. Y llevándolas, la corrección sale en el mapa donde debe.
          latitud: original.latitud ?? null,
          longitud: original.longitud ?? null,
          geocerca_estado: original.geocerca_estado ?? null,
          geocerca_motivo: original.geocerca_motivo ?? null,
          // A propósito en `false`. Un no pago registrado en la calle puede
          // alargar el cronograma si el cliente iba en su última cuota, y esa
          // decisión la toma el cobrador con la casilla del formulario. Una
          // corrección hecha después no puede alargarle el plan al cliente de
          // callada: si hace falta esa cuota, se anula y se gestiona de nuevo.
          generar_cuota_si_debe: false,
          cliente_nombre: m.nombre,
          observacion: queCambio,
        },
      })

      setEditingManaged(null)
      setManagedToday((prev) =>
        prev.map((x) =>
          x.loanId === m.loanId
            ? {
                ...x,
                gestionTipo: destino,
                valorAbonado: newMonto,
                cuotasAbonadas: destino === "pago" ? x.cuotasAbonadas : 0,
              }
            : x,
        ),
      )
      toast({
        title: destino === "pago" ? "Marcado como pago" : "Marcado como no pago",
        description:
          destino === "pago"
            ? `${m.nombre} — $${newMonto.toLocaleString()}`
            : `${m.nombre} queda como no pago del día`,
      })
      void fetchData({ silent: true })
    } catch (e) {
      // La reversa y el evento nuevo son dos llamadas, no una transacción. Si
      // la segunda falla, la primera YA se aplicó: la gestión anterior quedó
      // anulada y no hay nada en su lugar. Callarlo dejaba al cobrador
      // pensando que no había pasado nada, cuando el pago ya no estaba.
      toast({
        title: "No se pudo corregir",
        description:
          (e instanceof Error ? e.message : "Error al registrar la corrección") +
          " · La gestión anterior quedó anulada: vuelve a registrarla desde Pendientes.",
        variant: "destructive",
      })
      void fetchData({ silent: true })
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
        apodo: m.apodo,
        nombreCompleto: m.nombreCompleto,
        documento: m.documento,
        fechaVenta: m.fechaVenta,
        valorVenta: m.valorVenta,
        // La anulacion devuelve la plata: lo abonado baja en el mismo monto
        // que sube el saldo. El refetch silencioso de abajo corrige el exacto.
        totalAPagar: m.totalAPagar,
        abonado: Math.max(0, m.abonado - m.valorAbonado),
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

  // Franja de color al inicio de cada fila. Al sol, la lista se ve como un
  // bloque de texto gris: el borde entre un cliente y el siguiente es lo
  // primero que desaparece. Una barra saturada a la izquierda sobrevive al
  // reflejo mucho mejor que una linea de 1px, y de paso dice en que anda el
  // cliente antes de leer una sola palabra. Es la MISMA banda del badge de
  // mora, no un codigo nuevo que haya que aprenderse.
  /**
   * El color de la mora en TEXTO, sin pastilla.
   *
   * `getMoraColor` devuelve texto + fondo, que es lo que necesitaba la
   * pastilla de la fila vieja. En la fila apretada la pastilla costaba
   * relleno arriba y abajo en cada una de las cuarenta filas, así que se
   * quedó solo el color.
   */
  const moraTexto = (mora: number) => {
    const banda = colorMora(mora)
    if (banda === "verde") return "text-green-700"
    if (banda === "amarillo") return "text-yellow-700"
    return "text-red-700"
  }

  const getMoraBarra = (mora: number) => {
    const banda = colorMora(mora)
    if (banda === "verde") return "border-l-green-500"
    if (banda === "amarillo") return "border-l-yellow-500"
    return "border-l-red-500"
  }

  /**
   * EL BOTÓN VERDE Y SUS TRES ACCIONES.
   *
   * Lo usan la lista de la ruta, la de Pendientes y la tarjeta del aplazado en
   * Gestionados. Es una función y no JSX repetido porque de las tres opciones
   * dos mueven plata: tres copias del mismo menú son tres sitios donde una
   * guarda puede quedar sin poner.
   */
  const menuGestion = (client: DisplayClient, aplazado: boolean) => {
    const canManage = canManageClient(client)
    return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          className="h-10 w-10 shrink-0 rounded-full bg-success text-card hover:bg-success/80"
          title="Gestionar este cliente"
          aria-label="Gestionar este cliente"
        >
          <Check className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          className="cursor-pointer text-sm font-medium"
          onClick={() =>
            gpsStatus !== "granted"
              ? handleLocationRequired()
              : handleSelectClient(client)
          }
          disabled={canManage === false && gpsStatus === "granted"}
        >
          {/* Círculo LLENO con el visto en blanco, como el botón verde que
              abre este menú. Lucide no trae la versión rellena, y un aro
              contra un círculo lleno se leen como dos cosas distintas. */}
          <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-600">
            <Check className="h-3 w-3 text-white" strokeWidth={3} />
          </span>
          <span className="font-semibold text-green-700">Pago</span>
          {/* La única variante que sobrevive al recorte de nombres. Cobrar una
              cuota que todavía no vence es válido, pero es una decisión: sin
              este aviso el cobrador no tiene cómo saber que está adelantando.
              Va en gris y pequeño para no romper la fila de las tres. */}
          {client.nextPaymentEsFuturo && (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">adelantado</span>
          )}
        </DropdownMenuItem>

        <DropdownMenuItem
          className="cursor-pointer text-sm font-medium"
          onClick={() => {
            if (gpsStatus !== "granted") {
              handleLocationRequired()
              return
            }
            setAgregarCuotaSiDebeNoPago(true)
            setNoPaymentClient(client)
          }}
          disabled={canManage === false && gpsStatus === "granted"}
        >
          <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600">
            <X className="h-3 w-3 text-white" strokeWidth={3} />
          </span>
          <span className="font-semibold text-red-700">No Pago</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* APLAZAR no pide GPS ni día de cobro, y por eso NO lleva los
            guardas de los otros dos: no registra nada en el libro. Es
            una nota del cobrador sobre su propio día — "a este vuelvo
            más tarde"— y hasta ahora, para dejarla, había que marcarle
            no pago, que es una visita fallida y no lo fue. */}
        <DropdownMenuItem
          className="cursor-pointer text-sm font-medium"
          onClick={() => (aplazado ? devolverALaRuta(client) : marcarAplazado(client))}
        >
          {/* El reloj se queda SIN rellenar, a diferencia de los otros dos.
              No es un descuido de estilo: pago y no pago cierran el día del
              cliente y por eso van sólidos; dejarlo pendiente no cierra nada.
              La forma dice cuál de las tres no resuelve. */}
          <Clock className="mr-2 h-5 w-5 shrink-0 text-orange-500" strokeWidth={2.5} />
          <span className="font-semibold">{aplazado ? "Volver a la ruta" : "Pendiente"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    )
  }

  /**
   * UNA fila de cliente. Se usa en las DOS listas — "Ruta" y "Pendientes"— y
   * por eso es una función y no JSX repetido: son doscientas líneas con cuatro
   * botones y un menú, y dos copias se separan al primer arreglo que se haga
   * en una sola.
   *
   * `total` es el largo de la lista donde se está pintando, que es lo que
   * decide si "Bajar en la ruta" está disponible.
   */
  const filaCliente = (
    client: DisplayClient,
    index: number,
    total: number,
    aplazado: boolean,
  ) => {
      const canManage = canManageClient(client)
      const arrastre = {
        draggable: true,
        onDragStart: () => handleDragStart(index),
        onDragOver: (e: React.DragEvent) => handleDragOver(e, index),
        onDragEnd: () => { setDragIndex(null); setDragOverIndex(null) },
        onDrop: () => handleDrop(index),
      }
      return (
      <TableRow
        key={client.loanId}
        {...arrastre}
        className={`${index % 2 === 0 ? "bg-card" : "bg-muted"} hover:bg-accent/30 transition-colors border-b-2 border-b-border ${
          dragIndex === index ? "opacity-50" : ""
        } ${!canManage ? "opacity-60" : ""} ${
          dragOverIndex === index ? "border-t-2 border-t-brand" : ""
        }`}
      >
        {/* La franja de color va en la CELDA y no en la fila:
            la tabla le quita los bordes al último `<tr>`, así
            que puesta en la fila el último cliente se
            quedaría sin ella. */}
        {/* UNA SOLA FILA POR CLIENTE.
          Estuvo en dos —el nombre cruzando las tres columnas y debajo los
          datos— porque con la columna de acciones en 152px al nombre le
          quedaban 124 y se partía en cuatro renglones. Al juntar los dos
          botones de plata en uno solo y apilar el ojo sobre los tres puntos,
          esa columna bajó a 84 y el nombre pasó a tener ~196: ya cabe al lado
          de todo lo demás, y el cliente vuelve a ocupar una línea. */}
        <TableCell
          className={`py-1 md:py-1.5 px-2 border-l-4 align-middle whitespace-normal ${getMoraBarra(client.mora)}`}
        >
          {/* Dos renglones como máximo. `line-clamp-2` envuelve —no corta a
              media palabra— y deja la fila del mismo alto para todos. Lo que
              no quepa se lee completo en el extracto, a un toque del ojito.
              OJO: sin `block`, que pelea con `line-clamp` por el `display` y
              lo deja sin efecto. */}
          <span className="font-semibold text-[13px] md:text-base leading-tight break-words [overflow-wrap:anywhere] line-clamp-2">
            <span className="mr-1 text-[10px] md:text-xs font-normal text-muted-foreground tabular-nums">
              {index + 1}.
            </span>
            {client.nombreCompleto}
          </span>

          {/* Mora y cuota en el MISMO renglón. Apiladas, como en el boceto,
              costaban una línea más por cliente — y con cuarenta clientes esa
              línea es media pantalla. Las dos dicen "cómo va este cliente", así
              que leídas juntas no se pierde nada. */}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-tight">
            <span className={`text-[11px] md:text-sm font-semibold ${moraTexto(client.mora)}`}>
              {client.mora > 0 ? `Mora: ${client.mora}` : "Al día"}
            </span>
            <span className="text-[10px] md:text-sm text-muted-foreground tabular-nums">
              Cta {client.cuotasPagadas}/{client.cuotasTotales}
            </span>
            {aplazado && (
              <span className="rounded bg-amber-500/15 px-1 text-[9px] md:text-xs font-semibold text-amber-700">
                Pendiente
              </span>
            )}
            {/* El día de cobro SOLO en los no diarios, que es donde dice algo:
                en una ruta diaria sería la misma etiqueta en las cuarenta
                filas. Verde cuando es hoy. */}
            {client.frecuenciaPago !== "daily" && client.diaSemana && (
              <span className={`rounded px-1 text-[9px] md:text-xs font-semibold ${
                isPaymentDayToday(client.diaSemana)
                  ? "bg-success text-success-foreground"
                  : "bg-muted-foreground/15 text-muted-foreground"
              }`}>
                {client.diaSemana.charAt(0).toUpperCase() + client.diaSemana.slice(1)}
              </span>
            )}
          </span>
        </TableCell>

        <TableCell className="py-1 md:py-1.5 px-1 text-right align-middle">
          <span className="block text-[12px] md:text-base font-semibold tabular-nums leading-tight">
            ${Math.round(client.saldo).toLocaleString()}
          </span>
          {/* La multa sí se queda en la lista: es plata que
              hay que cobrar HOY y encontrarla solo abriendo
              el extracto sería enterrarla. */}
          {client.multaPendiente && (
            <span className="block text-[10px] md:text-sm font-semibold text-destructive tabular-nums leading-tight">
              Multa ${client.multaPendiente.valor.toLocaleString()}
            </span>
          )}
        </TableCell>

        <TableCell className="py-1 md:py-1.5 px-1 align-middle">
          {/* UNA SOLA PUERTA A LAS GESTIONES.
              Antes eran dos botones sueltos, verde y rojo, pegados en la misma
              fila. Estuvieron a 2px uno de otro y en la calle, a pulso, se
              tocaba No pago queriendo Pago — y cada equivocación cuesta una
              reversa. Ahora hay un solo botón y las tres acciones viven
              adentro, separadas y con su nombre escrito: para equivocarse hay
              que leer mal, no solo temblar.

              Los nombres son de UNA palabra —Pago, No Pago, Pendiente— y sin
              el verbo delante. "Registrar pago" y "Registrar no pago"
              empezaban igual, así que la palabra que de verdad distingue una
              opción de la otra quedaba en segundo lugar, que es el peor sitio
              para leer a pulso. Ahora la primera palabra es la que decide.

              Y libera ancho: la columna pasó de 152px a 84, y eso es lo que le
              devuelve espacio al nombre del cliente.

              Lo que cada acción hace al aplicarse NO cambia: el diálogo de
              pago y el de no pago son los mismos de siempre. */}
          <div className="flex items-center justify-end gap-1.5">
            {menuGestion(client, aplazado)}

            {/* EL OJO ENCIMA DE LOS TRES PUNTOS, no al lado: apilados ocupan
                una columna de 28px en vez de dos, y ese ancho se lo lleva el
                nombre. */}
            <div className="flex shrink-0 flex-col gap-0.5">
              <Button
                size="icon"
                variant="outline"
                className="h-[26px] w-[26px] rounded-full bg-transparent p-0"
                onClick={() => setExtractoClient(client)}
                title="Ver el extracto del cliente"
                aria-label="Ver el extracto del cliente"
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" className="h-[26px] w-[26px] rounded-full bg-transparent p-0">
                    <MoreVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {/* SUBIR Y BAJAR viven acá desde que la columna de flechas
                      se fue: medía 95px de alto y era la que decidía cuánto
                      media cada fila. Arrastrar la fila sigue funcionando. */}
                  <DropdownMenuItem
                    className="text-xs md:text-base cursor-pointer"
                    disabled={index === 0 || savingOrder}
                    onClick={() => handleMoveUp(index)}
                  >
                    <ArrowUp className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                    Subir en la ruta
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-xs md:text-base cursor-pointer"
                    disabled={index >= total - 1 || savingOrder}
                    onClick={() => handleMoveDown(index)}
                  >
                    <ArrowDown className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                    Bajar en la ruta
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
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
            </div>
          </div>
        </TableCell>
      </TableRow>
      )
  }

  // El guard y el boton de iniciar ruta viven en <RutaNoIniciada>: los usan
  // esta pantalla y el bloqueo global de los vendedores, y dos copias de la
  // logica terminarian discrepando en cuando se considera abierta una ruta.
  // Aca la exigencia es ABIERTA y no solo iniciada: con la jornada cerrada ya
  // no se cobra.
  if (rutaActivaEstado !== "abierta") {
    return (
      <RutaNoIniciada
        rutaId={currentRutaId}
        resuelto={rutaActivaResolved}
        estado={rutaActivaEstado ?? null}
        onEstadoChange={onRouteStateChange}
        mensaje="Para registrar pagos o no pagos primero debes iniciar la ruta del dia. Tambien puedes hacerlo desde la pestana Resumen del Dia."
        onIrAResumen={() => onViewChange("daily-summary")}
      />
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
                ? esIOS()
                  ? "En iPhone hay que habilitarlo desde Ajustes: Ajustes › Privacidad y seguridad › Localización › activarla, y ahí mismo buscar Safari y poner “Al usar la app”. Después volvé y recargá esta pantalla. El botón de acá no sirve: una vez que se dijo que no, Safari no vuelve a preguntar."
                  : "Debes permitir el acceso a la ubicación en la configuración del navegador para registrar pagos o no pagos."
                : esIOS()
                  ? "No se pudo leer la ubicación. Revisá que la Localización esté encendida en Ajustes › Privacidad y seguridad, y que Safari la tenga en “Al usar la app”. Si abriste la app desde el ícono del escritorio, el permiso se pide aparte del de Safari."
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

      {/* OJO con el Card de abajo: el grueso del "contenedor grande" de arriba
          NO era nuestro, lo ponía la librería. `py-6` mete 24px por encima del
          encabezado y `gap-6` otros 24 entre el encabezado y el listado — 48px
          de aire en una pantalla de teléfono. En móvil se van los dos.

          Van como `max-md:` y no como `py-0`/`gap-0` a secas porque
          competirían con `py-6`/`gap-6` por la misma propiedad, y ahí gana el
          orden del CSS generado, no el de las clases. Las variantes se emiten
          después, así que ganan siempre. */}
      {!selectedClient ? (
        <Card className="max-md:py-0 max-md:gap-0">
          {/* `border-b` NO se usa para la línea de abajo. El CardHeader de la
              librería trae `[.border-b]:pb-6`: con esa clase puesta se
              autoañade 24px de relleno inferior, y como es una variante le
              gana a cualquier `pb-*` que pongamos. La sombra de 1px se ve
              igual y no dispara esa regla.

              El `gap-2` propio del CardHeader tambien separa CADA hijo; en
              movil baja a 4px. */}
          <CardHeader
            className={`${encabezadoPlegado ? "p-2" : "p-3"} md:p-6 max-md:gap-1 sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--border)]`}
          >
            {/* Plegar el encabezado. Solo en móvil: en escritorio no sobra el
                espacio. Plegado sigue diciendo en qué modo está y cuántos
                faltan — es lo único del encabezado que el cobrador necesita
                tener a la vista mientras cobra, y sin eso plegarlo sería
                quedarse sin saber si está mirando Diario o No Diario. */}
            <button
              type="button"
              onClick={alternarEncabezado}
              aria-expanded={!encabezadoPlegado}
              className="md:hidden flex items-center justify-between gap-2 rounded-md px-1 py-0.5 text-muted-foreground hover:bg-muted"
            >
              <span className="text-[12px] font-semibold">
                {encabezadoPlegado
                  ? (() => {
                      // Plegado tambien se va la barra de pestanas, asi que
                      // esta linea tiene que decir DONDE esta parado: sin eso,
                      // Pendientes vacio y Gestionados vacio se ven igual.
                      if (activeTab === "aplazados") return `Pendientes · ${aplazadosDeLaRuta.length}`
                      if (activeTab === "gestionados") return `Gestionados · ${filteredManaged.length}`
                      if (activeTab === "ventas") return `Ventas del día · ${salesTodayCount}`
                      return `Pendientes · ${isDiario ? "Diario" : "No Diario"} · ${displayClients.length}${
                        moraFilter ? " · filtrado por mora" : ""
                      }`
                    })()
                  : "Ocultar encabezado"}
              </span>
              {encabezadoPlegado
                ? <ChevronDown className="h-5 w-5 shrink-0" />
                : <ChevronUp className="h-5 w-5 shrink-0" />}
            </button>

            <div className={`${ocultoEnMovil()} flex flex-col md:flex-row md:items-center md:justify-between gap-2`}>
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
              // Los de cuota FUTURA no entran en la cuenta del día: son ventas
              // recién hechas cuyo primer cobro todavía no llega. Siguen
              // visibles en la lista —se les puede cobrar por adelantado— pero
              // no son tarea de hoy, y contarlos dejaba el avance en "41 de 42"
              // para siempre. Es el mismo criterio que usa el cierre de caja
              // (`clientesSinGestionarHoy`), para que los dos no discrepen.
              const total = gestionados + sinGestionar.filter((c) => !c.nextPaymentEsFuturo).length
              if (total === 0) return null
              const recaudado = managedToday.reduce((s, m) => s + (m.valorAbonado || 0), 0)
              const pct = Math.round((gestionados / total) * 100)
              return (
                <div className={`${ocultoEnMovil()} px-1 pb-2 space-y-1`}>
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
            {activeTab !== "ventas" && (
              <Input
                placeholder="Buscar cliente por nombre o documento..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                // El buscador NO se pliega. Es lo unico del encabezado que se
                // usa MIENTRAS se cobra —encontrar al que toco la puerta sin
                // bajar por toda la ruta— y cuesta un renglon, no un tercio de
                // la pantalla como el resto.
                className="max-md:mt-0 mt-2 h-8 md:h-10 text-[12px] md:text-sm md:max-w-sm"
              />
            )}

            {/* Tab bar: Pendientes / Gestionados / Ventas
                Los dots debajo de la barra (solo en móvil) refuerzan la
                affordance de swipe horizontal. */}
            {/* Tab bar: cada botón ocupa 1/3 del ancho disponible para
                que los tres quepan exactamente en cualquier móvil sin
                desbordarse ni necesitar scroll. El texto largo se acorta
                en móvil con versiones compactas visibles solo en <md. */}
            {/* CUATRO pestañas. La de siempre pasa a llamarse RUTA —es el
                recorrido del día— y "Pendientes" queda libre para los que se
                aplazaron, que es lo que la palabra dice de verdad: gente a la
                que hay que volver.

                Con cuatro botones el texto ya no cabe en un teléfono, así que
                las dos de la derecha se quedan solo con su ícono y su número.
                Ruta y Pendientes conservan la palabra: son las dos entre las
                que se salta todo el día. */}
            {/* ── LAS CUATRO PESTAÑAS ──────────────────────────────────
                Sin texto: un ícono con color y su número. Con cuatro pestañas
                y un teléfono de 360px, "Gestionados" y "Ventas del día" ya
                venían recortados a la mitad o escondidos en `md:`, así que el
                nombre no estaba diciendo nada — y las pestañas quedaban de
                anchos distintos según lo que cupiera en cada una.

                El nombre NO se pierde: va en `title` y en `aria-label`, así
                que sigue estando para quien deje el dedo encima y para un
                lector de pantalla. Lo que se va es el texto que no cabía.

                Las cuatro salen del MISMO arreglo, que es lo que garantiza que
                midan igual: un `grid-cols-4` con `gap` reparte el ancho en
                cuartos exactos, pase lo que pase con los números. */}
            <div className={`${ocultoEnMovil()} mt-2 w-full`}>
              <div className="grid grid-cols-4 gap-1.5">
                {([
                  {
                    id: "pendientes" as const,
                    nombre: "Ruta",
                    Icono: MapPin,
                    // La ruta es el recorrido: azul de marca, el color del
                    // encabezado de la app.
                    color: "text-brand",
                    n: displayClients.length,
                  },
                  {
                    id: "aplazados" as const,
                    nombre: "Pendientes",
                    // EL MISMO RELOJ que se usa dentro del módulo — en el menú
                    // verde ("Dejar pendiente") y en la pastilla del aplazado.
                    // Tres reloj distintos para la misma idea serían tres cosas
                    // distintas a los ojos de quien cobra.
                    Icono: Clock,
                    color: "text-orange-500",
                    n: aplazadosDeLaRuta.length,
                  },
                  {
                    id: "gestionados" as const,
                    nombre: "Gestionados",
                    Icono: CheckCircle2,
                    color: "text-green-600",
                    n: filteredManaged.length,
                  },
                  {
                    id: "ventas" as const,
                    nombre: "Ventas del día",
                    Icono: ShoppingCart,
                    color: "text-green-600",
                    n: salesTodayCount,
                  },
                ]).map(({ id, nombre, Icono, color, n }) => {
                  const activa = activeTab === id
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setActiveTab(id)}
                      title={nombre}
                      aria-label={`${nombre}: ${n}`}
                      aria-current={activa ? "true" : undefined}
                      className={`flex items-center justify-center gap-1.5 rounded-xl px-1 py-2 shadow-sm transition-colors ${
                        activa ? "bg-brand/10" : "bg-muted/60 hover:bg-muted"
                      }`}
                    >
                      <Icono className={`h-5 w-5 shrink-0 ${color}`} />
                      {/* El número de la pestaña ACTIVA va en un círculo
                          lleno. Es la única marca que dice dónde estás cuando
                          no hay texto que resaltar. */}
                      <span
                        className={`shrink-0 text-[13px] font-bold tabular-nums ${
                          activa
                            ? "flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1 text-brand-foreground"
                            : "text-brand"
                        }`}
                      >
                        {n}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* El subrayado de la activa. Va en su propia rejilla de cuatro
                  para caer justo debajo de su pestaña, y sobre la línea gris
                  que separa la cabecera del listado. */}
              <div className="mt-1.5 grid grid-cols-4 gap-1.5 border-b border-border">
                {TAB_ORDER.map((t) => (
                  <span
                    key={t}
                    aria-hidden="true"
                    className={`h-[3px] rounded-full ${activeTab === t ? "bg-brand" : "bg-transparent"}`}
                  />
                ))}
              </div>
            </div>
            {/* Puntos de navegación — solo móvil, y TAMBIÉN se pliegan.
                Plegado no queda nada para cambiar de panel: hay que desplegar,
                tocar la pestaña y volver a plegar. Es a propósito — plegado, la
                pantalla es para cobrar, y para cobrar solo se usa Pendientes.

                (No hay deslizar el dedo: el comentario de más abajo lo decía,
                pero no hay ni un `onTouchStart` en el archivo.)

                El punto se ve chiquito pero el área de toque es de 32px
                (`p-2` alrededor). Antes el botón medía lo mismo que el punto
                —6px— y había que apuntarle. */}
            <div className={`${ocultoEnMovil()} flex md:hidden justify-center gap-0.5 pt-0.5`}>
              {TAB_ORDER.map((tab) => (
                <button
                  key={tab}
                  aria-label={`Ir a ${tab}`}
                  aria-current={activeTab === tab ? "true" : undefined}
                  onClick={() => setActiveTab(tab)}
                  className="p-2 flex items-center justify-center"
                >
                  <span
                    className={`block rounded-full transition-all duration-200 ${
                      activeTab === tab
                        ? "w-5 h-1.5 bg-primary"
                        : "w-1.5 h-1.5 bg-muted-foreground/40"
                    }`}
                  />
                </button>
              ))}
            </div>
          </CardHeader>

          {/* ── Contenedor deslizable ──────────────────────────────────────
               Los 3 paneles van en fila (100 % de ancho cada uno) y el
               `translateX` los corre según el índice activo.

               OJO: acá decía que en móvil se podía deslizar el dedo. NO se
               puede — no hay ni un `onTouchStart` en el archivo, nunca se
               implementó. Se cambia de panel con la barra de pestañas o con
               los puntos de abajo, y con el encabezado plegado quedan solo los
               puntos.
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
              // VUELVE A SER TABLA. Estuvo un rato en tarjetas, como el
              // listado de Gestionados, y se devolvio a peticion del dueno:
              // en la tabla cada dato tiene su columna y la vista recorre la
              // ruta de arriba abajo sin releer etiquetas.
              //
              // Lo que SI se conserva de esos dias: el nombre con el apodo
              // debajo, sin el % de interes, el numero que es la posicion real
              // y las flechas grandes.
              //
              // overflow-hidden (en lugar de overflow-x-auto): la tabla DEBE
              // caber dentro del viewport móvil sin scroll horizontal. El
              // nombre del cliente puede partirse en 2 líneas vía `break-words`
              // en la celda correspondiente.
              <div className="rounded-md border overflow-hidden">
                <Table className="w-full table-fixed">
                  <TableHeader>
                    {/* TRES COLUMNAS, no cuatro, y UNA fila por cliente.
                        Antes cada cliente ocupaba dos filas y ~110px: el nombre
                        cruzando las cuatro columnas y debajo orden, acciones,
                        frecuencia, mora, monto de venta, cuota, valor de cuota,
                        saldo, multa y fecha del último pago. En un teléfono
                        entraban cinco clientes; una ruta de cuarenta eran ocho
                        pantallazos.

                        Lo que se fue NO se perdió: se agrupó detrás del ojito
                        de cada fila (el "Extracto"). En la lista se queda lo
                        único que se mira mientras se cobra —quién es, cuánto
                        debe, por qué cuota va y cómo está de mora— y lo demás
                        se consulta cuando hace falta, que es casi nunca. */}
                    <TableRow>
                      {/* LOS ANCHOS SE CALCULARON CONTRA EL CONTENIDO REAL,
                          no a ojo. `table-fixed` respeta estos números pero NO
                          impide que el contenido se salga: la primera versión
                          le dio 142px a Acción cuando sus botones pedían 168, y
                          el sobrante se pintó encima del saldo.

                          Acción = 36 + 8 + 36 + 6 + 28 + 4 + 28 = 146px de
                          botones. Saldo = "$332.600" a 12px. Lo que queda es
                          para el nombre: ~124px en un teléfono de 360, que dan
                          para dos renglones. */}
                      <TableHead className="text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-2">Cliente</TableHead>
                      <TableHead className="w-[84px] md:w-[130px] text-right text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Saldo / Cuota</TableHead>
                      <TableHead className="w-[84px] md:w-[120px] text-center text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayClients.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground text-[12px] md:text-base py-2 md:py-4">
                          No se encontraron clientes activos
                        </TableCell>
                      </TableRow>
                    ) : (
                      displayClients.map((client, index) =>
                        filaCliente(client, index, displayClients.length, false))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>{/* fin Panel 0: Ruta */}

          {/* ── Panel 1: Pendientes (los aplazados) ────────────────────────
              La MISMA fila que la ruta —`filaCliente`— porque es el mismo
              cliente y las mismas acciones: desde acá también se le cobra o se
              le marca no pago, que es a lo que va. Lo único que cambia es que
              el reloj, en vez de aplazar, lo devuelve a la ruta. */}
          <div className="w-full shrink-0 p-2 md:p-6">
            {aplazadosDeLaRuta.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
                <Clock className="h-8 w-8 opacity-40" />
                <span className="text-sm">Nadie quedó pendiente por ahora.</span>
                <span className="max-w-xs text-xs">
                  Con el reloj del botón verde puedes dejar a un cliente para volver más
                  tarde, sin marcarle pago ni no pago.
                </span>
              </div>
            ) : (
              <div className="rounded-md border overflow-hidden">
                <Table className="w-full table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-2">Cliente</TableHead>
                      <TableHead className="w-[84px] md:w-[130px] text-right text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Saldo / Cuota</TableHead>
                      <TableHead className="w-[84px] md:w-[120px] text-center text-[12px] md:text-base whitespace-nowrap py-1 md:py-2 px-1">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {aplazadosDeLaRuta.map((client, index) =>
                      filaCliente(client, index, aplazadosDeLaRuta.length, true))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>{/* fin Panel 1: Pendientes */}

          {/* ── Panel 2: Gestionados ────────────────────────────────────── */}
          <div className="w-full shrink-0 p-2 md:p-6">
            <div className="space-y-2">
                {filteredManaged.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
                    <Users className="h-8 w-8 opacity-30" />
                    {/* Distinguir "no has gestionado a nadie" de "tu busqueda no
                        encontro a nadie": con el mismo texto para los dos, el
                        cobrador cree que perdio el trabajo del dia. */}
                    <p className="text-xs md:text-sm">
                      {sortedManaged.length === 0
                        ? "No hay clientes gestionados hoy"
                        : `Ningún gestionado coincide con "${searchTerm}"`}
                    </p>
                    {sortedManaged.length > 0 && (
                      <Button variant="outline" size="sm" onClick={() => setSearchTerm("")}>
                        Ver los {sortedManaged.length} gestionados
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                  <div className="space-y-1.5">
                    {filteredManaged.map((m, index) => (
                      <div
                        key={m.loanId}
                        // Mismo criterio que la lista de Pendientes: al sol,
                        // un borde de 1px sobre franjeado al 40% es blanco
                        // contra blanco. Borde grueso + franja de color al
                        // inicio, verde si pagó y roja si no.
                        className={`rounded-lg border-2 border-border border-l-4 px-3 py-2 ${
                          m.gestionTipo === "pago"
                            ? "border-l-green-500"
                            : m.gestionTipo === "aplazado"
                              ? "border-l-amber-500"
                              : "border-l-red-500"
                        } ${index % 2 === 0 ? "bg-card" : "bg-muted"}`}
                      >
                        {/* Línea 1: SOLO el nombre, con todo el ancho.
                            Compartía renglón con la insignia del monto y con la
                            hora, que juntas se llevan unos 180px de los 336 que
                            tiene la tarjeta en un teléfono: al nombre le
                            quedaban 150 y se partía en tres o cuatro renglones
                            contra el monto. Solo, le sobra para dos. */}
                        <div className="min-w-0">
                          {/* El nombre ENVUELVE, no se corta. Con `truncate` un
                              nombre largo terminaba en "..." y el cobrador no
                              podia distinguir dos clientes del mismo apellido.
                              Va un punto mas pequeño en movil, que es donde se
                              acaba el ancho; en pantalla grande se queda igual.

                              `min-w-0` es CRITICO: sin eso el span impone su
                              ancho intrinseco al flex item, desborda la fila y
                              se solapa con el badge de estado. */}
                          <span className="block font-semibold text-[13px] md:text-sm leading-tight break-words [overflow-wrap:anywhere]">
                            {m.nombreCompleto}
                          </span>
                          {m.apodo && (
                            <span className="block text-[11px] md:text-xs text-muted-foreground leading-tight break-words [overflow-wrap:anywhere]">
                              {m.apodo}
                            </span>
                          )}
                        </div>

                        {/* Línea 2: qué pasó, por cuánto y a qué hora. */}
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          {/* El valor abonado va DENTRO de la insignia, pegado
                              a "Pago": es el par que el cobrador busca de un
                              vistazo — qué pasó y por cuánto. Abajo, entre
                              Cuota/Préstamo/Saldo, se perdía entre tres cifras
                              más que se parecen. */}
                          {m.gestionTipo === "pago" ? (
                            <span className="inline-flex items-center gap-1 text-[12px] font-bold text-green-700 bg-green-100 px-2 py-1 rounded-full shrink-0">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Pago ${(m.valorAbonado ?? 0).toLocaleString()}
                            </span>
                          ) : m.gestionTipo === "aplazado" ? (
                            /* La misma insignia que lleva en la pestaña
                               Pendientes, en el mismo sitio donde las otras
                               dicen Pago o No pago: la fila se lee igual que
                               las demás y lo único que cambia es qué pasó.
                               Sin monto, porque no hubo. */
                            <span className="inline-flex items-center gap-1 text-[12px] font-bold text-amber-700 bg-amber-100 px-2 py-1 rounded-full shrink-0">
                              <Clock className="h-3.5 w-3.5" />
                              Pendiente
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[12px] font-bold text-red-700 bg-red-100 px-2 py-1 rounded-full shrink-0">
                              <XCircle className="h-3.5 w-3.5" />No pago
                            </span>
                          )}
                          {/* TRANSFERENCIA. Va pegada a la insignia del pago
                              porque es parte de la misma frase: cuánto y cómo.
                              Solo sale cuando NO fue efectivo — el efectivo es
                              lo normal, y marcarlo también dejaría la lista
                              llena de etiquetas que no distinguen nada. */}
                          {m.metodoPago && m.metodoPago !== "efectivo" && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-info-light px-2 py-1 text-[11px] font-bold text-info shrink-0">
                              <ArrowLeftRight className="h-3.5 w-3.5" />
                              {m.metodoPago === "mixto" ? "Mixto" : "Transferencia"}
                            </span>
                          )}
                          <span className="text-[11px] text-muted-foreground shrink-0">{m.gestionHora}</span>
                        </div>
                        {/* Línea 3: los datos a la izquierda, las acciones a la
                            derecha. Los tres botones estaban arriba, apretando
                            el nombre contra la insignia y midiendo 24px — por
                            debajo del mínimo de un dedo (44px). Acá abajo hay
                            sitio y quedan en 40px, con borde para que se vean
                            sin tener que tocarlos a ver si están. */}
                        <div className="flex items-end justify-between gap-2 mt-1.5">
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 min-w-0">
                            <span className="text-[11px] text-muted-foreground">Cuota: <span className="font-semibold text-foreground">${m.valorCuota.toLocaleString()}</span></span>
                            <span className="text-[11px] text-muted-foreground">Préstamo: <span className="font-semibold text-info">${m.valorPrestamo.toLocaleString()}</span></span>
                            <span className="text-[11px] text-muted-foreground">Saldo: <span className="font-semibold text-warning">${Math.round(m.saldo).toLocaleString()}</span></span>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {/* AL APLAZADO NO SE LE CORRIGE NADA: se le cobra.
                                No hay gestión detrás suyo —ni pago ni no pago—
                                así que un lápiz que abre "corregir esta
                                gestión" no tendría qué corregir. Lleva el mismo
                                botón verde de la ruta, con el que se resuelve
                                ahí mismo sin ir a buscarlo a la otra pestaña. */}
                            {m.gestionTipo === "aplazado" ? (
                              menuGestion(m, true)
                            ) : (
                              <>
                            {/* EL LÁPIZ ES UN MENÚ, no un botón.
                                Antes eran dos botones sueltos —lápiz y
                                basurero— y el basurero, en rojo y del mismo
                                tamaño que el otro, invitaba a tocarlo. Ahora
                                las cuatro salidas viven detrás del lápiz, con
                                su nombre escrito, y para llegar a la que
                                deshace hay que bajar hasta el final.

                                Los nombres son los MISMOS del menú verde de la
                                ruta —Pago, No Pago, Pendiente— porque son las
                                mismas tres cosas: lo que cambia es que acá ya
                                hay una gestión y se está corrigiendo. */}
<DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  title="Corregir esta gestión"
                                  aria-label="Corregir esta gestión"
                                  className="h-10 w-10 border-info/40 text-info hover:text-info hover:bg-info-light"
                                  disabled={savingManaged}
                                >
                                  <Pencil className="h-5 w-5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-52">
                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => {
                                    setEditingManaged(m)
                                    setEditTipo("pago")
                                    // Viniendo de un no pago no hay monto
                                    // anterior que proponer: se ofrece la
                                    // cuota, que es lo que debía ese día.
                                    setEditMonto(
                                      m.gestionTipo === "pago"
                                        ? (m.valorAbonado ?? 0).toString()
                                        : (m.valorCuota ?? 0).toString(),
                                    )
                                  }}
                                >
                                  <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-600">
                                    <Check className="h-3 w-3 text-white" strokeWidth={3} />
                                  </span>
                                  <span className="font-semibold text-green-700">Pago</span>
                                </DropdownMenuItem>

                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => {
                                    setEditingManaged(m)
                                    setEditTipo("no_pago")
                                    setEditMonto((m.valorCuota ?? 0).toString())
                                  }}
                                >
                                  <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600">
                                    <X className="h-3 w-3 text-white" strokeWidth={3} />
                                  </span>
                                  <span className="font-semibold text-red-700">No Pago</span>
                                </DropdownMenuItem>

                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => { void gestionadoAPendiente(m) }}
                                >
                                  <Clock className="mr-2 h-5 w-5 shrink-0 text-orange-500" strokeWidth={2.5} />
                                  <span className="font-semibold">Pendiente</span>
                                </DropdownMenuItem>

                                <DropdownMenuSeparator />

                                {/* ELIMINAR es la palabra que el cobrador
                                    busca, pero por dentro NO borra nada:
                                    registra una reversa. El evento original y
                                    su anulación quedan los dos en el
                                    historial, y el diálogo de confirmación lo
                                    dice con todas las letras. */}
                                <DropdownMenuItem
                                  className="cursor-pointer text-sm font-medium"
                                  onClick={() => setAnularManaged(m)}
                                >
                                  <Trash2 className="mr-2 h-5 w-5 shrink-0 text-destructive" />
                                  <span className="font-semibold text-destructive">Eliminar</span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                              </>
                            )}

                            {/* EL OJO, el mismo extracto del módulo de pagos.
                                Mismo icono, mismo diálogo, misma información:
                                dos fichas distintas del mismo cliente según
                                por qué pestaña se entre serían dos verdades. */}
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-10 w-10"
                              onClick={() => setExtractoClient(m)}
                              title="Ver el extracto del cliente"
                              aria-label="Ver el extracto del cliente"
                            >
                              <Eye className="h-5 w-5" />
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="outline" className="h-10 w-10" aria-label="Más opciones">
                                  <MoreVertical className="h-5 w-5" />
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
                                {/* Un aplazado no movió plata, así que no hay
                                    recibo que generar. */}
                                {m.gestionTipo !== "aplazado" && (
                                  <DropdownMenuItem
                                    className="text-xs md:text-base cursor-pointer"
                                    onClick={() => handleGenerarRecibo(m)}
                                  >
                                    <Receipt className="mr-2 h-3 w-3 md:h-4 md:w-4" />
                                    Generar recibo
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
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

      {/* ── EXTRACTO DEL CLIENTE ──────────────────────────────────────
          Lo que se sacó de la fila para que quepan más clientes. No es una
          pantalla nueva: es la MISMA información de antes, agrupada donde se
          consulta en vez de repetida cuarenta veces donde estorba. */}
      <Dialog open={!!extractoClient} onOpenChange={(o) => { if (!o) setExtractoClient(null) }}>
        <DialogContent className="max-h-[88vh] max-w-md overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="text-base">Extracto del cliente</DialogTitle>
            <DialogDescription className="text-sm font-semibold text-foreground">
              {extractoClient?.nombreCompleto}
              {extractoClient?.apodo && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {extractoClient.apodo}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {extractoClient && (() => {
            const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`
            const fecha = (f: string) => {
              if (!f) return "—"
              const [y, m, d] = f.split("-")
              return d ? `${d}/${m}/${y}` : f
            }
            // Dos columnas, cada dato con su nombre encima. `null` en el valor
            // apaga la fila entera: una multa que no existe no merece un
            // renglón que diga "$0".
            const datos: [string, React.ReactNode][] = [
              ["Fecha de venta", fecha(extractoClient.fechaVenta)],
              ["Frecuencia", `${frecuenciaLabel(extractoClient.frecuenciaPago)}${
                extractoClient.frecuenciaPago !== "daily" && extractoClient.diaSemana
                  ? ` · ${extractoClient.diaSemana.charAt(0).toUpperCase()}${extractoClient.diaSemana.slice(1)}`
                  : ""
              }`],
              ["Valor prestado", fmt(extractoClient.valorVenta)],
              ["Interés", `${extractoClient.tasaInteres ?? 0}%`],
              ["Total a pagar", fmt(extractoClient.totalAPagar)],
              ["Valor de cuota", fmt(extractoClient.valorCuota)],
              ["Cuotas", `${extractoClient.cuotasPagadas}/${extractoClient.cuotasTotales}`],
              ["Abonado", fmt(extractoClient.abonado)],
            ]
            return (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/30 p-3">
                  {datos.map(([k, v]) => (
                    <div key={k}>
                      <p className="text-[11px] leading-tight text-muted-foreground">{k}</p>
                      <p className="text-sm font-semibold leading-tight text-foreground tabular-nums">{v}</p>
                    </div>
                  ))}

                  {/* El saldo y el estado van aparte y más grandes: son las dos
                      cosas por las que se abre este extracto. */}
                  <div>
                    <p className="text-[11px] leading-tight text-muted-foreground">Saldo</p>
                    <p className="text-lg font-bold leading-tight text-foreground tabular-nums">
                      {fmt(extractoClient.saldo)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] leading-tight text-muted-foreground">Estado</p>
                    {/* "1 cuota" a secas no dice si es lo que lleva pagado o
                        lo que debe. Con "Mora:" delante se lee de una. */}
                    <p className={`text-lg font-bold leading-tight ${moraTexto(extractoClient.mora)}`}>
                      {extractoClient.mora > 0
                        ? `Mora: ${etiquetaMora(extractoClient.mora)}`
                        : "Al día"}
                    </p>
                  </div>

                  {extractoClient.multaPendiente && (
                    <div>
                      <p className="text-[11px] leading-tight text-muted-foreground">Multa pendiente</p>
                      <p className="text-sm font-bold leading-tight text-destructive tabular-nums">
                        {fmt(extractoClient.multaPendiente.valor)}
                      </p>
                    </div>
                  )}
                  {extractoClient.ultimoPagoFecha && (
                    <div>
                      <p className="text-[11px] leading-tight text-muted-foreground">Último pago</p>
                      <p className="text-sm font-semibold leading-tight text-foreground tabular-nums">
                        {fecha(extractoClient.ultimoPagoFecha)}
                        {extractoClient.ultimoPago > 0 && (
                          <span className="ml-1 font-normal text-muted-foreground">
                            {fmt(extractoClient.ultimoPago)}
                          </span>
                        )}
                      </p>
                    </div>
                  )}
                </div>

                {/* ACCESO DIRECTO AL HISTORIAL, como en el boceto. El
                    extracto contesta "cómo va este crédito"; el historial,
                    "qué ha pasado día por día". Son dos preguntas seguidas y
                    por eso la segunda se abre desde la primera, sin volver a
                    la lista y buscar el menú. */}
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-accent/40"
                  onClick={() => {
                    const c = extractoClient
                    setExtractoClient(null)
                    setPaymentHistoryClient(c)
                    setPaymentHistoryOpen(true)
                  }}
                >
                  <span className="text-sm font-semibold text-foreground">
                    Historial de pagos
                    {extractoMovimientos !== null && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({extractoMovimientos})
                      </span>
                    )}
                  </span>
                  <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </div>
            )
          })()}
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
            <DialogTitle className="text-sm md:text-lg">Editar gestión — {editingManaged?.nombre}</DialogTitle>
            <DialogDescription className="text-[11px] md:text-sm">
              No se borra nada: se anula la gestión anterior y queda la
              corrección, las dos en el historial.
            </DialogDescription>
          </DialogHeader>

          {/* Los dos estados como botones grandes y no como un desplegable:
              se usa con el pulgar y en la calle. 44px de alto es el mínimo
              para un dedo; un <select> nativo queda en 20. */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setEditTipo("pago")}
              className={`flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors ${
                editTipo === "pago"
                  ? "border-green-500 bg-green-100 text-green-700"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <CheckCircle2 className="h-4 w-4" />
              Pago
            </button>
            <button
              type="button"
              onClick={() => setEditTipo("no_pago")}
              className={`flex items-center justify-center gap-1.5 rounded-lg border-2 py-2.5 text-sm font-bold transition-colors ${
                editTipo === "no_pago"
                  ? "border-red-500 bg-red-100 text-red-700"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              <XCircle className="h-4 w-4" />
              No pago
            </button>
          </div>

          {editTipo === "pago" ? (
            <div className="space-y-1.5">
              <label className="text-xs md:text-sm text-muted-foreground">
                {editingManaged?.gestionTipo === "pago" ? "Nuevo monto abonado" : "Monto que pagó"}
              </label>
              <Input
                type="number"
                step="0.01"
                value={editMonto}
                onChange={(e) => setEditMonto(e.target.value)}
                className="h-9 text-sm"
                autoFocus
              />
            </div>
          ) : (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-snug text-red-700">
              Queda como visita sin pago.
              {editingManaged?.gestionTipo === "pago" &&
                ` Se anula el pago de $${(editingManaged?.valorAbonado ?? 0).toLocaleString()}.`}
            </p>
          )}

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
          {/* VISTA PREVIA. Además de dejar ver qué se va a mandar, es la
              salida de emergencia en los iPhone viejos (iOS 14 y anteriores):
              ahí no existe `canShare({files})` Y el enlace de descarga tampoco
              funciona — Safari navega en vez de guardar. Manteniendo pulsada
              la imagen, el teléfono ofrece "Guardar imagen" y "Compartir". */}
          {reciboListo && (
            <img
              src={reciboListo.dataUrl}
              alt="Comprobante de pago"
              className="mx-auto max-h-[45vh] w-auto rounded-md border border-border"
            />
          )}
          <div className="flex flex-col gap-2 pt-2 md:pt-4">
            {/* `onClick={handleShareComprobante}` a secas: sin envolverlo en
                una función async, para que el navegador vea la llamada a
                `share()` dentro del mismo gesto del usuario. */}
            <Button
              className="h-9 md:h-10 text-xs md:text-base gap-1.5"
              disabled={sharingPdf || preparandoRecibo || !reciboListo}
              onClick={handleShareComprobante}
            >
              {preparandoRecibo || sharingPdf ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Share2 className="h-4 w-4" />
              )}
              {preparandoRecibo ? "Preparando…" : "Compartir"}
            </Button>
            <Button
              variant="outline"
              className="h-9 md:h-10 text-xs md:text-base gap-1.5"
              disabled={sharingPdf || preparandoRecibo || !reciboListo}
              onClick={() => {
                if (!reciboListo) return
                const a = document.createElement("a")
                a.href = reciboListo.dataUrl
                a.download = reciboListo.filename
                a.click()
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
                    {/* El % de interes vive ACA y ya no en la lista de cobro:
                        es un dato que se consulta, no que se recorre. */}
                    <TableHead className="text-[10px] md:text-xs px-1 md:px-3 text-right">Interés</TableHead>
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
                        <TableCell className="text-[10px] md:text-xs px-1 md:px-3 text-right tabular-nums">
                          {row.tasa_interes != null ? `${row.tasa_interes}%` : "—"}
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
