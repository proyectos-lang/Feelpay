"use client"

import React from "react"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Barcode as BarCode, X, Loader2, UserPlus, AlertCircle, CheckCircle2 } from "lucide-react"
// Ya no usamos los helpers de lib/database (createClient/createLoan/
// createPaymentPlan): la creacion de venta corre ahora en una sola
// transaccion via la RPC `crear_venta_atomica` que evita los problemas
// de session vars RLS perdidas entre peticiones HTTP stateless.
import { createClient } from "@/lib/supabase/client"
import { useToast } from "@/hooks/use-toast"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

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
  const [clientOptions, setClientOptions] = useState<{ id: string; apodo: string; nombre_completo: string; tiene_prestamo_activo?: boolean }[]>([])
  const [loadingClients, setLoadingClients] = useState(false)
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false)
  const [soloSinPrestamo, setSoloSinPrestamo] = useState(true) // Default: only show clients without active loan

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
  const [isCreating, setIsCreating] = useState(false)
  const [cedulaImage, setCedulaImage] = useState<string | null>(null)
  const [documento, setDocumento] = useState("")
  const [nombreCompleto, setNombreCompleto] = useState("")
  const [apodo, setApodo] = useState("")
  const [sector, setSector] = useState("")
  const [procesandoCedula, setProcessandoCedula] = useState(false)
  const [pagoAdelantado, setPagoAdelantado] = useState(false)
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
    if (!tasaNum || isNaN(tasaNum)) {
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
    const todayStr = new Date().toLocaleDateString("en-CA")
    const [y, m, d] = todayStr.split("-").map(Number)
    const fechaInicio = new Date(y, m - 1, d + 1)

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

    const schedule: AmortizationRow[] = []

    if (prestamoEmpleado) {
      // Employee loan: no interest, divide valor evenly by number of installments (daily)
      const cuotaDiaria = valorPrestamo / numeroCuotas
      for (let i = 1; i <= numeroCuotas; i++) {
        const fechaPago = new Date(fechaInicio)
        fechaPago.setDate(fechaPago.getDate() + (i - 1))
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
          const fechaPago = new Date(fechaInicio)
          fechaPago.setDate(fechaPago.getDate() + diasEntrePagos * (i - 1))
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
          const fechaPago = new Date(fechaInicio)
          fechaPago.setDate(fechaPago.getDate() + diasEntrePagos * (i - 1))
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

  const handleCreateVenta = async () => {
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

      // ── Helpers de fecha (zona horaria local) ─────────────────────────
      // Formatea un Date a YYYY-MM-DD usando partes LOCALES — evita el bug
      // clasico de `.toISOString().split("T")[0]` que convierte a UTC y puede
      // restar un dia segun el huso del navegador (en Colombia/UTC-5 ocurre
      // cuando el Date se construye con hora 0).
      const toLocalDateStr = (d: Date): string => {
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, "0")
        const day = String(d.getDate()).padStart(2, "0")
        return `${y}-${m}-${day}`
      }
      // Para prestamos de cobro DIARIO no se cobra los domingos: si la fecha
      // calculada cae en domingo, se corre al lunes. Solo aplica cuando
      // diasEntrePagos === 1; para frecuencias semanal/quincenal/mensual
      // se respeta la fecha tal cual.
      const skipDomingoSiDiario = (d: Date): Date => {
        if (diasEntrePagos !== 1) return d
        if (d.getDay() === 0) {
          const ajustada = new Date(d)
          ajustada.setDate(ajustada.getDate() + 1)
          return ajustada
        }
        return d
      }

      // REGLA DE NEGOCIO: el plan de pagos SIEMPRE inicia al dia siguiente
      // de la fecha en que se registra la venta (hoy + 1).
      // - Construimos `hoy` desde partes locales para no arrastrar UTC.
      // - Sumamos 1 dia.
      // - Si el resultado cae en domingo y la frecuencia es diaria, se corre
      //   al lunes.
      const todayStr2 = new Date().toLocaleDateString("en-CA")
      const [y2, m2, d2] = todayStr2.split("-").map(Number)
      let fechaInicio = new Date(y2, m2 - 1, d2 + 1)
      fechaInicio = skipDomingoSiDiario(fechaInicio)

      const paymentSchedule: Array<{
        numero_cuota: number
        fecha_pago: string
        valor_cuota: number
        capital: number
        interes: number
        saldo: number
      }> = []

      if (prestamoEmpleado) {
        // Employee loan: no interest, simple daily division
        const cuotaDiaria = Math.round((valorNum / numeroCuotasNum) * 100) / 100
        for (let i = 1; i <= numeroCuotasNum; i++) {
          let fechaPago = new Date(fechaInicio)
          fechaPago.setDate(fechaPago.getDate() + (i - 1))
          fechaPago = skipDomingoSiDiario(fechaPago)
          paymentSchedule.push({
            numero_cuota: i,
            fecha_pago: toLocalDateStr(fechaPago),
            valor_cuota: cuotaDiaria,
            capital: cuotaDiaria,
            interes: 0,
            saldo: Math.round(Math.max(0, valorNum - cuotaDiaria * i) * 100) / 100,
          })
        }
      } else if (tipoAmortizacion === "americano") {
        // Americano (Interes plano): cada cuota paga (valor * tasa) de intereses
        // y la ultima cuota incluye ademas el capital completo. El campo `saldo`
        // representa el total pendiente por pagar despues de la cuota:
        // capital + intereses de las cuotas que aun faltan.
        const interesPorCuota = Math.round(valorNum * tasaNum * 100) / 100
        for (let i = 1; i <= numeroCuotasNum; i++) {
          let fechaPago = new Date(fechaInicio)
          fechaPago.setDate(fechaPago.getDate() + diasEntrePagos * (i - 1))
          fechaPago = skipDomingoSiDiario(fechaPago)
          const esUltima = i === numeroCuotasNum
          const capitalCuota = esUltima ? valorNum : 0
          const cuotaPago = interesPorCuota + capitalCuota
          const cuotasRestantesFinal = numeroCuotasNum - i
          const saldoRestante = esUltima
            ? 0
            : valorNum + interesPorCuota * cuotasRestantesFinal
          paymentSchedule.push({
            numero_cuota: i,
            fecha_pago: toLocalDateStr(fechaPago),
            valor_cuota: Math.round(cuotaPago * 100) / 100,
            capital: Math.round(capitalCuota * 100) / 100,
            interes: interesPorCuota,
            saldo: Math.round(saldoRestante * 100) / 100,
          })
        }
      } else {
        // Alemán – cuota fija simple: saldoTotal / numCuotas
        const saldoTotalNum = valorNum + valorNum * tasaNum
        const cuotaFija = Math.round((saldoTotalNum / numeroCuotasNum) * 100) / 100
        const interesPorCuota = Math.round(((valorNum * tasaNum) / numeroCuotasNum) * 100) / 100
        const capitalPorCuota = Math.round((valorNum / numeroCuotasNum) * 100) / 100
        let saldoRestante = saldoTotalNum
        for (let i = 1; i <= numeroCuotasNum; i++) {
          let fechaPago = new Date(fechaInicio)
          fechaPago.setDate(fechaPago.getDate() + diasEntrePagos * (i - 1))
          fechaPago = skipDomingoSiDiario(fechaPago)
          saldoRestante = Math.max(0, saldoRestante - cuotaFija)
          paymentSchedule.push({
            numero_cuota: i,
            fecha_pago: toLocalDateStr(fechaPago),
            valor_cuota: cuotaFija,
            capital: capitalPorCuota,
            interes: interesPorCuota,
            saldo: Math.round(saldoRestante * 100) / 100,
          })
        }
      }

      // ── Construir p_loan ──────────────────────────────────────────────
      // OJO: NO se incluye `cuenta_id` porque la columna no existe en el
      // esquema actual de `loans` (la RPC se encarga de moverlo a otra
      // tabla si aplica). `ruta` tampoco va aqui porque la RPC la toma de
      // p_ruta_id para evitar inconsistencias entre params.
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
        fecha_primer_pago: toLocalDateStr(fechaInicio),
      }

      // ── Construir p_payment_plan (array de cuotas amortizadas) ────────
      const p_payment_plan = paymentSchedule.map((row) => ({
        numero_cuota: row.numero_cuota,
        fecha_pago: row.fecha_pago,
        valor_cuota: row.valor_cuota,
        capital: row.capital,
        interes: row.interes,
        saldo: row.saldo,
        estado: "pendiente",
      }))

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

      // ── Llamada UNICA a la RPC atomica ────────────────────────────────
      // Toda la creacion (cliente + loan + payment_plan) corre en una sola
      // transaccion en la base; si algo falla, se hace rollback completo
      // y nunca quedan registros huerfanos.
      const supabase = createClient()
      const { data: rpcData, error: rpcError } = await supabase.rpc("crear_venta_atomica", {
        p_user_id,
        p_ruta_id,
        p_rol,
        p_cliente,
        p_loan,
        p_payment_plan,
      })

      if (rpcError) {
        console.error("[v0] Error RPC crear_venta_atomica:", rpcError)
        // Detectar el caso de documento duplicado para mostrar un mensaje
        // amigable. Postgres devuelve code "23505" (unique_violation) y el
        // mensaje suele incluir el nombre de la columna/constraint
        // (`clients_documento_key`, `clients.documento`, etc.).
        const errMsg = rpcError.message || ""
        const isDocDuplicado =
          rpcError.code === "23505" ||
          /documento/i.test(errMsg) ||
          /clients_documento/i.test(errMsg)
        toast({
          title: isDocDuplicado ? "Documento ya registrado" : "Error al crear la venta",
          description: isDocDuplicado
            ? `Ya existe un cliente con el documento ${documento}. Búscalo en "Cliente Existente" para registrar otra venta.`
            : errMsg || "No se pudo completar la operación",
          variant: "destructive",
        })
        return
      }

      console.log("[v0] crear_venta_atomica OK:", rpcData)

      // Success
      const successMsg = `Se registró la venta de $${Number(valor || 0).toLocaleString()} para ${apodo || nombreCompleto}.`
      // Toast pill flotante: feedback inmediato igual que en gastos/ingresos.
      showToastPill("Venta registrada exitosamente")
      // Dialog modal: requiere que el usuario lo cierre explicitamente
      // para que no se pierda el feedback de confirmacion.
      setSuccessDialog({ open: true, msg: successMsg })
      // Banner persistente en cabecera (respaldo visual mientras el dialog
      // este cerrado y el formulario aun visible).
      setSuccessAlert(successMsg)
      setFormAlert(null)
      setTimeout(() => setSuccessAlert(null), 6000)

      // Reset form — all fields regardless of new/existing client
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
      setNumeroCuotas(1)
      setOtroValor(false)
      setValorPago("")
      setPrestamoEmpleado(false)
      // Reset client selection
      setSelectedClient("")
      setClientSearch("")
      // Reset new-client fields always
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
      setFormErrors(new Set())
      setCedulaImage(null)
    } catch (error) {
      console.error('[v0] Error creating venta:', error)
      toast({
        title: "Error",
        description: "Ocurrió un error al crear la venta",
        variant: "destructive",
      })
    } finally {
      setIsCreating(false)
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
      <div className="flex items-center justify-between">
        <h2 className="text-base md:text-2xl font-bold text-card-foreground">Nueva Venta</h2>
        <button
          type="button"
          onClick={() => setIsNewClient(!isNewClient)}
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
                        Nombre completo <span className="text-red-500">*</span>
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
                        Teléfono <span className="text-red-500">*</span>
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
                      Dirección <span className="text-red-500">*</span>
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
              <Select
                value={selectedClient}
                onValueChange={(val) => {
                  setSelectedClient(val)
                  const found = clientOptions.find((c) => c.id === val)
                  if (found) setClientSearch((found.apodo || found.nombre_completo).toUpperCase())
                }}
              >
                <SelectTrigger
                  id="clientSearch"
                  className="h-7 md:h-10 text-[10px] md:text-sm"
                  onClick={() => {
                    if (clientOptions.length === 0) {
                      setLoadingClients(true)
                      const params = new URLSearchParams({ ruta: String(rutaId), search: '' })
                      if (soloSinPrestamo) params.append('sin_prestamo_activo', 'true')
                      fetch(`/api/clients?${params.toString()}`)
                        .then((r) => r.json())
                        .then((data) => setClientOptions(Array.isArray(data) ? data : []))
                        .catch(() => setClientOptions([]))
                        .finally(() => setLoadingClients(false))
                    }
                  }}
                >
                  {loadingClients
                    ? <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Cargando...</span>
                    : <SelectValue placeholder="Seleccione un cliente..." />
                  }
                </SelectTrigger>
<SelectContent className="max-h-60">
                    <div className="px-2 py-1.5 sticky top-0 bg-popover z-10 border-b border-border">
                      <Input
                        placeholder="Buscar por apodo..."
                        value={clientSearch}
                        onChange={(e) => setClientSearch(e.target.value.toUpperCase())}
                        className="h-7 text-[10px] md:text-sm uppercase bg-input text-foreground placeholder:text-muted-foreground"
                      autoComplete="off"
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                  </div>
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
                  {clientOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-[10px] md:text-sm">
                      <span className="font-medium">{(c.apodo || c.nombre_completo).toUpperCase()}</span>
                      {c.apodo && (
                        <span className="ml-2 text-muted-foreground text-[9px]">{c.nombre_completo}</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              {isCreating ? "Creando..." : isNewClient ? "Crear Cliente y Venta" : "Crear Venta"}
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
