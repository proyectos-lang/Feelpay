export interface ModuleDefinition {
  viewId: string
  label: string
  mobileLabel: string
  description: string
  defaultRoles: string[]
  defaultMobileNavRoles: string[]
  iconName: string
}

// PermissionsMap: null = usar defaults de rol; objeto = configuración explícita
export type PermissionsMap = Record<string, { enabled: boolean; inMobileNav: boolean }>

export const ALL_MODULES: ModuleDefinition[] = [
  // --- ASESOR / VENDEDOR ---
  {
    viewId: "daily-summary",
    label: "Resumen del Día",
    mobileLabel: "Resumen",
    description: "Resumen diario de cobros y estado de la ruta",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "BarChart3",
  },
  {
    viewId: "register-payment",
    label: "Registrar Pago",
    mobileLabel: "Pagos",
    description: "Registrar pagos de cuotas de clientes",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "DollarSign",
  },
  {
    viewId: "new-loan",
    label: "Nueva Venta",
    mobileLabel: "Venta",
    description: "Crear nuevos préstamos o ventas",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "Plus",
  },
  {
    viewId: "view-clients",
    label: "Clientes",
    mobileLabel: "Clientes",
    description: "Ver y gestionar el listado de clientes",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "Users",
  },
  {
    viewId: "register-transaction",
    label: "Gasto e Ingreso",
    mobileLabel: "Gastos",
    description: "Registrar gastos e ingresos de la ruta",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: ["vendedor", "asesor"],
    iconName: "TrendingUp",
  },
  {
    viewId: "view-expenses-income",
    label: "Ver Gastos",
    mobileLabel: "Ver G.",
    description: "Consultar historial de gastos e ingresos",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: [],
    iconName: "Eye",
  },
  {
    viewId: "view-loans",
    label: "Ver Ventas",
    mobileLabel: "Ventas",
    description: "Consultar el listado de ventas activas",
    defaultRoles: ["vendedor", "asesor"],
    defaultMobileNavRoles: [],
    iconName: "ShoppingBag",
  },
  // --- ADMINISTRADOR ---
  {
    viewId: "admin-dashboard",
    label: "Dashboard Admin",
    mobileLabel: "Dashboard",
    description: "Panel de control general del administrador",
    defaultRoles: ["admin", "administrador"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "LayoutDashboard",
  },
  {
    viewId: "admin-route-detail",
    label: "Detalle Rutas",
    mobileLabel: "Rutas",
    description: "Ver el detalle de todas las rutas",
    defaultRoles: ["admin", "administrador"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "ClipboardList",
  },
  {
    viewId: "pending-authorizations",
    label: "Autorizaciones Admin",
    mobileLabel: "Autoriz.",
    description: "Aprobar o rechazar solicitudes de autorización",
    defaultRoles: ["admin", "administrador"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "CheckCircle",
  },
  {
    viewId: "admin-route-monitor",
    label: "Monitoreo de Rutas",
    mobileLabel: "Monitor",
    description: "Monitorear el estado de rutas en tiempo real",
    defaultRoles: ["admin", "administrador"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "Route",
  },
  {
    viewId: "configure-route",
    label: "Ordenar Ruta",
    mobileLabel: "Ordenar",
    description: "Configurar el orden de visitas de la ruta",
    defaultRoles: ["admin", "administrador"],
    defaultMobileNavRoles: ["admin", "administrador"],
    iconName: "MapPin",
  },
  {
    viewId: "admin-reportes",
    label: "Reportes Diarios",
    mobileLabel: "Reportes",
    description: "Enviar y revisar reportes diarios del administrador",
    defaultRoles: ["admin", "administrador", "liquidador"],
    defaultMobileNavRoles: [],
    iconName: "FileText",
  },
  // --- SECRETARIA ---
  {
    viewId: "secretary-authorizations",
    label: "Autorizaciones",
    mobileLabel: "Autoriz.",
    description: "Gestionar autorizaciones enviadas por vendedores",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: ["secretaria", "secretario"],
    iconName: "CheckCircle",
  },
  {
    viewId: "payment-control",
    label: "Control de Pagos",
    mobileLabel: "Control",
    description: "Control y seguimiento de pagos por ruta",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: ["secretaria", "secretario"],
    iconName: "ListChecks",
  },
  {
    viewId: "secretary-reports",
    label: "Reportes Secretaria",
    mobileLabel: "Reportes",
    description: "Subir y gestionar reportes diarios de secretaría",
    defaultRoles: ["secretaria", "secretario", "gerencia"],
    defaultMobileNavRoles: ["secretaria", "secretario", "gerencia"],
    iconName: "FileText",
  },
  {
    viewId: "secretary-admin-reportes",
    label: "Reportes del Admin",
    mobileLabel: "Rep. Admin",
    description: "Revisar y aprobar reportes enviados por administradores",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: ["secretaria", "secretario"],
    iconName: "FileText",
  },
  {
    viewId: "user-route-management",
    label: "Usuarios y Rutas",
    mobileLabel: "Gestión",
    description: "Crear usuarios, definir rutas y asignarlas",
    defaultRoles: ["secretaria", "secretario"],
    defaultMobileNavRoles: ["secretaria", "secretario"],
    iconName: "Users",
  },
  // --- SOCIOADMIN ---
  {
    viewId: "socio-admin-reportes",
    label: "Reportes Socio Admin",
    mobileLabel: "Reportes",
    description: "Ver reportes del socio administrador",
    defaultRoles: ["socioadmin"],
    defaultMobileNavRoles: ["socioadmin"],
    iconName: "FileText",
  },
]

/** Módulos accesibles para un rol dado (según defaults) */
export function getDefaultModulesForRole(rol: string): ModuleDefinition[] {
  const r = rol.toLowerCase()
  return ALL_MODULES.filter((m) => m.defaultRoles.includes(r))
}

/** Verifica si un módulo debe aparecer en la bottom nav por defecto para un rol */
export function isDefaultMobileNav(module: ModuleDefinition, rol: string): boolean {
  return module.defaultMobileNavRoles.includes(rol.toLowerCase())
}
