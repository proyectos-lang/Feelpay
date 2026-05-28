"use client"
import { Card } from "@/components/ui/card"
import { Plus, CheckCircle, DollarSign, TrendingUp, BarChart3, Eye, Users, MapPin, Route, ShoppingBag } from "lucide-react"

interface MainDashboardProps {
  onViewChange: (view: string) => void
}

export function MainDashboard({ onViewChange }: MainDashboardProps) {
  // Quick access buttons using CSS custom property gradients for theming
  const quickAccessButtons = [
    {
      title: "Resumen del Día",
      icon: BarChart3,
      view: "daily-summary",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-summary-from),var(--card-summary-to))]",
    },
    {
      title: "Registro de Pago",
      icon: DollarSign,
      view: "register-payment",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-payment-from),var(--card-payment-to))]",
    },
    {
      title: "Nueva Venta",
      icon: Plus,
      view: "new-loan",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-sale-from),var(--card-sale-to))]",
    },
    {
      title: "Clientes",
      icon: Users,
      view: "view-clients",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-clients-from),var(--card-clients-to))]",
    },
    {
      title: "Registro de Gasto e Ingreso",
      icon: TrendingUp,
      view: "register-transaction",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-expense-from),var(--card-expense-to))]",
    },
    {
      title: "Autorizaciones Administrador",
      icon: CheckCircle,
      view: "pending-authorizations",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-auth-from),var(--card-auth-to))]",
    },
    {
      title: "Autorizaciones Secretaria",
      icon: CheckCircle,
      view: "secretary-authorizations",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-secretary-from),var(--card-secretary-to))]",
    },
    {
      title: "Ver Gastos e Ingresos",
      icon: Eye,
      view: "view-expenses-income",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-view-from),var(--card-view-to))]",
    },
    {
      title: "Ver Ventas",
      icon: ShoppingBag,
      view: "view-loans",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-sale-from),var(--card-sale-to))]",
    },
    {
      title: "Ordenar Ruta",
      icon: MapPin,
      view: "configure-route",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-route-from),var(--card-route-to))]",
    },
    {
      title: "Monitoreo de Rutas",
      icon: Route,
      view: "admin-route-monitor",
      bgClass: "bg-[linear-gradient(to_bottom_right,var(--card-summary-from),var(--card-summary-to))]",
    },
  ]

  return (
    <div className="bg-gradient-to-b from-info-light via-info-light/50 to-background md:min-h-screen md:pb-3">
      <div className="space-y-3 md:space-y-6">
        <div className="px-3 md:px-6 pt-2 md:pt-4">
          <h2 className="text-xl md:text-3xl font-bold text-foreground">Panel Principal</h2>
          <p className="text-sm md:text-base text-muted-foreground mt-1 md:mt-2">
            Accesos rápidos a funciones principales
          </p>
        </div>

        {/* Mobile: Full-width single column */}
        <div className="flex flex-col gap-3 md:hidden px-2 pb-2">
          {quickAccessButtons.map((button) => {
            const Icon = button.icon
            return (
              <button
                key={button.view}
                onClick={() => onViewChange(button.view)}
                className={`${button.bgClass} p-5 rounded-xl shadow-md active:scale-95 transition-all flex items-center gap-4 text-white font-semibold`}
                style={{ boxShadow: "0 4px 12px rgba(22, 66, 91, 0.35), inset 0 1px 0 rgba(255,255,255,0.15)" }}
              >
                <div className="bg-white/20 p-3 rounded-lg flex-shrink-0">
                  <Icon className="h-7 w-7 text-white" />
                </div>
                <span className="text-left text-base flex-grow">{button.title}</span>
              </button>
            )
          })}
        </div>

        {/* Desktop: Grid layout */}
        <div className="hidden md:grid gap-6 grid-cols-2 lg:grid-cols-4 px-6">
          {quickAccessButtons.map((button) => {
            const Icon = button.icon
            return (
              <Card
                key={button.view}
                className="cursor-pointer transition-all hover:shadow-lg active:scale-95 hover:scale-105 overflow-hidden group"
                onClick={() => onViewChange(button.view)}
              >
                <div className={`${button.bgClass} h-32 flex flex-col items-center justify-center relative overflow-hidden`}>
                  <div className="absolute opacity-10 group-hover:opacity-20 transition-opacity">
                    <Icon className="h-24 w-24 text-white" />
                  </div>
                  <div className="bg-white/20 p-4 rounded-lg mb-3 relative z-10">
                    <Icon className="h-8 w-8 text-white" />
                  </div>
                  <p className="font-semibold text-sm text-center text-white relative z-10 px-2">{button.title}</p>
                </div>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
