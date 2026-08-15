"use client"

/**
 * Control de Pagos
 * ----------------
 * Modulo administrativo para revisar el plan de pagos de cualquier prestamo
 * y corregirlo cuota a cuota.
 *
 * Flujo:
 *   1. Se elige la ruta (o todas) y se busca al cliente.
 *   2. La lista muestra el avance de cada prestamo: cuanto se ha recaudado,
 *      cuanto falta y si esta en mora. Los tres numeros salen de
 *      `v_loan_financiero` (scripts/043), LA formula del nucleo.
 *   3. Al entrar a un prestamo se ve su plan completo, con las cuotas
 *      vencidas y la de hoy resaltadas. El monto de cada cuota es el que le
 *      asigno la cascada de pagos (`v_cobertura_cuotas`), no un numero
 *      guardado a mano.
 *   4. Cada fila se puede editar: fecha, valor, estado y monto pagado.
 *
 * La edicion pasa por la RPC `ajustar_cuota_control_pagos` (scripts/044), que
 * en la misma transaccion registra los eventos de la correccion en `gestiones`,
 * recalcula el saldo del prestamo, lo cancela o lo reactiva segun corresponda
 * y cuadra `clients.tiene_prestamo_activo`.
 *
 * Sigue siendo una herramienta de correccion: mueve plata sin pasar por el
 * flujo de cobro, asi que cada ajuste queda con nombre y apellido.
 */

