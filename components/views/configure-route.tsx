"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { GripVertical, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"

interface LoanItem {
  id: string
  valor_cuota: number
  frecuencia_pago: string
  ordenvisita: number | null
  client_id: string
  clients: {
    nombre_completo: string
    apodo: string | null
  }
}

const frecuenciaLabels: Record<string, string> = {
  daily: "Diario",
  weekly: "Semanal",
  biweekly: "Quincenal",
  monthly: "Mensual",
}

interface ConfigureRouteProps {
  currentRutaId?: number
}

export function ConfigureRoute({ currentRutaId = 1 }: ConfigureRouteProps) {
  const { toast } = useToast()
  const [loans, setLoans] = useState<LoanItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const dragNode = useRef<HTMLDivElement | null>(null)

  const fetchLoans = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/route-order?ruta=${currentRutaId}`)
      if (!res.ok) throw new Error("Error fetching loans")
      const data = await res.json()
      // Assign sequential order if null
      const ordered = data.map((loan: LoanItem, i: number) => ({
        ...loan,
        ordenvisita: loan.ordenvisita ?? i + 1,
      }))
      setLoans(ordered)
    } catch {
      toast({
        title: "Error",
        description: "No se pudieron cargar los prestamos de la ruta",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [currentRutaId, toast])

  useEffect(() => {
    fetchLoans()
  }, [fetchLoans])

  const saveOrder = async (updatedLoans: LoanItem[]) => {
    setSaving(true)
    try {
      const items = updatedLoans.map((loan, i) => ({
        id: loan.id,
        ordenvisita: i + 1,
      }))
      const res = await fetch("/api/route-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error("Error saving order")
      toast({
        title: "Orden actualizado",
        description: "El orden de visita se ha guardado correctamente",
      })
    } catch {
      toast({
        title: "Error",
        description: "No se pudo guardar el orden de visita",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  // --- Drag handlers (pointer events for touch + mouse) ---
  const handleDragStart = (index: number) => {
    setDraggedIndex(index)
  }

  const handleDragEnter = (index: number) => {
    if (draggedIndex === null || draggedIndex === index) return
    setOverIndex(index)

    setLoans((prev) => {
      const updated = [...prev]
      const dragged = updated[draggedIndex]
      updated.splice(draggedIndex, 1)
      updated.splice(index, 0, dragged)
      setDraggedIndex(index)
      return updated.map((l, i) => ({ ...l, ordenvisita: i + 1 }))
    })
  }

  const handleDragEnd = () => {
    if (draggedIndex !== null) {
      saveOrder(loans)
    }
    setDraggedIndex(null)
    setOverIndex(null)
    dragNode.current = null
  }

  // --- Touch drag implementation ---
  const touchStartY = useRef(0)
  const touchCurrentItem = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const handleTouchStart = (index: number, e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
    touchCurrentItem.current = index
    setDraggedIndex(index)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchCurrentItem.current === null || !listRef.current) return
    const touch = e.touches[0]
    const elements = listRef.current.querySelectorAll("[data-drag-item]")

    elements.forEach((el, i) => {
      const rect = el.getBoundingClientRect()
      if (touch.clientY > rect.top && touch.clientY < rect.bottom && i !== draggedIndex) {
        handleDragEnter(i)
      }
    })
  }

  const handleTouchEnd = () => {
    handleDragEnd()
    touchCurrentItem.current = null
  }

  const getClientName = (loan: LoanItem) => {
    return loan.clients?.apodo || loan.clients?.nombre_completo || "Sin nombre"
  }

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(val)
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg md:text-2xl font-bold text-card-foreground">
          Configurar Ruta {currentRutaId}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchLoans}
          disabled={loading}
          className="h-8 md:h-10 text-[11px] md:text-sm"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Recargar
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2 md:pb-4">
          <CardTitle className="text-sm md:text-base">
            Orden de visita
          </CardTitle>
          <p className="text-[11px] md:text-sm text-muted-foreground">
            Arrastra los clientes para reorganizar el orden de visita de la ruta
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Cargando prestamos...</span>
            </div>
          ) : loans.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No hay prestamos registrados en esta ruta
            </div>
          ) : (
            <div
              ref={listRef}
              className="space-y-1.5 md:space-y-2"
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {/* Header row */}
              <div className="hidden md:grid grid-cols-[40px_50px_1fr_120px_120px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <div />
                <div>#</div>
                <div>Cliente</div>
                <div className="text-right">Valor Cuota</div>
                <div className="text-center">Frecuencia</div>
              </div>

              {loans.map((loan, index) => (
                <div
                  key={loan.id}
                  data-drag-item
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragEnter={() => handleDragEnter(index)}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e) => e.preventDefault()}
                  onTouchStart={(e) => handleTouchStart(index, e)}
                  className={`
                    flex md:grid md:grid-cols-[40px_50px_1fr_120px_120px] items-center gap-2 md:gap-2
                    rounded-lg border px-2 md:px-3 py-2.5 md:py-3
                    transition-all duration-150 select-none
                    ${draggedIndex === index
                      ? "border-primary bg-primary/5 shadow-md scale-[1.02]"
                      : overIndex === index
                        ? "border-primary/40 bg-primary/5"
                        : "border-border bg-card hover:bg-accent/50"
                    }
                    ${saving ? "pointer-events-none opacity-70" : "cursor-grab active:cursor-grabbing"}
                  `}
                >
                  {/* Grip icon */}
                  <div className="flex items-center justify-center text-muted-foreground flex-shrink-0">
                    <GripVertical className="h-4 w-4 md:h-5 md:w-5" />
                  </div>

                  {/* Order number */}
                  <div className="flex items-center justify-center flex-shrink-0">
                    <span className="flex h-6 w-6 md:h-7 md:w-7 items-center justify-center rounded-full bg-primary/10 text-[11px] md:text-xs font-bold text-primary">
                      {index + 1}
                    </span>
                  </div>

                  {/* Client name */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs md:text-sm font-medium truncate text-foreground">
                      {getClientName(loan)}
                    </p>
                    {/* Mobile: show cuota and freq inline */}
                    <div className="flex items-center gap-2 mt-0.5 md:hidden">
                      <span className="text-[10px] text-muted-foreground">
                        {formatCurrency(loan.valor_cuota)}
                      </span>
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">
                        {frecuenciaLabels[loan.frecuencia_pago] || loan.frecuencia_pago}
                      </Badge>
                    </div>
                  </div>

                  {/* Valor cuota - desktop */}
                  <div className="hidden md:block text-right">
                    <span className="text-sm font-medium text-foreground">
                      {formatCurrency(loan.valor_cuota)}
                    </span>
                  </div>

                  {/* Frecuencia - desktop */}
                  <div className="hidden md:flex justify-center">
                    <Badge variant="secondary" className="text-[11px]">
                      {frecuenciaLabels[loan.frecuencia_pago] || loan.frecuencia_pago}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}

          {saving && (
            <div className="flex items-center justify-center gap-2 pt-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Guardando orden...
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
