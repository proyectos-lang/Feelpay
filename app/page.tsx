"use client"

import { useState, useEffect, useCallback } from "react"
import { DashboardLayout } from "@/components/dashboard-layout"
import { MainDashboard } from "@/components/views/main-dashboard"
import { ViewClients } from "@/components/views/view-clients"
import { NewClient } from "@/components/views/new-client"
import { InactivationRequests } from "@/components/views/inactivation-requests"
import { ViewLoans } from "@/components/views/view-loans"
import { NewLoan } from "@/components/views/new-loan"
import { PendingAuthorizations } from "@/components/views/pending-authorizations"
import { SecretaryAuthorizations } from "@/components/views/secretary-authorizations"
import { DailyRoute } from "@/components/views/daily-route"
import { RegisterPayment } from "@/components/views/register-payment"
import { PaymentControl } from "@/components/views/payment-control"
import { RegisterTransaction } from "@/components/views/register-transaction"
import { ViewExpensesIncome } from "@/components/views/view-expenses-income"
import { DailySummary } from "@/components/views/daily-summary"
import { Movements } from "@/components/views/movements"
import { ManageUsers } from "@/components/views/manage-users"
import { ManageProfiles } from "@/components/views/manage-profiles"
import { RouteConfig } from "@/components/views/route-config"
import { ConfigItems } from "@/components/views/config-items"
import { AuthCodes } from "@/components/views/auth-codes"
import { GeneralConfig } from "@/components/views/general-config"
import { ConfigureRoute } from "@/components/views/configure-route"
import { CierreCaja } from "@/components/views/cierre-caja"
import { AdminRouteMonitor } from "@/components/views/admin-route-monitor"
import { AdminDashboard } from "@/components/views/admin-dashboard"
import { AdminRouteDetail } from "@/components/views/admin-route-detail"
import { RouteSelector, type SelectedRuta } from "@/components/route-selector"
import { LoginView, type AuthenticatedUser } from "@/components/views/login-view"
import { LoginSplash } from "@/components/login-splash"
import { SESSION_LOST_EVENT, getSupabaseSafe } from "@/lib/api-helper"
import { Button } from "@/components/ui/button"
import { Loader2, ShieldAlert, RefreshCw } from "lucide-react"

const RUTA_STORAGE_KEY = "selectedRuta"
const USER_STORAGE_KEY = "currentUser"
// Cache local del último estado conocido de `rutas_diarias` para la ruta y
// fecha actual. Sirve solo para hidratar instantáneamente la UI tras un
// reload (evita el flash de "Ruta no iniciada" durante el ~0.5s que tarda
// el fetch real). El valor se sobreescribe en cuanto llega la respuesta
// fresca del servidor, así que no genera estado "fantasma" persistente.
const RUTA_ACTIVA_CACHE_KEY = "rutaActivaCache"
type RutaActivaCache = {
  rutaId: number
  fecha: string // YYYY-MM-DD en zona Bogotá
  estado: "abierta" | "cerrada"
}

