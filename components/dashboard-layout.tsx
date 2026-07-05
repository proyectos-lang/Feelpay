"use client"

import { type ReactNode, useState } from "react"
import { Sidebar } from "./sidebar"
import { Header } from "./header"
import { MobileBottomNav } from "./mobile-bottom-nav"
import { PushPermissionPrompt } from "./push-permission-prompt"
import type { SelectedRuta } from "./route-selector"
import type { AuthenticatedUser } from "./views/login-view"
import type { PermissionsMap } from "@/lib/modules-catalog"

interface DashboardLayoutProps {
  children: ReactNode
  currentView: string
  onViewChange: (view: string) => void
  selectedRuta?: SelectedRuta | null
  onChangeRuta?: () => void
  currentUser?: AuthenticatedUser | null
  onLogout?: () => void
  userPermissions?: PermissionsMap | null
}

export function DashboardLayout({
  children,
  currentView,
  onViewChange,
  selectedRuta,
  onChangeRuta,
  currentUser,
  onLogout,
  userPermissions,
}: DashboardLayoutProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
  const [isDesktopSidebarOpen, setIsDesktopSidebarOpen] = useState(false)

  const isGerencia = (currentUser?.rol ?? "").toLowerCase() === "gerencia"

  const getViewTitle = (view: string) => {
    if (isGerencia) return "Gerencia"
    const titleMap: Record<string, string> = {
      dashboard: "Panel Principal",
      "view-clients": "Ver Clientes",
      "new-client": "Nuevo Cliente",
      "inactivation-requests": "Solicitudes de Inactivación",
      "view-loans": "Ver Ventas",
      "new-loan": "Nuevo Préstamo",
      "pending-authorizations": "Autorizaciones Administrador",
      "secretary-authorizations": "Autorizaciones Secretaria",
      "daily-route": "Ruta Diaria",
      "configure-route": "Ordenar Ruta",
      "register-payment": "Registrar Pago",
      "register-transaction": "Registro de Gasto e Ingreso",
      "view-expenses-income": "Ver Gastos e Ingresos",
      movements: "Movimientos",
      "manage-users": "Gestionar Usuarios",
      "manage-profiles": "Gestionar Perfiles/Roles",
      "route-config": "Configuración de Rutas",
      "config-items": "Configurar Items",
      "auth-codes": "Generar Códigos de Autorización",
      "general-config": "Configuración General",
      "admin-route-monitor": "Monitoreo de Rutas",
      "admin-dashboard": "Dashboard Administrador",
      "admin-route-detail": "Detalle de Rutas",
      "secretary-reports": "Reportes",
      "user-route-management": "Gestión de Usuarios y Rutas",
    }
    return titleMap[view] || "Panel Principal"
  }

  const handleViewChange = (view: string) => {
    onViewChange(view)
    setIsMobileSidebarOpen(false)
  }

  return (
    <div className="flex h-screen bg-transparent">
      <div className={`hidden md:block transition-all duration-300 ${isDesktopSidebarOpen ? "w-60" : "w-16"}`}>
        <Sidebar
          currentView={currentView}
          onViewChange={onViewChange}
          isCollapsed={!isDesktopSidebarOpen}
          onToggleCollapse={() => setIsDesktopSidebarOpen(!isDesktopSidebarOpen)}
          currentUser={currentUser}
          onLogout={onLogout}
          userPermissions={userPermissions}
        />
      </div>

      {isMobileSidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setIsMobileSidebarOpen(false)} />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-200 ease-in-out md:hidden ${
          isMobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          currentView={currentView}
          onViewChange={handleViewChange}
          currentUser={currentUser}
          onLogout={onLogout}
          userPermissions={userPermissions}
        />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          title={getViewTitle(currentView)}
          onMenuClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
          onSidebarToggle={() => setIsDesktopSidebarOpen(!isDesktopSidebarOpen)}
          isSidebarOpen={isDesktopSidebarOpen}
          selectedRuta={selectedRuta}
          onChangeRuta={onChangeRuta}
          currentUser={currentUser}
          onLogout={onLogout}
        />
        <main className="flex-1 overflow-y-auto p-3 md:p-6 pb-16 md:pb-6">{children}</main>
        <MobileBottomNav currentView={currentView} onViewChange={onViewChange} currentUser={currentUser} userPermissions={userPermissions} />
      </div>
      {currentUser && <PushPermissionPrompt currentUser={currentUser} />}
    </div>
  )
}