import { useState, useEffect, useMemo, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { getSupabaseSafe, callRpcAtomic } from "@/lib/api-helper"
import { todayColombia, etiquetaMora } from "@/lib/gestion-core"
import {
  Search,
  ChevronLeft,
  Edit2,
  Save,
  X,
  User,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Wallet,
  ListChecks,
} from "lucide-react"

interface PaymentControlProps {
  currentRutaId: number
  rutaPais?: string
}

interface Ruta {
  id: number
  nombre: string
}

// Un prestamo en el listado, ya cruzado con su saldo y su mora.
//
// Saldo, recaudado y mora salen los tres de `v_loan_financiero` — LA formula
// del nucleo (script 043). Antes venian de dos vistas distintas
// (`saldo_prestamos_clientes` + `v_loan_mora_status`) que se cruzaban en
// memoria y podian discrepar entre si.
interface LoanSummary {
  id: string
  monto_prestamo: number
  total_a_pagar: number
  total_cuotas: number
  estado: string
  fecha_inicio: string
  tipo_amortizacion: string | null
  ruta: number
  cliente: {
    nombre_completo: string
    apodo: string | null
    documento: string
  }
  /** `v_loan_financiero.total_pagado`: plata neta que entro al prestamo. */
  recaudado: number
  /** `v_loan_financiero.saldo_hoy`: lo que el cliente debe HOY. */
  saldoPendiente: number
  /**
   * `v_loan_financiero.cuotas_mora`: CANTIDAD DE CUOTAS vencidas sin cubrir.
   * No son dias — antes se mostraba "Nd mora" y confundia a todo el mundo.
   * 0 = al dia.
   */
  cuotasMora: number
}

// Una fila del plan tal como se edita: el cronograma (`payment_plan`) cruzado
// con lo que de verdad se le asigno (`v_cobertura_cuotas`).
interface CuotaRow {
  id: string
  numero_cuota: number
  fecha_pago: string
  valor_cuota: number
  estado: string
  /**
   * `v_cobertura_cuotas.monto_asignado`: lo que la cascada de pagos dejo en
   * ESTA cuota. Es tambien el numero contra el que la RPC calcula el delta.
   */
  monto_asignado: number
  /** Ultima gestion del libro anclada a esta cuota (`gestiones.cuota_objetivo`). */
  fecha_gestionada: string | null
  capital: number | null
  es_extra: boolean
}

// Lo que el usuario esta escribiendo en la fila que edita. `monto_pagado` es
// el nombre que espera el payload de la RPC, no una columna que se lea.
interface EditBuffer {
  fecha_pago?: string
  valor_cuota?: number
  estado?: string
  monto_pagado?: number | null
}

// "Cancelada" NO está aquí a propósito, y no es un olvido: una cuota queda
// cancelada porque se canceló el CRÉDITO COMPLETO, no cuota por cuota. Es un
// estado derivado de un evento de cancelación, así que ponerlo a mano dejaría
// la cuota diciendo algo que el libro no respalda. (Hasta ahora la opción
// aparecía en el selector pero la función siempre la rechazaba: elegirla solo
// producía un error.)
//
// Para cancelar un crédito: módulo de pagos → "Cancelación total". Para
// corregir una cancelación mal hecha: Control Total → pestaña Gestiones.
const ESTADOS_EDITABLES = [
  { value: "pendiente", label: "Pendiente" },
  { value: "pagado", label: "Pagado" },
  { value: "parcial", label: "Parcial" },
  { value: "no_pago", label: "No pago" },
]

// Colores por estado. Se usan tanto en el badge como en el tinte de la fila,
// para que el plan se lea de un vistazo sin tener que ir columna por columna.
const ESTADO_ESTILO: Record<string, { label: string; badge: string; fila: string }> = {
  pagado:    { label: "Pagado",    badge: "bg-green-100 text-green-800 border-green-200",   fila: "bg-green-50/40" },
  pendiente: { label: "Pendiente", badge: "bg-slate-100 text-slate-700 border-slate-200",   fila: "" },
  no_pago:   { label: "No pago",   badge: "bg-red-100 text-red-800 border-red-200",         fila: "bg-red-50/40" },
  parcial:   { label: "Parcial",   badge: "bg-amber-100 text-amber-800 border-amber-200",   fila: "bg-amber-50/40" },
  cancelada: { label: "Cancelada", badge: "bg-blue-100 text-blue-800 border-blue-200",      fila: "bg-blue-50/40" },
}

const fmtCOP = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(Number(n)).toLocaleString("es-CO")}`

// Acepta una fecha ISO (YYYY-MM-DD) o un timestamp. Se construye como fecha
// local para no arrastrar el corrimiento de UTC.
const fmtFecha = (s: string | null | undefined) => {
  if (!s) return "—"
  const [y, m, d] = s.split("T")[0].split("-").map(Number)
  if (!y || !m || !d) return "—"
  return new Date(y, m - 1, d).toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "short",
  })
}

const tipoLabel = (t: string | null) =>
  t === "aleman" ? "Capital" : t === "americano" ? "Intereses" : t === "empleado" ? "Empleado" : t

type FiltroEstadoLoan = "activos" | "cancelados" | "todos"
type FiltroCuota = "todas" | "pendientes" | "vencidas" | "pagadas" | "no_pago"

export function PaymentControl({ currentRutaId }: PaymentControlProps) {
  const { toast } = useToast()
  const hoy = todayColombia()

  // ── Filtros del listado ──────────────────────────────────────────────
  const [rutas, setRutas] = useState<Ruta[]>([])
  const [rutaFiltro, setRutaFiltro] = useState<number | "todas">(currentRutaId)
  const [searchTerm, setSearchTerm] = useState("")
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstadoLoan>("activos")

  const [loans, setLoans] = useState<LoanSummary[]>([])
  const [loadingLoans, setLoadingLoans] = useState(true)

  // ── Prestamo seleccionado ────────────────────────────────────────────
  const [selectedLoan, setSelectedLoan] = useState<LoanSummary | null>(null)
  const [cuotas, setCuotas] = useState<CuotaRow[]>([])
  const [loadingCuotas, setLoadingCuotas] = useState(false)
  const [filtroCuota, setFiltroCuota] = useState<FiltroCuota>("todas")

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState<EditBuffer>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  // ── Catalogo de rutas ────────────────────────────────────────────────
  useEffect(() => {
    let cancelado = false
    getSupabaseSafe()
      .then((supabase) => supabase.from("rutas").select("id, nombre").order("id"))
      .then(({ data }) => {
        if (!cancelado) setRutas((data ?? []) as Ruta[])
      })
      .catch((err) => console.error("[v0] PaymentControl rutas error:", err))
    return () => { cancelado = true }
  }, [])

  // ── Cargar prestamos + su estado financiero ──────────────────────────
  // UNA sola vista para saldo, recaudado y mora: `v_loan_financiero`. Antes
  // eran dos consultas (`saldo_prestamos_clientes` + `v_loan_mora_status`) que
  // se cruzaban en memoria y podian contradecirse; ahora los tres numeros
  // salen de la misma fila, asi que no hay forma de que discrepen.
  useEffect(() => {
    let cancelado = false
    const cargar = async () => {
      setLoadingLoans(true)
      try {
        const supabase = await getSupabaseSafe()

        let q = supabase
          .from("loans")
          .select(
            "id, valor, valor_a_pagar, numero_cuotas, estado, fecha_creacion, tipo_amortizacion, ruta, clients:clients(nombre_completo, apodo, documento)",
          )
          .order("fecha_creacion", { ascending: false })
        let qFin = supabase
          .from("v_loan_financiero")
          .select("loan_id, total_pagado, saldo_hoy, cuotas_mora")
        if (rutaFiltro !== "todas") {
          q = q.eq("ruta", rutaFiltro)
          qFin = qFin.eq("ruta", rutaFiltro)
        }

        const [{ data: loansData, error }, { data: finData }] = await Promise.all([q, qFin])
        if (cancelado) return
        if (error) throw error

        const financiero = new Map<string, { recaudado: number; saldo: number; mora: number }>()
        for (const f of (finData ?? []) as {
          loan_id: string
          total_pagado: number | null
          saldo_hoy: number | null
          cuotas_mora: number | null
        }[]) {
          financiero.set(f.loan_id, {
            recaudado: Number(f.total_pagado ?? 0),
            saldo: Number(f.saldo_hoy ?? 0),
            mora: Number(f.cuotas_mora ?? 0),
          })
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mapped: LoanSummary[] = (loansData ?? []).map((l: any) => ({
          id: l.id,
          monto_prestamo: Number(l.valor ?? 0),
          total_a_pagar: Number(l.valor_a_pagar ?? l.valor ?? 0),
          total_cuotas: Number(l.numero_cuotas ?? 0),
          estado: l.estado ?? "",
          fecha_inicio: l.fecha_creacion ?? "",
          tipo_amortizacion: l.tipo_amortizacion ?? null,
          ruta: Number(l.ruta ?? 0),
          cliente: {
            nombre_completo: l.clients?.nombre_completo ?? "",
            apodo: l.clients?.apodo ?? null,
            documento: l.clients?.documento ?? "",
          },
          recaudado: financiero.get(l.id)?.recaudado ?? 0,
          saldoPendiente: financiero.get(l.id)?.saldo ?? 0,
          cuotasMora: financiero.get(l.id)?.mora ?? 0,
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
        if (!cancelado) setLoadingLoans(false)
      }
    }
    cargar()
    return () => { cancelado = true }
  }, [rutaFiltro, toast])

  const nombreRuta = useCallback(
    (id: number) => rutas.find((r) => r.id === id)?.nombre ?? `Ruta ${id}`,
    [rutas],
  )

  // ── Filtrado del listado ─────────────────────────────────────────────
  const filteredLoans = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return loans.filter((l) => {
      if (filtroEstado === "activos" && l.estado !== "activo") return false
      if (filtroEstado === "cancelados" && l.estado === "activo") return false
      if (!term) return true
      return (
        l.cliente.apodo?.toLowerCase().includes(term) ||
        l.cliente.nombre_completo.toLowerCase().includes(term) ||
        l.cliente.documento.toLowerCase().includes(term) ||
        l.id.toLowerCase().includes(term)
      )
    })
  }, [loans, searchTerm, filtroEstado])

  // Totales de lo que se esta viendo, no de toda la ruta: si el usuario
  // filtro por cliente, el resumen habla de ese recorte.
  const totales = useMemo(() => {
    return filteredLoans.reduce(
      (acc, l) => ({
        prestamos: acc.prestamos + 1,
        cartera: acc.cartera + l.total_a_pagar,
        recaudado: acc.recaudado + l.recaudado,
        saldo: acc.saldo + l.saldoPendiente,
        enMora: acc.enMora + (l.cuotasMora > 0 ? 1 : 0),
      }),
      { prestamos: 0, cartera: 0, recaudado: 0, saldo: 0, enMora: 0 },
    )
  }, [filteredLoans])

  // ── Cuotas del prestamo seleccionado ─────────────────────────────────
  // Tres fuentes que se cruzan por id de cuota:
  //   payment_plan       el cronograma pactado (fecha, valor, estado, capital)
  //   v_cobertura_cuotas cuanto se le asigno DE VERDAD a cada cuota
  //   gestiones          cuando se gestiono cada cuota (el libro de eventos)
  const loadCuotas = async (loanId: string) => {
    setLoadingCuotas(true)
    setEditingId(null)
    setEditBuffer({})
    try {
      const supabase = await getSupabaseSafe()
      const [{ data, error }, { data: cobertura, error: errCob }, { data: gests, error: errGest }] =
        await Promise.all([
          supabase
            .from("payment_plan")
            .select("id, numero_cuota, fecha_pago, valor_cuota, estado, capital, es_extra")
            .eq("loan_id", loanId)
            .order("numero_cuota", { ascending: true }),
          supabase
            .from("v_cobertura_cuotas")
            .select("id, monto_asignado")
            .eq("loan_id", loanId),
          // Solo los eventos anclados a una cuota: son los que responden
          // "cuando se gestiono ESTA cuota".
          supabase
            .from("gestiones")
            .select("cuota_objetivo, fecha_gestion")
            .eq("loan_id", loanId)
            .eq("estado", "aplicada")
            .not("cuota_objetivo", "is", null)
            .order("fecha_hora", { ascending: true }),
        ])

      if (error) throw error
      if (errCob) console.error("[v0] PaymentControl v_cobertura_cuotas error:", errCob.message)
      if (errGest) console.error("[v0] PaymentControl gestiones error:", errGest.message)

      const asignado = new Map<string, number>()
      for (const c of (cobertura ?? []) as { id: string; monto_asignado: number | null }[]) {
        asignado.set(c.id, Number(c.monto_asignado ?? 0))
      }
      // Vienen ordenadas por fecha_hora ascendente, asi que la ultima escritura
      // de cada cuota es la gestion mas reciente.
      const gestionadaEn = new Map<string, string>()
      for (const g of (gests ?? []) as { cuota_objetivo: string; fecha_gestion: string | null }[]) {
        if (g.fecha_gestion) gestionadaEn.set(g.cuota_objetivo, g.fecha_gestion)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapped: CuotaRow[] = (data ?? []).map((r: any) => ({
        id: r.id,
        numero_cuota: Number(r.numero_cuota ?? 0),
        fecha_pago: r.fecha_pago ?? "",
        valor_cuota: Number(r.valor_cuota ?? 0),
        estado: r.estado ?? "pendiente",
        monto_asignado: asignado.get(r.id) ?? 0,
        fecha_gestionada: gestionadaEn.get(r.id) ?? null,
        capital: r.capital != null ? Number(r.capital) : null,
        es_extra: !!r.es_extra,
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
    setFiltroCuota("todas")
    loadCuotas(l.id)
  }

  const handleBack = () => {
    setSelectedLoan(null)
    setCuotas([])
    setEditingId(null)
    setEditBuffer({})
  }

  const startEdit = (row: CuotaRow) => {
    setEditingId(row.id)
    setEditBuffer({
      fecha_pago: row.fecha_pago,
      valor_cuota: row.valor_cuota,
      estado: row.estado,
      // Se arranca con lo ASIGNADO, que es contra lo que la RPC calcula el
      // delta del ajuste (ver scripts/044, v_asignado).
      monto_pagado: row.monto_asignado,
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditBuffer({})
  }

  // ── Guardar la fila editada ──────────────────────────────────────────
  const saveEdit = async (row: CuotaRow) => {
    setSavingId(row.id)
    try {
      const newEstado = (editBuffer.estado as string) ?? row.estado
      let newMonto = editBuffer.monto_pagado as number | null | undefined
      if (typeof newMonto === "string") newMonto = Number(newMonto)
      if (Number.isNaN(newMonto as number)) newMonto = null

      // Cada estado tiene su forma coherente de monto. Sin esto quedaban
      // filas como "no pago" con plata cobrada o "pendiente" con monto.
      if (newEstado === "pendiente") {
        newMonto = null
      } else if (newEstado === "no_pago") {
        newMonto = 0
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
          description: "El valor de la cuota debe ser un número mayor o igual a 0.",
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

      // Va por RPC y no por un UPDATE suelto: el ajuste tiene que recalcular
      // el saldo del prestamo, decidir si se cancela o se reactiva, cuadrar
      // la marca del cliente y dejar rastro de quien lo toco — todo dentro
      // de la misma transaccion. Ahora ademas escribe los eventos de la
      // correccion en `gestiones`. La firma NO cambio.
      // Ver scripts/044-registrar-gestion.sql.
      const res = await callRpcAtomic("ajustar_cuota_control_pagos", {
        payment_plan_id: row.id,
        fecha_pago: newFecha,
        valor_cuota: newValor,
        estado: newEstado,
        monto_pagado: newMonto,
      })

      const nuevoSaldo = Number(res.nuevo_saldo ?? 0)
      const estadoFinal = (res.loan_estado_final as string) ?? selectedLoan?.estado ?? "activo"
      const reactivado = res.loan_reactivado === true

      toast({
        title: reactivado ? "Cuota actualizada y préstamo reactivado" : "Cuota actualizada",
        description: reactivado
          ? `Quedaron cuotas pendientes, así que el préstamo volvió a estar activo. Saldo: ${fmtCOP(nuevoSaldo)}.`
          : estadoFinal === "cancelado"
            ? "No quedan cuotas pendientes ni saldo: el préstamo quedó cancelado."
            : `Nuevo saldo del préstamo: ${fmtCOP(nuevoSaldo)}.`,
      })

      setEditingId(null)
      setEditBuffer({})

      // El encabezado muestra saldo, avance y estado: se actualiza al vuelo con
      // lo que devolvio la RPC para no quedar mostrando el saldo viejo.
      //
      // OJO: `nuevo_saldo` es el saldo TOTAL del contrato, mientras que la
      // pantalla muestra `saldo_hoy` (que en los creditos americanos no es el
      // mismo numero). Por eso, en seguida se relee la fila de
      // `v_loan_financiero` y esa es la que manda.
      const aplicar = (l: LoanSummary, saldo: number, recaudado: number, mora: number) => ({
        ...l,
        estado: estadoFinal,
        saldoPendiente: saldo,
        recaudado,
        cuotasMora: mora,
      })

      setSelectedLoan((prev) =>
        prev
          ? aplicar(prev, nuevoSaldo, Number(res.total_pagado ?? prev.recaudado), prev.cuotasMora)
          : prev,
      )
      setLoans((prev) =>
        prev.map((l) =>
          l.id === selectedLoan?.id
            ? aplicar(l, nuevoSaldo, Number(res.total_pagado ?? l.recaudado), l.cuotasMora)
            : l,
        ),
      )

      if (selectedLoan) {
        const supabase = await getSupabaseSafe()
        const { data: fin } = await supabase
          .from("v_loan_financiero")
          .select("total_pagado, saldo_hoy, cuotas_mora")
          .eq("loan_id", selectedLoan.id)
          .maybeSingle()
        if (fin) {
          const saldo = Number(fin.saldo_hoy ?? 0)
          const recaudado = Number(fin.total_pagado ?? 0)
          const mora = Number(fin.cuotas_mora ?? 0)
          setSelectedLoan((prev) => (prev ? aplicar(prev, saldo, recaudado, mora) : prev))
          setLoans((prev) =>
            prev.map((l) => (l.id === selectedLoan.id ? aplicar(l, saldo, recaudado, mora) : l)),
          )
        }
        await loadCuotas(selectedLoan.id)
      }
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

  // ── Resumen y filtro del plan ────────────────────────────────────────
  const resumen = useMemo(() => {
    if (cuotas.length === 0) return null
    const base = cuotas.filter((c) => !c.es_extra)
    return {
      pagadas: cuotas.filter((c) => c.estado === "pagado" || c.estado === "cancelada").length,
      pendientes: cuotas.filter((c) => c.estado === "pendiente").length,
      vencidas: cuotas.filter((c) => c.estado === "pendiente" && c.fecha_pago < hoy).length,
      noPago: cuotas.filter((c) => c.estado === "no_pago").length,
      extra: cuotas.length - base.length,
      totalBase: base.length,
      totalPagado: cuotas.reduce((s, c) => s + c.monto_asignado, 0),
      totalProgramado: cuotas.reduce((s, c) => s + c.valor_cuota, 0),
    }
  }, [cuotas, hoy])

  const cuotasVisibles = useMemo(() => {
    switch (filtroCuota) {
      case "pendientes": return cuotas.filter((c) => c.estado === "pendiente")
      case "vencidas":   return cuotas.filter((c) => c.estado === "pendiente" && c.fecha_pago < hoy)
      case "pagadas":    return cuotas.filter((c) => c.estado === "pagado" || c.estado === "parcial" || c.estado === "cancelada")
      case "no_pago":    return cuotas.filter((c) => c.estado === "no_pago")
      default:           return cuotas
    }
  }, [cuotas, filtroCuota, hoy])

  // ─────────────────────────────────────────────────────────────────────
  // DETALLE
  // ─────────────────────────────────────────────────────────────────────
  if (selectedLoan) {
    const avance = selectedLoan.total_a_pagar > 0
      ? Math.min(100, (selectedLoan.recaudado / selectedLoan.total_a_pagar) * 100)
      : 0

    const chips: { key: FiltroCuota; label: string; n: number }[] = [
      { key: "todas",      label: "Todas",     n: cuotas.length },
      { key: "vencidas",   label: "Vencidas",  n: resumen?.vencidas ?? 0 },
      { key: "pendientes", label: "Pendientes",n: resumen?.pendientes ?? 0 },
      { key: "pagadas",    label: "Pagadas",   n: resumen?.pagadas ?? 0 },
      { key: "no_pago",    label: "No pago",   n: resumen?.noPago ?? 0 },
    ]

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1">
            <ChevronLeft className="h-4 w-4" />
            Volver
          </Button>
          <h1 className="text-lg md:text-2xl font-bold">Control de Pagos</h1>
        </div>

        {/* Encabezado del prestamo */}
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base md:text-xl font-bold truncate">
                    {selectedLoan.cliente.apodo || selectedLoan.cliente.nombre_completo}
                  </h2>
                  <Badge variant={selectedLoan.estado === "activo" ? "default" : "secondary"}>
                    {selectedLoan.estado}
                  </Badge>
                  {selectedLoan.tipo_amortizacion && (
                    <Badge variant="outline">{tipoLabel(selectedLoan.tipo_amortizacion)}</Badge>
                  )}
                  {/* El numero son CUOTAS vencidas sin cubrir, no dias: etiquetaMora
                      lo dice con todas las letras. */}
                  {selectedLoan.cuotasMora > 0 && (
                    <Badge className="bg-red-100 text-red-800 border-red-200 gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      {etiquetaMora(selectedLoan.cuotasMora)} en mora
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {selectedLoan.cliente.documento} · {nombreRuta(selectedLoan.ruta)} · Inicio {fmtFecha(selectedLoan.fecha_inicio)}
                </p>
              </div>
            </div>

            {/* Avance del recaudo */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">
                  Recaudado <strong className="text-foreground">{fmtCOP(selectedLoan.recaudado)}</strong> de {fmtCOP(selectedLoan.total_a_pagar)}
                </span>
                <span className="font-semibold">{Math.round(avance)}%</span>
              </div>
              <Progress value={avance} className="h-2" />
              <p className="text-xs text-muted-foreground">
                Saldo pendiente <strong className="text-foreground">{fmtCOP(selectedLoan.saldoPendiente)}</strong>
              </p>
            </div>

            {resumen && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3 border-t text-sm">
                <div>
                  <div className="text-[11px] text-muted-foreground">Cuotas</div>
                  <div className="font-semibold">
                    {resumen.pagadas} / {resumen.totalBase}
                    {resumen.extra > 0 && (
                      <span className="text-[11px] font-normal text-muted-foreground"> +{resumen.extra} extra</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Vencidas sin gestionar</div>
                  <div className={`font-semibold ${resumen.vencidas > 0 ? "text-red-600" : ""}`}>{resumen.vencidas}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">No pagos</div>
                  <div className={`font-semibold ${resumen.noPago > 0 ? "text-amber-600" : ""}`}>{resumen.noPago}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">Total programado</div>
                  <div className="font-semibold tabular-nums">{fmtCOP(resumen.totalProgramado)}</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Plan de pagos */}
        <Card>
          <CardHeader className="pb-3 space-y-3">
            <CardTitle className="text-base md:text-lg flex items-center gap-2">
              <ListChecks className="h-4 w-4" />
              Plan de pagos
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Al editar una cuota se recalcula el saldo del préstamo y queda registrado quién hizo el cambio.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setFiltroCuota(c.key)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                    filtroCuota === c.key ? "border-brand bg-brand/10 font-semibold" : "hover:bg-muted/50"
                  }`}
                >
                  {c.label} ({c.n})
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="px-0 md:px-6">
            {loadingCuotas ? (
              <div className="space-y-2 px-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : cuotasVisibles.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground flex flex-col items-center gap-2">
                <AlertCircle className="h-8 w-8 opacity-40" />
                <span className="text-sm">
                  {cuotas.length === 0
                    ? "Este préstamo no tiene cuotas registradas."
                    : "No hay cuotas con ese filtro."}
                </span>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs md:text-sm">
                  <thead className="bg-muted/50 text-left sticky top-0">
                    <tr>
                      <th className="px-3 py-2 font-semibold">#</th>
                      <th className="px-3 py-2 font-semibold">Fecha</th>
                      <th className="px-3 py-2 font-semibold text-right">Valor</th>
                      <th className="px-3 py-2 font-semibold">Estado</th>
                      <th className="px-3 py-2 font-semibold text-right">Pagado</th>
                      <th className="px-3 py-2 font-semibold">Gestionada</th>
                      <th className="px-3 py-2 font-semibold text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cuotasVisibles.map((row) => {
                      const isEditing = editingId === row.id
                      const isSaving = savingId === row.id
                      const meta = ESTADO_ESTILO[row.estado] ?? {
                        label: row.estado, badge: "bg-slate-100 text-slate-700 border-slate-200", fila: "",
                      }
                      const esHoy = row.fecha_pago === hoy
                      const vencida = row.estado === "pendiente" && row.fecha_pago < hoy
                      return (
                        <tr
                          key={row.id}
                          className={`border-t transition-colors ${vencida ? "bg-red-50/60" : meta.fila} ${
                            esHoy ? "ring-1 ring-inset ring-brand/40" : ""
                          } hover:bg-muted/40`}
                        >
                          <td className="px-3 py-2 font-semibold whitespace-nowrap">
                            {row.numero_cuota}
                            {row.es_extra && (
                              <span className="ml-1 text-[9px] text-muted-foreground font-normal">extra</span>
                            )}
                          </td>

                          <td className="px-3 py-2 whitespace-nowrap">
                            {isEditing ? (
                              <Input
                                type="date"
                                value={(editBuffer.fecha_pago as string) ?? ""}
                                onChange={(e) => setEditBuffer((b) => ({ ...b, fecha_pago: e.target.value }))}
                                className="h-8 w-36"
                              />
                            ) : (
                              <span className="flex items-center gap-1.5">
                                {fmtFecha(row.fecha_pago)}
                                {esHoy && <span className="text-[9px] font-bold text-brand uppercase">hoy</span>}
                                {vencida && <span className="text-[9px] font-bold text-red-600 uppercase">vencida</span>}
                              </span>
                            )}
                          </td>

                          <td className="px-3 py-2 text-right tabular-nums">
                            {isEditing ? (
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                step="1"
                                value={editBuffer.valor_cuota === undefined ? "" : String(editBuffer.valor_cuota)}
                                onChange={(e) =>
                                  setEditBuffer((b) => ({
                                    ...b,
                                    valor_cuota: e.target.value === "" ? 0 : Number(e.target.value),
                                  }))
                                }
                                className="h-8 w-28 text-right"
                              />
                            ) : (
                              fmtCOP(row.valor_cuota)
                            )}
                          </td>

                          <td className="px-3 py-2">
                            {isEditing ? (
                              <Select
                                value={(editBuffer.estado as string) ?? row.estado}
                                onValueChange={(v) => setEditBuffer((b) => ({ ...b, estado: v }))}
                              >
                                <SelectTrigger className="h-8 w-32">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ESTADOS_EDITABLES.map((e) => (
                                    <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}>
                                {meta.label}
                              </span>
                            )}
                          </td>

                          <td className="px-3 py-2 text-right tabular-nums">
                            {isEditing ? (
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                step="1"
                                value={editBuffer.monto_pagado == null ? "" : String(editBuffer.monto_pagado)}
                                onChange={(e) =>
                                  setEditBuffer((b) => ({
                                    ...b,
                                    monto_pagado: e.target.value === "" ? null : Number(e.target.value),
                                  }))
                                }
                                className="h-8 w-28 text-right"
                                placeholder="0"
                              />
                            ) : (
                              // Lo que la CASCADA dejo en esta cuota, no lo que
                              // se digito en una fila. Un abono de 3 cuotas se
                              // reparte 10/10/10 en vez de quedar 30/0/0 en la
                              // primera: la columna muestra lo que de verdad
                              // cubrio cada cuota.
                              fmtCOP(row.monto_asignado)
                            )}
                          </td>

                          {/*
                            "Gestionada" ya no puede venir de payment_plan.fecha_pago_real
                            (esa columna quedo NULL para siempre). Se conserva la columna
                            porque la pregunta sigue siendo util — "¿cuando se toco esta
                            cuota?" — y ahora se responde con el libro: la ultima gestion
                            anclada a ella. Queda vacia cuando la cuota se cubrio por
                            derrame de un abono grande, que es la verdad: nadie la gestiono,
                            le llego la plata sobrante de otra.
                          */}
                          <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                            {fmtFecha(row.fecha_gestionada)}
                          </td>

                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1">
                              {isEditing ? (
                                <>
                                  <Button size="sm" className="h-7 px-2" onClick={() => saveEdit(row)} disabled={isSaving}>
                                    {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={cancelEdit} disabled={isSaving}>
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

  // ─────────────────────────────────────────────────────────────────────
  // LISTADO
  // ─────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg md:text-2xl font-bold">Control de Pagos</h1>
        <p className="text-xs md:text-sm text-muted-foreground">
          Revisa y corrige el plan de pagos de cualquier préstamo.
        </p>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="p-3 md:p-4 space-y-3">
          <div className="flex flex-col md:flex-row gap-2">
            <Select
              value={String(rutaFiltro)}
              onValueChange={(v) => setRutaFiltro(v === "todas" ? "todas" : Number(v))}
            >
              <SelectTrigger className="h-9 md:w-56">
                <SelectValue placeholder="Ruta" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas las rutas</SelectItem>
                {rutas.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>{r.nombre}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por apodo, nombre o documento..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 h-9"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {([
              { key: "activos", label: "Activos" },
              { key: "cancelados", label: "Cancelados" },
              { key: "todos", label: "Todos" },
            ] as { key: FiltroEstadoLoan; label: string }[]).map((f) => (
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

      {/* Totales de lo que se esta viendo */}
      {!loadingLoans && filteredLoans.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            { icon: User,       label: "Préstamos", valor: String(totales.prestamos), tono: "" },
            { icon: Wallet,     label: "Cartera",   valor: fmtCOP(totales.cartera),   tono: "" },
            { icon: ListChecks, label: "Recaudado", valor: fmtCOP(totales.recaudado), tono: "text-green-600" },
            { icon: AlertTriangle, label: `Saldo · ${totales.enMora} en mora`, valor: fmtCOP(totales.saldo), tono: totales.enMora > 0 ? "text-red-600" : "" },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border bg-card p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <k.icon className="h-3 w-3" />
                <span className="truncate">{k.label}</span>
              </div>
              <div className={`text-sm md:text-base font-bold tabular-nums ${k.tono}`}>{k.valor}</div>
            </div>
          ))}
        </div>
      )}

      {/* Listado */}
      <Card>
        <CardContent className="px-0 md:px-3 py-0 md:py-2">
          {loadingLoans ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : filteredLoans.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground flex flex-col items-center gap-2">
              <AlertCircle className="h-8 w-8 opacity-40" />
              <span className="text-sm">
                {searchTerm ? "Ningún préstamo coincide con la búsqueda." : "No hay préstamos con estos filtros."}
              </span>
            </div>
          ) : (
            <ul className="divide-y">
              {filteredLoans.map((l) => {
                const avance = l.total_a_pagar > 0 ? Math.min(100, (l.recaudado / l.total_a_pagar) * 100) : 0
                return (
                  <li
                    key={l.id}
                    className="px-3 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                    onClick={() => handleSelectLoan(l)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold text-sm truncate">
                            {l.cliente.apodo || l.cliente.nombre_completo}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{l.cliente.documento}</span>
                          {l.estado !== "activo" && (
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{l.estado}</Badge>
                          )}
                          {l.tipo_amortizacion && (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                              {tipoLabel(l.tipo_amortizacion)}
                            </Badge>
                          )}
                          {l.cuotasMora > 0 && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-red-100 text-red-800 px-1.5 py-0.5 text-[9px] font-semibold">
                              <AlertTriangle className="h-2.5 w-2.5" />
                              {etiquetaMora(l.cuotasMora)} en mora
                            </span>
                          )}
                          {rutaFiltro === "todas" && (
                            <span className="text-[9px] text-muted-foreground">· {nombreRuta(l.ruta)}</span>
                          )}
                        </div>

                        <Progress value={avance} className="h-1.5" />

                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">
                            {fmtCOP(l.recaudado)} de {fmtCOP(l.total_a_pagar)} · {l.total_cuotas} cuotas
                          </span>
                          <span className="tabular-nums whitespace-nowrap">
                            Saldo <strong className="text-foreground">{fmtCOP(l.saldoPendiente)}</strong>
                          </span>
                        </div>
                      </div>
                      <ChevronLeft className="h-4 w-4 text-muted-foreground rotate-180 shrink-0 mt-1" />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