export default function Page() {
  const [currentView, setCurrentView] = useState("register-payment")
  const [viewData, setViewData] = useState<any>(null)
  const [rutaActivaEstado, setRutaActivaEstado] = useState<"abierta" | "cerrada" | null>(null)
  // `rutaActivaResolved` distingue entre "todavía no he resuelto el estado
  // de la ruta" (false → mostrar spinner/skeleton, NO el guard) y "ya tengo
  // respuesta definitiva" (true → renderizar guard si null/cerrada o el
  // contenido si abierta). Sin este flag, los ~500ms iniciales antes de la
  // primera respuesta del servidor caían en el guard "Ruta no iniciada"
  // y generaban un parpadeo confuso. Si hay caché válido en localStorage
  // se inicializa ya en `true` y la UI no parpadea.
  const [rutaActivaResolved, setRutaActivaResolved] = useState(false)

  // Authenticated user + selected ruta (both global). Hydrated from localStorage on mount.
  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null)
  const [selectedRuta, setSelectedRuta] = useState<SelectedRuta | null>(null)
  const [hydrated, setHydrated] = useState(false)
  // Splash de transicion tras un login fresco (no se muestra al recargar la pagina)
  const [showSplash, setShowSplash] = useState(false)

  // Hydrate user + ruta from localStorage on mount
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        const rawUser = localStorage.getItem(USER_STORAGE_KEY)
        if (rawUser) {
          const parsed = JSON.parse(rawUser) as AuthenticatedUser
          if (parsed && parsed.id) setCurrentUser(parsed)
        }
        const rawRuta = localStorage.getItem(RUTA_STORAGE_KEY)
        let hydratedRutaId: number | null = null
        if (rawRuta) {
          const parsedRuta = JSON.parse(rawRuta) as SelectedRuta
          if (parsedRuta && typeof parsedRuta.id === "number") {
            setSelectedRuta(parsedRuta)
            hydratedRutaId = parsedRuta.id
            // Admin recargando página con ruta virtual → ir directo al dashboard
            if (parsedRuta.id === 0 && parsed && ["admin", "administrador"].includes((parsed.rol ?? "").toLowerCase())) {
              setCurrentView("admin-dashboard")
            }
          }
        }
        // Hidratacion OPTIMISTA del estado de ruta del dia. Si el cache
        // corresponde a la misma ruta + fecha de hoy, usamos su valor
        // mientras llega la respuesta fresca del servidor. Esto elimina
        // el flash de "Ruta no iniciada" en recargas posteriores al
        // primer "Iniciar Ruta" del dia.
        const rawCache = localStorage.getItem(RUTA_ACTIVA_CACHE_KEY)
        if (rawCache && hydratedRutaId !== null) {
          try {
            const cache = JSON.parse(rawCache) as RutaActivaCache
            const fechaHoy = new Intl.DateTimeFormat("en-CA", {
              timeZone: "America/Bogota",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date())
            if (
              cache &&
              cache.rutaId === hydratedRutaId &&
              cache.fecha === fechaHoy &&
              (cache.estado === "abierta" || cache.estado === "cerrada")
            ) {
              setRutaActivaEstado(cache.estado)
              setRutaActivaResolved(true)
            } else if (cache && cache.fecha !== fechaHoy) {
              // Cache obsoleto (cambio de dia): limpiar para evitar
              // hidratar estados de ayer.
              localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
            }
          } catch {
            localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
          }
        }
      }
    } catch (err) {
      console.error("[v0] Error hydrating user/ruta from localStorage:", err)
    } finally {
      setHydrated(true)
    }
  }, [])

  // Whenever (user + ruta) is set, fix the session on Supabase so RLS policies work.
  // This MUST succeed BEFORE rendering any operational view. We distinguish
  // explicit success ("ready") from failure ("error") to avoid showing a
  // dashboard that would just hit RLS denials.
  type SessionPhase = "idle" | "applying" | "ready" | "error"
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>("idle")
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionRetryCounter, setSessionRetryCounter] = useState(0)

  useEffect(() => {
    if (!currentUser || !selectedRuta) {
      setSessionPhase("idle")
      setSessionError(null)
      return
    }

    let cancelled = false
    setSessionPhase("applying")
    setSessionError(null)

    const applySession = async () => {
      // RLS eliminado: no hay que fijar session vars en la base. Pasamos
      // directamente a "ready" para no bloquear el render del resto de la
      // app. Mantenemos las fases por compatibilidad con efectos que las
      // observan (p.ej. el fetch de rutas_diarias depende de `sesionFixed`).
      if (cancelled) return
      setSessionPhase("ready")
    }

    applySession()
    return () => {
      cancelled = true
    }
  }, [currentUser, selectedRuta, sessionRetryCounter])

  // Backward-compatible flag for existing dependent useEffects/components.
  const sesionFixed = sessionPhase === "ready"

  const handleRetrySession = useCallback(() => {
    setSessionRetryCounter((n) => n + 1)
  }, [])

  // Wrapper de `setRutaActivaEstado` que también persiste el cache local.
  // Lo usan los hijos (DailySummary, RegisterPayment) cuando inician/cierran
  // la ruta para que la próxima recarga hidrate instantáneamente y NO se
  // muestre el flash de "Ruta no iniciada".
  const handleRutaActivaEstadoChange = useCallback(
    (estado: "abierta" | "cerrada" | null) => {
      setRutaActivaEstado(estado)
      setRutaActivaResolved(true)
      if (typeof window === "undefined") return
      try {
        if ((estado === "abierta" || estado === "cerrada") && selectedRuta) {
          const fechaHoy = new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Bogota",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date())
          const cache: RutaActivaCache = {
            rutaId: selectedRuta.id,
            fecha: fechaHoy,
            estado,
          }
          localStorage.setItem(RUTA_ACTIVA_CACHE_KEY, JSON.stringify(cache))
        } else if (estado === null) {
          localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
        }
      } catch (err) {
        console.warn("[v0] No se pudo persistir rutaActivaCache (handler):", err)
      }
    },
    [selectedRuta],
  )

  // Carga global del estado de rutas_diarias para la ruta + fecha actual.
  // Antes esto solo ocurria dentro de DailySummary, por lo que si el usuario
  // entraba directamente a Clientes Activos (register-payment) sin pasar por
  // Resumen del Dia, rutaActivaEstado se quedaba en null y aparecia el guard
  // "Ruta no iniciada" aunque ya existiera una fila con estado "abierta".
  // Ahora se sincroniza globalmente cada vez que cambia la ruta o se fija la sesion.
  useEffect(() => {
    if (!selectedRuta || !sesionFixed) {
      setRutaActivaEstado(null)
      // Solo marcamos NO resuelto si no había ruta seleccionada todavía.
      // Si la ruta cambió, dejamos `resolved` como esté para que la UI
      // no parpadee a "loading" si ya teniamos un valor previo.
      if (!selectedRuta) setRutaActivaResolved(false)
      return
    }
    let cancelled = false
    const fetchRutaActiva = async () => {
      // Fecha hoy en zona Colombia (YYYY-MM-DD)
      const fechaHoy = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Bogota",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date())

      // SELECT directo sobre `rutas_diarias` filtrando por ruta_id + fecha.
      // RLS eliminado: el filtro por ruta es 100% a nivel app.
      let result: "abierta" | "cerrada" | null = null
      try {
        const supabase = await getSupabaseSafe()
        const { data, error } = await supabase
          .from("rutas_diarias")
          .select("estado")
          .eq("ruta_id", selectedRuta.id)
          .eq("fecha", fechaHoy)
          .maybeSingle()
        if (cancelled) return
        if (error) {
          console.error("[v0] rutas_diarias error:", error.message)
        } else {
          result = (data?.estado ?? null) as "abierta" | "cerrada" | null
        }
      } catch (err) {
        if (cancelled) return
        console.warn("[v0] rutas_diarias excepcion:", err)
      }
      setRutaActivaEstado(result)
      // Una vez tenemos respuesta definitiva del servidor (sea cual sea),
      // marcamos resolved=true para que el guard pueda evaluar.
      setRutaActivaResolved(true)
      // Persistimos el resultado en cache cuando es un estado conocido
      // (abierta/cerrada). Si es null lo limpiamos para no hidratar
      // optimistamente con datos viejos.
      try {
        if (result === "abierta" || result === "cerrada") {
          const cache: RutaActivaCache = {
            rutaId: selectedRuta.id,
            fecha: fechaHoy,
            estado: result,
          }
          localStorage.setItem(RUTA_ACTIVA_CACHE_KEY, JSON.stringify(cache))
        } else {
          localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
        }
      } catch (err) {
        console.warn("[v0] No se pudo persistir rutaActivaCache:", err)
      }
    }
    fetchRutaActiva()
    return () => {
      cancelled = true
    }
  }, [selectedRuta, sesionFixed])

  const ADMIN_VIRTUAL_RUTA: SelectedRuta = { id: 0, nombre: "Todas las rutas", ciudad: null, pais: null }
  const ADMIN_ROLES = new Set(["admin", "administrador"])

  const handleLoginSuccess = useCallback((user: AuthenticatedUser) => {
    try {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
    } catch (err) {
      console.error("[v0] Error writing currentUser to localStorage:", err)
    }
    setCurrentUser(user)

    const isAdmin = ADMIN_ROLES.has((user.rol ?? "").toLowerCase())
    if (isAdmin) {
      // Admins saltan el RouteSelector: se les asigna la ruta virtual "todas"
      // y van directo al dashboard de administrador.
      try {
        localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ADMIN_VIRTUAL_RUTA))
      } catch {}
      setSelectedRuta(ADMIN_VIRTUAL_RUTA)
      setCurrentView("admin-dashboard")
    } else {
      try {
        localStorage.removeItem(RUTA_STORAGE_KEY)
      } catch {}
      setSelectedRuta(null)
    }
    setShowSplash(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLogout = useCallback(() => {
    try {
      localStorage.removeItem(USER_STORAGE_KEY)
      localStorage.removeItem(RUTA_STORAGE_KEY)
    } catch (err) {
      console.error("[v0] Error clearing session:", err)
    }
    setCurrentUser(null)
    setSelectedRuta(null)
    setSessionPhase("idle")
    setShowSplash(false)
  }, [])

  const handleSelectRuta = useCallback((ruta: SelectedRuta) => {
    try {
      localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ruta))
    } catch (err) {
      console.error("[v0] Error writing selectedRuta to localStorage:", err)
    }
    setSelectedRuta(ruta)
  }, [])

  const handleChangeRuta = useCallback(() => {
    try {
      localStorage.removeItem(RUTA_STORAGE_KEY)
    } catch (err) {
      console.error("[v0] Error clearing selectedRuta:", err)
    }
    // Reset ruta state (no reload — RouteSelector reappears and session re-fixes)
    setSelectedRuta(null)
    setSessionPhase("idle")
  }, [])

  // Listener global del evento "app:session-lost" disparado por `safeQuery` en
  // `lib/api-helper.ts` cuando detecta que las variables de sesion RLS no
  // estan aplicadas o que faltan datos de sesion en localStorage. Al recibir
  // el evento, redirigimos al flujo de login/seleccion de ruta para forzar
  // que la sesion se vuelva a establecer correctamente.
  useEffect(() => {
    const onSessionLost = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string }>).detail
      console.warn(
        "[v0] app:session-lost recibido en page.tsx:",
        detail?.reason ?? "unknown",
      )
      // Si no hay user en localStorage → login completo. Si solo falta
      // ruta → volver al RouteSelector. handleChangeRuta cubre el caso ruta;
      // handleLogout cubre el caso user.
      let hasUser = false
      try {
        hasUser = !!localStorage.getItem(USER_STORAGE_KEY)
      } catch {}
      if (!hasUser) {
        handleLogout()
      } else {
        handleChangeRuta()
      }
    }
    window.addEventListener(SESSION_LOST_EVENT, onSessionLost)
    return () => {
      window.removeEventListener(SESSION_LOST_EVENT, onSessionLost)
    }
  }, [handleLogout, handleChangeRuta])

  // Only admins and secretaries can change ruta from the header
  const userRol = (currentUser?.rol ?? "").toLowerCase()
  const canChangeRuta = ["admin", "administrador", "secretaria", "secretario"].includes(userRol)

  const handleViewChange = (view: string, data?: any) => {
    setCurrentView(view)
    setViewData(data)
  }

  const rutaId = selectedRuta?.id ?? 1
  const rutaPais = selectedRuta?.pais ?? ""

  const renderView = () => {
    switch (currentView) {
      case "dashboard":
        return <MainDashboard onViewChange={handleViewChange} />
      case "daily-summary":
        return (
          <DailySummary
            onViewChange={handleViewChange}
            rutaId={rutaId}
            onRouteStateChange={handleRutaActivaEstadoChange}
          />
        )
      case "cierre-caja":
        return <CierreCaja onBack={() => handleViewChange("daily-summary")} rutaId={rutaId} rutaNombre={rutaPais} />
      case "view-clients":
        return <ViewClients />
      case "new-client":
        return <NewClient />
      case "inactivation-requests":
        return <InactivationRequests />
      case "view-loans":
        return <ViewLoans currentRutaId={rutaId} />
      case "new-loan":
        return (
          <NewLoan
            preSelectedClient={viewData}
            currentRutaId={rutaId}
            rutaPais={rutaPais}
            onCancel={() => handleViewChange("register-payment")}
          />
        )
      case "pending-authorizations":
        return <PendingAuthorizations />
      case "secretary-authorizations":
        return <SecretaryAuthorizations />
      case "daily-route":
        return <DailyRoute />
      case "configure-route":
        return <ConfigureRoute currentRutaId={rutaId} />
      case "register-payment":
        return (
          <RegisterPayment
            onViewChange={handleViewChange}
            currentRutaId={rutaId}
            rutaPais={rutaPais}
            rutaActivaEstado={rutaActivaEstado}
            rutaActivaResolved={rutaActivaResolved}
            onRouteStateChange={handleRutaActivaEstadoChange}
          />
        )
      case "register-transaction":
        return <RegisterTransaction onViewChange={handleViewChange} currentRutaId={rutaId} />
      case "view-expenses-income":
        return <ViewExpensesIncome />
      case "movements":
        return <Movements />
      case "manage-users":
        return <ManageUsers />
      case "manage-profiles":
        return <ManageProfiles />
      case "route-config":
        return <RouteConfig />
      case "config-items":
        return <ConfigItems />
      case "auth-codes":
        return <AuthCodes />
      case "general-config":
        return <GeneralConfig />
      case "admin-route-monitor":
        return <AdminRouteMonitor />
      case "admin-dashboard":
        return <AdminDashboard currentUserId={currentUser?.id} />
      case "admin-route-detail":
        return <AdminRouteDetail currentUserId={currentUser?.id} />
      case "payment-control":
        return <PaymentControl currentRutaId={rutaId} rutaPais={rutaPais} />
      default:
        return <MainDashboard onViewChange={handleViewChange} />
    }
  }

  // Wait for localStorage hydration before deciding what to render
  if (!hydrated) {
    return <div className="min-h-screen bg-background" aria-hidden="true" />
  }

  // 1) No user → Login screen
  if (!currentUser) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />
  }

  // Render principal: route selector / loading / error / dashboard,
  // segun el estado de la sesion. El splash se monta encima como overlay.
  let mainContent: React.ReactNode

  if (!selectedRuta) {
    mainContent = (
      <RouteSelector
        open
        onSelect={handleSelectRuta}
        userId={currentUser.id}
        userRol={currentUser.rol}
      />
    )
  } else if (sessionPhase === "applying" || sessionPhase === "idle") {
    // Pantalla de carga mientras se fija la sesion contra Supabase. NO se
    // renderiza ninguna vista todavia para evitar fetches que choquen con RLS.
    mainContent = (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" aria-hidden="true" />
        <p className="text-sm font-medium text-muted-foreground">
          Preparando tu sesion para la ruta seleccionada...
        </p>
      </div>
    )
  } else if (sessionPhase === "error") {
    // Pantalla de error generica (rara ahora que sessionPhase pasa
    // directamente a "ready" sin tocar la base).
    mainContent = (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-7 w-7" aria-hidden="true" />
        </div>
        <div className="flex max-w-md flex-col gap-1">
          <h2 className="text-lg font-bold text-foreground">
            No se pudo preparar la sesion
          </h2>
          <p className="text-sm text-muted-foreground">
            Hubo un problema fijando la ruta activa para tu sesion. Por
            seguridad, no se cargara ningun dato hasta resolverlo.
          </p>
          {sessionError && (
            <p className="mt-2 break-words text-xs text-muted-foreground/80">
              <span className="font-mono">{sessionError}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={handleRetrySession} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
          <Button variant="outline" onClick={handleChangeRuta}>
            Cambiar de ruta
          </Button>
          <Button variant="ghost" onClick={handleLogout}>
            Cerrar sesion
          </Button>
        </div>
      </div>
    )
  } else {
    // sessionPhase === "ready" — sesion fijada con exito, renderizar app.
    mainContent = (
      <DashboardLayout
        currentView={currentView}
        onViewChange={handleViewChange}
        selectedRuta={selectedRuta}
        onChangeRuta={canChangeRuta ? handleChangeRuta : undefined}
        currentUser={currentUser}
        onLogout={handleLogout}
      >
        {renderView()}
      </DashboardLayout>
    )
  }

  return (
    <>
      {mainContent}
      {showSplash && (
        <LoginSplash
          userName={currentUser.nombre}
          onComplete={() => setShowSplash(false)}
        />
      )}
    </>
  )
}
