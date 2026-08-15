"use client"

import React from "react"

import { useState, useEffect, useRef, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Barcode as BarCode, X, Loader2, UserPlus, AlertCircle, CheckCircle2, ChevronsUpDown, Check } from "lucide-react"
// Ya no usamos los helpers de lib/database (createClient/createLoan/
// createPaymentPlan): la creacion de venta corre ahora en una sola
// transaccion via la RPC `crear_venta_atomica` que evita los problemas
// de session vars RLS perdidas entre peticiones HTTP stateless.
import { createClient } from "@/lib/supabase/client"
import { todayColombia } from "@/lib/colombia-date"
import { fmtFecha, fmtMoneda, sumarDias } from "@/lib/gestion-core"
import { buildPaymentSchedule, type Frecuencia, type TipoAmortizacion } from "@/lib/loan-schedule"
import { useToast } from "@/hooks/use-toast"
import { getRutaUmbrales, excedeUmbral, MENSAJE_REVISION, getSolicitanteNombre } from "@/lib/ruta-umbrales"
import { enviarOEncolar } from "@/lib/offline-queue"
import { obtenerUbicacion } from "@/lib/geo"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

// ── Fechas del cronograma ───────────────────────────────────────────────
// En frecuencia diaria NO se cobra los domingos: la semana de cobro es de
// lunes a sabado, seis dias.
//
// La regla anterior calculaba `inicio + (i-1)` y, si caia domingo, corria
// esa cuota un dia — pero sin mover las siguientes. La cuota del domingo y
// la del lunes terminaban el MISMO dia y el cliente amanecia debiendo dos.
// Ahora la cuota i cae en el i-esimo dia de cobro, saltando los domingos de
// corrido, asi que nunca se doblan.
//
// `inicio` nunca debe ser domingo (se ajusta con `siguienteDiaDeCobro`).
function fechaCuotaDiaria(inicio: Date, i: number): Date {
  const posicionEnLaSemana = (inicio.getDay() + 6) % 7 // lunes=0 … sabado=5
  const k = i - 1
  const d = new Date(inicio)
  d.setDate(d.getDate() + k + Math.floor((posicionEnLaSemana + k) / 6))
  return d
}

/** Corre la fecha al lunes si cae domingo. Solo aplica a frecuencia diaria. */
function siguienteDiaDeCobro(d: Date, diasEntrePagos: number): Date {
  if (diasEntrePagos !== 1 || d.getDay() !== 0) return d
  const ajustada = new Date(d)
  ajustada.setDate(ajustada.getDate() + 1)
  return ajustada
}

/** Fecha de la cuota `i` (1-based) segun la frecuencia. */
function fechaDeCuota(inicio: Date, i: number, diasEntrePagos: number): Date {
  if (diasEntrePagos === 1) return fechaCuotaDiaria(inicio, i)
  const d = new Date(inicio)
  d.setDate(d.getDate() + diasEntrePagos * (i - 1))
  return d
}

interface AmortizationRow {
  cuota: number
  fecha: string
  saldoInicial: number
  interes: number
  capital: number
  cuotaPago: number
  saldoFinal: number
}

type Client = {
  id: string
  clientId: string
  name: string
  cedula: string
  activeLoans: number
  pendingAmount: number
  cuota: number
  paidInstallments: number
  pendingInstallments: number
  mora: number
  lastPayment: number
  lastPaymentDate: string
  installmentAmount: number
  balance: number
}

type NewLoanProps = {
  preSelectedClientId?: string | null
  currentRutaId?: number
  rutaPais?: string
  onCancel?: () => void
}

