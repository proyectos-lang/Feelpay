"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TrendingDown, TrendingUp, Wallet, Camera, X, AlertCircle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { saveTransaction } from "@/lib/actions/save-transaction"
import { getRutaUmbrales, excedeUmbral, MENSAJE_REVISION, getSolicitanteNombre, type RutaUmbrales } from "@/lib/ruta-umbrales"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

type ItemOption = {
  id: number
  nombre: string
  limite?: number
}

type PendingTransaction = {
  type: "income" | "expense" | "withdrawal"
  amount: number
  limite?: number
}

export function RegisterTransaction({
  onViewChange,
  currentRutaId,
}: {
  onViewChange?: (view: string) => void
  // ID de la ruta activa de la sesion. Se inyecta desde `app/page.tsx`
  // (`selectedRuta?.id`) y se persiste como `gastosregistros.ruta` en cada
  // ingreso/gasto/retiro registrado, garantizando que cada movimiento quede
  // contabilizado en la ruta correcta del recolector logueado.
  currentRutaId?: number
}) {
  const [activeTab, setActiveTab] = useState("income")
  const [incomePhoto, setIncomePhoto] = useState<string | null>(null)
  const [expensePhoto, setExpensePhoto] = useState<string | null>(null)
  const [withdrawalPhoto, setWithdrawalPhoto] = useState<string | null>(null)

  const [incomeItems, setIncomeItems] = useState<ItemOption[]>([])
  const [expenseItems, setExpenseItems] = useState<ItemOption[]>([])
  const [withdrawalItems, setWithdrawalItems] = useState<ItemOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [selectedIncomeItem, setSelectedIncomeItem] = useState<string>("")
  const [selectedExpenseItem, setSelectedExpenseItem] = useState<string>("")
  const [selectedWithdrawalItem, setSelectedWithdrawalItem] = useState<string>("")

  const [incomeLimite, setIncomeLimite] = useState<number | null>(null)
  const [expenseLimite, setExpenseLimite] = useState<number | null>(null)
  const [withdrawalLimite, setWithdrawalLimite] = useState<number | null>(null)

  const [currentDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" }))

  // Form values
  const [incomeAmount, setIncomeAmount] = useState<string>("")
  const [incomeDescription, setIncomeDescription] = useState<string>("")
  const [expenseAmount, setExpenseAmount] = useState<string>("")
  const [expenseDescription, setExpenseDescription] = useState<string>("")
  const [withdrawalAmount, setWithdrawalAmount] = useState<string>("")
  const [withdrawalDescription, setWithdrawalDescription] = useState<string>("")

  // Route info - la ruta proviene de la sesion via `currentRutaId`.
  // Si no se inyecta (caso defensivo), se cae a 1 para no romper inserts;
  // pero en operacion normal SIEMPRE viene desde `app/page.tsx`.
  const ruta = currentRutaId ?? 1
  const [adminid] = useState(1)

  // Warning states for limit exceeded
  const [showIncomeWarning, setShowIncomeWarning] = useState(false)
  const [showExpenseWarning, setShowExpenseWarning] = useState(false)
  const [showWithdrawalWarning, setShowWithdrawalWarning] = useState(false)

  // Success dialogs for limit exceeded
  const [showIncomeSuccessDialog, setShowIncomeSuccessDialog] = useState(false)
  const [showExpenseSuccessDialog, setShowExpenseSuccessDialog] = useState(false)
  const [showWithdrawalSuccessDialog, setShowWithdrawalSuccessDialog] = useState(false)

  // Toast notification state
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null)
  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }

  const [showIncomeApprovalDialog, setShowIncomeApprovalDialog] = useState(false)
  const [showExpenseApprovalDialog, setShowExpenseApprovalDialog] = useState(false)
  const [showWithdrawalApprovalDialog, setShowWithdrawalApprovalDialog] = useState(false)
  const [pendingTransaction, setPendingTransaction] = useState<PendingTransaction | null>(null)

  // Umbral de aprobacion por ruta (configurado por secretaria en Gestion de
  // Usuarios y Rutas > Umbrales). Si un movimiento lo supera, se envia a
  // revision en vez de aplicarse directamente.
  const [umbrales, setUmbrales] = useState<RutaUmbrales | null>(null)
  const [confirmingRevision, setConfirmingRevision] = useState(false)

  useEffect(() => {
    getRutaUmbrales(ruta).then(setUmbrales)
  }, [ruta])

  useEffect(() => {
    const fetchItems = async () => {
      const supabase = createClient()

      try {
        const { data: ingresos, error: ingresosError } = await supabase
          .from("ingresos")
          .select("id, nombre, limite")
          .order("nombre")

        if (ingresosError) {
          console.error("[v0] Error fetching ingresos:", ingresosError)
        } else {
          setIncomeItems(ingresos || [])
        }

        const { data: gastos, error: gastosError } = await supabase
          .from("gastos")
          .select("id, nombre, limite")
          .order("nombre")

        if (gastosError) {
          console.error("[v0] Error fetching gastos:", gastosError)
        } else {
          setExpenseItems(gastos || [])
        }

        const { data: retiros, error: retirosError } = await supabase
          .from("retiros")
          .select("id, nombre, limite")
          .order("nombre")

        if (retirosError) {
          console.error("[v0] Error fetching retiros:", retirosError)
        } else {
          setWithdrawalItems(retiros || [])
        }
      } catch (error) {
        console.error("[v0] Error in fetchItems:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchItems()
  }, [])

  const handleIncomeItemChange = (value: string) => {
    setSelectedIncomeItem(value)
    const item = incomeItems.find((i) => i.id.toString() === value)
    setIncomeLimite(item?.limite ?? null)
  }

  const handleExpenseItemChange = (value: string) => {
    setSelectedExpenseItem(value)
    const item = expenseItems.find((i) => i.id.toString() === value)
    console.log("[v0] Expense item selected:", { item, value, allItems: expenseItems })
    setExpenseLimite(item?.limite ?? null)
  }

  const handleWithdrawalItemChange = (value: string) => {
    setSelectedWithdrawalItem(value)
    const item = withdrawalItems.find((i) => i.id.toString() === value)
    console.log("[v0] Withdrawal item selected:", { item, value, allItems: withdrawalItems })
    setWithdrawalLimite(item?.limite ?? null)
  }

  const handlePhotoUpload = (type: "income" | "expense" | "withdrawal") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => {
        if (type === "income") setIncomePhoto(reader.result as string)
        else if (type === "expense") setExpensePhoto(reader.result as string)
        else if (type === "withdrawal") setWithdrawalPhoto(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  const removePhoto = (type: "income" | "expense" | "withdrawal") => {
    if (type === "income") setIncomePhoto(null)
    else if (type === "expense") setExpensePhoto(null)
    else if (type === "withdrawal") setWithdrawalPhoto(null)
  }

  const getSelectedItemName = (type: "income" | "expense" | "withdrawal"): string => {
    if (type === "income") {
      const item = incomeItems.find((i) => i.id.toString() === selectedIncomeItem)
      return item?.nombre || ""
    } else if (type === "expense") {
      const item = expenseItems.find((i) => i.id.toString() === selectedExpenseItem)
      return item?.nombre || ""
    } else {
      const item = withdrawalItems.find((i) => i.id.toString() === selectedWithdrawalItem)
      return item?.nombre || ""
    }
  }

  const handleSaveIncome = async () => {
    const conceptoName = getSelectedItemName("income")
    const valor = parseFloat(incomeAmount)

    if (!selectedIncomeItem || !incomeAmount || !conceptoName) {
      alert("Por favor completa todos los campos requeridos")
      return
    }

    if (excedeUmbral(umbrales?.gasto_habilitado ?? false, umbrales?.gasto_umbral ?? null, valor)) {
      setPendingTransaction({ type: "income", amount: valor })
      setShowIncomeApprovalDialog(true)
      return
    }

    setSaving(true)
    try {
      const requiresApproval = incomeLimite && valor > incomeLimite
      const result = await saveTransaction({
        concepto: conceptoName,
        limite: incomeLimite,
        valor,
        observacion: incomeDescription,
        foto: incomePhoto,
        tipo: "Ingreso",
        ruta,
        adminid,
        requiresApproval: requiresApproval || false,
      })

      if (result.success) {
        const requiresApproval = incomeLimite && valor > incomeLimite
        if (requiresApproval) {
          setShowIncomeSuccessDialog(true)
        } else {
          showToast("Ingreso guardado exitosamente")
        }
        setIncomeAmount("")
        setIncomeDescription("")
        setIncomePhoto(null)
        setSelectedIncomeItem("")
        setIncomeLimite(null)
        setShowIncomeWarning(false)
      } else {
        showToast(`Error: ${result.error}`, "error")
      }
    } catch (error) {
      console.error("[v0] Error saving income:", error)
      showToast("Error al guardar el ingreso", "error")
    } finally {
      setSaving(false)
    }
  }

  const handleSaveExpense = async () => {
    const conceptoName = getSelectedItemName("expense")
    const valor = parseFloat(expenseAmount)

    if (!selectedExpenseItem || !expenseAmount || !conceptoName) {
      alert("Por favor completa todos los campos requeridos")
      return
    }

    if (excedeUmbral(umbrales?.gasto_habilitado ?? false, umbrales?.gasto_umbral ?? null, valor)) {
      setPendingTransaction({ type: "expense", amount: valor })
      setShowExpenseApprovalDialog(true)
      return
    }

    setSaving(true)
    try {
      const requiresApproval = expenseLimite && valor > expenseLimite
      const result = await saveTransaction({
        concepto: conceptoName,
        limite: expenseLimite,
        valor,
        observacion: expenseDescription,
        foto: expensePhoto,
        tipo: "Gasto",
        ruta,
        adminid,
        requiresApproval: requiresApproval || false,
      })

      if (result.success) {
        const requiresApproval = expenseLimite && valor > expenseLimite
        if (requiresApproval) {
          setShowExpenseSuccessDialog(true)
        } else {
          showToast("Gasto guardado exitosamente")
        }
        setExpenseAmount("")
        setExpenseDescription("")
        setExpensePhoto(null)
        setSelectedExpenseItem("")
        setExpenseLimite(null)
        setShowExpenseWarning(false)
      } else {
        showToast(`Error: ${result.error}`, "error")
      }
    } catch (error) {
      console.error("[v0] Error saving expense:", error)
      showToast("Error al guardar el gasto", "error")
    } finally {
      setSaving(false)
    }
  }

  const handleSaveWithdrawal = async () => {
    const conceptoName = getSelectedItemName("withdrawal")
    const valor = parseFloat(withdrawalAmount)

    if (!selectedWithdrawalItem || !withdrawalAmount || !conceptoName) {
      showToast("Por favor completa todos los campos requeridos", "error")
      return
    }

    if (excedeUmbral(umbrales?.gasto_habilitado ?? false, umbrales?.gasto_umbral ?? null, valor)) {
      setPendingTransaction({ type: "withdrawal", amount: valor })
      setShowWithdrawalApprovalDialog(true)
      return
    }

    setSaving(true)
    try {
      const requiresApproval = withdrawalLimite && valor > withdrawalLimite
      const result = await saveTransaction({
        concepto: conceptoName,
        limite: withdrawalLimite,
        valor,
        observacion: withdrawalDescription,
        foto: withdrawalPhoto,
        tipo: "Retiro",
        ruta,
        adminid,
        requiresApproval: requiresApproval || false,
      })

      if (result.success) {
        const requiresApproval = withdrawalLimite && valor > withdrawalLimite
        if (requiresApproval) {
          setShowWithdrawalSuccessDialog(true)
        } else {
          showToast("Retiro guardado exitosamente")
        }
        setWithdrawalAmount("")
        setWithdrawalDescription("")
        setWithdrawalPhoto(null)
        setSelectedWithdrawalItem("")
        setWithdrawalLimite(null)
        setShowWithdrawalWarning(false)
      } else {
        showToast(`Error: ${result.error}`, "error")
      }
    } catch (error) {
      console.error("[v0] Error saving withdrawal:", error)
      showToast("Error al guardar el retiro", "error")
    } finally {
      setSaving(false)
    }
  }

  const handleCancelRevision = () => {
    setPendingTransaction(null)
    setShowIncomeApprovalDialog(false)
    setShowExpenseApprovalDialog(false)
    setShowWithdrawalApprovalDialog(false)
  }

  const handleConfirmRevision = async () => {
    if (!pendingTransaction) return
    const { type, amount } = pendingTransaction

    const tipoTransaccion = type === "income" ? "Ingreso" : type === "expense" ? "Gasto" : "Retiro"
    const concepto = getSelectedItemName(type)
    const observacion = type === "income" ? incomeDescription : type === "expense" ? expenseDescription : withdrawalDescription
    const foto = type === "income" ? incomePhoto : type === "expense" ? expensePhoto : withdrawalPhoto

    setConfirmingRevision(true)
    try {
      const { error } = await createClient().from("solicitudes_revision").insert({
        tipo: "gasto",
        ruta_id: ruta,
        solicitado_por: adminid,
        solicitado_por_nombre: getSolicitanteNombre(),
        monto: amount,
        descripcion: `${tipoTransaccion}: ${concepto}`,
        payload: { concepto, limite: null, valor: amount, observacion, foto, tipo: tipoTransaccion, ruta, adminid },
      })
      if (error) throw error

      showToast(MENSAJE_REVISION)

      if (type === "income") {
        setIncomeAmount("")
        setIncomeDescription("")
        setIncomePhoto(null)
        setSelectedIncomeItem("")
        setIncomeLimite(null)
        setShowIncomeWarning(false)
      } else if (type === "expense") {
        setExpenseAmount("")
        setExpenseDescription("")
        setExpensePhoto(null)
        setSelectedExpenseItem("")
        setExpenseLimite(null)
        setShowExpenseWarning(false)
      } else {
        setWithdrawalAmount("")
        setWithdrawalDescription("")
        setWithdrawalPhoto(null)
        setSelectedWithdrawalItem("")
        setWithdrawalLimite(null)
        setShowWithdrawalWarning(false)
      }
    } catch (error) {
      console.error("[v0] Error creando solicitud de revision:", error)
      showToast("Error al enviar a revisión", "error")
    } finally {
      setConfirmingRevision(false)
      handleCancelRevision()
    }
  }

  return (
    <>
    <div className="space-y-3 md:space-y-6">
      <h2 className="text-sm md:text-2xl font-bold text-card-foreground">Registro de Gasto e Ingreso</h2>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full max-w-md grid-cols-3 h-11 md:h-12">
          <TabsTrigger
            value="income"
            className="flex items-center gap-1.5 md:gap-2 text-sm md:text-base font-medium data-[state=active]:bg-sky-100 data-[state=active]:text-sky-700"
          >
            <TrendingUp className="h-4 w-4 md:h-5 md:w-5" />
            Ingreso
          </TabsTrigger>
          <TabsTrigger
            value="expense"
            className="flex items-center gap-1.5 md:gap-2 text-sm md:text-base font-medium data-[state=active]:bg-orange-100 data-[state=active]:text-orange-700"
          >
            <TrendingDown className="h-4 w-4 md:h-5 md:w-5" />
            Gasto
          </TabsTrigger>
          <TabsTrigger
            value="withdrawal"
            className="flex items-center gap-1.5 md:gap-2 text-sm md:text-base font-medium data-[state=active]:bg-green-100 data-[state=active]:text-green-700"
          >
            <Wallet className="h-4 w-4 md:h-5 md:w-5" />
            Retiros
          </TabsTrigger>
        </TabsList>

        <TabsContent value="income" className="mt-3 md:mt-6">
          <Card>
            <CardHeader className="p-2 md:p-6">
              <CardTitle className="text-xs md:text-base">Información del Ingreso</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 md:space-y-4 p-2 md:p-6">
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="incomeItem" className="text-[12px] md:text-sm">
                  Item de Ingreso
                </Label>
                <Select disabled={loading} value={selectedIncomeItem} onValueChange={handleIncomeItemChange}>
                  <SelectTrigger id="incomeItem" className="h-7 md:h-10 text-[12px] md:text-sm">
                    <SelectValue placeholder={loading ? "Cargando..." : "Seleccione un item"} />
                  </SelectTrigger>
                  <SelectContent>
                    {incomeItems.map((item) => (
                      <SelectItem key={item.id} value={item.id.toString()} className="text-[12px] md:text-sm">
                        {item.nombre}
                      </SelectItem>
                    ))}
                    {incomeItems.length === 0 && !loading && (
                      <SelectItem value="none" disabled className="text-[12px] md:text-sm">
                        No hay items disponibles
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {incomeLimite !== null && (
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="incomeLimite" className="text-[12px] md:text-sm">
                    Límite
                  </Label>
                  <Input
                    id="incomeLimite"
                    value={`$${incomeLimite.toLocaleString("es-CO")}`}
                    readOnly
                    className="h-7 md:h-10 text-[12px] md:text-sm bg-muted cursor-not-allowed"
                  />
                </div>
              )}

              <div className="grid gap-2 md:gap-4 grid-cols-1 md:grid-cols-2">
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="incomeAmount" className="text-[12px] md:text-sm">
                    Monto
                  </Label>
                  <Input
                    id="incomeAmount"
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    value={incomeAmount}
                    onChange={(e) => {
                      setIncomeAmount(e.target.value)
                      const valor = parseFloat(e.target.value)
                      setShowIncomeWarning(incomeLimite != null && valor > incomeLimite)
                    }}
                    className="h-7 md:h-10 text-[12px] md:text-sm"
                  />
                  {showIncomeWarning && (
                    <p className="text-red-600 text-[11px] md:text-xs mt-1">
                      ⚠️ El monto excede el límite permitido de ${incomeLimite?.toLocaleString("es-CO")}. Se marcará como "Por aprobar"
                    </p>
                  )}
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="incomeDate" className="text-[12px] md:text-sm">
                    Fecha
                  </Label>
                  <Input
                    id="incomeDate"
                    type="date"
                    value={currentDate}
                    readOnly
                    className="h-7 md:h-10 text-[12px] md:text-sm bg-muted cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="incomeDescription" className="text-[12px] md:text-sm">
                  Descripción
                </Label>
                <Textarea
                  id="incomeDescription"
                  placeholder="Descripción del ingreso..."
                  value={incomeDescription}
                  onChange={(e) => setIncomeDescription(e.target.value)}
                  className="min-h-[50px] md:min-h-[100px] text-[12px] md:text-sm"
                />
              </div>

              <div className="space-y-1 md:space-y-2">
                <Label className="text-[12px] md:text-sm">Comprobante</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handlePhotoUpload("income")}
                    className="hidden"
                    id="income-photo-upload"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className={`h-7 w-7 md:h-9 md:w-9 ${incomePhoto ? "bg-green-100 hover:bg-green-200" : ""}`}
                    onClick={() => document.getElementById("income-photo-upload")?.click()}
                  >
                    <Camera className="h-3 w-3 md:h-4 md:w-4" />
                  </Button>
                  {incomePhoto && (
                    <div className="relative">
                      <img
                        src={incomePhoto || "/placeholder.svg"}
                        alt="Comprobante"
                        className="h-12 w-12 md:h-16 md:w-16 object-cover rounded"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute -top-1 -right-1 h-4 w-4 md:h-5 md:w-5 rounded-full p-0"
                        onClick={() => removePhoto("income")}
                      >
                        <X className="h-2 w-2 md:h-3 md:w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 md:gap-2 pt-2 md:pt-4">
                <Button
                  variant="outline"
                  className="h-11 md:h-10 text-sm md:text-sm bg-transparent"
                  onClick={() => onViewChange?.("dashboard")}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleSaveIncome}
                  disabled={saving}
                  className="h-11 md:h-10 text-sm md:text-sm"
                >
                  {saving ? "Guardando..." : "Guardar Ingreso"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expense" className="mt-3 md:mt-6">
          <Card>
            <CardHeader className="p-2 md:p-6">
              <CardTitle className="text-xs md:text-base">Información del Gasto</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 md:space-y-4 p-2 md:p-6">
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="expenseItem" className="text-[12px] md:text-sm">
                  Item de Gasto
                </Label>
                <Select disabled={loading} value={selectedExpenseItem} onValueChange={handleExpenseItemChange}>
                  <SelectTrigger id="expenseItem" className="h-7 md:h-10 text-[12px] md:text-sm">
                    <SelectValue placeholder={loading ? "Cargando..." : "Seleccione un item"} />
                  </SelectTrigger>
                  <SelectContent>
                    {expenseItems.map((item) => (
                      <SelectItem key={item.id} value={item.id.toString()} className="text-[12px] md:text-sm">
                        {item.nombre}
                      </SelectItem>
                    ))}
                    {expenseItems.length === 0 && !loading && (
                      <SelectItem value="none" disabled className="text-[12px] md:text-sm">
                        No hay items disponibles
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {expenseLimite !== null && (
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="expenseLimite" className="text-[12px] md:text-sm">
                    Límite
                  </Label>
                  <Input
                    id="expenseLimite"
                    value={`$${expenseLimite.toLocaleString("es-CO")}`}
                    readOnly
                    className="h-7 md:h-10 text-[12px] md:text-sm bg-muted cursor-not-allowed"
                  />
                </div>
              )}

              <div className="grid gap-2 md:gap-4 grid-cols-1 md:grid-cols-2">
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="expenseAmount" className="text-[12px] md:text-sm">
                    Monto
                  </Label>
                  <Input
                    id="expenseAmount"
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    value={expenseAmount}
                    onChange={(e) => {
                      setExpenseAmount(e.target.value)
                      const valor = parseFloat(e.target.value)
                      setShowExpenseWarning(expenseLimite != null && valor > expenseLimite)
                    }}
                    className="h-7 md:h-10 text-[12px] md:text-sm"
                  />
                  {showExpenseWarning && (
                    <p className="text-red-600 text-[11px] md:text-xs mt-1">
                      ⚠️ El monto excede el límite permitido de ${expenseLimite?.toLocaleString("es-CO")}. Se marcará como "Por aprobar"
                    </p>
                  )}
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="expenseDate" className="text-[12px] md:text-sm">
                    Fecha
                  </Label>
                  <Input
                    id="expenseDate"
                    type="date"
                    value={currentDate}
                    readOnly
                    className="h-7 md:h-10 text-[12px] md:text-sm bg-muted cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="expenseDescription" className="text-[12px] md:text-sm">
                  Descripción
                </Label>
                <Textarea
                  id="expenseDescription"
                  placeholder="Descripción del gasto..."
                  value={expenseDescription}
                  onChange={(e) => setExpenseDescription(e.target.value)}
                  className="min-h-[50px] md:min-h-[100px] text-[12px] md:text-sm"
                />
              </div>

              <div className="space-y-1 md:space-y-2">
                <Label className="text-[12px] md:text-sm">Comprobante</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handlePhotoUpload("expense")}
                    className="hidden"
                    id="expense-photo-upload"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className={`h-7 w-7 md:h-9 md:w-9 ${expensePhoto ? "bg-green-100 hover:bg-green-200" : ""}`}
                    onClick={() => document.getElementById("expense-photo-upload")?.click()}
                  >
                    <Camera className="h-3 w-3 md:h-4 md:w-4" />
                  </Button>
                  {expensePhoto && (
                    <div className="relative">
                      <img
                        src={expensePhoto || "/placeholder.svg"}
                        alt="Comprobante"
                        className="h-12 w-12 md:h-16 md:w-16 object-cover rounded"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute -top-1 -right-1 h-4 w-4 md:h-5 md:w-5 rounded-full p-0"
                        onClick={() => removePhoto("expense")}
                      >
                        <X className="h-2 w-2 md:h-3 md:w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 md:gap-2 pt-2 md:pt-4">
                <Button
                  variant="outline"
                  className="h-11 md:h-10 text-sm md:text-sm bg-transparent"
                  onClick={() => onViewChange?.("dashboard")}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleSaveExpense}
                  disabled={saving}
                  className="h-11 md:h-10 text-sm md:text-sm"
                >
                  {saving ? "Guardando..." : "Guardar Gasto"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="withdrawal" className="mt-3 md:mt-6">
          <Card>
            <CardHeader className="p-2 md:p-6">
              <CardTitle className="text-xs md:text-base">Información del Retiro</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 md:space-y-4 p-2 md:p-6">
              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="withdrawalItem" className="text-[12px] md:text-sm">
                  Item de Retiro
                </Label>
                <Select disabled={loading} value={selectedWithdrawalItem} onValueChange={handleWithdrawalItemChange}>
                  <SelectTrigger id="withdrawalItem" className="h-7 md:h-10 text-[12px] md:text-sm">
                    <SelectValue placeholder={loading ? "Cargando..." : "Seleccione un item"} />
                  </SelectTrigger>
                  <SelectContent>
                    {withdrawalItems.map((item) => (
                      <SelectItem key={item.id} value={item.id.toString()} className="text-[12px] md:text-sm">
                        {item.nombre}
                      </SelectItem>
                    ))}
                    {withdrawalItems.length === 0 && !loading && (
                      <SelectItem value="none" disabled className="text-[12px] md:text-sm">
                        No hay items disponibles
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              {withdrawalLimite !== null && (
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="withdrawalLimite" className="text-[12px] md:text-sm">
                    Límite
                  </Label>
                  <Input
                    id="withdrawalLimite"
                    value={`$${withdrawalLimite.toLocaleString("es-CO")}`}
                    readOnly
                    className="h-7 md:h-10 text-[12px] md:text-sm bg-muted cursor-not-allowed"
                  />
                </div>
              )}

              <div className="grid gap-2 md:gap-4 grid-cols-1 md:grid-cols-2">
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="withdrawalAmount" className="text-[12px] md:text-sm">
                    Monto
                  </Label>
                  <Input
                    id="withdrawalAmount"
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    value={withdrawalAmount}
                    onChange={(e) => {
                      setWithdrawalAmount(e.target.value)
                      const valor = parseFloat(e.target.value)
                      setShowWithdrawalWarning(withdrawalLimite != null && valor > withdrawalLimite)
                    }}
                    className="h-7 md:h-10 text-[12px] md:text-sm"
                  />
                  {showWithdrawalWarning && (
                    <p className="text-red-600 text-[11px] md:text-xs mt-1">
                      ⚠️ El monto excede el límite permitido de ${withdrawalLimite?.toLocaleString("es-CO")}. Se marcará como "Por aprobar"
                    </p>
                  )}
                </div>
                <div className="space-y-1 md:space-y-2">
                  <Label htmlFor="withdrawalDate" className="text-[12px] md:text-sm">
                    Fecha
                  </Label>
                  <Input
                    id="withdrawalDate"
                    type="date"
                    value={currentDate}
                    readOnly
                    className="h-7 md:h-10 text-[12px] md:text-sm bg-muted cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="space-y-1 md:space-y-2">
                <Label htmlFor="withdrawalDescription" className="text-[12px] md:text-sm">
                  Descripción
                </Label>
                <Textarea
                  id="withdrawalDescription"
                  placeholder="Descripción del retiro..."
                  value={withdrawalDescription}
                  onChange={(e) => setWithdrawalDescription(e.target.value)}
                  className="min-h-[50px] md:min-h-[100px] text-[12px] md:text-sm"
                />
              </div>

              <div className="space-y-1 md:space-y-2">
                <Label className="text-[12px] md:text-sm">Comprobante</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handlePhotoUpload("withdrawal")}
                    className="hidden"
                    id="withdrawal-photo-upload"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className={`h-7 w-7 md:h-9 md:w-9 ${withdrawalPhoto ? "bg-green-100 hover:bg-green-200" : ""}`}
                    onClick={() => document.getElementById("withdrawal-photo-upload")?.click()}
                  >
                    <Camera className="h-3 w-3 md:h-4 md:w-4" />
                  </Button>
                  {withdrawalPhoto && (
                    <div className="relative">
                      <img
                        src={withdrawalPhoto || "/placeholder.svg"}
                        alt="Comprobante"
                        className="h-12 w-12 md:h-16 md:w-16 object-cover rounded"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        className="absolute -top-1 -right-1 h-4 w-4 md:h-5 md:w-5 rounded-full p-0"
                        onClick={() => removePhoto("withdrawal")}
                      >
                        <X className="h-2 w-2 md:h-3 md:w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 md:gap-2 pt-2 md:pt-4">
                <Button
                  variant="outline"
                  className="h-11 md:h-10 text-sm md:text-sm bg-transparent"
                  onClick={() => onViewChange?.("dashboard")}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleSaveWithdrawal}
                  disabled={saving}
                  className="h-11 md:h-10 text-sm md:text-sm"
                >
                  {saving ? "Guardando..." : "Guardar Retiro"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Diálogo de confirmación: movimiento supera el umbral de ruta */}
      <Dialog
        open={showIncomeApprovalDialog || showExpenseApprovalDialog || showWithdrawalApprovalDialog}
        onOpenChange={(open) => { if (!open) handleCancelRevision() }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-14 w-14 rounded-full bg-amber-100 mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-amber-600" />
            </div>
            <DialogTitle className="text-xl md:text-2xl text-center">Movimiento supera el umbral de la ruta</DialogTitle>
            <DialogDescription className="text-center text-base mt-4">
              {MENSAJE_REVISION}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse sm:flex-row justify-center gap-2 pt-4">
            <Button variant="outline" onClick={handleCancelRevision} disabled={confirmingRevision}>
              Cancelar
            </Button>
            <Button onClick={handleConfirmRevision} disabled={confirmingRevision}>
              {confirmingRevision ? "Enviando..." : "Continuar"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Income Success Dialog - Approval Required */}
      <Dialog open={showIncomeSuccessDialog} onOpenChange={setShowIncomeSuccessDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-14 w-14 rounded-full bg-blue-100 mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-blue-600" />
            </div>
            <DialogTitle className="text-xl md:text-2xl text-center">Su ingreso supera el límite permitido</DialogTitle>
            <DialogDescription className="text-center text-base mt-4">
              El registro ha sido guardado y pasará a aprobación por parte del administrador.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center pt-4">
            <Button
              onClick={() => setShowIncomeSuccessDialog(false)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-8"
            >
              Aceptar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Expense Success Dialog - Approval Required */}
      <Dialog open={showExpenseSuccessDialog} onOpenChange={setShowExpenseSuccessDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-14 w-14 rounded-full bg-orange-100 mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-orange-600" />
            </div>
            <DialogTitle className="text-xl md:text-2xl text-center">Su gasto supera el límite permitido</DialogTitle>
            <DialogDescription className="text-center text-base mt-4">
              El registro ha sido guardado y pasará a aprobación por parte del administrador.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center pt-4">
            <Button
              onClick={() => setShowExpenseSuccessDialog(false)}
              className="bg-orange-600 hover:bg-orange-700 text-white px-8"
            >
              Aceptar
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Withdrawal Success Dialog - Approval Required */}
      <Dialog open={showWithdrawalSuccessDialog} onOpenChange={setShowWithdrawalSuccessDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center justify-center h-14 w-14 rounded-full bg-purple-100 mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-purple-600" />
            </div>
            <DialogTitle className="text-xl md:text-2xl text-center">Su retiro supera el límite permitido</DialogTitle>
            <DialogDescription className="text-center text-base mt-4">
              El registro ha sido guardado y pasará a aprobación por parte del administrador.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center pt-4">
            <Button
              onClick={() => setShowWithdrawalSuccessDialog(false)}
              className="bg-purple-600 hover:bg-purple-700 text-white px-8"
            >
              Aceptar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>

    {/* Toast notification */}
    {toast && (
      <div className={`fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium transition-all animate-in fade-in slide-in-from-bottom-4 ${
        toast.type === "error"
          ? "bg-destructive text-destructive-foreground"
          : "bg-success text-white"
      }`}>
        {toast.type === "error" ? (
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        ) : (
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        )}
        {toast.message}
      </div>
    )}
  </>
  )
}
