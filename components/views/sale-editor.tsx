"use client"

/**
 * Editor de ventas — el "Control total" de secretaría
 * ---------------------------------------------------------------------------
 * Aquí se edita CUALQUIER venta y su plan de pagos, tenga o no gestiones
 * registradas. Es el hermano sin restricciones de `payment-control.tsx`.
 *
 * POR QUÉ SE PUEDE EDITAR TODO SIN MIEDO
 * --------------------------------------
 * El núcleo nuevo (scripts 041-049) separó dos cosas que antes vivían
 * revueltas:
 *
 *   payment_plan  = el cronograma pactado. `fecha_pago` es el VENCIMIENTO.
 *   gestiones     = el libro de eventos, INSERT-only: nada se borra ni se
 *                   modifica, ni siquiera para corregir.
 *
 * Todo lo financiero (saldo, mora, cuotas cubiertas) se DERIVA de esos dos
 * por cascada: la plata neta se reparte sobre las cuotas de la más antigua a
 * la más nueva. Por eso regenerar el plan no pierde un peso — la plata se
 * vuelve a repartir sola sobre el plan nuevo.
 *
 * LAS TRES ESCRITURAS (todas RPC atómicas, ninguna toca tablas a mano)
 *   · editar_venta_atomica  → regenera el cronograma desde el servidor.
 *   · ajustar_cronograma    → crear / editar / eliminar una cuota suelta.
 *   · corregir_gestion      → anular o "editar" un evento; el original nunca
 *                             se toca: se materializa como reversa + evento
 *                             nuevo, y ambos quedan en el historial.
 *
 * Después de cada escritura se recargan préstamo + financiero + cuotas +
 * gestiones, porque el servidor es el único que sabe cómo quedó el derivado.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useToast } from "@/hooks/use-toast"
import { getSupabaseSafe, callRpcAtomic } from "@/lib/api-helper"
import {
  COLUMNAS_GESTION,
  etiquetaFrecuencia,
  etiquetaMora,
  fmtFecha,
  fmtFechaHora,
  fmtMoneda,
  nuevaGestionId,
  todayColombia,
  type Gestion,
} from "@/lib/gestion-core"
import {
  buildPaymentSchedule,
  type Frecuencia,
  type TipoAmortizacion,
} from "@/lib/loan-schedule"
import {
  AlertCircle,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Edit2,
  History,
  Info,
  ListChecks,
  Loader2,
  MapPin,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Trash2,
} from "lucide-react"

// ── Props ───────────────────────────────────────────────────────────────────

interface SaleEditorProps {
  currentRutaId: number
  /** Si viene, se abre directamente ese préstamo sin pasar por el buscador. */
  loanIdInicial?: string
  onBack?: () => void
}

// ── Formas de los datos ─────────────────────────────────────────────────────

interface ClienteMin {
  nombre_completo: string
  apodo: string | null
  documento: string
}

interface PrestamoRow {
  id: string
  client_id: string | null
  valor: number
  valor_a_pagar: number
  valor_cuota: number
  saldo: number
  tasa_interes: number
  numero_cuotas: number
  tipo_amortizacion: string | null
  frecuencia_pago: string | null
  dia_semana: string | null
  fecha_primer_pago: string | null
  prestamo_empleado: boolean
  tipo_venta: string | null
  cuenta_id: number | null
  estado: string
  fecha_creacion: string | null
  ruta: number
  cliente: ClienteMin
}

/** Fila de `v_loan_financiero`: el estado derivado del préstamo. */
interface Financiero {
  total_a_pagar: number
  total_pagado: number
  saldo: number
  saldo_hoy: number
  saldo_en_mora: number
  cuotas_mora: number
  cuotas_cubiertas: number
  cuotas_totales: number
  cuotas_extra: number
  fecha_ultimo_pago: string | null
}

/** Fila de `v_cobertura_cuotas` + capital/interés del cronograma. */
interface CuotaRow {
  id: string
  numero_cuota: number
  fecha_pago: string
  valor_cuota: number
  es_extra: boolean
  monto_asignado: number
  estado_derivado: string
  capital: number | null
  interes: number | null
}

const COLUMNAS_LOAN =
  "id, client_id, valor, valor_a_pagar, valor_cuota, saldo, tasa_interes, " +
  "numero_cuotas, tipo_amortizacion, frecuencia_pago, dia_semana, " +
  "fecha_primer_pago, prestamo_empleado, tipo_venta, cuenta_id, estado, " +
  "fecha_creacion, ruta, clients:clients(nombre_completo, apodo, documento)"

const COLUMNAS_FINANCIERO =
  "loan_id, total_a_pagar, total_pagado, saldo, saldo_hoy, saldo_en_mora, " +
  "cuotas_mora, cuotas_cubiertas, cuotas_totales, cuotas_extra, fecha_ultimo_pago"

// ── Etiquetas y colores ─────────────────────────────────────────────────────

const ESTILO_CUOTA: Record<string, { label: string; badge: string; fila: string }> = {
  pagado:    { label: "Pagada",    badge: "bg-green-100 text-green-800 border-green-200", fila: "bg-green-50/40" },
  pendiente: { label: "Pendiente", badge: "bg-slate-100 text-slate-700 border-slate-200", fila: "" },
  parcial:   { label: "Parcial",   badge: "bg-amber-100 text-amber-800 border-amber-200", fila: "bg-amber-50/40" },
  no_pago:   { label: "No pago",   badge: "bg-red-100 text-red-800 border-red-200",       fila: "bg-red-50/40" },
  cancelada: { label: "Cancelada", badge: "bg-blue-100 text-blue-800 border-blue-200",    fila: "bg-blue-50/40" },
}

