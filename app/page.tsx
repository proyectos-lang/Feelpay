"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { DashboardLayout } from "@/components/dashboard-layout"
import { MainDashboard } from "@/components/views/main-dashboard"
import { ViewClients } from "@/components/views/view-clients"
import { NewClient } from "@/components/views/new-client"
import { InactivationRequests } from "@/components/views/inactivation-requests"
import { ViewLoans } from "@/components/views/view-loans"
import { NewLoan } from "@/components/views/new-loan"
import { PendingAuthorizations } from "@/components/views/pending-authorizations"
import { SecretaryAuthorizations } from "@/components/views/secretary-authorizations"
import { MovimientosRevision } from "@/components/views/movimientos-revision"
import { MultasView } from "@/components/views/multas-view"
import { DocumentosView } from "@/components/views/documentos-view"
import { MiPerfil } from "@/components/views/mi-perfil"
import { SecretaryReports } from "@/components/views/secretary-reports"
import { SocioAdminReportes } from "@/components/views/socio-admin-reportes"
import { AdminReportes } from "@/components/views/admin-reportes"
import { SecretaryAdminReportes } from "@/components/views/secretary-admin-reportes"
import { GestionUsuariosRutas } from "@/components/views/gestion-usuarios-rutas"
import { ChatView } from "@/components/views/chat-view"
import { ReportesBi } from "@/components/views/reportes-bi"
import { DailyRoute } from "@/components/views/daily-route"
import { RegisterPayment } from "@/components/views/register-payment"
import { PaymentControl } from "@/components/views/payment-control"
import { SaleEditor } from "@/components/views/sale-editor"
import { LoanAudit } from "@/components/views/loan-audit"
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
import { RutaNoIniciada } from "@/components/views/ruta-no-iniciada"
import { LoginView, type AuthenticatedUser } from "@/components/views/login-view"
import { LoginSplash } from "@/components/login-splash"
import { SESSION_LOST_EVENT, getSupabaseSafe } from "@/lib/api-helper"
import { limpiarCache } from "@/lib/offline-cache"
import { createClient } from "@/lib/supabase/client"
import { ALL_MODULES, isDefaultMobileNav, type PermissionsMap } from "@/lib/modules-catalog"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Loader2, ShieldAlert, RefreshCw } from "lucide-react"

async function loadUserPermissions(userId: number, rol: string): Promise<PermissionsMap | null> {
  try {
    const { data } = await createClient()
      .from("user_permissions")
      .select("view_id, enabled, in_mobile_nav")
      .eq("user_id", userId)
    // Sin filas: el usuario nunca tuvo permisos personalizados -> null le
    // indica al sidebar/mobile-nav que use los defaults de rol tal cual.
    if (!data || data.length === 0) return null

    const overrides = new Map<string, { enabled: boolean; inMobileNav: boolean }>()
    data.forEach((row) => {
      overrides.set(row.view_id, { enabled: row.enabled, inMobileNav: row.in_mobile_nav })
    })

    // Para cada modulo del catalogo: usar el override guardado si existe: si
    // no, caer al default de su rol. Sin este merge, un modulo agregado
    // DESPUES de que a este usuario se le personalizaron permisos queda
    // invisible para siempre (sin fila en user_permissions = "deshabilitado"),
    // aunque su rol lo tendria habilitado por defecto.
    const map: PermissionsMap = {}
    for (const m of ALL_MODULES) {
      const override = overrides.get(m.viewId)
      if (override) {
        map[m.viewId] = override
      } else {
        const isDefault = m.defaultRoles.includes(rol.toLowerCase())
        map[m.viewId] = { enabled: isDefault, inMobileNav: isDefault && isDefaultMobileNav(m, rol) }
      }
    }
    return map
  } catch {
    return null
  }
}

