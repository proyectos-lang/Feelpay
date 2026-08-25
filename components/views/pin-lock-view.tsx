"use client"

/**
 * La pantalla del candado.
 *
 * Un teclado propio en vez de un `<input type="number">`: en el celular el
 * teclado del sistema tapa media pantalla, tarda en salir y a veces trae
 * letras. Cuatro dígitos con el pulgar no necesitan nada de eso.
 *
 * Se muestra el nombre y la foto de quien está adentro. Es deliberado: quien
 * levanta el teléfono ve de quién es la sesión —no un formulario anónimo— y
 * quien vuelve a la suya confirma de un vistazo que no se equivocó de cuenta.
 */

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Delete, Loader2, Lock, LogOut, ShieldAlert } from "lucide-react"
import { verificarPin, pinSigueEnDefault } from "@/lib/pin-lock"
import type { AuthenticatedUser } from "@/components/views/login-view"

interface Props {
  user: AuthenticatedUser
  /** El PIN fue correcto: se abre la app, sin volver a pedir la contraseña. */
  onDesbloqueado: () => void
  /** Salir del todo: borra la sesión y manda al login completo. */
  onSalir: () => void
}

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "borrar"]

export function PinLockView({ user, onDesbloqueado, onSalir }: Props) {
  const [pin, setPin] = useState("")
  const [verificando, setVerificando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bloqueado, setBloqueado] = useState(false)
  const [esDefault, setEsDefault] = useState(false)

  useEffect(() => {
    pinSigueEnDefault(user.id).then(setEsDefault).catch(() => {})
  }, [user.id])

  const intentar = useCallback(
    async (valor: string) => {
      setVerificando(true)
      setError(null)
      try {
        const r = await verificarPin(user.id, valor)
        if (r.bloqueado) {
          setBloqueado(true)
          setPin("")
          return
        }
        if (r.ok) {
          onDesbloqueado()
          return
        }
        setPin("")
        setError(
          r.restantes <= 3
            ? `PIN incorrecto. Te quedan ${r.restantes} intentos.`
            : "PIN incorrecto.",
        )
      } catch (e) {
        setPin("")
        setError(e instanceof Error ? e.message : "No se pudo verificar el PIN.")
      } finally {
        setVerificando(false)
      }
    },
    [user.id, onDesbloqueado],
  )

  // Se verifica solo al llegar al cuarto dígito: nadie tiene que buscar un
  // botón de "entrar" con el pulgar ocupado.
  const teclear = (t: string) => {
    if (verificando || bloqueado) return
    if (t === "borrar") {
      setPin((p) => p.slice(0, -1))
      setError(null)
      return
    }
    if (!t || pin.length >= 4) return
    const nuevo = pin + t
    setPin(nuevo)
    setError(null)
    if (nuevo.length === 4) void intentar(nuevo)
  }

  // El teclado físico también sirve: en escritorio nadie va a hacer clic en
  // cuatro botones.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") teclear(e.key)
      else if (e.key === "Backspace") teclear("borrar")
    }
    window.addEventListener("keydown", alTeclear)
    return () => window.removeEventListener("keydown", alTeclear)
  })

  const iniciales = (user.nombre || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase()

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-5 bg-background px-6 py-8">
      <div className="flex flex-col items-center gap-2.5">
        <Avatar className="h-16 w-16 border-2 border-border">
          {user.foto_url && <AvatarImage src={user.foto_url} alt={user.nombre} />}
          <AvatarFallback className="text-lg font-semibold">{iniciales}</AvatarFallback>
        </Avatar>
        <div className="text-center">
          <p className="text-base font-semibold text-foreground">{user.nombre}</p>
          <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            Ingresa tu PIN para continuar
          </p>
        </div>
      </div>

      {/* Los cuatro puntos. Se llenan a medida que teclea. */}
      <div className="flex gap-3" aria-label={`${pin.length} de 4 dígitos`}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-3.5 w-3.5 rounded-full border-2 transition-colors ${
              i < pin.length ? "border-brand bg-brand" : "border-muted-foreground/40"
            }`}
          />
        ))}
      </div>

      <div className="min-h-[2.5rem] px-4 text-center">
        {verificando && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Verificando…
          </span>
        )}
        {!verificando && bloqueado && (
          <p className="text-xs font-medium leading-snug text-destructive">
            Demasiados intentos. Entra con tu usuario y contraseña para volver a
            habilitar el PIN.
          </p>
        )}
        {!verificando && !bloqueado && error && (
          <p className="text-xs font-medium text-destructive">{error}</p>
        )}
        {!verificando && !bloqueado && !error && esDefault && (
          <p className="flex items-center justify-center gap-1 text-[11px] leading-snug text-warning">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            Tu PIN sigue siendo 0000. Cámbialo en Mi Perfil.
          </p>
        )}
      </div>

      {!bloqueado && (
        <div className="grid w-full max-w-[15rem] grid-cols-3 gap-2.5">
          {TECLAS.map((t, i) =>
            t === "" ? (
              <div key={i} />
            ) : (
              <Button
                key={i}
                type="button"
                variant={t === "borrar" ? "ghost" : "outline"}
                disabled={verificando}
                onClick={() => teclear(t)}
                className="h-14 text-xl font-semibold tabular-nums"
                aria-label={t === "borrar" ? "Borrar" : t}
              >
                {t === "borrar" ? <Delete className="h-5 w-5" /> : t}
              </Button>
            ),
          )}
        </div>
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={onSalir}
        className="gap-1.5 text-xs text-muted-foreground"
      >
        <LogOut className="h-3.5 w-3.5" />
        Entrar con usuario y contraseña
      </Button>
    </div>
  )
}
