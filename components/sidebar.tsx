"use client"

import React from "react"
import {
  DollarSign,
  ChevronLeft,
  ChevronsRight,
  Plus,
  CheckCircle,
  TrendingUp,
  BarChart3,
  Eye,
  MapPin,
  Users,
  ShoppingBag,
  Route,
  ListChecks,
  LogOut,
  User as UserIcon,
  LayoutDashboard,
  ClipboardList,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import type { AuthenticatedUser } from "./views/login-view"

type NavItem = { id: string; label: string; icon: React.ElementType; colorClass: string }
type NavGroup = { group: string; items: NavItem[] }

const navGroups: NavGroup[] = [
  {
    group: "Asesor",
    items: [
      { id: "daily-summary",        label: "Resumen del Día",   icon: BarChart3,   colorClass: "sidebar-item-summary"   },
      { id: "register-payment",     label: "Registrar Pago",    icon: DollarSign,  colorClass: "sidebar-item-payment"   },
      { id: "new-loan",             label: "Nueva Venta",        icon: Plus,        colorClass: "sidebar-item-sale"      },
      { id: "view-clients",         label: "Clientes",           icon: Users,       colorClass: "sidebar-item-clients"   },
      { id: "register-transaction", label: "Gasto e Ingreso",   icon: TrendingUp,  colorClass: "sidebar-item-expense"   },
      { id: "view-expenses-income", label: "Ver Gastos",         icon: Eye,         colorClass: "sidebar-item-view"      },
      { id: "view-loans",           label: "Ver Ventas",         icon: ShoppingBag, colorClass: "sidebar-item-clients"   },
    ],
  },
  {
    group: "Administrador",
    items: [
      { id: "admin-dashboard",        label: "Dashboard",          icon: LayoutDashboard, colorClass: "sidebar-item-summary"  },
      { id: "admin-route-detail",     label: "Detalle Rutas",      icon: ClipboardList,   colorClass: "sidebar-item-clients"  },
      { id: "pending-authorizations", label: "Autor. Admin",       icon: CheckCircle,     colorClass: "sidebar-item-auth"     },
      { id: "admin-route-monitor",    label: "Monitoreo Rutas",    icon: Route,           colorClass: "sidebar-item-route"    },
      { id: "configure-route",        label: "Ordenar Ruta",       icon: MapPin,          colorClass: "sidebar-item-route"    },
    ],
  },
  {
    group: "Secretaria",
    items: [
      { id: "secretary-authorizations", label: "Autor. Secret.",  icon: CheckCircle, colorClass: "sidebar-item-secretary" },
      { id: "payment-control",          label: "Control Pagos",   icon: ListChecks,  colorClass: "sidebar-item-payment"   },
    ],
  },
]

interface SidebarProps {
  currentView: string
  onViewChange: (view: string) => void
  isCollapsed?: boolean
  onToggleCollapse?: () => void
  currentUser?: AuthenticatedUser | null
  onLogout?: () => void
}

export function Sidebar({
  currentView,
  onViewChange,
  isCollapsed = false,
  onToggleCollapse,
  currentUser,
  onLogout,
}: SidebarProps) {
  const initials = currentUser?.nombre
    ? currentUser.nombre
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p.charAt(0))
        .join("")
        .toUpperCase()
    : ""

  return (
    <aside
      className={cn(
        "h-full border-r border-sidebar-border bg-sidebar-gradient relative transition-all duration-300 flex flex-col",
        isCollapsed ? "w-16" : "w-60",
      )}
    >
      {/* Header */}
      <div className="flex h-12 md:h-16 items-center border-b border-sidebar-border px-3 md:px-6 flex-shrink-0">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="flex h-7 w-7 md:h-9 md:w-9 items-center justify-center rounded-lg bg-white/95 ring-1 ring-white/20 overflow-hidden p-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/opad-logo.png"
              alt="OPAD APP"
              className="h-full w-full object-contain"
            />
          </div>
          {!isCollapsed && (
            <div className="flex flex-col leading-tight">
              <span className="text-sm md:text-base font-extrabold tracking-tight text-sidebar-foreground">
                OPAD
              </span>
              <span className="text-[9px] md:text-[10px] font-semibold tracking-[0.18em] text-sidebar-primary uppercase">
                APP
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Collapse toggle */}
      {onToggleCollapse && (
        <Button
          variant="ghost"
          size="icon"
          className="hidden md:flex absolute -right-3 top-20 z-50 h-6 w-6 rounded-full border border-sidebar-border bg-brand text-brand-foreground hover:bg-brand-light"
          onClick={onToggleCollapse}
        >
          {isCollapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">

        {/* Grouped Quick Access */}
        <div className="flex flex-col divide-y divide-sidebar-border">
          {navGroups.map(({ group, items }, gi) => (
            <div key={group} className="p-1.5 md:p-3">
              {!isCollapsed && (
                <p className="text-[9px] md:text-[10px] font-bold uppercase tracking-wider text-white/80 px-1 mb-1.5">
                  {group}
                </p>
              )}
              {isCollapsed && gi > 0 && (
                <div className="border-t border-sidebar-border mb-1" />
              )}
              <div className={cn("grid gap-1", isCollapsed ? "grid-cols-1" : "grid-cols-3")}>
                {items.map((item) => {
                  const Icon = item.icon
                  const isActive = currentView === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onViewChange(item.id)}
                      title={item.label}
                      className={cn(
                        "flex flex-col items-center justify-center rounded-md transition-all active:scale-95",
                        isCollapsed ? "p-2 h-10" : "p-1.5 h-14 gap-1",
                        item.colorClass,
                        isActive
                          ? "ring-2 ring-offset-1 ring-current shadow-sm opacity-100"
                          : "opacity-60 hover:opacity-100",
                      )}
                    >
                      <Icon className={cn(isCollapsed ? "h-4 w-4" : "h-4 w-4 md:h-5 md:w-5")} />
                      {!isCollapsed && (
                        <span className="text-[8px] md:text-[9px] font-medium text-center leading-tight line-clamp-2">
                          {item.label}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>


      </div>

      {/* Mobile-only session footer with user info + logout */}
      {currentUser && (
        <div className="md:hidden flex-shrink-0 border-t border-sidebar-border bg-white/10 backdrop-blur-sm p-3">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10 ring-2 ring-white/30">
              <AvatarFallback className="bg-brand-gradient text-brand-foreground text-xs font-bold">
                {initials || <UserIcon className="h-4 w-4" />}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-1 flex-col min-w-0 leading-tight">
              <span className="truncate text-sm font-semibold text-sidebar-foreground">
                {currentUser.nombre || "Usuario"}
              </span>
              {currentUser.rol && (
                <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/70">
                  {currentUser.rol}
                </span>
              )}
            </div>
          </div>

          {onLogout && (
            <Button
              type="button"
              onClick={onLogout}
              variant="outline"
              size="sm"
              className="mt-3 w-full gap-2 border-white/30 bg-white/10 text-sidebar-foreground hover:bg-white/20 hover:text-sidebar-foreground"
            >
              <LogOut className="h-4 w-4" />
              Cerrar sesion
            </Button>
          )}
        </div>
      )}
    </aside>
  )
}