async function loadUserFoto(userId: number | string): Promise<string | null> {
  try {
    const { data } = await createClient().from("usuarios").select("foto_url").eq("id", userId).maybeSingle()
    return (data as { foto_url: string | null } | null)?.foto_url ?? null
  } catch {
    return null
  }
}

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
  const { toast } = useToast()
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
  const [showRutaSelector, setShowRutaSelector] = useState(false)
  const [userPermissions, setUserPermissions] = useState<PermissionsMap | null>(null)

  // ── Badges de "nuevo": conteo en memoria por viewId (chat, documentos, reportes) ──
  const [moduleBadgeCounts, setModuleBadgeCounts] = useState<Record<string, number>>({})
  const bumpBadge = useCallback((viewId: string) => {
    setModuleBadgeCounts((prev) => ({ ...prev, [viewId]: (prev[viewId] ?? 0) + 1 }))
  }, [])
  // IDs de conversaciones donde participa el usuario (para filtrar mensajes ajenos)
  const myConvIdsRef = useRef<Set<string>>(new Set())
  // IDs de carpetas de Documentos accesibles (raíz + subcarpetas heredadas)
  const myCarpetaIdsRef = useRef<Set<string>>(new Set())
  // Ref del currentView para leer en handlers sin closure stale
  const currentViewRef = useRef(currentView)
  currentViewRef.current = currentView

  // Hydrate user + ruta from localStorage on mount
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        const rawUser = localStorage.getItem(USER_STORAGE_KEY)
        if (rawUser) {
          const parsed = JSON.parse(rawUser) as AuthenticatedUser
          if (parsed && parsed.id) {
            setCurrentUser(parsed)
            loadUserPermissions(parsed.id, parsed.rol ?? "").then(setUserPermissions).catch(() => {})
            // Refresca la foto de perfil por si cambio desde otro dispositivo
            // desde la ultima vez que se guardo la sesion en este localStorage.
            loadUserFoto(parsed.id).then((foto_url) => {
              setCurrentUser((prev) => (prev ? { ...prev, foto_url } : prev))
              try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ ...parsed, foto_url })) } catch {}
            }).catch(() => {})
          }
        }
        const rawRuta = localStorage.getItem(RUTA_STORAGE_KEY)
        let hydratedRutaId: number | null = null
        if (rawRuta) {
          const parsedRuta = JSON.parse(rawRuta) as SelectedRuta
          if (parsedRuta && typeof parsedRuta.id === "number") {
            setSelectedRuta(parsedRuta)
            hydratedRutaId = parsedRuta.id
            // Admin recargando página con ruta virtual → ir directo al dashboard
            if (rawUser) {
              const parsedUser = JSON.parse(rawUser) as AuthenticatedUser
              const rol = (parsedUser.rol ?? "").toLowerCase()
              if (parsedRuta.id === 0 && ["admin", "administrador"].includes(rol)) {
                setCurrentView("admin-dashboard")
              } else if (rol === "liquidador") {
                setCurrentView("admin-reportes")
              } else if (["gerencia", "secretaria", "secretario"].includes(rol)) {
                setCurrentView("secretary-reports")
              } else if (rol === "socioadmin") {
                setCurrentView("socio-admin-reportes")
              }
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
    if (!currentUser) {
      setSessionPhase("idle")
      setSessionError(null)
      return
    }

    let cancelled = false
    setSessionPhase("applying")
    setSessionError(null)

    const applySession = async () => {
      if (cancelled) return
      setSessionPhase("ready")
    }

    applySession()
    return () => {
      cancelled = true
    }
  }, [currentUser, sessionRetryCounter])

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

      // El ultimo estado conocido para ESTA ruta y ESTE dia. Es lo que se
      // usa cuando no se puede preguntar al servidor.
      const leerCacheRuta = (): "abierta" | "cerrada" | null => {
        try {
          const raw = localStorage.getItem(RUTA_ACTIVA_CACHE_KEY)
          if (!raw) return null
          const c = JSON.parse(raw) as RutaActivaCache
          if (c?.rutaId !== selectedRuta.id || c?.fecha !== fechaHoy) return null
          return c.estado === "abierta" || c.estado === "cerrada" ? c.estado : null
        } catch {
          return null
        }
      }

      // SIN CONEXION no se pregunta: se trabaja con lo ultimo que se supo.
      //
      // Antes se intentaba igual, la consulta fallaba, el resultado quedaba
      // en null y eso hacia dos danos: aparecia "Ruta no iniciada" sobre una
      // ruta que si estaba abierta, y ademas se BORRABA el cache. Con el
      // cache borrado ya no habia forma de recuperarlo sin señal, asi que el
      // cobrador quedaba encerrado fuera del modulo de pagos en pleno campo.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (cancelled) return
        setRutaActivaEstado(leerCacheRuta())
        setRutaActivaResolved(true)
        return
      }

      // SELECT directo sobre `rutas_diarias` filtrando por ruta_id + fecha.
      // RLS eliminado: el filtro por ruta es 100% a nivel app.
      let result: "abierta" | "cerrada" | null = null
      // Distingue "el servidor dijo que no hay fila" de "no pude preguntar".
      // Solo lo primero justifica borrar el cache.
      let respondioElServidor = false
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
          respondioElServidor = true
        }
      } catch (err) {
        if (cancelled) return
        console.warn("[v0] rutas_diarias excepcion:", err)
      }

      // Si no hubo respuesta, se conserva lo ultimo que se supo en vez de
      // caer a null y mostrar el guard sobre una ruta abierta.
      if (!respondioElServidor) {
        setRutaActivaEstado(leerCacheRuta())
        setRutaActivaResolved(true)
        return
      }

      setRutaActivaEstado(result)
      setRutaActivaResolved(true)
      try {
        if (result === "abierta" || result === "cerrada") {
          const cache: RutaActivaCache = {
            rutaId: selectedRuta.id,
            fecha: fechaHoy,
            estado: result,
          }
          localStorage.setItem(RUTA_ACTIVA_CACHE_KEY, JSON.stringify(cache))
        } else {
          // El servidor confirmo que no hay jornada abierta hoy: aqui si
          // corresponde limpiar.
          localStorage.removeItem(RUTA_ACTIVA_CACHE_KEY)
        }
      } catch (err) {
        console.warn("[v0] No se pudo persistir rutaActivaCache:", err)
      }
    }
    fetchRutaActiva()

    // Al volver la señal se vuelve a preguntar: mientras estuvo sin conexion
    // se trabajo con el ultimo estado conocido y pudo haber cambiado (otro
    // dispositivo cerro la jornada, por ejemplo).
    const alVolverLaRed = () => { fetchRutaActiva() }
    window.addEventListener("online", alVolverLaRed)

    return () => {
      cancelled = true
      window.removeEventListener("online", alVolverLaRed)
    }
  }, [selectedRuta, sesionFixed])

  const ADMIN_VIRTUAL_RUTA: SelectedRuta = { id: 0, nombre: "Todas las rutas", ciudad: null, pais: null }
  const ADMIN_ROLES = new Set(["admin", "administrador"])

  const handleLoginSuccess = useCallback(async (user: AuthenticatedUser) => {
    try {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
    } catch (err) {
      console.error("[v0] Error writing currentUser to localStorage:", err)
    }
    setCurrentUser(user)
    setShowSplash(true)
    loadUserPermissions(user.id, user.rol ?? "").then(setUserPermissions).catch(() => {})
    loadUserFoto(user.id).then((foto_url) => {
      setCurrentUser((prev) => (prev ? { ...prev, foto_url } : prev))
      try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ ...user, foto_url })) } catch {}
    }).catch(() => {})

    const isAdmin = ADMIN_ROLES.has((user.rol ?? "").toLowerCase())
    if (isAdmin) {
      try {
        localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ADMIN_VIRTUAL_RUTA))
      } catch {}
      setSelectedRuta(ADMIN_VIRTUAL_RUTA)
      setCurrentView("admin-dashboard")
      return
    }

    if ((user.rol ?? "").toLowerCase() === "liquidador") {
      try {
        localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ADMIN_VIRTUAL_RUTA))
      } catch {}
      setSelectedRuta(ADMIN_VIRTUAL_RUTA)
      setCurrentView("admin-reportes")
      return
    }

    // Resto de roles: auto-seleccionar la primera ruta asignada al usuario
    // para evitar mostrar el RouteSelector en cada login.
    try {
      const supabase = createClient()
      let rutasData: SelectedRuta[] = []

      const { data, error } = await supabase
        .from("usuario_rutas")
        .select("rutas:ruta_id(id, nombre, ciudad, pais)")
        .eq("usuario_id", user.id)

      if (!error && data) {
        rutasData = (data as any[])
          .map((row) => row.rutas)
          .filter(Boolean)
          .sort((a: SelectedRuta, b: SelectedRuta) => a.id - b.id)
      }

      const rolLower = (user.rol ?? "").toLowerCase()
      const isSecretariaOrGerencia = ["secretaria", "secretario", "gerencia"].includes(rolLower)
      const isSocioadmin = rolLower === "socioadmin"

      if (rutasData.length > 0) {
        const ruta = rutasData[0]
        try { localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ruta)) } catch {}
        setSelectedRuta(ruta)
        setShowRutaSelector(false)
        if (isSecretariaOrGerencia) setCurrentView("secretary-reports")
        else if (isSocioadmin) setCurrentView("socio-admin-reportes")
      } else {
        // Sin rutas asignadas: entrar al dashboard sin ruta
        try { localStorage.removeItem(RUTA_STORAGE_KEY) } catch {}
        setSelectedRuta(null)
        setShowRutaSelector(false)
        if (isSecretariaOrGerencia) setCurrentView("secretary-reports")
        else if (isSocioadmin) setCurrentView("socio-admin-reportes")
      }
    } catch (err) {
      console.error("[v0] Error auto-selecting ruta:", err)
      try { localStorage.removeItem(RUTA_STORAGE_KEY) } catch {}
      setSelectedRuta(null)
    }
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
    setUserPermissions(null)
    setModuleBadgeCounts({})
    myConvIdsRef.current = new Set()
    myCarpetaIdsRef.current = new Set()
    // Datos cacheados para trabajar sin señal: se borran para que el
    // siguiente usuario no vea la ruta del anterior.
    void limpiarCache()
  }, [])

  // ── Suscripción global de notificaciones (chat, documentos, reportes) ──────
  // Se mantiene activa durante toda la sesión, independientemente de la vista.
  useEffect(() => {
    if (!currentUser) return
    const supabase = createClient()
    const rol = (currentUser.rol ?? "").toLowerCase()

    // Cargar IDs de conversaciones propias para filtrar mensajes ajenos
    supabase
      .from("chat_participants")
      .select("conversation_id")
      .eq("user_id", currentUser.id)
      .then(({ data }: { data: { conversation_id: string }[] | null }) => {
        if (data) myConvIdsRef.current = new Set(data.map((r) => r.conversation_id))
      })
      .catch(() => {})

    // Cargar IDs de carpetas de Documentos accesibles (mismo query shape que
    // documentos-view.tsx loadCarpetas: permisos -> raíz -> subcarpetas heredadas)
    ;(async () => {
      try {
        const { data: permisos } = await supabase
          .from("documento_carpeta_permisos")
          .select("carpeta_id")
          .eq("user_id", currentUser.id)
        const allowedIds = ((permisos ?? []) as { carpeta_id: string }[]).map((p) => p.carpeta_id)

        let rootQuery = supabase.from("documento_carpetas").select("id").is("parent_id", null)
        rootQuery = allowedIds.length > 0
          ? rootQuery.or(`created_by.eq.${currentUser.id},id.in.(${allowedIds.join(",")})`)
          : rootQuery.eq("created_by", currentUser.id)
        const { data: rootData } = await rootQuery
        const rootIds = ((rootData ?? []) as { id: string }[]).map((r) => r.id)

        let subIds: string[] = []
        if (rootIds.length > 0) {
          const { data: subData } = await supabase
            .from("documento_carpetas")
            .select("id")
            .in("parent_id", rootIds)
          subIds = ((subData ?? []) as { id: string }[]).map((r) => r.id)
        }
        myCarpetaIdsRef.current = new Set([...rootIds, ...subIds])
      } catch (err) {
        console.error("[v0] Error cargando carpetas accesibles:", err)
      }
    })()

    const channel = supabase
      .channel(`notif-${currentUser.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload: { new: { sender_id: number; sender_nombre: string; body: string | null; conversation_id: string } }) => {
          const msg = payload.new
          if (msg.sender_id === currentUser.id) return
          if (!myConvIdsRef.current.has(msg.conversation_id)) return
          // Solo notificar si el usuario NO está ya en el módulo de chat
          if (currentViewRef.current !== "chat") {
            bumpBadge("chat")
            toast({
              title: `💬 ${msg.sender_nombre}`,
              description: msg.body ?? "📷 Imagen",
            })
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_participants" },
        (payload: { new: { user_id: number; conversation_id: string } }) => {
          // Registrar nuevas conversaciones donde me agregan
          if (payload.new.user_id === currentUser.id) {
            myConvIdsRef.current.add(payload.new.conversation_id)
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "documentos" },
        (payload: { new: { carpeta_id: string; uploaded_by: number; uploaded_by_nombre: string; nombre_archivo: string } }) => {
          const doc = payload.new
          if (doc.uploaded_by === currentUser.id) return
          if (!myCarpetaIdsRef.current.has(doc.carpeta_id)) return
          if (currentViewRef.current !== "documentos") {
            bumpBadge("documentos")
            toast({ title: "📁 Nuevo documento", description: `${doc.uploaded_by_nombre}: ${doc.nombre_archivo}` })
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "documento_carpeta_permisos" },
        (payload: { new: { user_id: number; carpeta_id: string } }) => {
          if (payload.new.user_id === currentUser.id) {
            myCarpetaIdsRef.current.add(payload.new.carpeta_id)
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "documento_carpetas" },
        (payload: { new: { id: string; parent_id: string | null } }) => {
          // Nueva subcarpeta dentro de una carpeta a la que ya tengo acceso
          if (payload.new.parent_id && myCarpetaIdsRef.current.has(payload.new.parent_id)) {
            myCarpetaIdsRef.current.add(payload.new.id)
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "informes" },
        (payload: { new: { destinatario: string; socioadmin_id: number | null; secretaria_nombre: string; nombre_reporte: string } }) => {
          const row = payload.new
          if (rol === "gerencia" && row.destinatario === "gerencia") {
            if (currentViewRef.current !== "secretary-reports") {
              bumpBadge("secretary-reports")
              toast({ title: "📄 Nuevo reporte", description: `${row.secretaria_nombre}: ${row.nombre_reporte}` })
            }
          } else if (rol === "socioadmin" && row.destinatario === "socioadmin" && row.socioadmin_id === currentUser.id) {
            if (currentViewRef.current !== "socio-admin-reportes") {
              bumpBadge("socio-admin-reportes")
              toast({ title: "📄 Nuevo reporte", description: `${row.secretaria_nombre}: ${row.nombre_reporte}` })
            }
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "admin_informes" },
        (payload: { new: { admin_nombre: string; nombre_reporte: string } }) => {
          if (rol !== "secretaria" && rol !== "secretario") return
          const row = payload.new
          if (currentViewRef.current !== "secretary-admin-reportes") {
            bumpBadge("secretary-admin-reportes")
            toast({ title: "📄 Reporte de admin", description: `${row.admin_nombre}: ${row.nombre_reporte}` })
          }
        }
      )
      .on(
        // Cierre del circuito de gastos: quien registro el movimiento se
        // entera de si se lo aprobaron o se lo rechazaron. Antes lo mandaba
        // y quedaba a ciegas, sin mas remedio que ir a buscarlo a mano.
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "gastosregistros" },
        (payload: {
          new: { adminid: number; tipo: string; concepto: string; valor: number; estadoadmin: string; estadosecre: string }
          old: { estadoadmin?: string; estadosecre?: string }
        }) => {
          const row = payload.new
          if (row.adminid !== currentUser.id) return

          // Solo interesa el momento en que pasa de "por aprobar" a resuelto.
          const eraPendiente = payload.old?.estadoadmin === "por aprobar" || payload.old?.estadosecre === "por aprobar"
          const rechazado = row.estadoadmin === "rechazado" || row.estadosecre === "rechazado"
          const aprobado = row.estadoadmin !== "por aprobar" && row.estadosecre !== "por aprobar" && !rechazado
          if (!eraPendiente || (!rechazado && !aprobado)) return

          const monto = `$${Math.round(row.valor ?? 0).toLocaleString("es-CO")}`
          if (currentViewRef.current !== "view-expenses-income") bumpBadge("view-expenses-income")
          toast({
            title: rechazado ? `❌ ${row.tipo} rechazado` : `✅ ${row.tipo} aprobado`,
            description: `${row.concepto} — ${monto}`,
            variant: rechazado ? "destructive" : undefined,
          })
        }
      )
      .subscribe()

    return () => { channel.unsubscribe() }
  // Solo se recrea al cambiar de usuario (login/logout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id])

  const handleSelectRuta = useCallback((ruta: SelectedRuta) => {
    try {
      localStorage.setItem(RUTA_STORAGE_KEY, JSON.stringify(ruta))
    } catch (err) {
      console.error("[v0] Error writing selectedRuta to localStorage:", err)
    }
    setSelectedRuta(ruta)
    setShowRutaSelector(false)
  }, [])

  const handleChangeRuta = useCallback(() => {
    setShowRutaSelector(true)
  }, [])

  // Permite que una vista (ej. Mi Perfil tras subir una foto) actualice el
  // usuario en memoria y en localStorage sin necesidad de volver a iniciar sesion.
  const handleUserUpdate = useCallback((updated: AuthenticatedUser) => {
    setCurrentUser(updated)
    try { localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated)) } catch {}
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
      // Si no hay user en localStorage → logout completo.
      // Si solo falta ruta: no abrir el selector automáticamente — el
      // header ya muestra "Seleccionar Ruta" cuando es necesario.
      let hasUser = false
      try {
        hasUser = !!localStorage.getItem(USER_STORAGE_KEY)
      } catch {}
      if (!hasUser) {
        handleLogout()
      }
    }
    window.addEventListener(SESSION_LOST_EVENT, onSessionLost)
    return () => {
      window.removeEventListener(SESSION_LOST_EVENT, onSessionLost)
    }
  }, [handleLogout])

  // Only admins and secretaries can change ruta from the header
  const userRol = (currentUser?.rol ?? "").toLowerCase()
  const canChangeRuta = ["admin", "administrador", "secretaria", "secretario"].includes(userRol)

  const BADGE_VIEWS = ["chat", "documentos", "secretary-reports", "socio-admin-reportes", "secretary-admin-reportes"]

  const handleViewChange = (view: string, data?: any) => {
    setCurrentView(view)
    setViewData(data)
    if (BADGE_VIEWS.includes(view)) {
      setModuleBadgeCounts((prev) => ({ ...prev, [view]: 0 }))
    }
  }

  const rutaId = selectedRuta?.id ?? 0
  const rutaPais = selectedRuta?.pais ?? ""

  // ── El vendedor no entra a nada antes de iniciar la ruta ──────────────
  //
  // Antes el guard vivia solo dentro del modulo de pagos, asi que un vendedor
  // podia registrar una venta, un gasto o mirar clientes sin haber abierto la
  // jornada. La fila de `rutas_diarias` es la que despues consultan el cierre
  // de caja y el monitoreo del admin: si no existe, ese dia no aparece por
  // ningun lado aunque se haya trabajado.
  //
  // La jornada tiene que estar ABIERTA, no solo iniciada. Cerrar la caja
  // termina el dia: el conteo ya se cuadro y se firmo, asi que cualquier
  // movimiento posterior lo descuadraria hacia atras. El vendedor queda
  // bloqueado hasta el dia siguiente, cuando vuelve a iniciar ruta.
  //
  // UNICA EXCEPCION: `cierre-caja`. Es la pantalla donde acaba de cerrar y
  // donde esta el resumen y el PDF de la jornada. Bloquearla le arrancaria el
  // comprobante de las manos en el mismo momento de generarlo, y ademas no
  // permite hacer ningun movimiento: el propio cierre solo aplica sobre una
  // ruta 'abierta', asi que volver a entrar ahi no puede reabrir ni alterar
  // nada.
  const rolExigeRutaIniciada = ["vendedor", "asesor"].includes(userRol)
  const rutaSinIniciar =
    rolExigeRutaIniciada &&
    !!selectedRuta &&
    currentView !== "cierre-caja" &&
    (!rutaActivaResolved || rutaActivaEstado !== "abierta")

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
        return (
          <CierreCaja
            onBack={() => handleViewChange("daily-summary")}
            rutaId={rutaId}
            rutaNombre={rutaPais}
            onRouteStateChange={handleRutaActivaEstadoChange}
          />
        )
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
            preSelectedClientId={viewData?.clientId ?? null}
            currentRutaId={rutaId}
            rutaPais={rutaPais}
            onCancel={() => handleViewChange("register-payment")}
          />
        )
      case "pending-authorizations":
        return <PendingAuthorizations />
      case "secretary-authorizations":
        return <SecretaryAuthorizations />
      case "movimientos-revision":
        return <MovimientosRevision />
      case "multas":
        return <MultasView />
      case "documentos":
        return <DocumentosView currentUser={currentUser!} />
      case "mi-perfil":
        return <MiPerfil currentUser={currentUser!} onUserUpdate={handleUserUpdate} />
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
        return <ViewExpensesIncome currentRutaId={rutaId} />
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
      case "sale-editor":
        return <SaleEditor currentRutaId={rutaId} />
      case "loan-audit":
        return <LoanAudit currentRutaId={rutaId} />
      case "secretary-reports":
        return <SecretaryReports currentRutaId={rutaId} />
      case "socio-admin-reportes":
        return <SocioAdminReportes currentUser={currentUser!} />
      case "admin-reportes":
        return <AdminReportes currentUser={currentUser!} />
      case "secretary-admin-reportes":
        return <SecretaryAdminReportes currentUser={currentUser!} />
      case "user-route-management":
        return <GestionUsuariosRutas />
      case "chat":
        return <ChatView currentUser={currentUser!} />
      case "reportes-bi":
        return <ReportesBi currentUser={currentUser!} />
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

  // Render principal: loading / error / dashboard
  let mainContent: React.ReactNode

  if (sessionPhase === "applying" || sessionPhase === "idle") {
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
        userPermissions={userPermissions}
        moduleBadgeCounts={moduleBadgeCounts}
      >
        {rutaSinIniciar ? (
          <RutaNoIniciada
            rutaId={rutaId}
            resuelto={rutaActivaResolved}
            estado={rutaActivaEstado}
            onEstadoChange={handleRutaActivaEstadoChange}
            mensaje="Antes de trabajar tienes que iniciar la ruta del dia. Hasta entonces no se puede entrar a ningun modulo."
          />
        ) : (
          renderView()
        )}
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
      <RouteSelector
        open={showRutaSelector}
        onSelect={handleSelectRuta}
        userId={currentUser.id}
        userRol={currentUser.rol}
        onClose={() => setShowRutaSelector(false)}
      />
    </>
  )
}