const ESTILO_GESTION: Record<string, { label: string; badge: string }> = {
  pago:        { label: "Pago",           badge: "bg-green-100 text-green-800 border-green-200" },
  no_pago:     { label: "No pago",        badge: "bg-red-100 text-red-800 border-red-200" },
  cancelacion: { label: "Cancelación",    badge: "bg-blue-100 text-blue-800 border-blue-200" },
  abono_venta: { label: "Abono de venta", badge: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  extension:   { label: "Extensión",      badge: "bg-purple-100 text-purple-800 border-purple-200" },
  ajuste:      { label: "Ajuste",         badge: "bg-amber-100 text-amber-800 border-amber-200" },
  reversa:     { label: "Reversa",        badge: "bg-slate-200 text-slate-800 border-slate-300" },
}

/** Los eventos que `corregir_gestion` acepta (el resto se corrige por otro lado). */
const TIPOS_CORREGIBLES = ["pago", "no_pago", "cancelacion", "abono_venta"]

const DIAS_SEMANA = [
  { value: "lunes", label: "Lunes" },
  { value: "martes", label: "Martes" },
  { value: "miercoles", label: "Miércoles" },
  { value: "jueves", label: "Jueves" },
  { value: "viernes", label: "Viernes" },
  { value: "sabado", label: "Sábado" },
  { value: "domingo", label: "Domingo" },
]

type FiltroEstado = "activos" | "cancelados" | "todos"

/** Qué operación está en vuelo (deshabilita el botón y pinta el spinner). */
type EnCurso =
  | null
  | "terminos"
  | "cuota-editar"
  | "cuota-crear"
  | "cuota-eliminar"
  | "gestion-corregir"
  | "gestion-anular"

// ── Componente ──────────────────────────────────────────────────────────────

export function SaleEditor({ currentRutaId, loanIdInicial, onBack }: SaleEditorProps) {
  const { toast } = useToast()
  const hoy = todayColombia()

  // Buscador
  const [prestamos, setPrestamos] = useState<PrestamoRow[]>([])
  const [cargandoLista, setCargandoLista] = useState(true)
  const [busqueda, setBusqueda] = useState("")
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>("activos")
  // Filtro de ruta: secretaría atiende varias, y el préstamo que hay que
  // corregir no tiene por qué estar en la que uno tenga abierta.
  const [rutas, setRutas] = useState<{ id: number; nombre: string }[]>([])
  const [rutaFiltro, setRutaFiltro] = useState<number | "todas">(currentRutaId)

  // Préstamo abierto
  const [loanId, setLoanId] = useState<string | null>(loanIdInicial ?? null)
  const [prestamo, setPrestamo] = useState<PrestamoRow | null>(null)
  const [financiero, setFinanciero] = useState<Financiero | null>(null)
  const [cuotas, setCuotas] = useState<CuotaRow[]>([])
  const [gestiones, setGestiones] = useState<Gestion[]>([])
  const [cargandoDetalle, setCargandoDetalle] = useState(false)
  const [tab, setTab] = useState("terminos")

  // Catálogos
  const [usuarios, setUsuarios] = useState<Record<number, string>>({})
  const [cuentas, setCuentas] = useState<{ id: string; nombre: string }[]>([])

  // Formulario de términos
  const [fValor, setFValor] = useState("")
  const [fTasa, setFTasa] = useState("")
  const [fCuotas, setFCuotas] = useState("")
  const [fTipoAm, setFTipoAm] = useState<TipoAmortizacion>("aleman")
  const [fFrecuencia, setFFrecuencia] = useState<Frecuencia>("daily")
  const [fDiaSemana, setFDiaSemana] = useState("")
  const [fPrimerPago, setFPrimerPago] = useState("")
  const [fEmpleado, setFEmpleado] = useState(false)
  const [fTipoVenta, setFTipoVenta] = useState("efectivo")
  const [fCuentaId, setFCuentaId] = useState("")

  // Diálogos
  const [confirmarTerminos, setConfirmarTerminos] = useState(false)
  const [cuotaEditando, setCuotaEditando] = useState<CuotaRow | null>(null)
  const [cuotaEliminando, setCuotaEliminando] = useState<CuotaRow | null>(null)
  const [crearAbierto, setCrearAbierto] = useState(false)
  const [gestionCorrigiendo, setGestionCorrigiendo] = useState<Gestion | null>(null)
  const [gestionAnulando, setGestionAnulando] = useState<Gestion | null>(null)

  // Campos de los diálogos de cuota
  const [cFecha, setCFecha] = useState("")
  const [cValor, setCValor] = useState("")
  const [cCapital, setCCapital] = useState("")
  const [cInteres, setCInteres] = useState("")
  const [cEsExtra, setCEsExtra] = useState(true)

  // Campos de los diálogos de gestión
  const [gMonto, setGMonto] = useState("")
  const [gFecha, setGFecha] = useState("")
  const [gMotivo, setGMotivo] = useState("")

  const [enCurso, setEnCurso] = useState<EnCurso>(null)

  const errorToast = useCallback(
    (titulo: string, err: unknown) => {
      // El mensaje del servidor se muestra TAL CUAL: dice exactamente qué
      // regla se violó, y eso es lo que le sirve a quien está corrigiendo.
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[v0] SaleEditor ${titulo}:`, err)
      toast({ title: titulo, description: msg, variant: "destructive" })
    },
    [toast],
  )

  // ── Catálogos (una sola vez) ──────────────────────────────────────────────
  useEffect(() => {
    let cancelado = false
    ;(async () => {
      try {
        const supabase = await getSupabaseSafe()
        const { data } = await supabase.from("usuarios").select("id, nombre")
        if (cancelado) return
        const mapa: Record<number, string> = {}
        for (const u of (data ?? []) as { id: number; nombre: string | null }[]) {
          mapa[Number(u.id)] = u.nombre ?? `Usuario ${u.id}`
        }
        setUsuarios(mapa)
      } catch (err) {
        console.error("[v0] SaleEditor usuarios error:", err)
      }
    })()
    fetch(`/api/cuentas?ruta=${currentRutaId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelado) setCuentas(Array.isArray(d) ? d : [])
      })
      .catch((err) => console.error("[v0] SaleEditor cuentas error:", err))
    return () => {
      cancelado = true
    }
  }, [currentRutaId])

  // ── Catálogo de rutas ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelado = false
    getSupabaseSafe()
      .then((supabase) => supabase.from("rutas").select("id, nombre").order("id"))
      .then(({ data }) => {
        if (!cancelado) setRutas((data ?? []) as { id: number; nombre: string }[])
      })
      .catch((err) => console.error("[v0] SaleEditor rutas error:", err))
    return () => {
      cancelado = true
    }
  }, [])

  const nombreRuta = useCallback(
    (id: number) => rutas.find((r) => r.id === id)?.nombre ?? `Ruta ${id}`,
    [rutas],
  )

  // ── Listado de préstamos de la ruta elegida ───────────────────────────────
  useEffect(() => {
    let cancelado = false
    ;(async () => {
      setCargandoLista(true)
      try {
        const supabase = await getSupabaseSafe()
        let q = supabase
          .from("loans")
          .select(COLUMNAS_LOAN)
          .order("fecha_creacion", { ascending: false })
        // Sin RLS, el filtro por ruta es responsabilidad de la app.
        if (rutaFiltro !== "todas") q = q.eq("ruta", rutaFiltro)
        const { data, error } = await q
        if (cancelado) return
        if (error) throw error
        setPrestamos((data ?? []).map(mapPrestamo))
      } catch (err) {
        if (!cancelado) errorToast("No se pudieron cargar los préstamos", err)
      } finally {
        if (!cancelado) setCargandoLista(false)
      }
    })()
    return () => {
      cancelado = true
    }
  }, [rutaFiltro, errorToast])

  // ── Detalle del préstamo abierto ──────────────────────────────────────────
  const cargarDetalle = useCallback(
    async (id: string) => {
      setCargandoDetalle(true)
      try {
        const supabase = await getSupabaseSafe()
        const [resPrestamo, resFin, resCuotas, resPlan, resGestiones] = await Promise.all([
          // Se busca por id, sin atar a una ruta: este módulo trabaja sobre
          // todas y el préstamo se eligió de una lista que el usuario ya vio.
          supabase.from("loans").select(COLUMNAS_LOAN).eq("id", id).maybeSingle(),
          supabase.from("v_loan_financiero").select(COLUMNAS_FINANCIERO).eq("loan_id", id).maybeSingle(),
          supabase
            .from("v_cobertura_cuotas")
            .select("id, loan_id, numero_cuota, fecha_pago, valor_cuota, es_extra, monto_asignado, estado_derivado")
            .eq("loan_id", id)
            .order("fecha_pago", { ascending: true })
            .order("numero_cuota", { ascending: true }),
          supabase.from("payment_plan").select("id, capital, interes").eq("loan_id", id),
          supabase.from("gestiones").select(COLUMNAS_GESTION).eq("loan_id", id).order("fecha_hora", { ascending: false }),
        ])

        if (resPrestamo.error) throw resPrestamo.error
        if (!resPrestamo.data) {
          throw new Error("El préstamo no existe.")
        }
        setPrestamo(mapPrestamo(resPrestamo.data))

        if (resFin.error) console.error("[v0] SaleEditor v_loan_financiero error:", resFin.error.message)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const f = resFin.data as any
        setFinanciero(
          f
            ? {
                total_a_pagar: Number(f.total_a_pagar ?? 0),
                total_pagado: Number(f.total_pagado ?? 0),
                saldo: Number(f.saldo ?? 0),
                saldo_hoy: Number(f.saldo_hoy ?? 0),
                saldo_en_mora: Number(f.saldo_en_mora ?? 0),
                cuotas_mora: Number(f.cuotas_mora ?? 0),
                cuotas_cubiertas: Number(f.cuotas_cubiertas ?? 0),
                cuotas_totales: Number(f.cuotas_totales ?? 0),
                cuotas_extra: Number(f.cuotas_extra ?? 0),
                fecha_ultimo_pago: f.fecha_ultimo_pago ?? null,
              }
            : null,
        )

        // capital/interés viven en payment_plan, no en la vista de cobertura:
        // se cruzan aquí para poder precargarlos en el diálogo de edición.
        const extras = new Map<string, { capital: number | null; interes: number | null }>()
        for (const p of (resPlan.data ?? []) as { id: string; capital: number | null; interes: number | null }[]) {
          extras.set(p.id, {
            capital: p.capital == null ? null : Number(p.capital),
            interes: p.interes == null ? null : Number(p.interes),
          })
        }
        if (resCuotas.error) console.error("[v0] SaleEditor v_cobertura_cuotas error:", resCuotas.error.message)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setCuotas(((resCuotas.data ?? []) as any[]).map((c) => ({
          id: c.id,
          numero_cuota: Number(c.numero_cuota ?? 0),
          fecha_pago: c.fecha_pago ?? "",
          valor_cuota: Number(c.valor_cuota ?? 0),
          es_extra: !!c.es_extra,
          monto_asignado: Number(c.monto_asignado ?? 0),
          estado_derivado: c.estado_derivado ?? "pendiente",
          capital: extras.get(c.id)?.capital ?? null,
          interes: extras.get(c.id)?.interes ?? null,
        })))

        if (resGestiones.error) console.error("[v0] SaleEditor gestiones error:", resGestiones.error.message)
        setGestiones((resGestiones.data ?? []) as unknown as Gestion[])
      } catch (err) {
        errorToast("No se pudo cargar el préstamo", err)
        setPrestamo(null)
      } finally {
        setCargandoDetalle(false)
      }
    },
    [currentRutaId, errorToast],
  )

  useEffect(() => {
    if (!loanId) {
      setPrestamo(null)
      setFinanciero(null)
      setCuotas([])
      setGestiones([])
      return
    }
    cargarDetalle(loanId)
  }, [loanId, cargarDetalle])

  // El formulario se sincroniza con el préstamo cada vez que llega del servidor.
  useEffect(() => {
    if (!prestamo) return
    setFValor(String(prestamo.valor ?? ""))
    setFTasa(String(prestamo.tasa_interes ?? 0))
    setFCuotas(String(prestamo.numero_cuotas ?? ""))
    setFTipoAm(prestamo.tipo_amortizacion === "americano" ? "americano" : "aleman")
    setFFrecuencia((prestamo.frecuencia_pago as Frecuencia) || "daily")
    setFDiaSemana(prestamo.dia_semana ?? "")
    setFPrimerPago((prestamo.fecha_primer_pago ?? "").slice(0, 10))
    setFEmpleado(!!prestamo.prestamo_empleado)
    setFTipoVenta(prestamo.tipo_venta ?? "efectivo")
    setFCuentaId(prestamo.cuenta_id != null ? String(prestamo.cuenta_id) : "")
  }, [prestamo])

  // ── Derivados de pantalla ─────────────────────────────────────────────────

  const listaFiltrada = useMemo(() => {
    const term = busqueda.trim().toLowerCase()
    return prestamos.filter((p) => {
      if (filtroEstado === "activos" && p.estado !== "activo") return false
      if (filtroEstado === "cancelados" && p.estado === "activo") return false
      if (!term) return true
      return (
        p.cliente.apodo?.toLowerCase().includes(term) ||
        p.cliente.nombre_completo.toLowerCase().includes(term) ||
        p.cliente.documento.toLowerCase().includes(term) ||
        p.id.toLowerCase().includes(term)
      )
    })
  }, [prestamos, busqueda, filtroEstado])

  /** IDs de gestiones que ya tienen una reversa aplicada apuntándoles. */
  const reversadas = useMemo(() => {
    const set = new Set<string>()
    for (const g of gestiones) {
      if (g.tipo === "reversa" && g.estado === "aplicada" && g.referencia_gestion_id) {
        set.add(g.referencia_gestion_id)
      }
    }
    return set
  }, [gestiones])

  /** Gestiones de plata/visita vivas: las que hacen "pesada" una regeneración. */
  const gestionesVivas = useMemo(
    () =>
      gestiones.filter(
        (g) => g.estado === "aplicada" && TIPOS_CORREGIBLES.includes(g.tipo) && !reversadas.has(g.id),
      ),
    [gestiones, reversadas],
  )

  /**
   * Simulación local del plan nuevo (espejo exacto del SQL, ver
   * `lib/loan-schedule.ts`). Solo sirve para avisar cómo quedaría: quien
   * manda al guardar sigue siendo el servidor.
   */
  const simulacion = useMemo(() => {
    const valor = Number(fValor)
    const cuotasNum = Number(fCuotas)
    if (!(valor > 0) || !(cuotasNum >= 1)) return null
    try {
      const r = buildPaymentSchedule({
        valor,
        tasaInteres: Number(fTasa) || 0,
        numeroCuotas: cuotasNum,
        frecuenciaPago: fFrecuencia,
        tipoAmortizacion: fEmpleado ? "empleado" : fTipoAm,
        prestamoEmpleado: fEmpleado,
        fechaInicio: fPrimerPago || undefined,
        diaSemana: fFrecuencia === "weekly" ? fDiaSemana || null : null,
      })
      const pagado = financiero?.total_pagado ?? 0
      return {
        total: r.valorAPagar,
        cuota: r.valorCuota,
        saldo: Math.max(0, r.valorAPagar - pagado),
      }
    } catch {
      return null
    }
  }, [fValor, fTasa, fCuotas, fFrecuencia, fTipoAm, fEmpleado, fPrimerPago, fDiaSemana, financiero])

  // ── Escrituras ────────────────────────────────────────────────────────────

  /** Recarga todo y avisa con el saldo que devolvió la RPC. */
  const trasEscribir = useCallback(
    async (titulo: string, res: { nuevo_saldo?: number; loan_estado_final?: string }, extra?: string) => {
      if (loanId) await cargarDetalle(loanId)
      const saldo = Number(res.nuevo_saldo ?? 0)
      const cancelado = res.loan_estado_final === "cancelado"
      toast({
        title: titulo,
        description:
          (extra ? `${extra} ` : "") +
          (cancelado
            ? `El préstamo quedó CANCELADO: saldo ${fmtMoneda(saldo)}.`
            : `Nuevo saldo: ${fmtMoneda(saldo)}.`),
      })
    },
    [loanId, cargarDetalle, toast],
  )

  /** Valida el formulario de términos. Devuelve el error o null. */
  const validarTerminos = (): string | null => {
    const valor = Number(fValor)
    const tasa = Number(fTasa)
    const cuotasNum = Number(fCuotas)
    if (!Number.isFinite(valor) || valor <= 0) return "El valor del préstamo debe ser mayor que cero."
    if (!Number.isFinite(tasa) || tasa < 0) return "La tasa de interés no puede ser negativa."
    if (!Number.isInteger(cuotasNum) || cuotasNum < 1) return "El número de cuotas debe ser un entero mayor o igual a 1."
    if (!fPrimerPago) return "Falta la fecha del primer pago."
    if (!fEmpleado && fFrecuencia === "weekly" && !fDiaSemana) return "Para la frecuencia semanal hay que elegir el día de cobro."
    return null
  }

  const intentarGuardarTerminos = () => {
    const error = validarTerminos()
    if (error) {
      toast({ title: "Revisa los datos", description: error, variant: "destructive" })
      return
    }
    // Si ya hay plata o visitas en el libro, se pide confirmación explícita.
    if (gestionesVivas.length > 0) {
      setConfirmarTerminos(true)
      return
    }
    guardarTerminos()
  }

  const guardarTerminos = async () => {
    if (!prestamo) return
    setEnCurso("terminos")
    try {
      const res = await callRpcAtomic("editar_venta_atomica", {
        loan_id: prestamo.id,
        valor: Number(fValor),
        tasa_interes: Number(fTasa) || 0,
        numero_cuotas: Number(fCuotas),
        tipo_amortizacion: fEmpleado ? "empleado" : fTipoAm,
        frecuencia_pago: fEmpleado ? "daily" : fFrecuencia,
        dia_semana: !fEmpleado && fFrecuencia === "weekly" ? fDiaSemana || null : null,
        fecha_primer_pago: fPrimerPago,
        prestamo_empleado: fEmpleado,
        tipo_venta: fTipoVenta,
        cuenta_id: fTipoVenta === "transferencia" && fCuentaId ? Number(fCuentaId) : null,
        idempotency_key: nuevaGestionId(),
      })
      setConfirmarTerminos(false)
      const totales = Number(res.cuotas_totales ?? 0)
      await trasEscribir(
        "Venta actualizada",
        res,
        `Plan regenerado con ${totales} cuota${totales === 1 ? "" : "s"}; total ${fmtMoneda(Number(res.total_a_pagar ?? 0))}.`,
      )
    } catch (err) {
      errorToast("No se pudo actualizar la venta", err)
    } finally {
      setEnCurso(null)
    }
  }

  const abrirEditarCuota = (c: CuotaRow) => {
    setCuotaEditando(c)
    setCFecha(c.fecha_pago)
    setCValor(String(c.valor_cuota))
    setCCapital(c.capital == null ? "" : String(c.capital))
    setCInteres(c.interes == null ? "" : String(c.interes))
  }

  const abrirCrearCuota = () => {
    setCrearAbierto(true)
    setCFecha(hoy)
    setCValor("")
    setCCapital("")
    setCInteres("")
    setCEsExtra(true)
  }

  /** Valida los campos comunes de los diálogos de cuota. */
  const validarCuota = (exigeValor: boolean): string | null => {
    if (!cFecha) return "Falta la fecha de vencimiento de la cuota."
    if (exigeValor && cValor.trim() === "") return "Falta el valor de la cuota."
    for (const [etiqueta, texto] of [
      ["El valor de la cuota", cValor],
      ["El capital", cCapital],
      ["El interés", cInteres],
    ] as [string, string][]) {
      if (texto.trim() === "") continue
      const n = Number(texto)
      if (!Number.isFinite(n) || n < 0) return `${etiqueta} debe ser un número mayor o igual a 0.`
    }
    return null
  }

  const guardarCuota = async () => {
    if (!prestamo || !cuotaEditando) return
    const error = validarCuota(false)
    if (error) {
      toast({ title: "Revisa los datos", description: error, variant: "destructive" })
      return
    }
    setEnCurso("cuota-editar")
    try {
      const res = await callRpcAtomic("ajustar_cronograma", {
        loan_id: prestamo.id,
        accion: "editar",
        cuota_id: cuotaEditando.id,
        fecha_pago: cFecha,
        valor_cuota: cValor.trim() === "" ? null : Number(cValor),
        capital: cCapital.trim() === "" ? null : Number(cCapital),
        interes: cInteres.trim() === "" ? null : Number(cInteres),
        idempotency_key: nuevaGestionId(),
      })
      setCuotaEditando(null)
      await trasEscribir("Cuota actualizada", res, "La plata se repartió otra vez sobre el plan.")
    } catch (err) {
      errorToast("No se pudo actualizar la cuota", err)
    } finally {
      setEnCurso(null)
    }
  }

  const crearCuota = async () => {
    if (!prestamo) return
    const error = validarCuota(true)
    if (error) {
      toast({ title: "Revisa los datos", description: error, variant: "destructive" })
      return
    }
    setEnCurso("cuota-crear")
    try {
      const res = await callRpcAtomic("ajustar_cronograma", {
        loan_id: prestamo.id,
        accion: "crear",
        fecha_pago: cFecha,
        valor_cuota: Number(cValor),
        capital: cCapital.trim() === "" ? null : Number(cCapital),
        interes: cInteres.trim() === "" ? null : Number(cInteres),
        es_extra: cEsExtra,
        idempotency_key: nuevaGestionId(),
      })
      setCrearAbierto(false)
      await trasEscribir("Cuota agregada", res)
    } catch (err) {
      errorToast("No se pudo agregar la cuota", err)
    } finally {
      setEnCurso(null)
    }
  }

  const eliminarCuota = async () => {
    if (!prestamo || !cuotaEliminando) return
    setEnCurso("cuota-eliminar")
    try {
      const res = await callRpcAtomic("ajustar_cronograma", {
        loan_id: prestamo.id,
        accion: "eliminar",
        cuota_id: cuotaEliminando.id,
        idempotency_key: nuevaGestionId(),
      })
      setCuotaEliminando(null)
      await trasEscribir("Cuota eliminada", res, "La plata que la cubría pasó a las cuotas siguientes.")
    } catch (err) {
      errorToast("No se pudo eliminar la cuota", err)
    } finally {
      setEnCurso(null)
    }
  }

  const abrirCorregir = (g: Gestion) => {
    setGestionCorrigiendo(g)
    setGMonto(String(Number(g.monto) || 0))
    setGFecha(g.fecha_gestion ?? hoy)
    setGMotivo("")
  }

  const abrirAnular = (g: Gestion) => {
    setGestionAnulando(g)
    setGMotivo("")
  }

  const corregirGestion = async () => {
    if (!gestionCorrigiendo) return
    const monto = Number(gMonto)
    if (!Number.isFinite(monto) || monto < 0) {
      toast({ title: "Revisa los datos", description: "El monto debe ser un número mayor o igual a 0.", variant: "destructive" })
      return
    }
    if (!gFecha) {
      toast({ title: "Revisa los datos", description: "Falta la fecha de la gestión.", variant: "destructive" })
      return
    }
    if (gFecha > hoy) {
      toast({ title: "Revisa los datos", description: "La fecha corregida no puede ser futura.", variant: "destructive" })
      return
    }
    if (!gMotivo.trim()) {
      toast({ title: "Falta el motivo", description: "El motivo queda en el historial: escribe por qué se corrige.", variant: "destructive" })
      return
    }
    setEnCurso("gestion-corregir")
    try {
      const res = await callRpcAtomic("corregir_gestion", {
        gestion_id: gestionCorrigiendo.id,
        accion: "editar",
        monto,
        fecha_gestion: gFecha,
        motivo: gMotivo.trim(),
        idempotency_key: nuevaGestionId(),
      })
      setGestionCorrigiendo(null)
      await trasEscribir("Gestión corregida", res, "Quedaron en el historial la anulación y el valor nuevo.")
    } catch (err) {
      errorToast("No se pudo corregir la gestión", err)
    } finally {
      setEnCurso(null)
    }
  }

  const anularGestion = async () => {
    if (!gestionAnulando) return
    if (!gMotivo.trim()) {
      toast({ title: "Falta el motivo", description: "El motivo queda en el historial: escribe por qué se anula.", variant: "destructive" })
      return
    }
    setEnCurso("gestion-anular")
    try {
      const res = await callRpcAtomic("corregir_gestion", {
        gestion_id: gestionAnulando.id,
        accion: "anular",
        motivo: gMotivo.trim(),
        idempotency_key: nuevaGestionId(),
      })
      setGestionAnulando(null)
      await trasEscribir("Gestión anulada", res, "El evento original sigue en el historial con su reversa.")
    } catch (err) {
      errorToast("No se pudo anular la gestión", err)
    } finally {
      setEnCurso(null)
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LISTADO
  // ──────────────────────────────────────────────────────────────────────────
  if (!loanId) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
              <ChevronLeft className="h-4 w-4" />
              Volver
            </Button>
          )}
          <div>
            <h1 className="text-lg md:text-2xl font-bold">Editor de ventas</h1>
            <p className="text-xs md:text-sm text-muted-foreground">
              Control total: edita cualquier venta y su plan de pagos, tenga o no gestiones registradas.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="p-3 md:p-4 space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por apodo, nombre o documento..."
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  className="pl-8 h-9"
                />
              </div>
              <Select
                value={String(rutaFiltro)}
                onValueChange={(v) => setRutaFiltro(v === "todas" ? "todas" : Number(v))}
              >
                <SelectTrigger className="h-9 w-full sm:w-52">
                  <MapPin className="h-3.5 w-3.5 mr-1.5 shrink-0 text-muted-foreground" />
                  <SelectValue placeholder="Ruta" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todas">Todas las rutas</SelectItem>
                  {rutas.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([
                { key: "activos", label: "Activos" },
                { key: "cancelados", label: "Cancelados" },
                { key: "todos", label: "Todos" },
              ] as { key: FiltroEstado; label: string }[]).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFiltroEstado(f.key)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                    filtroEstado === f.key ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="px-0 md:px-3 py-0 md:py-2">
            {cargandoLista ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : listaFiltrada.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground flex flex-col items-center gap-2">
                <AlertCircle className="h-8 w-8 opacity-40" />
                <span className="text-sm">
                  {busqueda ? "Ningún préstamo coincide con la búsqueda." : "No hay préstamos con este filtro."}
                </span>
              </div>
            ) : (
              <ul className="divide-y">
                {listaFiltrada.map((p) => (
                  <li
                    key={p.id}
                    className="px-3 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                    onClick={() => {
                      setTab("terminos")
                      setLoanId(p.id)
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-sm truncate">
                            {p.cliente.apodo || p.cliente.nombre_completo}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{p.cliente.documento}</span>
                          {p.estado !== "activo" && (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                              {p.estado}
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                            {etiquetaFrecuencia(p.frecuencia_pago)}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">
                            {fmtMoneda(p.valor)} · {p.numero_cuotas} cuotas · {fmtFecha(p.fecha_creacion)}
                          </span>
                          <span className="tabular-nums whitespace-nowrap">
                            Saldo <strong className="text-foreground">{fmtMoneda(p.saldo)}</strong>
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
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

  // ──────────────────────────────────────────────────────────────────────────
  // DETALLE
  // ──────────────────────────────────────────────────────────────────────────
  const volverAlListado = () => {
    setLoanId(null)
    setBusqueda("")
  }

  if (cargandoDetalle && !prestamo) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!prestamo) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={volverAlListado} className="gap-1">
          <ChevronLeft className="h-4 w-4" />
          Volver
        </Button>
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground flex flex-col items-center gap-2">
            <AlertCircle className="h-8 w-8 opacity-40" />
            <span className="text-sm">No se pudo abrir el préstamo.</span>
          </CardContent>
        </Card>
      </div>
    )
  }

  const guardando = enCurso !== null

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={volverAlListado} className="gap-1">
          <ChevronLeft className="h-4 w-4" />
          Volver
        </Button>
        <h1 className="text-lg md:text-2xl font-bold">Editor de ventas</h1>
      </div>

      {/* Encabezado del préstamo: todo lo que se muestra aquí es DERIVADO */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base md:text-xl font-bold truncate">
              {prestamo.cliente.apodo || prestamo.cliente.nombre_completo}
            </h2>
            <Badge variant={prestamo.estado === "activo" ? "default" : "secondary"}>{prestamo.estado}</Badge>
            <Badge variant="outline">{etiquetaFrecuencia(prestamo.frecuencia_pago)}</Badge>
            {prestamo.prestamo_empleado && <Badge variant="outline">Empleado</Badge>}
            {(financiero?.cuotas_mora ?? 0) > 0 && (
              <Badge className="bg-red-100 text-red-800 border-red-200 gap-1">
                <AlertTriangle className="h-3 w-3" />
                Mora {etiquetaMora(financiero?.cuotas_mora ?? 0)}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {prestamo.cliente.documento} · Creada {fmtFecha(prestamo.fecha_creacion)} ·
            {" "}Último pago {fmtFecha(financiero?.fecha_ultimo_pago)}
          </p>

          <Separator />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-[11px] text-muted-foreground">Total a pagar</div>
              <div className="font-semibold tabular-nums">{fmtMoneda(financiero?.total_a_pagar)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">Pagado</div>
              <div className="font-semibold tabular-nums text-green-600">{fmtMoneda(financiero?.total_pagado)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">Saldo</div>
              <div className="font-semibold tabular-nums">{fmtMoneda(financiero?.saldo)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">Cuotas cubiertas</div>
              <div className="font-semibold tabular-nums">
                {financiero?.cuotas_cubiertas ?? 0} / {financiero?.cuotas_totales ?? 0}
                {(financiero?.cuotas_extra ?? 0) > 0 && (
                  <span className="text-[11px] font-normal text-muted-foreground"> +{financiero?.cuotas_extra} extra</span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="terminos" className="text-[11px] md:text-sm gap-1">
            <Settings2 className="h-3.5 w-3.5" />
            <span className="truncate">Términos</span>
          </TabsTrigger>
          <TabsTrigger value="plan" className="text-[11px] md:text-sm gap-1">
            <ListChecks className="h-3.5 w-3.5" />
            <span className="truncate">Plan de pagos</span>
          </TabsTrigger>
          <TabsTrigger value="gestiones" className="text-[11px] md:text-sm gap-1">
            <History className="h-3.5 w-3.5" />
            <span className="truncate">Gestiones</span>
          </TabsTrigger>
        </TabsList>

        {/* ── PESTAÑA 1: TÉRMINOS DE LA VENTA ──────────────────────────── */}
        <TabsContent value="terminos" className="mt-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base md:text-lg">Términos de la venta</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Al guardar, el servidor regenera el cronograma completo. Los pagos ya registrados NO se pierden:
                se vuelven a repartir sobre el plan nuevo.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="se-valor" className="text-xs">Valor del préstamo</Label>
                  <Input
                    id="se-valor"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="1"
                    value={fValor}
                    onChange={(e) => setFValor(e.target.value)}
                    className="h-9"
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="se-tasa" className="text-xs">Tasa de interés (%)</Label>
                  <Input
                    id="se-tasa"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={fTasa}
                    onChange={(e) => setFTasa(e.target.value)}
                    disabled={fEmpleado}
                    className="h-9"
                  />
                  <span className="text-[10px] text-muted-foreground">
                    En puntos porcentuales: 20 = 20%. En préstamos de empleado se ignora.
                  </span>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="se-cuotas" className="text-xs">Número de cuotas</Label>
                  <Input
                    id="se-cuotas"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step="1"
                    value={fCuotas}
                    onChange={(e) => setFCuotas(e.target.value)}
                    className="h-9"
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="se-tipo" className="text-xs">Tipo de amortización</Label>
                  <Select
                    value={fTipoAm}
                    onValueChange={(v) => setFTipoAm(v as TipoAmortizacion)}
                    disabled={fEmpleado}
                  >
                    <SelectTrigger id="se-tipo" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="aleman">Cuota fija</SelectItem>
                      <SelectItem value="americano">Cuota interés</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="se-frecuencia" className="text-xs">Frecuencia de pago</Label>
                  <Select
                    value={fFrecuencia}
                    onValueChange={(v) => {
                      setFFrecuencia(v as Frecuencia)
                      if (v !== "weekly") setFDiaSemana("")
                    }}
                    disabled={fEmpleado}
                  >
                    <SelectTrigger id="se-frecuencia" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Diario</SelectItem>
                      <SelectItem value="weekly">Semanal</SelectItem>
                      <SelectItem value="biweekly">Quincenal</SelectItem>
                      <SelectItem value="monthly">Mensual</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {!fEmpleado && fFrecuencia === "weekly" && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="se-dia" className="text-xs">Día de cobro</Label>
                    <Select value={fDiaSemana} onValueChange={setFDiaSemana}>
                      <SelectTrigger id="se-dia" className="h-9">
                        <SelectValue placeholder="Selecciona el día" />
                      </SelectTrigger>
                      <SelectContent>
                        {DIAS_SEMANA.map((d) => (
                          <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="grid gap-1.5">
                  <Label htmlFor="se-primer-pago" className="text-xs">Fecha del primer pago</Label>
                  <Input
                    id="se-primer-pago"
                    type="date"
                    value={fPrimerPago}
                    onChange={(e) => setFPrimerPago(e.target.value)}
                    className="h-9"
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="se-tipo-venta" className="text-xs">Tipo de venta</Label>
                  <Select
                    value={fTipoVenta}
                    onValueChange={(v) => {
                      setFTipoVenta(v)
                      if (v !== "transferencia") setFCuentaId("")
                    }}
                  >
                    <SelectTrigger id="se-tipo-venta" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="efectivo">Efectivo</SelectItem>
                      <SelectItem value="transferencia">Transferencia</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {fTipoVenta === "transferencia" && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="se-cuenta" className="text-xs">Cuenta de la transferencia</Label>
                    <Select value={fCuentaId} onValueChange={setFCuentaId}>
                      <SelectTrigger id="se-cuenta" className="h-9">
                        <SelectValue placeholder="Selecciona una cuenta" />
                      </SelectTrigger>
                      <SelectContent>
                        {cuentas.length === 0 ? (
                          <SelectItem value="__sin_cuentas" disabled>
                            No hay cuentas para esta ruta
                          </SelectItem>
                        ) : (
                          cuentas.map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>{c.nombre}</SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              <div className="flex items-start gap-2 rounded-lg border p-3">
                <Checkbox
                  id="se-empleado"
                  checked={fEmpleado}
                  onCheckedChange={(v) => setFEmpleado(v === true)}
                />
                <div className="grid gap-0.5 leading-tight">
                  <Label htmlFor="se-empleado" className="text-xs font-medium cursor-pointer">
                    Préstamo de empleado
                  </Label>
                  <span className="text-[10px] text-muted-foreground">
                    Sin intereses y siempre diario: el capital se divide en partes iguales.
                  </span>
                </div>
              </div>

              {simulacion && (
                <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <Info className="h-3.5 w-3.5" />
                    Así quedaría el plan nuevo
                  </div>
                  <div className="grid grid-cols-3 gap-2 tabular-nums">
                    <div>
                      <div className="text-[10px] text-muted-foreground">Total a pagar</div>
                      <div className="font-semibold">{fmtMoneda(simulacion.total)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Valor de cuota</div>
                      <div className="font-semibold">{fmtMoneda(simulacion.cuota)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Saldo estimado</div>
                      <div className="font-semibold">{fmtMoneda(simulacion.saldo)}</div>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Es una estimación con la misma fórmula del servidor. El número definitivo lo calcula la base al guardar.
                  </p>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={intentarGuardarTerminos} disabled={guardando}>
                  {enCurso === "terminos" ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Guardando...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      Guardar términos
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── PESTAÑA 2: PLAN DE PAGOS ─────────────────────────────────── */}
        <TabsContent value="plan" className="mt-3">
          <Card>
            <CardHeader className="pb-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <CardTitle className="text-base md:text-lg">Plan de pagos</CardTitle>
                <Button size="sm" variant="outline" onClick={abrirCrearCuota} disabled={guardando}>
                  <Plus className="h-4 w-4 mr-1" />
                  Agregar cuota
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Los pagos se reparten en cascada sobre las cuotas, de la más antigua a la más nueva. Al cambiar el
                plan, la plata se reasigna sola: no hay que redistribuirla a mano.
              </p>
            </CardHeader>
            <CardContent className="px-0 md:px-6">
              {cuotas.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground flex flex-col items-center gap-2">
                  <AlertCircle className="h-8 w-8 opacity-40" />
                  <span className="text-sm">Este préstamo no tiene cuotas en el cronograma.</span>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-xs md:text-sm">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="px-3 py-2 font-semibold">#</th>
                        <th className="px-3 py-2 font-semibold">Vence</th>
                        <th className="px-3 py-2 font-semibold text-right">Valor cuota</th>
                        <th className="px-3 py-2 font-semibold text-right">Asignado</th>
                        <th className="px-3 py-2 font-semibold">Estado</th>
                        <th className="px-3 py-2 font-semibold text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cuotas.map((c) => {
                        const meta = ESTILO_CUOTA[c.estado_derivado] ?? {
                          label: c.estado_derivado,
                          badge: "bg-slate-100 text-slate-700 border-slate-200",
                          fila: "",
                        }
                        const vencida = c.estado_derivado === "pendiente" && c.fecha_pago < hoy
                        const esHoy = c.fecha_pago === hoy
                        return (
                          <tr
                            key={c.id}
                            className={`border-t transition-colors ${vencida ? "bg-red-50/60" : meta.fila} ${
                              esHoy ? "ring-1 ring-inset ring-brand/40" : ""
                            } hover:bg-muted/40`}
                          >
                            <td className="px-3 py-2 font-semibold whitespace-nowrap">
                              {c.numero_cuota}
                              {c.es_extra && (
                                <span className="ml-1 text-[9px] font-normal text-muted-foreground">extra</span>
                              )}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {fmtFecha(c.fecha_pago)}
                              {esHoy && <span className="ml-1 text-[9px] font-bold text-brand uppercase">hoy</span>}
                              {vencida && <span className="ml-1 text-[9px] font-bold text-red-600 uppercase">vencida</span>}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtMoneda(c.valor_cuota)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtMoneda(c.monto_asignado)}</td>
                            <td className="px-3 py-2">
                              <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}>
                                {meta.label}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2"
                                  onClick={() => abrirEditarCuota(c)}
                                  disabled={guardando}
                                  title="Editar cuota"
                                >
                                  <Edit2 className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-red-600 hover:text-red-700"
                                  onClick={() => setCuotaEliminando(c)}
                                  disabled={guardando}
                                  title="Eliminar cuota"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
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
        </TabsContent>

        {/* ── PESTAÑA 3: GESTIONES ─────────────────────────────────────── */}
        <TabsContent value="gestiones" className="mt-3">
          <Card>
            <CardHeader className="pb-3 space-y-2">
              <CardTitle className="text-base md:text-lg">Gestiones</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Las gestiones no se borran ni se editan: corregir registra la anulación y el valor nuevo, y ambas
                quedan en el historial.
              </p>
            </CardHeader>
            <CardContent className="px-0 md:px-6">
              {gestiones.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground flex flex-col items-center gap-2">
                  <AlertCircle className="h-8 w-8 opacity-40" />
                  <span className="text-sm">Este préstamo todavía no tiene gestiones.</span>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-xs md:text-sm">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Fecha</th>
                        <th className="px-3 py-2 font-semibold">Tipo</th>
                        <th className="px-3 py-2 font-semibold text-right">Monto</th>
                        <th className="px-3 py-2 font-semibold">Estado</th>
                        <th className="px-3 py-2 font-semibold">Origen</th>
                        <th className="px-3 py-2 font-semibold">Usuario</th>
                        <th className="px-3 py-2 font-semibold">Observación</th>
                        <th className="px-3 py-2 font-semibold text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gestiones.map((g) => {
                        const meta = ESTILO_GESTION[g.tipo] ?? {
                          label: g.tipo,
                          badge: "bg-slate-100 text-slate-700 border-slate-200",
                        }
                        const anulada = reversadas.has(g.id)
                        const corregible =
                          g.estado === "aplicada" && TIPOS_CORREGIBLES.includes(g.tipo) && !anulada
                        return (
                          <tr
                            key={g.id}
                            className={`border-t hover:bg-muted/40 transition-colors ${
                              anulada ? "opacity-60" : ""
                            }`}
                          >
                            <td className="px-3 py-2 whitespace-nowrap">
                              <div className={anulada ? "line-through" : ""}>{fmtFecha(g.fecha_gestion)}</div>
                              <div className="text-[10px] text-muted-foreground">{fmtFechaHora(g.fecha_hora)}</div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-col items-start gap-1">
                                <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}>
                                  {meta.label}
                                </span>
                                {anulada && (
                                  <span className="inline-block rounded-full border border-slate-300 bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-800">
                                    anulada
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className={`px-3 py-2 text-right tabular-nums ${anulada ? "line-through" : ""}`}>
                              {fmtMoneda(g.monto)}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">{g.estado}</td>
                            <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{g.origen}</td>
                            <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                              {g.user_id != null ? usuarios[g.user_id] ?? `Usuario ${g.user_id}` : "—"}
                            </td>
                            <td className="px-3 py-2 max-w-[220px]">
                              <span className="block truncate text-muted-foreground" title={g.observacion ?? ""}>
                                {g.observacion || "—"}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center justify-end gap-1">
                                {corregible ? (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 px-2 text-[11px]"
                                      onClick={() => abrirCorregir(g)}
                                      disabled={guardando}
                                    >
                                      <Edit2 className="h-3.5 w-3.5 mr-1" />
                                      Corregir
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 px-2 text-[11px] text-red-600 hover:text-red-700"
                                      onClick={() => abrirAnular(g)}
                                      disabled={guardando}
                                    >
                                      <RotateCcw className="h-3.5 w-3.5 mr-1" />
                                      Anular
                                    </Button>
                                  </>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground">—</span>
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
        </TabsContent>
      </Tabs>

      {/* ── Confirmación: regenerar el plan con gestiones registradas ──── */}
      <AlertDialog open={confirmarTerminos} onOpenChange={(o) => !o && setConfirmarTerminos(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cambiar los términos de esta venta?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Este préstamo ya tiene {gestionesVivas.length} gestion
                  {gestionesVivas.length === 1 ? "" : "es"} registrada
                  {gestionesVivas.length === 1 ? "" : "s"}. Al cambiar los términos se regenera el plan de cuotas;
                  los pagos NO se pierden: se vuelven a repartir sobre el plan nuevo.
                </p>
                {simulacion && (
                  <p className="tabular-nums">
                    Total nuevo <strong>{fmtMoneda(simulacion.total)}</strong> · ya pagado{" "}
                    <strong>{fmtMoneda(financiero?.total_pagado ?? 0)}</strong> · saldo estimado{" "}
                    <strong>{fmtMoneda(simulacion.saldo)}</strong>.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enCurso === "terminos"}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                guardarTerminos()
              }}
              disabled={enCurso === "terminos"}
            >
              {enCurso === "terminos" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Guardando...
                </>
              ) : (
                "Sí, regenerar el plan"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Diálogo: editar cuota ──────────────────────────────────────── */}
      <Dialog open={cuotaEditando !== null} onOpenChange={(o) => !o && setCuotaEditando(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Editar cuota {cuotaEditando?.numero_cuota}</DialogTitle>
            <DialogDescription>
              Cambiar el vencimiento o el valor reordena la cascada: la plata se vuelve a repartir sola.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="se-c-fecha" className="text-xs">Fecha de vencimiento</Label>
              <Input id="se-c-fecha" type="date" value={cFecha} onChange={(e) => setCFecha(e.target.value)} className="h-9" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="se-c-valor" className="text-xs">Valor de la cuota</Label>
              <Input
                id="se-c-valor"
                type="number"
                inputMode="decimal"
                min={0}
                step="1"
                value={cValor}
                onChange={(e) => setCValor(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="se-c-capital" className="text-xs">Capital</Label>
                <Input
                  id="se-c-capital"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="1"
                  value={cCapital}
                  onChange={(e) => setCCapital(e.target.value)}
                  className="h-9"
                  placeholder="Sin cambio"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="se-c-interes" className="text-xs">Interés</Label>
                <Input
                  id="se-c-interes"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="1"
                  value={cInteres}
                  onChange={(e) => setCInteres(e.target.value)}
                  className="h-9"
                  placeholder="Sin cambio"
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCuotaEditando(null)} disabled={enCurso === "cuota-editar"}>
              Cancelar
            </Button>
            <Button onClick={guardarCuota} disabled={enCurso === "cuota-editar"}>
              {enCurso === "cuota-editar" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Guardando...
                </>
              ) : (
                "Guardar cuota"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Diálogo: agregar cuota ─────────────────────────────────────── */}
      <Dialog open={crearAbierto} onOpenChange={(o) => !o && setCrearAbierto(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Agregar cuota</DialogTitle>
            <DialogDescription>
              La cuota nueva entra al cronograma en su fecha de vencimiento y la cascada la toma en cuenta de inmediato.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="se-n-fecha" className="text-xs">Fecha de vencimiento</Label>
              <Input id="se-n-fecha" type="date" value={cFecha} onChange={(e) => setCFecha(e.target.value)} className="h-9" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="se-n-valor" className="text-xs">Valor de la cuota</Label>
              <Input
                id="se-n-valor"
                type="number"
                inputMode="decimal"
                min={0}
                step="1"
                value={cValor}
                onChange={(e) => setCValor(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="se-n-capital" className="text-xs">Capital</Label>
                <Input
                  id="se-n-capital"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="1"
                  value={cCapital}
                  onChange={(e) => setCCapital(e.target.value)}
                  className="h-9"
                  placeholder="Igual al valor"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="se-n-interes" className="text-xs">Interés</Label>
                <Input
                  id="se-n-interes"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="1"
                  value={cInteres}
                  onChange={(e) => setCInteres(e.target.value)}
                  className="h-9"
                  placeholder="0"
                />
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-lg border p-3">
              <Checkbox id="se-n-extra" checked={cEsExtra} onCheckedChange={(v) => setCEsExtra(v === true)} />
              <div className="grid gap-0.5 leading-tight">
                <Label htmlFor="se-n-extra" className="text-xs font-medium cursor-pointer">
                  Cuota extra
                </Label>
                <span className="text-[10px] text-muted-foreground">
                  Las extras no cuentan en el X/Y de cuotas del plan, pero sí en el total a cobrar.
                </span>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCrearAbierto(false)} disabled={enCurso === "cuota-crear"}>
              Cancelar
            </Button>
            <Button onClick={crearCuota} disabled={enCurso === "cuota-crear"}>
              {enCurso === "cuota-crear" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Agregando...
                </>
              ) : (
                "Agregar cuota"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirmación: eliminar cuota ───────────────────────────────── */}
      <AlertDialog open={cuotaEliminando !== null} onOpenChange={(o) => !o && setCuotaEliminando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar la cuota {cuotaEliminando?.numero_cuota}?</AlertDialogTitle>
            <AlertDialogDescription>
              Se quita del cronograma la cuota del {fmtFecha(cuotaEliminando?.fecha_pago)} por{" "}
              {fmtMoneda(cuotaEliminando?.valor_cuota)}. Ningún pago se pierde: la plata que la cubría pasa a las
              cuotas siguientes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enCurso === "cuota-eliminar"}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                eliminarCuota()
              }}
              disabled={enCurso === "cuota-eliminar"}
            >
              {enCurso === "cuota-eliminar" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Eliminando...
                </>
              ) : (
                "Sí, eliminar"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Diálogo: corregir gestión ──────────────────────────────────── */}
      <Dialog open={gestionCorrigiendo !== null} onOpenChange={(o) => !o && setGestionCorrigiendo(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Corregir gestión</DialogTitle>
            <DialogDescription>
              El evento original no se toca: se registra su anulación y un evento nuevo con los valores corregidos.
              Ambos quedan visibles en el historial.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            {gestionCorrigiendo && (
              <div className="rounded-lg border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
                Original: {ESTILO_GESTION[gestionCorrigiendo.tipo]?.label ?? gestionCorrigiendo.tipo} del{" "}
                {fmtFecha(gestionCorrigiendo.fecha_gestion)} por {fmtMoneda(gestionCorrigiendo.monto)}.
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="se-g-monto" className="text-xs">Monto corregido</Label>
              <Input
                id="se-g-monto"
                type="number"
                inputMode="decimal"
                min={0}
                step="1"
                value={gMonto}
                onChange={(e) => setGMonto(e.target.value)}
                className="h-9"
                disabled={gestionCorrigiendo?.tipo === "no_pago"}
              />
              {gestionCorrigiendo?.tipo === "no_pago" && (
                <span className="text-[10px] text-muted-foreground">
                  Un “no pago” siempre queda en cero: solo se puede corregir la fecha.
                </span>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="se-g-fecha" className="text-xs">Fecha de la gestión</Label>
              <Input
                id="se-g-fecha"
                type="date"
                max={hoy}
                value={gFecha}
                onChange={(e) => setGFecha(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="se-g-motivo" className="text-xs">Motivo</Label>
              <Textarea
                id="se-g-motivo"
                value={gMotivo}
                onChange={(e) => setGMotivo(e.target.value)}
                placeholder="Por qué se corrige (queda en el historial)"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setGestionCorrigiendo(null)} disabled={enCurso === "gestion-corregir"}>
              Cancelar
            </Button>
            <Button onClick={corregirGestion} disabled={enCurso === "gestion-corregir"}>
              {enCurso === "gestion-corregir" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Corrigiendo...
                </>
              ) : (
                "Guardar corrección"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirmación: anular gestión ───────────────────────────────── */}
      <AlertDialog open={gestionAnulando !== null} onOpenChange={(o) => !o && setGestionAnulando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Anular esta gestión?</AlertDialogTitle>
            <AlertDialogDescription>
              {gestionAnulando
                ? `Se registra una reversa del ${ESTILO_GESTION[gestionAnulando.tipo]?.label?.toLowerCase() ?? gestionAnulando.tipo} del ${fmtFecha(gestionAnulando.fecha_gestion)} por ${fmtMoneda(gestionAnulando.monto)}. El evento original queda en el historial.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="se-a-motivo" className="text-xs">Motivo</Label>
            <Textarea
              id="se-a-motivo"
              value={gMotivo}
              onChange={(e) => setGMotivo(e.target.value)}
              placeholder="Por qué se anula (queda en el historial)"
              rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enCurso === "gestion-anular"}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                anularGestion()
              }}
              disabled={enCurso === "gestion-anular"}
            >
              {enCurso === "gestion-anular" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Anulando...
                </>
              ) : (
                "Sí, anular"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Utilidades ──────────────────────────────────────────────────────────────

/** Normaliza una fila de `loans` con su join de cliente. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapPrestamo(l: any): PrestamoRow {
  const c = Array.isArray(l?.clients) ? l.clients[0] : l?.clients
  return {
    id: l.id,
    client_id: l.client_id ?? null,
    valor: Number(l.valor ?? 0),
    valor_a_pagar: Number(l.valor_a_pagar ?? l.valor ?? 0),
    valor_cuota: Number(l.valor_cuota ?? 0),
    saldo: Number(l.saldo ?? 0),
    tasa_interes: Number(l.tasa_interes ?? 0),
    numero_cuotas: Number(l.numero_cuotas ?? 0),
    tipo_amortizacion: l.tipo_amortizacion ?? null,
    frecuencia_pago: l.frecuencia_pago ?? null,
    dia_semana: l.dia_semana ?? null,
    fecha_primer_pago: l.fecha_primer_pago ?? null,
    prestamo_empleado: !!l.prestamo_empleado,
    tipo_venta: l.tipo_venta ?? null,
    cuenta_id: l.cuenta_id == null ? null : Number(l.cuenta_id),
    estado: l.estado ?? "",
    fecha_creacion: l.fecha_creacion ?? null,
    ruta: Number(l.ruta ?? 0),
    cliente: {
      nombre_completo: c?.nombre_completo ?? "",
      apodo: c?.apodo ?? null,
      documento: c?.documento ?? "",
    },
  }
}
