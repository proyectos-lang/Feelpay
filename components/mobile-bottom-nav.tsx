"use client"

import { Home, DollarSign, Plus, TrendingUp, BarChart3 } from "lucide-react"
import { Button } from "@/components/ui/button"

interface MobileBottomNavProps {
  currentView: string
  onViewChange: (view: string) => void
}

export function MobileBottomNav({ currentView, onViewChange }: MobileBottomNavProps) {
  // Using semantic tokens for nav item colors
  const navItems = [
    {
      id: "dashboard",
      icon: Home,
      label: "Inicio",
      colorClass: "nav-item-home",
    },
    {
      id: "register-payment",
      icon: DollarSign,
      label: "Pagos",
      colorClass: "nav-item-payment",
    },
    {
      id: "new-loan",
      icon: Plus,
      label: "Venta",
      colorClass: "nav-item-sale",
    },
    {
      id: "register-transaction",
      icon: TrendingUp,
      label: "Gastos",
      colorClass: "nav-item-expense",
    },
    {
      id: "daily-summary",
      icon: BarChart3,
      label: "Resumen",
      colorClass: "nav-item-summary",
    },
  ]

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border md:hidden safe-area-inset-bottom">
      <div className="grid grid-cols-5 gap-1 p-1.5">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = currentView === item.id

          return (
            <Button
              key={item.id}
              variant="ghost"
              onClick={() => onViewChange(item.id)}
              className={`h-18 rounded-xl flex flex-col items-center justify-center gap-1.5 px-1 ${item.colorClass} ${
                isActive ? "nav-item-active" : "nav-item-inactive"
              }`}
              style={{
                boxShadow: isActive 
                  ? "0 6px 16px rgba(58, 124, 165, 0.7), 0 2px 4px rgba(58, 124, 165, 0.5), inset 0 1px 0 rgba(255,255,255,0.25)"
                  : "0 5px 14px rgba(58, 124, 165, 0.55), 0 2px 4px rgba(58, 124, 165, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
            >
              <Icon className="h-8 w-8" />
              <span className="text-xs font-semibold">{item.label}</span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}