export function NewLoan({ preSelectedClientId, currentRutaId = 1, rutaPais = "", onCancel }: NewLoanProps) {
  const { toast } = useToast()
  const [rutaId] = useState<number>(currentRutaId)
  const [isNewClient, setIsNewClient] = useState(false)
  const [selectedClient, setSelectedClient] = useState(preSelectedClientId || "")
  const [clientSearch, setClientSearch] = useState("")
  // Etiqueta del cliente elegido. Va aparte de `clientSearch` porque esa
  // ahora es SOLO el texto que se escribe para buscar: si se reutilizara
  // para mostrar el seleccionado, elegir un cliente dispararia una
  // busqueda nueva contra el servidor con su propio nombre.
  const [selectedClientLabel, setSelectedClientLabel] = useState("")
  const [clientPickerOpen, setClientPickerOpen] = useState(false)
  const [clientOptions, setClientOptions] = useState<{ id: string; apodo: string; nombre_completo: string; tiene_prestamo_activo?: boolean }[]>([])
  const [loadingClients, setLoadingClients] = useState(false)
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false)
  // Cuando viene de una renovación ya hay cliente preseleccionado; desactivar
  // el filtro para garantizar que aparezca sin importar tiene_prestamo_activo.
  const [soloSinPrestamo, setSoloSinPrestamo] = useState(!preSelectedClientId)

  // Fetch clients by apodo filtered by ruta and optionally by tiene_prestamo_activo.
  // Usa Supabase directamente (no /api/clients). RLS eliminado: el filtrado
  // por ruta es 100% a nivel aplicacion con `.eq('ruta', currentRutaId)`.
  useEffect(() => {
    if (isNewClient) return
    setLoadingClients(true)
    const timeout = setTimeout(async () => {
      try {
        const supabase = createClient()

        let query = supabase
          .from("clients")
          .select("id, nombre_completo, apodo, documento, tiene_prestamo_activo")
          .eq("ruta", rutaId)
          .order("apodo", { ascending: true })

        if (clientSearch.trim()) {
          query = query.ilike("apodo", `%${clientSearch.trim()}%`)
        }
        if (soloSinPrestamo) {
          query = query.eq("tiene_prestamo_activo", false)
        }

        const { data, error } = await query
        if (error) {
          console.error("[v0] Error fetching clients (new-loan):", error.message)
          setClientOptions([])
        } else {
          setClientOptions(Array.isArray(data) ? data : [])
        }
      } catch (err) {
        console.error("[v0] Unexpected error fetching clients (new-loan):", err)
        setClientOptions([])
      } finally {
        setLoadingClients(false)
      }
    }, 300)
    return () => clearTimeout(timeout)
  }, [clientSearch, rutaId, isNewClient, soloSinPrestamo])

  // Cuando el componente se abre desde el flujo de renovación, pre-carga el
  // cliente para que el Select muestre su nombre sin que el usuario tenga que buscarlo.
  useEffect(() => {
    if (!preSelectedClientId) return
    const fetchPreSelected = async () => {
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from("clients")
          .select("id, nombre_completo, apodo, tiene_prestamo_activo")
          .eq("id", preSelectedClientId)
          .maybeSingle()
        if (data) {
          setClientOptions([data])
          setSelectedClientLabel((data.apodo || data.nombre_completo).toUpperCase())
        }
      } catch (err) {
        console.error("[v0] Error pre-cargando cliente para renovacion:", err)
      }
    }
    fetchPreSelected()
  }, [preSelectedClientId])

  const [isCreating, setIsCreating] = useState(false)
  const [cedulaImage, setCedulaImage] = useState<string | null>(null)
  const [documento, setDocumento] = useState("")
  const [nombreCompleto, setNombreCompleto] = useState("")
  const [apodo, setApodo] = useState("")
  const [sector, setSector] = useState("")
  const [procesandoCedula, setProcessandoCedula] = useState(false)
  const [pagoAdelantado, setPagoAdelantado] = useState(false)
  // Por defecto el plan arranca MAÑANA (regla de negocio de siempre). Con
  // esto marcado arranca HOY, el mismo dia de la venta.
  const [iniciaPagosHoy, setIniciaPagosHoy] = useState(false)

  // ── Venta homologada ─────────────────────────────────────────────────────
  // Para cargar créditos que ya venían corriendo en otro sistema: se elige la
  // fecha real en que arrancó y se marca, día por día, qué pagó y qué no.
  // Con eso el saldo, la mora y el X/Y quedan exactos al día de hoy, en vez
  // de tener que "inventar" un préstamo nuevo por el saldo que quedaba.
  const [ventaHomologada, setVentaHomologada] = useState(false)
  const [fechaInicioHomologada, setFechaInicioHomologada] = useState("")
  // Marcas por número de cuota: qué pasó ese día y cuánto entró.
  const [marcasHomologacion, setMarcasHomologacion] = useState<
    Record<number, { tipo: "pago" | "no_pago"; monto: string }>
  >({})
  const [numeroCuotas, setNumeroCuotas] = useState(1)
  const [otroValor, setOtroValor] = useState(false)
  const [valorPago, setValorPago] = useState("")
  const [prestamoEmpleado, setPrestamoEmpleado] = useState(false)
  const [telefono, setTelefono] = useState("")
  const [telefono2, setTelefono2] = useState("")
  // ── Campos antes no controlados que ahora se persisten en estado para
  //    poder validar "obligatoriedad" y resaltar errores en la UI. ──
  const [direccion, setDireccion] = useState("")
  const [tipoComercio, setTipoComercio] = useState("")
  const [ref1Nombre, setRef1Nombre] = useState("")
  const [ref1Telefono, setRef1Telefono] = useState("")
  const [ref1Direccion, setRef1Direccion] = useState("")
  // Set de claves con errores de campo obligatorio. Se llena cuando el
  // usuario intenta enviar y faltan datos; cada Input/Select consulta este
  // set para pintar borde rojo. Se limpia automaticamente cuando el campo
  // recibe un valor valido (efecto controlado por el onChange).
  const [formErrors, setFormErrors] = useState<Set<string>>(new Set())
  // Banners persistentes en la cabecera del formulario:
  // - `formAlert` muestra "Faltan datos obligatorios" cuando la validacion
  //   bloquea el submit (queda visible hasta que el usuario empieza a
  //   corregir el primer campo en error).
  // - `successAlert` muestra el mensaje de exito tras crear la venta y se
  //   auto-oculta a los 5 segundos.
  // Estos avisos complementan los toasts existentes para que el usuario
  // vea el feedback aunque el toast haya desaparecido.
  const [formAlert, setFormAlert] = useState<string | null>(null)
  const [successAlert, setSuccessAlert] = useState<string | null>(null)
  // Dialog modal de confirmacion de venta exitosa. El usuario lo debe
  // cerrar explicitamente con "Aceptar" para no perderse el feedback.
  const [successDialog, setSuccessDialog] = useState<{ open: boolean; msg: string }>({
    open: false,
    msg: "",
  })
  // Dialog modal para campos faltantes. Muestra la lista de campos
  // pendientes de forma central y explicita.
  const [errorDialog, setErrorDialog] = useState<{ open: boolean; fields: string[] }>({
    open: false,
    fields: [],
  })
  // Toast pill flotante (mismo patron que register-transaction.tsx):
  // aparece en la parte inferior de la pantalla con fondo verde y
  // desaparece automaticamente a los 3 segundos.
  const [toastPill, setToastPill] = useState<string | null>(null)
  const showToastPill = (msg: string) => {
    setToastPill(msg)
    setTimeout(() => setToastPill(null), 3000)
  }
  // Dialog de confirmacion cuando la venta supera el umbral de la ruta
  // (nueva o renovacion, configurado por secretaria). Se resuelve via
  // Promise para poder "pausar" handleCreateVenta hasta que el usuario
  // decida, sin duplicar toda la logica de construccion de p_cliente/p_loan.
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
  // Helper: marca/desmarca un campo en formErrors. Permite que el onChange
  // de cada input limpie el resaltado tan pronto el usuario corrige.
  const clearFieldError = (field: string) =>
    setFormErrors((prev) => {
      // Cuando el usuario corrige un campo, ocultamos tambien el banner
      // global de error si seguia visible — asi el aviso desaparece tan
      // pronto el usuario empieza a actuar en respuesta al feedback.
      if (formAlert) setFormAlert(null)
      if (!prev.has(field)) return prev
      const next = new Set(prev)
      next.delete(field)
      return next
    })
  // Clase utilitaria que devuelve el borde rojo si el campo esta en error.
  // Se concatena al className existente para conservar estilos base.
  const errCls = (field: string) =>
    formErrors.has(field) ? "border-red-500 focus-visible:ring-red-500" : ""
  const [telefonoError, setTelefonoError] = useState("")
  const [telefono2Error, setTelefono2Error] = useState("")

  // Phone digits required per country
  const phoneDigitsByCountry: Record<string, number> = {
    colombia: 10,
    argentina: 10,
    peru: 9,
    perú: 9,
    chile: 9,
    brasil: 9,
    brazil: 9,
  }

  const requiredPhoneDigits = phoneDigitsByCountry[rutaPais.toLowerCase()] ?? 10

  const validatePhone = (value: string, field: "tel1" | "tel2") => {
    const digits = value.replace(/\D/g, "")
    if (digits.length > 0 && digits.length !== requiredPhoneDigits) {
      const msg = `El teléfono debe tener ${requiredPhoneDigits} dígitos (${rutaPais || "país no definido"})`
      if (field === "tel1") setTelefonoError(msg)
      else setTelefono2Error(msg)
      return false
    }
    if (field === "tel1") setTelefonoError("")
    else setTelefono2Error("")
    return true
  }

  const [valor, setValor] = useState("")
  const [saldo, setSaldo] = useState("")
  const [valorAPagar, setValorAPagar] = useState("")
  const [valorCuota, setValorCuota] = useState("")
  const [tasaInteres, setTasaInteres] = useState("")
  const [dias, setDias] = useState("")
  const [tipoAmortizacion, setTipoAmortizacion] = useState("")
  const [tipoVenta, setTipoVenta] = useState("efectivo")
  const [cuentaId, setCuentaId] = useState<string>("")
  const [cuentas, setCuentas] = useState<{ id: string; nombre: string }[]>([])
  const [loadingCuentas, setLoadingCuentas] = useState(false)

  // Fetch cuentas filtered by ruta when tipoVenta = transferencia
  useEffect(() => {
    if (tipoVenta !== "transferencia") return
    setLoadingCuentas(true)
    fetch(`/api/cuentas?ruta=${rutaId}`)
      .then((r) => r.json())
      .then((data) => setCuentas(Array.isArray(data) ? data : []))
      .catch(() => setCuentas([]))
      .finally(() => setLoadingCuentas(false))
  }, [tipoVenta, rutaId])
  // Frecuencia de pago: queda VACIA por defecto; el usuario debe elegir
  // explicitamente una opcion antes de poder generar el plan o registrar
  // la venta. La validacion en `handleGenerarPlanPago` y en el submit
  // bloquean continuar si esta en "".
  const [frecuenciaPago, setFrecuenciaPago] = useState("")
  const [diaSemana, setDiaSemana] = useState("")
  const [enrutarVenta, setEnrutarVenta] = useState("")
  const [amortizacionTable, setAmortizacionTable] = useState<AmortizationRow[]>([])
  const [showAmortization, setShowAmortization] = useState(false)

  // ── Cuotas que ya vencieron en una venta homologada ─────────────────────
  // Se calculan con la MISMA fórmula del servidor (lib/loan-schedule.ts es
  // espejo de `generar_cronograma`), así que lo que se marca aquí es
  // exactamente lo que quedará en el plan.
  const cuotasHomologacion = useMemo(() => {
    if (!ventaHomologada || !fechaInicioHomologada) return []
    const valorNum = Number.parseFloat(valor)
    const nCuotas = Number.parseInt(dias)
    const tasaNum = prestamoEmpleado ? 0 : Number.parseFloat(tasaInteres)
    if (!(valorNum > 0) || !(nCuotas >= 1)) return []
    if (!prestamoEmpleado && (!tipoAmortizacion || Number.isNaN(tasaNum))) return []
    if (!prestamoEmpleado && !frecuenciaPago) return []
    try {
      const { schedule } = buildPaymentSchedule({
        valor: valorNum,
        tasaInteres: tasaNum,
        numeroCuotas: nCuotas,
        frecuenciaPago: (prestamoEmpleado ? "daily" : frecuenciaPago) as Frecuencia,
        tipoAmortizacion: (prestamoEmpleado ? "empleado" : tipoAmortizacion) as TipoAmortizacion,
        prestamoEmpleado,
        fechaInicio: fechaInicioHomologada,
        diaSemana: diaSemana || null,
      })
      const hoy = todayColombia()
      return schedule.filter((r) => r.fecha_pago <= hoy)
    } catch (e) {
      console.warn("[v0] No se pudo simular el cronograma homologado:", e)
      return []
    }
  }, [
    ventaHomologada, fechaInicioHomologada, valor, dias, tasaInteres,
    tipoAmortizacion, frecuenciaPago, prestamoEmpleado, diaSemana,
  ])

  // Marca efectiva de una cuota: lo que eligió el usuario, o "pagó completo"
  // por defecto (el caso normal al homologar es que venía al día).
  const marcaDe = (numeroCuota: number, valorCuota: number) =>
    marcasHomologacion[numeroCuota] ?? { tipo: "pago" as const, monto: String(valorCuota) }

  const resumenHomologacion = useMemo(() => {
    let pagado = 0
    let noPagos = 0
    for (const c of cuotasHomologacion) {
      const m = marcaDe(c.numero_cuota, c.valor_cuota)
      if (m.tipo === "pago") pagado += Number.parseFloat(m.monto) || 0
      else noPagos += 1
    }
    return { pagado, noPagos, cuotas: cuotasHomologacion.length }
  }, [cuotasHomologacion, marcasHomologacion])

  // Auto-calculate Saldo (Valor a Pagar) y valor de cuota.
  // - Empleado: sin interes, saldo = valor.
  // - Aleman: interes total unico → saldo = valor + (valor * tasa).
  // - Americano: interes plano por periodo → cada cuota paga (valor * tasa)
  //   y la ultima cuota suma el capital. Saldo total = valor + (valor * tasa * numCuotas).
  useEffect(() => {
    const valorNum = Number.parseFloat(valor)
    if (!valorNum || isNaN(valorNum)) {
      setValorAPagar("")
      setValorCuota("")
      return
    }

    if (prestamoEmpleado) {
      // No interest for employee loans
      setValorAPagar(valorNum.toFixed(2))
      const diasNum = Number.parseInt(dias)
      if (diasNum > 0) setValorCuota((valorNum / diasNum).toFixed(2))
      else setValorCuota("")
      return
    }

    const tasaNum = Number.parseFloat(tasaInteres) / 100
    // Se distingue "todavia no escribio nada" de "escribio 0". Antes bastaba
    // con `!tasaNum`, y como 0 es falso, una venta al 0% dejaba el saldo y la
    // cuota en blanco: parecia que el formulario no respondia.
    if (tasaInteres.trim() === "" || isNaN(tasaNum)) {
      setValorAPagar("")
      setValorCuota("")
      return
    }

    const diasNum = Number.parseInt(dias)

    if (tipoAmortizacion === "americano" && diasNum > 0) {
      // Interes plano por periodo: cada cuota intermedia paga valor*tasa,
      // la ultima cuota paga valor*tasa + capital. Total a pagar incluye
      // todos los intereses acumulados.
      const interesPorPeriodo = valorNum * tasaNum
      const valorTotal = valorNum + interesPorPeriodo * diasNum
      setValorAPagar(valorTotal.toFixed(2))
      // El "valor de cuota" mostrado es el de las cuotas intermedias (solo interes).
      // La ultima cuota sera mayor porque incluye el capital.
      setValorCuota(interesPorPeriodo.toFixed(2))
      return
    }

    // Aleman (o cuando aun no se elige tipoAmortizacion): saldo = valor + (valor*tasa)
    const valorTotal = valorNum + valorNum * tasaNum
    setValorAPagar(valorTotal.toFixed(2))
    if (diasNum > 0) setValorCuota((valorTotal / diasNum).toFixed(2))
    else setValorCuota("")
  }, [valor, tasaInteres, dias, prestamoEmpleado, tipoAmortizacion])

  // Mock cuota value - this would come from loan calculation
  const cuotaValue = 50000

  const compressImage = (base64String: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => {
        const canvas = document.createElement("canvas")
        let width = img.width
        let height = img.height

        // Redimensionar si la imagen es muy grande
        // Máximo 1200px de ancho para mantener calidad pero reducir tamaño
        if (width > 1200) {
          height = (height * 1200) / width
          width = 1200
        }

        canvas.width = width
        canvas.height = height

        const ctx = canvas.getContext("2d")
        if (!ctx) {
          reject(new Error("No se pudo obtener contexto de canvas"))
          return
        }

        ctx.drawImage(img, 0, 0, width, height)

        // Comprimir a JPEG con calidad 0.7
        const compressedBase64 = canvas.toDataURL("image/jpeg", 0.7)
        resolve(compressedBase64)
      }
      img.onerror = () => {
        reject(new Error("Error al cargar imagen"))
      }
      img.src = base64String
    })
  }

  const handleCedulaCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onload = async (event) => {
        const imageBase64 = event.target?.result as string
        setCedulaImage(imageBase64)
        
        // Compress the image before processing
        try {
          setProcessandoCedula(true)
          
          const compressedImage = await compressImage(imageBase64)
          
          const response = await fetch("/api/escanear-cedula", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ imageBase64: compressedImage }),
          })

          const responseText = await response.text()
          
          let responseData
          try {
            responseData = JSON.parse(responseText)
          } catch (parseError) {
            throw new Error(`Respuesta inválida del servidor: ${responseText.substring(0, 100)}`)
          }
          
          if (!response.ok) {
            const errorMsg = responseData.details || responseData.error || "Error desconocido"
            throw new Error(errorMsg)
          }

        setDocumento((responseData.numero_documento || "").toUpperCase())
        setNombreCompleto((responseData.nombre_completo || "").toUpperCase())
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Error desconocido"
          alert(`Error al procesar la cédula: ${errorMsg}`)
          setCedulaImage(null) // Clear image on error
        } finally {
          setProcessandoCedula(false)
        }
      }
      reader.readAsDataURL(file)
    }
  }

  const clearCedulaImage = () => {
    setCedulaImage(null)
    setDocumento("")
    setNombreCompleto("")
  }

  const calcularAmortizacion = () => {
    const valorPrestamo = Number.parseFloat(valor)
    // El campo `dias` esta etiquetado como "Numero de cuotas" en la UI, por lo
    // que se interpreta como el numero total de cuotas a generar (no como
    // dias totales del prestamo). Esto mantiene la simulacion consistente
    // con handleCreateVenta, que tambien usa `dias` como numero de cuotas.
    const numeroCuotas = Number.parseInt(dias)
    const todayStr = todayColombia()
    const [y, m, d] = todayStr.split("-").map(Number)
    const fechaInicioCruda = new Date(y, m - 1, d + (iniciaPagosHoy ? 0 : 1))

    if (!valorPrestamo || !numeroCuotas) {
      alert("Por favor complete los campos de valor y número de cuotas")
      return
    }

    if (!prestamoEmpleado && (!tasaInteres || !tipoAmortizacion || !frecuenciaPago)) {
      alert("Por favor complete todos los campos requeridos")
      return
    }
    if (frecuenciaPago === "weekly" && !diaSemana) {
      alert("Para frecuencia Semanal debe seleccionar el día de cobro")
      return
    }

    // `numeroCuotas` ya es el numero total de pagos. Solo necesitamos calcular
    // la distancia (en dias) entre pagos segun la frecuencia.
    const numeroPagos = numeroCuotas
    let diasEntrePagos = 1

    if (!prestamoEmpleado) {
      switch (frecuenciaPago) {
        case "weekly":    diasEntrePagos = 7;  break
        case "biweekly":  diasEntrePagos = 15; break
        case "monthly":   diasEntrePagos = 30; break
        default:          diasEntrePagos = 1
      }
    }

    // La previsualizacion tiene que salir IDENTICA al plan que se guarda:
    // antes esta tabla no aplicaba la regla de domingos y el cobrador le
    // mostraba al cliente unas fechas y se guardaban otras.
    const fechaInicio = siguienteDiaDeCobro(fechaInicioCruda, diasEntrePagos)

    const schedule: AmortizationRow[] = []

    if (prestamoEmpleado) {
      // Employee loan: no interest, divide valor evenly by number of installments (daily)
      const cuotaDiaria = valorPrestamo / numeroCuotas
      for (let i = 1; i <= numeroCuotas; i++) {
        const fechaPago = fechaDeCuota(fechaInicio, i, diasEntrePagos)
        schedule.push({
          cuota: i,
          fecha: fechaPago.toLocaleDateString("es-ES"),
          saldoInicial: Math.round((valorPrestamo - cuotaDiaria * (i - 1)) * 100) / 100,
          interes: 0,
          capital: Math.round(cuotaDiaria * 100) / 100,
          cuotaPago: Math.round(cuotaDiaria * 100) / 100,
          saldoFinal: Math.round(Math.max(0, valorPrestamo - cuotaDiaria * i) * 100) / 100,
        })
      }
    } else {
      const tasa = Number.parseFloat(tasaInteres) / 100
      if (tipoAmortizacion === "americano") {
        // Interes plano por periodo: cada cuota paga valor*tasa de intereses,
        // la ultima cuota incluye ademas el capital completo. El saldo
        // inicial/final refleja capital + intereses pendientes por pagar.
        // Ej: valor=100, tasa=10%, 10 cuotas → $10 interes c/u, capital $100 al final.
        const interesPorPeriodo = valorPrestamo * tasa
        const interesRound = Math.round(interesPorPeriodo * 100) / 100
        for (let i = 1; i <= numeroPagos; i++) {
          const fechaPago = fechaDeCuota(fechaInicio, i, diasEntrePagos)
          const esUltimaCuota = i === numeroPagos
          const capitalCuota = esUltimaCuota ? valorPrestamo : 0
          const cuotaPago = interesRound + capitalCuota
          // Intereses que aun faltan por pagar al inicio de esta cuota:
          // si quedan k cuotas (incluyendo esta), faltan k * interes.
          const cuotasRestantesInicio = numeroPagos - i + 1
          const cuotasRestantesFinal = numeroPagos - i
          const saldoInicial = valorPrestamo + interesRound * cuotasRestantesInicio
          const saldoFinal = esUltimaCuota ? 0 : valorPrestamo + interesRound * cuotasRestantesFinal
          schedule.push({
            cuota: i,
            fecha: fechaPago.toLocaleDateString("es-ES"),
            saldoInicial: Math.round(saldoInicial * 100) / 100,
            interes: interesRound,
            capital: Math.round(capitalCuota * 100) / 100,
            cuotaPago: Math.round(cuotaPago * 100) / 100,
            saldoFinal: Math.round(saldoFinal * 100) / 100,
          })
        }
      } else if (tipoAmortizacion === "aleman") {
        // Cuota fija simple: el saldo total ya incluye intereses (valor + valor*tasa)
        // cuota = saldoTotal / numCuotas  →  siempre igual
        const saldoTotal = valorPrestamo + valorPrestamo * tasa
        const cuotaFija = Math.round((saldoTotal / numeroPagos) * 100) / 100
        const interesTotal = valorPrestamo * tasa
        const interesPorCuota = Math.round((interesTotal / numeroPagos) * 100) / 100
        const capitalPorCuota = Math.round((valorPrestamo / numeroPagos) * 100) / 100
        let saldoRestante = saldoTotal
        for (let i = 1; i <= numeroPagos; i++) {
          const fechaPago = fechaDeCuota(fechaInicio, i, diasEntrePagos)
          const saldoInicial = Math.round(saldoRestante * 100) / 100
          saldoRestante = Math.max(0, saldoRestante - cuotaFija)
          schedule.push({
            cuota: i,
            fecha: fechaPago.toLocaleDateString("es-ES"),
            saldoInicial,
            interes: interesPorCuota,
            capital: capitalPorCuota,
            cuotaPago: cuotaFija,
            saldoFinal: Math.round(saldoRestante * 100) / 100,
          })
        }
      }
    }

    setAmortizacionTable(schedule)
    setShowAmortization(true)
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value)
  }

  // Limpieza del formulario tras registrar una venta. Se usa en los tres
  // caminos de salida: creacion directa, envio a revision por umbral, y
  // guardado en la cola cuando no hay conexion.
  // Limpia SOLO los datos del cliente. Se usa al elegir otro cliente, donde
  // los valores del prestamo que el cobrador ya digito deben conservarse.
  const limpiarDatosCliente = () => {
    setDocumento("")
    setNombreCompleto("")
    setApodo("")
    setSector("")
    setTelefono("")
    setTelefono2("")
    setTelefonoError("")
    setTelefono2Error("")
    setDireccion("")
    setTipoComercio("")
    setRef1Nombre("")
    setRef1Telefono("")
    setRef1Direccion("")
    setCedulaImage(null)
  }

  const resetFormularioVenta = () => {
    setValor("")
    setSaldo("")
    setValorAPagar("")
    setValorCuota("")
    setTasaInteres("")
    setDias("")
    setTipoAmortizacion("")
    setFrecuenciaPago("")
    setDiaSemana("")
    setEnrutarVenta("")
    setAmortizacionTable([])
    setShowAmortization(false)
    setPagoAdelantado(false)
    setIniciaPagosHoy(false)
    setNumeroCuotas(1)
    setOtroValor(false)
    setValorPago("")
    setPrestamoEmpleado(false)
    setSelectedClient("")
    setSelectedClientLabel("")
    setClientSearch("")
    setClientSearch("")
    limpiarDatosCliente()
    setFormErrors(new Set())
  }

  // Candado de re-entrada. `disabled={isCreating}` en el boton no alcanza:
  // solo aplica despues del re-render, y un doble toque rapido en el celular
  // vuelve a entrar antes de eso — creando dos ventas.
  const creandoVentaRef = useRef(false)

  const handleCreateVenta = async () => {
    if (creandoVentaRef.current) {
      console.warn("[v0] Venta ya en curso: se ignora el segundo envio")
      return
    }
    creandoVentaRef.current = true
    try {
      setIsCreating(true)

      // ── Validacion de campos requeridos ───────────────────────────────
      // Construimos un set con los IDs de los campos faltantes para poder
      // resaltarlos individualmente en la UI (cada Input/SelectTrigger
      // consulta `formErrors.has(<id>)` via el helper `errCls`).
      //
      // Campos obligatorios (segun regla de negocio):
      // - Cliente NUEVO: apodo, telefono, direccion, tipoComercio,
      //   nombreCompleto (auto desde cedula), ref1Nombre, ref1Telefono,
      //   ref1Direccion
      // - Cliente EXISTENTE: solo se valida que se haya seleccionado
      // - Datos del prestamo: valor, dias (nro cuotas), frecuenciaPago
      //   (+ tasaInteres y tipoAmortizacion si NO es prestamo empleado)
      // Mapa de IDs de campo → etiqueta legible para el usuario. Se usa
      // tanto en el banner de error como en el toast para que el mensaje
      // sea especifico en lugar de generico.
      const fieldLabels: Record<string, string> = {
        nombreCompleto: "Nombre completo",
        apodo: "Apodo",
        telefono: "Teléfono",
        direccion: "Dirección",
        tipoComercio: "Tipo de comercio",
        ref1Nombre: "Nombre de referencia 1",
        ref1Telefono: "Teléfono de referencia 1",
        ref1Direccion: "Dirección de referencia 1",
        amount: "Valor del préstamo",
        dias: "Número de cuotas",
        frequency: "Frecuencia de pago",
        diaSemana: "Día de cobro (obligatorio para frecuencia Semanal)",
        tasaInteres: "Tasa de interés",
        tipoAmortizacion: "Método de interés",
      }

      const errors = new Set<string>()
      if (isNewClient) {
        if (!nombreCompleto.trim()) errors.add("nombreCompleto")
        if (!apodo.trim()) errors.add("apodo")
        if (!telefono.trim()) errors.add("telefono")
        if (!direccion.trim()) errors.add("direccion")
        if (!tipoComercio.trim()) errors.add("tipoComercio")
        if (!ref1Nombre.trim()) errors.add("ref1Nombre")
        if (!ref1Telefono.trim()) errors.add("ref1Telefono")
        if (!ref1Direccion.trim()) errors.add("ref1Direccion")
      }
      if (!valor || Number.parseFloat(valor) <= 0) errors.add("amount")
      if (!dias || Number.parseInt(dias) <= 0) errors.add("dias")
      if (!frecuenciaPago) errors.add("frequency")
      if (frecuenciaPago === "weekly" && !diaSemana) errors.add("diaSemana")
      if (!prestamoEmpleado) {
        if (!tasaInteres) errors.add("tasaInteres")
        if (!tipoAmortizacion) errors.add("tipoAmortizacion")
      }

      if (errors.size > 0) {
        setFormErrors(errors)
        const missingNames = [...errors].map((id) => fieldLabels[id] ?? id)
        // Dialog modal con lista de campos faltantes
        setErrorDialog({ open: true, fields: missingNames })
        // Banner persistente en cabecera como respaldo visual
        setFormAlert(missingNames.join("||"))
        setSuccessAlert(null)
        return
      }
      // Limpiar errores previos si la validacion paso.
      setFormErrors(new Set())
      setFormAlert(null)

      // ── Construir p_cliente (nuevo vs existente) ──────────────────────
      // Si es cliente nuevo validamos sus campos y armamos el payload
      // completo; si es existente, solo enviamos `is_new: false` y `id`.
      let p_cliente: Record<string, unknown>
      if (isNewClient) {
        // Sin conexion no se pueden crear clientes nuevos: el escaneo de
        // cedula necesita el servidor, y dos cobradores sin senal podrian
        // registrar a la misma persona y duplicarla. Las renovaciones a
        // clientes existentes si funcionan offline.
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          toast({
            title: "Sin conexión",
            description:
              "No se pueden registrar clientes nuevos sin internet. Puedes hacer ventas a clientes que ya existen, o esperar a tener señal.",
            variant: "destructive",
          })
          return
        }
        if (!documento || !nombreCompleto) {
          toast({
            title: "Error",
            description: "Por favor complete los datos del cliente",
            variant: "destructive",
          })
          return
        }
        if (telefono && telefono.replace(/\D/g, "").length !== requiredPhoneDigits) {
          toast({
            title: "Teléfono inválido",
            description: `El teléfono debe tener exactamente ${requiredPhoneDigits} dígitos para ${rutaPais || "el país configurado"}`,
            variant: "destructive",
          })
          return
        }
        if (telefono2 && telefono2.replace(/\D/g, "").length !== requiredPhoneDigits) {
          toast({
            title: "Teléfono 2 inválido",
            description: `El teléfono 2 debe tener exactamente ${requiredPhoneDigits} dígitos para ${rutaPais || "el país configurado"}`,
            variant: "destructive",
          })
          return
        }
        p_cliente = {
          is_new: true,
          documento,
          nombre_completo: nombreCompleto,
          apodo: apodo || null,
          sector: sector || null,
          telefono: telefono || null,
          telefono2: telefono2 || null,
          // Datos adicionales obligatorios capturados en el formulario
          // (antes se enviaban como null porque eran inputs no controlados).
          direccion: direccion || null,
          tipo_comercio: tipoComercio || null,
          ref1_nombre: ref1Nombre || null,
          ref1_telefono: ref1Telefono || null,
          ref1_direccion: ref1Direccion || null,
          cedula_image_url: cedulaImage || null,
        }
      } else {
        if (!selectedClient) {
          toast({
            title: "Error",
            description: "Por favor seleccione un cliente",
            variant: "destructive",
          })
          return
        }
        p_cliente = { is_new: false, id: selectedClient }
      }

      // ── Calculos de amortizacion (se preservan tal cual) ──────────────
      const valorNum = Number.parseFloat(valor)
      const tasaNum = Number.parseFloat(tasaInteres) / 100
      const numeroCuotasNum = Number.parseInt(dias)

      // Total a pagar segun el tipo:
      // - Empleado: solo el capital
      // - Americano: capital + intereses planos por cada cuota (valor*tasa*N)
      // - Aleman: capital + interes total unico (valor*tasa)
      // Si el usuario ya tiene un valorAPagar calculado por el useEffect lo usamos,
      // pero recalculamos como respaldo para americano para garantizar consistencia.
      let valorAPagarNum: number
      if (prestamoEmpleado) {
        valorAPagarNum = valorNum
      } else if (tipoAmortizacion === "americano") {
        valorAPagarNum = valorNum + valorNum * tasaNum * numeroCuotasNum
      } else {
        valorAPagarNum = valorAPagar ? Number.parseFloat(valorAPagar) : valorNum + valorNum * tasaNum
      }
      // Para americano la "cuota" tipica es solo el interes; para aleman es el promedio.
      const valorCuotaNum =
        tipoAmortizacion === "americano" && !prestamoEmpleado
          ? valorNum * tasaNum
          : valorAPagarNum / numeroCuotasNum

      // Calculate days between payments based on frequency
      let diasEntrePagos = 1
      if (!prestamoEmpleado) {
        switch (frecuenciaPago) {
          case "weekly": diasEntrePagos = 7; break
          case "biweekly": diasEntrePagos = 15; break
          case "monthly": diasEntrePagos = 30; break
          default: diasEntrePagos = 1
        }
      }

      // ── Fecha de la primera cuota ─────────────────────────────────────
      // REGLA DE NEGOCIO: por defecto el plan inicia al día siguiente de la
      // venta. Con "Inicia pagos hoy" arranca el mismo día. En una venta
      // homologada arranca el día real en que arrancó en el otro sistema.
      //
      // El CRONOGRAMA ya no se arma aquí: lo genera el servidor con
      // `generar_cronograma` (script 045). Antes esta matemática vivía en
      // tres copias distintas —dos en este archivo y una en la librería—
      // y divergían entre sí.
      const hoyStr = todayColombia()
      const fechaPrimerPago = ventaHomologada && fechaInicioHomologada
        ? fechaInicioHomologada
        : sumarDias(hoyStr, iniciaPagosHoy ? 0 : 1)

      // ── Historial de la venta homologada ──────────────────────────────
      // Un evento por cada día ya vencido: qué pagó y qué no. El servidor
      // los aplica como gestiones con origen 'homologacion' — cuentan para
      // el saldo y la mora, pero NO entran en la caja de esos días (esa
      // plata se recibió en el sistema anterior).
      const historial = ventaHomologada
        ? cuotasHomologacion.map((c) => {
            const m = marcaDe(c.numero_cuota, c.valor_cuota)
            return {
              fecha: c.fecha_pago,
              tipo: m.tipo,
              monto: m.tipo === "pago" ? Number.parseFloat(m.monto) || 0 : 0,
            }
          })
        : []

      if (ventaHomologada) {
        if (!fechaInicioHomologada) {
          toast({
            title: "Falta la fecha de inicio",
            description: "Indica en qué fecha arrancó el crédito para poder cargar su historia.",
            variant: "destructive",
          })
          return
        }
        if (fechaInicioHomologada > hoyStr) {
          toast({
            title: "Fecha de inicio inválida",
            description: "La fecha de inicio de una venta homologada no puede ser futura.",
            variant: "destructive",
          })
          return
        }
        const totalHistorial = historial.reduce((s, h) => s + h.monto, 0)
        if (totalHistorial > valorAPagarNum) {
          toast({
            title: "Los pagos superan el total",
            description: `Lo marcado como pagado (${fmtMoneda(totalHistorial)}) supera el total a pagar (${fmtMoneda(valorAPagarNum)}).`,
            variant: "destructive",
          })
          return
        }
      }

      // ── Construir p_loan ──────────────────────────────────────────────
      // OJO: NO se incluye `cuenta_id` porque la columna no existe en el
      // esquema actual de `loans` (la RPC se encarga de moverlo a otra
      // tabla si aplica). `ruta` tampoco va aqui porque la RPC la toma de
      // p_ruta_id para evitar inconsistencias entre params.
      // ── Abono inicial ─────────────────────────────────────────────────
      const abonoInicialNum = pagoAdelantado ? (Number.parseFloat(valorPago) || 0) : 0
      if (pagoAdelantado && abonoInicialNum <= 0) {
        toast({
          title: "Abono inválido",
          description: "Marcaste pago adelantado pero el valor está vacío o en cero.",
          variant: "destructive",
        })
        return
      }
      if (abonoInicialNum > valorAPagarNum) {
        toast({
          title: "Abono mayor que la venta",
          description: `El abono ($${abonoInicialNum.toLocaleString()}) no puede superar el total a pagar ($${valorAPagarNum.toLocaleString()}).`,
          variant: "destructive",
        })
        return
      }

      const p_loan = {
        valor: valorNum,
        saldo: valorAPagarNum,
        valor_a_pagar: valorAPagarNum,
        valor_cuota: Math.round(valorCuotaNum * 100) / 100,
        tasa_interes: prestamoEmpleado ? 0 : Number.parseFloat(tasaInteres),
        numero_cuotas: numeroCuotasNum,
        tipo_amortizacion: prestamoEmpleado ? "empleado" : tipoAmortizacion,
        frecuencia_pago: frecuenciaPago,
        dia_semana: diaSemana || null,
        tipo_venta: tipoVenta,
        prestamo_empleado: prestamoEmpleado,
        enrutar_venta: enrutarVenta || null,
        cuenta_id: tipoVenta === "transferencia" && cuentaId ? cuentaId : null,
        fecha_primer_pago: fechaPrimerPago,
        // Fecha del DISPOSITIVO: si la venta se sincroniza mañana, el abono
        // inicial debe quedar en el día en que el cliente entregó la plata,
        // no en el día en que el servidor la recibió.
        fecha_dispositivo: hoyStr,
        // Historia de la venta homologada (vacío en una venta normal).
        historial,
        // Abono inicial ("Pago adelantado"). Viaja DENTRO de p_loan igual que
        // la llave de idempotencia, para no cambiar la firma de la RPC — que
        // tiene otros callers, como la aprobacion de solicitudes.
        //
        // Hasta el script 040 este dato se capturaba en el formulario y se
        // descartaba al guardar: la venta quedaba con todas las cuotas
        // pendientes y la plata que el cliente entrego no aparecia por
        // ningun lado.
        abono_inicial: abonoInicialNum,
      }

      // El plan lo genera el servidor: se manda vacío. Ver `crear_venta_atomica`
      // en el script 045 — si llegara con filas las respeta (compatibilidad
      // con dispositivos que aún tengan la versión anterior en su cola).
      const p_payment_plan: unknown[] = []

      // ── Leer credenciales del usuario desde localStorage ──────────────
      // currentUser y selectedRuta los persiste el shell (app/page.tsx).
      let p_user_id: string | null = null
      let p_ruta_id: number = rutaId
      let p_rol: string | null = null
      try {
        const rawUser = typeof window !== "undefined" ? localStorage.getItem("currentUser") : null
        if (rawUser) {
          const parsed = JSON.parse(rawUser)
          p_user_id = parsed?.id ?? null
          p_rol = parsed?.rol ?? null
        }
        const rawRuta = typeof window !== "undefined" ? localStorage.getItem("selectedRuta") : null
        if (rawRuta) {
          const parsedRuta = JSON.parse(rawRuta)
          if (typeof parsedRuta?.id === "number") p_ruta_id = parsedRuta.id
        }
      } catch (e) {
        console.warn("[v0] Error leyendo credenciales de localStorage:", e)
      }

      if (!p_user_id || !p_ruta_id || !p_rol) {
        toast({
          title: "Sesión inválida",
          description: "No se pudieron obtener las credenciales del usuario. Vuelve a iniciar sesión.",
          variant: "destructive",
        })
        return
      }

      // ── Ubicacion de la venta ─────────────────────────────────────────
      // Queda como referencia del cliente para la geocerca: al cobrarle se
      // compara contra este punto. Tambien viaja en las renovaciones — si
      // el cliente venia sin ubicacion la RPC la llena con esta, y si ya
      // tenia no la pisa.
      //
      // Es de MEJOR ESFUERZO a proposito. Una venta es plata entrando; no
      // puede quedar bloqueada porque el chip GPS no engancho o el permiso
      // esta en prompt. Si no se captura aca, el primer cobro la captura.
      //
      // Va DESPUES de las validaciones para no hacerle esperar hasta 10s de
      // GPS a un formulario que igual iba a rebotar.
      try {
        const pos = await obtenerUbicacion()
        p_cliente.latitud = pos.latitud
        p_cliente.longitud = pos.longitud
      } catch (err) {
        console.warn("[v0] Venta sin ubicacion (se capturara en el primer cobro):", err)
      }

      // ── Umbral de aprobacion por ruta (venta nueva vs renovacion) ──────
      // Si la venta supera el umbral configurado por secretaria para este
      // tipo (nueva o renovacion, segun si viene de preSelectedClientId),
      // se envia a revision en vez de llamar la RPC directamente. Nada se
      // escribe en loans/payment_plan hasta que secretaria la apruebe.
      const esRenovacion = !!preSelectedClientId
      const umbrales = await getRutaUmbrales(p_ruta_id)
      const ventaHabilitada = esRenovacion ? umbrales.venta_renovacion_habilitado : umbrales.venta_nueva_habilitado
      const ventaUmbral = esRenovacion ? umbrales.venta_renovacion_umbral : umbrales.venta_nueva_umbral

      if (excedeUmbral(ventaHabilitada, ventaUmbral, valorNum)) {
        const confirmado = await confirmRevision()
        if (!confirmado) return

        const { error: insertError } = await createClient().from("solicitudes_revision").insert({
          tipo: "venta",
          subtipo: esRenovacion ? "renovacion" : "nueva",
          ruta_id: p_ruta_id,
          solicitado_por: p_user_id,
          solicitado_por_nombre: getSolicitanteNombre(),
          monto: valorNum,
          descripcion: `${esRenovacion ? "Renovación" : "Venta nueva"} — ${apodo || nombreCompleto}`,
          payload: { p_cliente, p_loan, p_payment_plan },
        })

        if (insertError) {
          toast({ title: "Error", description: insertError.message, variant: "destructive" })
          return
        }

        showToastPill(MENSAJE_REVISION)
        setSuccessDialog({ open: true, msg: MENSAJE_REVISION })
        setSuccessAlert(MENSAJE_REVISION)
        setFormAlert(null)
        setTimeout(() => setSuccessAlert(null), 6000)

        resetFormularioVenta()
        return
      }

      // ── Llamada UNICA a la RPC atomica ────────────────────────────────
      // Toda la creacion (cliente + loan + payment_plan) corre en una sola
      // transaccion en la base; si algo falla, se hace rollback completo
      // y nunca quedan registros huerfanos.
      // Sin conexion la venta queda en la cola del dispositivo y se envia sola
      // despues. Las fechas del plan NO se recalculan al sincronizar: son las
      // que se pactaron con el cliente al hacer la venta.
      // Se usa la etiqueta guardada al elegir y no una busqueda dentro de
      // `clientOptions`: esa lista se refiltra con cada tecla, asi que el
      // cliente ya seleccionado puede no estar en ella.
      const nombreParaEtiqueta = isNewClient
        ? (apodo || nombreCompleto || "Cliente")
        : (selectedClientLabel
            || clientOptions.find((c) => c.id === selectedClient)?.apodo
            || clientOptions.find((c) => c.id === selectedClient)?.nombre_completo
            || "Cliente")

      let ventaEncolada = false
      let resultadoVenta: unknown = null
      try {
        const r = await enviarOEncolar({
          tipo: "venta",
          descripcion: `Venta — ${nombreParaEtiqueta} ($${valorNum.toLocaleString()})`,
          payload: { p_cliente, p_loan, p_payment_plan },
        })
        ventaEncolada = r.encolado
        resultadoVenta = r.resultado ?? null
      } catch (err) {
        // Documento repetido: mensaje claro en vez del generico. Antes este
        // caso solo se veia por la llamada duplicada que ya se elimino.
        const msg = err instanceof Error ? err.message : String(err)
        const code = (err as { code?: string })?.code
        const esDocDuplicado =
          code === "23505" || /documento/i.test(msg) || /clients_documento/i.test(msg)
        console.error("[v0] Error creando venta:", err)
        toast({
          title: esDocDuplicado ? "Documento ya registrado" : "Error al crear la venta",
          description: esDocDuplicado
            ? `Ya existe un cliente con el documento ${documento}. Búscalo en "Cliente Existente" para registrarle otra venta.`
            : msg || "No se pudo completar la operación",
          variant: "destructive",
        })
        return
      }

      if (ventaEncolada) {
        showToastPill("Venta guardada sin conexión. Se enviará al volver la señal.")
        setSuccessDialog({
          open: true,
          msg: "La venta quedó guardada en el teléfono y se enviará automáticamente cuando vuelva la señal.",
        })
        resetFormularioVenta()
        return
      }

      // NOTA: `enviarOEncolar` de arriba YA envio la venta al servidor. Aqui
      // antes habia una segunda llamada directa a `crear_venta_atomica` que
      // quedo por error al agregar el soporte offline: creaba un SEGUNDO
      // prestamo, ademas sin llave de idempotencia, asi que la proteccion
      // contra duplicados no podia detectarlo. Ese bloque se elimino.

      console.log("[v0] crear_venta_atomica OK:", resultadoVenta)

      const successMsg = `Se registró la venta de $${Number(valor || 0).toLocaleString()} para ${nombreParaEtiqueta}.`
      showToastPill("Venta registrada exitosamente")
      setSuccessDialog({ open: true, msg: successMsg })
      setSuccessAlert(successMsg)
      setFormAlert(null)
      setTimeout(() => setSuccessAlert(null), 6000)

      resetFormularioVenta()
    } catch (error) {
      console.error('[v0] Error creating venta:', error)
      toast({
        title: "Error",
        description: "Ocurrió un error al crear la venta",
        variant: "destructive",
      })
    } finally {
      setIsCreating(false)
      creandoVentaRef.current = false
    }
  }

  return (
    <div className="space-y-3 md:space-y-6">
      {/* ── Banners de feedback ────────────────────────────────────────
          Avisos persistentes que complementan los toasts. Quedan en la
          cabecera del formulario, encima del titulo, para que sean
          visibles tras el scroll automatico que disparamos en
          `handleCreateVenta`. */}
      {formAlert && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Faltan campos obligatorios</AlertTitle>
          <AlertDescription>
            <p className="mb-1">Por favor diligencia los siguientes campos resaltados en rojo:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {formAlert.split("||").map((campo) => (
                <li key={campo} className="text-[11px] md:text-sm">
                  {campo}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {successAlert && (
        <Alert
          role="status"
          className="border-success bg-success-light/40 text-success [&>svg]:text-success"
        >
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle className="font-semibold">Venta registrada exitosamente</AlertTitle>
          <AlertDescription className="text-foreground/90">
            {successAlert}
          </AlertDescription>
        </Alert>
      )}

      {/* Toast pill flotante — mismo patron que register-transaction.tsx */}
      {toastPill && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium bg-success text-white animate-in fade-in slide-in-from-bottom-4">
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {toastPill}
        </div>
      )}

      {/* Dialog modal de campos faltantes */}
      <Dialog
        open={errorDialog.open}
        onOpenChange={(open) => setErrorDialog((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader className="items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <DialogTitle className="text-base font-semibold text-center">
              Faltan campos por diligenciar
            </DialogTitle>
            <DialogDescription className="text-sm text-center text-foreground/80">
              Por favor completa los siguientes campos antes de registrar la venta:
            </DialogDescription>
          </DialogHeader>
          <ul className="mt-1 space-y-1 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3">
            {errorDialog.fields.map((campo) => (
              <li key={campo} className="flex items-center gap-2 text-sm text-foreground">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                {campo}
              </li>
            ))}
          </ul>
          <DialogFooter className="mt-2">
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => {
                setErrorDialog({ open: false, fields: [] })
                if (typeof window !== "undefined") {
                  window.scrollTo({ top: 0, behavior: "smooth" })
                }
              }}
            >
              Entendido, voy a corregirlo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog modal de confirmacion de venta exitosa */}
      <Dialog
        open={successDialog.open}
        onOpenChange={(open) => setSuccessDialog((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="max-w-sm text-center">
          <DialogHeader className="items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15">
              <CheckCircle2 className="h-6 w-6 text-success" />
            </div>
            <DialogTitle className="text-base font-semibold">
              Venta registrada exitosamente
            </DialogTitle>
            <DialogDescription className="text-sm text-foreground/80">
              {successDialog.msg}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 justify-center">
            <Button
              className="w-full"
              onClick={() => setSuccessDialog({ open: false, msg: "" })}
            >
              Aceptar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog de confirmacion: la venta supera el umbral de la ruta */}
      <Dialog open={showRevisionDialog} onOpenChange={(open) => { if (!open) handleRevisionChoice(false) }}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader className="items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
              <AlertCircle className="h-6 w-6 text-amber-600" />
            </div>
            <DialogTitle className="text-base font-semibold">Venta supera el umbral de la ruta</DialogTitle>
            <DialogDescription className="text-sm text-foreground/80">
              {MENSAJE_REVISION}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 flex-col-reverse sm:flex-row gap-2">
            <Button variant="outline" className="w-full" onClick={() => handleRevisionChoice(false)}>
              Cancelar
            </Button>
            <Button className="w-full" onClick={() => handleRevisionChoice(true)}>
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex items-center justify-between">
        <h2 className="text-base md:text-2xl font-bold text-card-foreground">Nueva Venta</h2>
        <button
          type="button"
          onClick={() => {
            // Se cambia de cliente: el formulario se limpia por completo.
            // Antes los datos del cliente anterior quedaban vivos en el
            // estado (solo dejaban de verse), y el mensaje de exito podia
            // anunciar la venta a nombre del cliente equivocado.
            resetFormularioVenta()
            setIsNewClient(!isNewClient)
          }}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-sm md:text-base transition-all ${
            isNewClient
              ? "bg-primary text-primary-foreground shadow-md"
              : "bg-sky-100 text-sky-700 hover:bg-sky-200 border border-sky-300"
          }`}
        >
          <UserPlus className="h-5 w-5 md:h-6 md:w-6" />
          Nuevo cliente
        </button>
      </div>

      {/* Botón grande para capturar cédula - solo visible cuando es nuevo cliente */}
      {isNewClient && (
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-lg p-4 md:p-8 border-2 border-blue-200 shadow-md">
          <input type="file" accept="image/*" capture="environment" onChange={handleCedulaCapture} className="hidden" id="cedula-upload" />
          <Label htmlFor="cedula-upload" className="cursor-pointer block">
            <div className="flex flex-col items-center gap-3 md:gap-4">
              <div className="flex items-center justify-center">
                <Button
                  type="button"
                  size="lg"
                  variant={cedulaImage ? "default" : "outline"}
                  className={`h-16 w-16 md:h-24 md:w-24 rounded-full shadow-lg transition-all ${
                    cedulaImage 
                      ? "bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white border-0" 
                      : "bg-white border-2 border-blue-400 hover:bg-blue-50"
                  } ${procesandoCedula ? "opacity-60 cursor-wait animate-pulse" : "hover:shadow-xl"}`}
                  asChild
                  disabled={procesandoCedula}
                >
                  <span title={procesandoCedula ? "Procesando cédula..." : "Toca para capturar tu cédula"}>
                    <BarCode className={`${cedulaImage ? "h-12 w-12 md:h-16 md:w-16" : "h-10 w-10 md:h-14 md:w-14"}`} />
                  </span>
                </Button>
              </div>
              <div className="text-center">
                <p className="text-xs md:text-base font-semibold text-blue-900">
                  {procesandoCedula ? "Procesando..." : cedulaImage ? "Cédula capturada" : "Captura tu cédula"}
                </p>
                <p className="text-[10px] md:text-sm text-blue-700">
                  {procesandoCedula ? "Leyendo información..." : cedulaImage ? "Toca para cambiar" : "Toca el botón para fotografiar"}
                </p>
              </div>
              {cedulaImage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="hover:text-red-700 hover:bg-red-50 text-popover-foreground"
                  onClick={clearCedulaImage}
                >
                  <X className="h-4 w-4 mr-1" />
                  Cambiar
                </Button>
              )}
            </div>
          </Label>
        </div>
      )}

      {/* Vista previa de cédula */}
      {cedulaImage && (
        <div className="bg-card rounded-lg p-3 md:p-4 border border-border">
          <img src={cedulaImage || "/placeholder.svg"} alt="Cédula" className="max-h-40 md:max-h-64 mx-auto rounded" />
        </div>
      )}

      <Card>
        <CardHeader className="p-2 md:p-6">
          <CardTitle className="text-xs md:text-base">
            {isNewClient ? "Información del Nuevo Cliente" : "Información del Préstamo"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 md:space-y-4 p-2 md:p-6">
          {isNewClient ? (
            // New client form
            <>
              <div className="grid gap-2 md:gap-4 grid-cols-1 md:grid-cols-3">
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="documento" className="text-[11px] md:text-sm">
                    Documento
                  </Label>
                  <Input
                    id="documento"
                    placeholder="Número de documento"
                    value={documento}
                    readOnly
                    disabled={procesandoCedula}
                    className="h-8 md:h-10 text-[11px] md:text-sm bg-muted"
                  />
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="nombreCompleto" className="text-[11px] md:text-sm">
                    Nombre y apellido completo <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="nombreCompleto"
                    placeholder="Nombre completo"
                    value={nombreCompleto}
                    readOnly
                    disabled={procesandoCedula}
                    className="h-8 md:h-10 text-[11px] md:text-sm bg-muted"
                  />
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="apodo" className="text-[11px] md:text-sm">
                    Apodo <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="apodo"
                    placeholder="Apodo o referencia"
                    value={apodo}
                    onChange={(e) => {
                      setApodo(e.target.value.toUpperCase())
                      clearFieldError("apodo")
                    }}
                    className={`h-8 md:h-10 text-[11px] md:text-sm uppercase ${errCls("apodo")}`}
                  />
                </div>
              </div>

              <div className="grid gap-2 md:gap-4 grid-cols-2 md:grid-cols-4">
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="telefono" className="text-[10px] md:text-sm">
                    Teléfono <span className="text-red-500">*</span>
                    {requiredPhoneDigits > 0 && (
                      <span className="ml-1 text-muted-foreground">({requiredPhoneDigits} dígitos)</span>
                    )}
                  </Label>
                  <Input
                    id="telefono"
                    placeholder={`${requiredPhoneDigits} dígitos`}
                    type="tel"
                    value={telefono}
                    maxLength={requiredPhoneDigits}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "")
                      setTelefono(val)
                      validatePhone(val, "tel1")
                      if (val) clearFieldError("telefono")
                    }}
                    className={`h-7 md:h-10 text-[10px] md:text-sm ${telefonoError ? "border-red-500 focus-visible:ring-red-500" : ""} ${errCls("telefono")}`}
                  />
                  {telefonoError && (
                    <p className="text-[9px] md:text-xs text-red-500">{telefonoError}</p>
                  )}
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="telefono2" className="text-[10px] md:text-sm">
                    Teléfono 2
                    {requiredPhoneDigits > 0 && (
                      <span className="ml-1 text-muted-foreground">({requiredPhoneDigits} dígitos)</span>
                    )}
                  </Label>
                  <Input
                    id="telefono2"
                    placeholder={`${requiredPhoneDigits} dígitos (opcional)`}
                    type="tel"
                    value={telefono2}
                    maxLength={requiredPhoneDigits}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "")
                      setTelefono2(val)
                      validatePhone(val, "tel2")
                    }}
                    className={`h-7 md:h-10 text-[10px] md:text-sm ${telefono2Error ? "border-red-500 focus-visible:ring-red-500" : ""}`}
                  />
                  {telefono2Error && (
                    <p className="text-[9px] md:text-xs text-red-500">{telefono2Error}</p>
                  )}
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="direccion" className="text-[10px] md:text-sm">
                    Dirección <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="direccion"
                    placeholder="Dirección completa"
                    value={direccion}
                    onChange={(e) => {
                      setDireccion(e.target.value.toUpperCase())
                      clearFieldError("direccion")
                    }}
                    className={`h-7 md:h-10 text-[10px] md:text-sm uppercase ${errCls("direccion")}`}
                  />
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="sector" className="text-[10px] md:text-sm">
                    Sector
                  </Label>
                  <Input
                    id="sector"
                    placeholder="Ej: Centro, Norte, Sur, etc."
                    value={sector}
                    onChange={(e) => setSector(e.target.value.toUpperCase())}
                    className="h-7 md:h-10 text-[10px] md:text-sm uppercase"
                  />
                </div>
              </div>
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="tipoComercio" className="text-[10px] md:text-sm">
                  Tipo de comercio <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="tipoComercio"
                  placeholder="Ej: Tienda, Restaurante, etc."
                  value={tipoComercio}
                  onChange={(e) => {
                    setTipoComercio(e.target.value.toUpperCase())
                    clearFieldError("tipoComercio")
                  }}
                  className={`h-7 md:h-10 text-[10px] md:text-sm uppercase ${errCls("tipoComercio")}`}
                />
              </div>

              <div className="pt-2 md:pt-4">
                <h3 className="text-[10px] md:text-sm font-semibold mb-2 md:mb-3">Referencia 1</h3>
                <div className="space-y-2 md:space-y-4">
                  <div className="grid gap-2 md:gap-4 grid-cols-1 md:grid-cols-2">
                    <div className="space-y-1 md:space-y-2">
                      <Label htmlFor="ref1Nombre" className="text-[10px] md:text-sm">
                        Nombre completo de la referencia <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="ref1Nombre"
                        placeholder="Nombre de la referencia"
                        value={ref1Nombre}
                        onChange={(e) => {
                          setRef1Nombre(e.target.value.toUpperCase())
                          clearFieldError("ref1Nombre")
                        }}
                        className={`h-7 md:h-10 text-[10px] md:text-sm uppercase ${errCls("ref1Nombre")}`}
                      />
                    </div>
                    <div className="space-y-1 md:space-y-2">
                      <Label htmlFor="ref1Telefono" className="text-[10px] md:text-sm">
                        Teléfono de la referencia <span className="text-red-500">*</span>
                      </Label>
                      <Input
                        id="ref1Telefono"
                        placeholder="Teléfono de la referencia"
                        type="tel"
                        value={ref1Telefono}
                        onChange={(e) => {
                          setRef1Telefono(e.target.value.replace(/\D/g, ""))
                          if (e.target.value) clearFieldError("ref1Telefono")
                        }}
                        className={`h-7 md:h-10 text-[10px] md:text-sm ${errCls("ref1Telefono")}`}
                      />
                    </div>
                  </div>
                  <div className="space-y-1 md:space-y-2">
                    <Label htmlFor="ref1Direccion" className="text-[10px] md:text-sm">
                      Dirección de la referencia <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="ref1Direccion"
                      placeholder="Dirección de la referencia"
                      value={ref1Direccion}
                      onChange={(e) => {
                        setRef1Direccion(e.target.value.toUpperCase())
                        clearFieldError("ref1Direccion")
                      }}
                      className={`h-7 md:h-10 text-[10px] md:text-sm uppercase ${errCls("ref1Direccion")}`}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            // Existing client selector — searchable dropdown filtered by ruta/apodo
            <div className="space-y-1 md:space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="clientSearch" className="text-[10px] md:text-sm">
                  Cliente
                </Label>
                <div className="flex items-center gap-1.5">
                  <Checkbox
                    id="soloSinPrestamo"
                    checked={soloSinPrestamo}
                    onCheckedChange={(checked) => setSoloSinPrestamo(checked === true)}
                    className="h-3.5 w-3.5 md:h-4 md:w-4"
                  />
                  <Label htmlFor="soloSinPrestamo" className="text-[9px] md:text-xs text-muted-foreground cursor-pointer">
                    Solo sin prestamo activo
                  </Label>
                </div>
              </div>
              {/* Combobox (Popover + Command) y no un Select.
                  El Select de Radix esta pensado para elegir con el teclado:
                  se queda con las pulsaciones para su propia busqueda y
                  maneja el foco el mismo. Con un campo de texto adentro eso
                  choca, y en el celular era peor — al abrirse el teclado la
                  pantalla cambia de tamaño y el desplegable se cerraba a la
                  primera letra. Popover + Command si esta hecho para
                  contener un buscador. */}
              <Popover open={clientPickerOpen} onOpenChange={(open) => {
                setClientPickerOpen(open)
                // Al abrir sin nada cargado se traen los clientes de la ruta.
                if (open && clientOptions.length === 0 && !loadingClients) {
                  setClientSearch("")
                }
              }}>
                <PopoverTrigger asChild>
                  <Button
                    id="clientSearch"
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={clientPickerOpen}
                    className="w-full justify-between h-7 md:h-10 text-[10px] md:text-sm font-normal px-2 md:px-3"
                  >
                    <span className={`truncate ${selectedClientLabel ? "" : "text-muted-foreground"}`}>
                      {loadingClients && !clientPickerOpen
                        ? "Cargando..."
                        : selectedClientLabel || "Seleccione un cliente..."}
                    </span>
                    <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="p-0 w-[var(--radix-popover-trigger-width)]"
                  align="start"
                  // En el celular el teclado virtual roba el foco al abrir.
                  // Sin esto, Radix lo devuelve al boton y el campo pierde el
                  // cursor apenas se toca.
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <Command shouldFilter={false}>
                    {/* shouldFilter en false: el filtrado lo hace el servidor
                        con `ilike` sobre el apodo. Si tambien filtrara cmdk,
                        escondería resultados que el servidor si devolvio. */}
                    <CommandInput
                      placeholder="Buscar por apodo..."
                      value={clientSearch}
                      onValueChange={(v) => setClientSearch(v.toUpperCase())}
                      className="text-[11px] md:text-sm uppercase"
                    />
                    <CommandList className="max-h-52">
                      {loadingClients && (
                        <div className="flex items-center justify-center py-3 text-muted-foreground text-[10px] gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> Buscando...
                        </div>
                      )}
                      {!loadingClients && clientOptions.length === 0 && (
                        <div className="py-3 text-center text-muted-foreground text-[10px] md:text-sm">
                          No se encontraron clientes en esta ruta
                        </div>
                      )}
                      {!loadingClients && clientOptions.length > 0 && (
                        <CommandGroup>
                          {clientOptions.map((c) => (
                            <CommandItem
                              key={c.id}
                              value={c.id}
                              onSelect={() => {
                                // Al elegir otro cliente se limpian los datos
                                // del anterior (incluidos los de un intento de
                                // cliente nuevo abandonado).
                                limpiarDatosCliente()
                                setSelectedClient(c.id)
                                setSelectedClientLabel((c.apodo || c.nombre_completo).toUpperCase())
                                setClientPickerOpen(false)
                              }}
                              className="text-[10px] md:text-sm"
                            >
                              <Check
                                className={`mr-2 h-3.5 w-3.5 shrink-0 ${selectedClient === c.id ? "opacity-100" : "opacity-0"}`}
                              />
                              <span className="font-medium truncate">{(c.apodo || c.nombre_completo).toUpperCase()}</span>
                              {c.apodo && (
                                <span className="ml-2 text-muted-foreground text-[9px] truncate">{c.nombre_completo}</span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          )}

          {/* Cuando arranca el cobro */}
          {!ventaHomologada && (
            <label
              htmlFor="iniciaPagosHoy"
              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
                iniciaPagosHoy
                  ? "bg-amber-100 border-amber-400 text-amber-800"
                  : "bg-muted/50 border-border hover:bg-muted"
              }`}
            >
              <Checkbox
                id="iniciaPagosHoy"
                checked={iniciaPagosHoy}
                onCheckedChange={(checked) => setIniciaPagosHoy(checked as boolean)}
                className="h-4 w-4 md:h-5 md:w-5"
              />
              <span className="text-[11px] md:text-sm font-medium">
                Inicia pagos hoy
                <span className="ml-1 font-normal opacity-80">
                  (por defecto la primera cuota es mañana)
                </span>
              </span>
            </label>
          )}

          {/* ── Venta homologada (crédito que ya venía corriendo) ────────── */}
          <label
            htmlFor="ventaHomologada"
            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
              ventaHomologada
                ? "bg-violet-100 border-violet-400 text-violet-800"
                : "bg-muted/50 border-border hover:bg-muted"
            }`}
          >
            <Checkbox
              id="ventaHomologada"
              checked={ventaHomologada}
              onCheckedChange={(checked) => {
                const v = checked as boolean
                setVentaHomologada(v)
                if (v) setIniciaPagosHoy(false)
                else { setFechaInicioHomologada(""); setMarcasHomologacion({}) }
              }}
              className="h-4 w-4 md:h-5 md:w-5"
            />
            <span className="text-[11px] md:text-sm font-medium">
              Venta homologada
              <span className="ml-1 font-normal opacity-80">
                (crédito que ya venía corriendo en otro sistema)
              </span>
            </span>
          </label>

          {ventaHomologada && (
            <div className="rounded-lg border border-violet-300 bg-violet-50/60 p-3 space-y-3">
              <p className="text-[11px] md:text-sm text-violet-900">
                Indica cuándo arrancó el crédito y marca qué días pagó y cuáles no.
                Con eso el saldo, la mora y el conteo de cuotas quedan reales al día de hoy.
                Estos pagos <strong>no entran en la caja</strong>: esa plata se recibió en el otro sistema.
              </p>

              <div className="grid gap-1.5">
                <Label htmlFor="fechaInicioHomologada" className="text-[11px] md:text-sm">
                  Fecha de la primera cuota
                </Label>
                <Input
                  id="fechaInicioHomologada"
                  type="date"
                  max={todayColombia()}
                  value={fechaInicioHomologada}
                  onChange={(e) => { setFechaInicioHomologada(e.target.value); setMarcasHomologacion({}) }}
                  className="h-8 md:h-10 text-[11px] md:text-sm"
                />
              </div>

              {cuotasHomologacion.length === 0 && fechaInicioHomologada && (
                <p className="text-[11px] md:text-sm text-violet-900">
                  Completa el valor, las cuotas y la tasa para ver las cuotas ya vencidas.
                </p>
              )}

              {cuotasHomologacion.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] md:text-sm font-medium text-violet-900">
                      {cuotasHomologacion.length} cuota{cuotasHomologacion.length === 1 ? "" : "s"} ya vencida{cuotasHomologacion.length === 1 ? "" : "s"}
                    </span>
                    <Button
                      type="button" variant="outline" size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => setMarcasHomologacion({})}
                    >
                      Marcar todas como pagadas
                    </Button>
                    <Button
                      type="button" variant="outline" size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        const todas: Record<number, { tipo: "pago" | "no_pago"; monto: string }> = {}
                        for (const c of cuotasHomologacion) todas[c.numero_cuota] = { tipo: "no_pago", monto: "0" }
                        setMarcasHomologacion(todas)
                      }}
                    >
                      Marcar todas como no pago
                    </Button>
                  </div>

                  <div className="max-h-72 overflow-y-auto rounded-md border border-violet-200 bg-background">
                    <table className="w-full text-[11px] md:text-sm">
                      <thead className="sticky top-0 bg-violet-100 text-violet-900">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium">#</th>
                          <th className="px-2 py-1.5 text-left font-medium">Vencía</th>
                          <th className="px-2 py-1.5 text-right font-medium">Cuota</th>
                          <th className="px-2 py-1.5 text-center font-medium">¿Pagó?</th>
                          <th className="px-2 py-1.5 text-right font-medium">Abonó</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cuotasHomologacion.map((c) => {
                          const m = marcaDe(c.numero_cuota, c.valor_cuota)
                          const pago = m.tipo === "pago"
                          return (
                            <tr key={c.numero_cuota} className="border-t border-violet-100">
                              <td className="px-2 py-1 text-muted-foreground">{c.numero_cuota}</td>
                              <td className="px-2 py-1">{fmtFecha(c.fecha_pago)}</td>
                              <td className="px-2 py-1 text-right">{fmtMoneda(c.valor_cuota)}</td>
                              <td className="px-2 py-1">
                                <div className="flex justify-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setMarcasHomologacion((p) => ({
                                      ...p, [c.numero_cuota]: { tipo: "pago", monto: String(c.valor_cuota) },
                                    }))}
                                    className={`rounded px-2 py-0.5 text-[10px] md:text-xs font-medium transition-colors ${
                                      pago ? "bg-green-600 text-white" : "bg-muted text-muted-foreground hover:bg-green-100"
                                    }`}
                                  >
                                    Pagó
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setMarcasHomologacion((p) => ({
                                      ...p, [c.numero_cuota]: { tipo: "no_pago", monto: "0" },
                                    }))}
                                    className={`rounded px-2 py-0.5 text-[10px] md:text-xs font-medium transition-colors ${
                                      !pago ? "bg-amber-600 text-white" : "bg-muted text-muted-foreground hover:bg-amber-100"
                                    }`}
                                  >
                                    No pagó
                                  </button>
                                </div>
                              </td>
                              <td className="px-2 py-1 text-right">
                                <Input
                                  type="number" inputMode="decimal" min="0" disabled={!pago}
                                  value={pago ? m.monto : "0"}
                                  onChange={(e) => setMarcasHomologacion((p) => ({
                                    ...p, [c.numero_cuota]: { tipo: "pago", monto: e.target.value },
                                  }))}
                                  className="h-7 w-24 ml-auto text-right text-[11px] md:text-sm"
                                />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap justify-between gap-2 rounded-md bg-violet-100 px-3 py-2 text-[11px] md:text-sm text-violet-900">
                    <span>Ya abonado: <strong>{fmtMoneda(resumenHomologacion.pagado)}</strong></span>
                    <span>No pagos: <strong>{resumenHomologacion.noPagos}</strong></span>
                    <span>
                      Saldo al crearla:{" "}
                      <strong>
                        {fmtMoneda(Math.max(0, (Number.parseFloat(valorAPagar) || 0) - resumenHomologacion.pagado))}
                      </strong>
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Pago Adelantado - Préstamo Empleado Checkboxes */}
          <div className="grid gap-2 md:gap-4 grid-cols-2">
            <label
              htmlFor="pagoAdelantado"
              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
                pagoAdelantado
                  ? "bg-sky-100 border-sky-400 text-sky-800"
                  : "bg-muted/50 border-border hover:bg-muted"
              }`}
            >
              <Checkbox
                id="pagoAdelantado"
                checked={pagoAdelantado}
                onCheckedChange={(checked) => {
                  setPagoAdelantado(checked as boolean)
                  if (checked && valorCuota) {
                    setValorPago(valorCuota)
                  }
                }}
                className="h-4 w-4 md:h-5 md:w-5"
              />
              <span className="text-[11px] md:text-sm font-medium">
                Pago adelantado
              </span>
            </label>

            <label
              htmlFor="prestamoEmpleado"
              className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all border ${
                prestamoEmpleado
                  ? "bg-green-100 border-green-400 text-green-800"
                  : "bg-muted/50 border-border hover:bg-muted"
              }`}
            >
              <Checkbox
                id="prestamoEmpleado"
                checked={prestamoEmpleado}
                onCheckedChange={(checked) => setPrestamoEmpleado(checked as boolean)}
                className="h-4 w-4 md:h-5 md:w-5"
              />
              <span className="text-[11px] md:text-sm font-medium">
                Préstamo empleado
              </span>
            </label>
          </div>

          {/* Tipo de Venta */}
          <div className="space-y-1 md:space-y-2">
            <Label htmlFor="tipoVenta" className="text-[11px] md:text-sm">
              Tipo de Venta
            </Label>
            <Select value={tipoVenta} onValueChange={(v) => { setTipoVenta(v); setCuentaId("") }}>
              <SelectTrigger id="tipoVenta" className="h-8 md:h-10 text-[11px] md:text-sm">
                <SelectValue placeholder="Seleccione tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="efectivo" className="text-[11px] md:text-sm">
                  Efectivo
                </SelectItem>
                <SelectItem value="transferencia" className="text-[11px] md:text-sm">
                  Transferencia
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Cuenta bancaria - solo visible para Transferencia */}
          {tipoVenta === "transferencia" && (
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="cuentaId" className="text-[11px] md:text-sm">
                Cuenta de Transferencia
              </Label>
              <Select value={cuentaId} onValueChange={setCuentaId} disabled={loadingCuentas}>
                <SelectTrigger id="cuentaId" className="h-8 md:h-10 text-[11px] md:text-sm">
                  <SelectValue placeholder={loadingCuentas ? "Cargando cuentas..." : "Seleccione una cuenta"} />
                </SelectTrigger>
                <SelectContent>
                  {cuentas.length === 0 && !loadingCuentas ? (
                    <SelectItem value="__none" disabled className="text-[11px] md:text-sm text-muted-foreground">
                      No hay cuentas disponibles para esta ruta
                    </SelectItem>
                  ) : (
                    cuentas.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-[11px] md:text-sm">
                        {c.nombre}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Valor - Tasa - Saldo (calculado automáticamente) */}
          <div className={`grid gap-2 md:gap-4 ${prestamoEmpleado ? "grid-cols-2" : "grid-cols-3"}`}>
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="amount" className="text-[11px] md:text-sm">
                Valor <span className="text-red-500">*</span>
              </Label>
              <Input
                id="amount"
                placeholder="0.00"
                type="number"
                step="0.01"
                value={valor}
                onChange={(e) => {
                  setValor(e.target.value)
                  if (e.target.value) clearFieldError("amount")
                }}
                className={`h-8 md:h-10 text-[11px] md:text-sm ${errCls("amount")}`}
              />
            </div>
            {!prestamoEmpleado && (
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="interestRate" className="text-[11px] md:text-sm">
                  Tasa de Interés (%) <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="interestRate"
                  placeholder="0.00"
                  type="number"
                  step="0.01"
                  value={tasaInteres}
                  onChange={(e) => {
                    setTasaInteres(e.target.value)
                    if (e.target.value) clearFieldError("tasaInteres")
                  }}
                  className={`h-8 md:h-10 text-[11px] md:text-sm ${errCls("tasaInteres")}`}
                />
              </div>
            )}
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="saldo" className="text-[11px] md:text-sm">
                Saldo x pagar
                <span className="ml-1 text-[9px] text-muted-foreground font-normal">auto</span>
              </Label>
              <Input
                id="saldo"
                type="number"
                step="0.01"
                value={valorAPagar}
                readOnly
                className="h-8 md:h-10 text-[11px] md:text-sm bg-muted font-semibold text-primary"
              />
            </div>
          </div>

          {/* Método de Interés - hidden for employee loans */}
          {!prestamoEmpleado && (
          <div className="space-y-1 md:space-y-2">
            <Label htmlFor="tipoAmortizacion" className="text-[11px] md:text-sm">
              Método de Interés <span className="text-red-500">*</span>
            </Label>
            <Select
              value={tipoAmortizacion}
              onValueChange={(v) => {
                setTipoAmortizacion(v)
                clearFieldError("tipoAmortizacion")
              }}
            >
              <SelectTrigger
                id="tipoAmortizacion"
                className={`h-8 md:h-10 text-[11px] md:text-sm ${errCls("tipoAmortizacion")}`}
              >
                <SelectValue placeholder="Seleccione método" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="americano" className="text-[11px] md:text-sm">
                  Americano (Interés)
                </SelectItem>
                <SelectItem value="aleman" className="text-[11px] md:text-sm">
                  Alemán (Capital)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          )}

          {/* Nro Cuotas */}
          <div className="space-y-1 md:space-y-2">
            <Label htmlFor="dias" className="text-[11px] md:text-sm">
              Nro Cuotas <span className="text-red-500">*</span>
            </Label>
            <Input
              id="dias"
              type="number"
              placeholder="Número de cuotas"
              value={dias}
              onChange={(e) => {
                setDias(e.target.value)
                if (e.target.value) clearFieldError("dias")
              }}
              className={`h-8 md:h-10 text-[11px] md:text-sm ${errCls("dias")}`}
            />
          </div>

          {/* Frecuencia de Pago - Valor Cuota */}
          <div className="grid gap-2 md:gap-4 grid-cols-2">
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="frequency" className="text-[11px] md:text-sm">
                Frecuencia de Pago <span className="text-red-500">*</span>
              </Label>
              <Select
                value={frecuenciaPago}
                onValueChange={(v) => {
                  setFrecuenciaPago(v)
                  clearFieldError("frequency")
                }}
              >
                <SelectTrigger
                  id="frequency"
                  className={`h-8 md:h-10 text-[11px] md:text-sm ${errCls("frequency")}`}
                >
                  <SelectValue placeholder="Seleccione frecuencia" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily" className="text-[11px] md:text-sm">
                    Diario
                  </SelectItem>
                  <SelectItem value="weekly" className="text-[11px] md:text-sm">
                    Semanal
                  </SelectItem>
                  <SelectItem value="biweekly" className="text-[11px] md:text-sm">
                    Quincenal
                  </SelectItem>
                  <SelectItem value="monthly" className="text-[11px] md:text-sm">
                    Mensual
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="valorCuota" className="text-[11px] md:text-sm">
                Valor Cuota
              </Label>
              <Input
                id="valorCuota"
                placeholder="0.00"
                type="number"
                step="0.01"
                value={valorCuota}
                readOnly
                className="h-8 md:h-10 text-[11px] md:text-sm bg-muted"
              />
            </div>
          </div>

          {/* Day of Week - Only visible if frequency is not daily */}
          {frecuenciaPago && frecuenciaPago !== "daily" && (
            <div className="space-y-1 md:space-y-2">
              <Label htmlFor="dayOfWeek" className="text-[11px] md:text-sm">
                Día de Cobro{frecuenciaPago === "weekly" && <span className="text-red-500 ml-0.5">*</span>}
              </Label>
              <Select value={diaSemana} onValueChange={(v) => { setDiaSemana(v); clearFieldError("diaSemana") }}>
                <SelectTrigger id="dayOfWeek" className={`h-8 md:h-10 text-[11px] md:text-sm ${errCls("diaSemana")}`}>
                  <SelectValue placeholder="Seleccione día" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lunes" className="text-[11px] md:text-sm">
                    Lunes
                  </SelectItem>
                  <SelectItem value="martes" className="text-[11px] md:text-sm">
                    Martes
                  </SelectItem>
                  <SelectItem value="miercoles" className="text-[11px] md:text-sm">
                    Miércoles
                  </SelectItem>
                  <SelectItem value="jueves" className="text-[11px] md:text-sm">
                    Jueves
                  </SelectItem>
                  <SelectItem value="viernes" className="text-[11px] md:text-sm">
                    Viernes
                  </SelectItem>
                  <SelectItem value="sabado" className="text-[11px] md:text-sm">
                    Sábado
                  </SelectItem>
                  <SelectItem value="domingo" className="text-[11px] md:text-sm">
                    Domingo
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex justify-end pt-2 md:pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={calcularAmortizacion}
              className="h-7 md:h-10 text-[10px] md:text-sm bg-transparent"
            >
              Simular amortización
            </Button>
          </div>

          {pagoAdelantado && (
              <div className="space-y-2 md:space-y-3">
                <div className="grid gap-2 md:gap-4 grid-cols-1 md:grid-cols-3">
                  <div className="space-y-1 md:space-y-2">
                    <Label htmlFor="numeroCuotas" className="text-[10px] md:text-sm">
                      Número de Cuotas
                    </Label>
                    <Select
                      value={numeroCuotas.toString()}
                      onValueChange={(value) => {
                        const num = Number.parseInt(value)
                        setNumeroCuotas(num)
                        if (!otroValor) {
                          setValorPago((cuotaValue * num).toString())
                        }
                      }}
                      disabled={otroValor}
                    >
                      <SelectTrigger id="numeroCuotas" className="h-7 md:h-10 text-[10px] md:text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                          <SelectItem key={num} value={num.toString()} className="text-[10px] md:text-sm">
                            {num} {num === 1 ? "cuota" : "cuotas"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-end">
                    <div className="flex items-center gap-1.5 md:gap-2 h-7 md:h-10">
                      <Checkbox
                        id="otroValor"
                        checked={otroValor}
                        onCheckedChange={(checked) => {
                          setOtroValor(checked as boolean)
                          if (!checked) {
                            setValorPago((cuotaValue * numeroCuotas).toString())
                          } else {
                            setValorPago("")
                          }
                        }}
                      />
                      <Label htmlFor="otroValor" className="text-[10px] md:text-sm font-medium cursor-pointer">
                        Otro valor
                      </Label>
                    </div>
                  </div>

                  <div className="space-y-1 md:space-y-2">
                    <Label htmlFor="valorPago" className="text-[10px] md:text-sm">
                      Valor pago
                    </Label>
                    <Input
                      id="valorPago"
                      type="number"
                      placeholder="0.00"
                      step="0.01"
                      value={valorPago}
                      onChange={(e) => setValorPago(e.target.value)}
                      readOnly={!otroValor}
                      className="h-7 md:h-10 text-[10px] md:text-sm"
                    />
                  </div>
                </div>
              </div>
            )}

          <div className="flex flex-col-reverse sm:flex-row justify-end gap-1.5 md:gap-2 pt-2 md:pt-4">
            <Button 
              variant="outline" 
              className="h-8 md:h-10 text-[11px] md:text-sm bg-transparent"
              disabled={isCreating}
              onClick={onCancel}
            >
              Cancelar
            </Button>
            <Button 
              onClick={handleCreateVenta}
              disabled={isCreating}
              className="h-8 md:h-10 text-[11px] md:text-sm"
            >
              {isCreating ? "Creando..." : "Crear Venta"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {showAmortization && amortizacionTable.length > 0 && (
        <Card>
          <CardHeader className="p-2 md:p-6">
            <CardTitle className="text-xs md:text-base">
              Tabla de Amortización - {tipoAmortizacion === "americano" ? "Sistema Americano" : "Sistema Alemán"}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-2 md:p-6">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-[10px] md:text-sm">
                    <TableHead className="text-[10px] md:text-sm">Cuota</TableHead>
                    <TableHead className="text-[10px] md:text-sm">Fecha</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Saldo Inicial</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Interés</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Capital</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Cuota</TableHead>
                    <TableHead className="text-[10px] md:text-sm text-right">Saldo Final</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {amortizacionTable.map((row) => (
                    <TableRow key={row.cuota} className="text-[10px] md:text-sm">
                      <TableCell className="text-[10px] md:text-sm">{row.cuota}</TableCell>
                      <TableCell className="text-[10px] md:text-sm">{row.fecha}</TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">
                        {formatCurrency(row.saldoInicial)}
                      </TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">{formatCurrency(row.interes)}</TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">{formatCurrency(row.capital)}</TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right font-semibold">
                        {formatCurrency(row.cuotaPago)}
                      </TableCell>
                      <TableCell className="text-[10px] md:text-sm text-right">
                        {formatCurrency(row.saldoFinal)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
