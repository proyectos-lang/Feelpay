"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { Camera, KeyRound, Loader2, ShieldAlert, User as UserIcon } from "lucide-react"
import { cambiarPin, pinSigueEnDefault, requierePin } from "@/lib/pin-lock"
import type { AuthenticatedUser } from "./login-view"

function initials(nombre: string): string {
  return nombre.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase()
}

const UNSUPPORTED_IMAGE_TYPES = ["image/heic", "image/heif"]

interface MiPerfilProps {
  currentUser: AuthenticatedUser
  onUserUpdate: (user: AuthenticatedUser) => void
}

export function MiPerfil({ currentUser, onUserUpdate }: MiPerfilProps) {
  const { toast } = useToast()
  const [uploading, setUploading] = useState(false)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return

    if (!file.type.startsWith("image/")) {
      toast({ title: "Archivo inválido", description: "Selecciona una imagen", variant: "destructive" })
      return
    }
    if (UNSUPPORTED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
      toast({
        title: "Formato no compatible",
        description: "Las fotos en formato HEIC/HEIF no se muestran bien. Usa JPG o PNG (en iPhone: Ajustes > Cámara > Formatos > \"Más compatible\").",
        variant: "destructive",
      })
      return
    }

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("folder", `perfiles/${currentUser.id}`)
      const res = await fetch("/api/upload-photo", { method: "POST", body: fd })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? "Error al subir la imagen")

      const { error } = await createClient().from("usuarios").update({ foto_url: json.url }).eq("id", currentUser.id)
      if (error) throw error

      onUserUpdate({ ...currentUser, foto_url: json.url })
      toast({ title: "Foto de perfil actualizada" })
    } catch (err) {
      console.error("[v0] Error subiendo foto de perfil:", err)
      toast({ title: "Error", description: err instanceof Error ? err.message : "No se pudo subir la foto", variant: "destructive" })
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
        </div>
        <div>
          <h2 className="text-base md:text-lg font-bold leading-tight">Mi Perfil</h2>
          <p className="text-[11px] text-muted-foreground">Tu información de cuenta</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6 flex flex-col items-center gap-4">
        <div className="relative">
          <Avatar className="h-24 w-24 ring-2 ring-border">
            {currentUser.foto_url && <AvatarImage src={currentUser.foto_url} alt={currentUser.nombre} />}
            <AvatarFallback className="bg-brand-gradient text-brand-foreground text-2xl font-bold">
              {currentUser.nombre ? initials(currentUser.nombre) : <UserIcon className="h-8 w-8" />}
            </AvatarFallback>
          </Avatar>
          <label
            htmlFor="perfil-foto-input"
            className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-brand text-white cursor-pointer hover:bg-brand-light transition-colors shadow"
            title="Cambiar foto"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          </label>
          <input
            id="perfil-foto-input"
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploading}
            onChange={handleFileChange}
          />
        </div>

        <div className="text-center">
          <p className="text-base font-semibold">{currentUser.nombre}</p>
          {currentUser.usuario && <p className="text-xs text-muted-foreground">@{currentUser.usuario}</p>}
          {currentUser.rol && (
            <span className="inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {currentUser.rol}
            </span>
          )}
        </div>
      </div>

      {/* A quien nunca se le pide el PIN no se le ofrece cambiarlo, y sobre
          todo no se le avisa que "sigue en 0000": seria pedirle que arregle
          una cerradura que su puerta no tiene. */}
      {requierePin(currentUser.rol) && <CambiarPinCard userId={currentUser.id} />}
    </div>
  )
}

/**
 * Cambiar el PIN de bloqueo.
 *
 * Pide el actual además del nuevo: sin eso, quien levanta un celular
 * desbloqueado le pondría otro PIN y se quedaría con la sesión para siempre.
 * La comprobación la hace el servidor — acá solo se manda.
 */
function CambiarPinCard({ userId }: { userId: number | string }) {
  const { toast } = useToast()
  const [actual, setActual] = useState("")
  const [nuevo, setNuevo] = useState("")
  const [repetir, setRepetir] = useState("")
  const [guardando, setGuardando] = useState(false)
  const [esDefault, setEsDefault] = useState(false)

  useEffect(() => {
    pinSigueEnDefault(userId).then(setEsDefault).catch(() => {})
  }, [userId])

  const soloDigitos = (v: string) => v.replace(/[^0-9]/g, "").slice(0, 4)
  const listo = actual.length === 4 && nuevo.length === 4 && repetir.length === 4 && !guardando

  const guardar = async () => {
    if (nuevo !== repetir) {
      toast({ title: "No coinciden", description: "El PIN nuevo y su repetición son distintos.", variant: "destructive" })
      return
    }
    if (nuevo === "0000") {
      toast({
        title: "Elige otro PIN",
        description: "0000 es el que trae por defecto: no protege nada.",
        variant: "destructive",
      })
      return
    }
    setGuardando(true)
    try {
      const r = await cambiarPin(userId, actual, nuevo)
      if (!r.ok) {
        toast({ title: "No se pudo cambiar", description: r.error ?? "Intenta de nuevo.", variant: "destructive" })
        return
      }
      setActual(""); setNuevo(""); setRepetir(""); setEsDefault(false)
      toast({ title: "PIN actualizado", description: "Lo vas a necesitar la próxima vez que vuelvas a la app." })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-brand" />
        <div>
          <h3 className="text-sm font-semibold leading-tight">PIN de bloqueo</h3>
          <p className="text-[11px] text-muted-foreground">
            Se pide cada vez que vuelves a la app.
          </p>
        </div>
      </div>

      {esDefault && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2 text-[11px] leading-snug text-warning-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          Tu PIN sigue siendo <span className="font-semibold">0000</span>, el que viene por
          defecto. Cualquiera que tome tu celular lo adivina.
        </p>
      )}

      <div className="grid gap-2">
        {[
          { label: "PIN actual", v: actual, set: setActual },
          { label: "PIN nuevo", v: nuevo, set: setNuevo },
          { label: "Repite el nuevo", v: repetir, set: setRepetir },
        ].map((c) => (
          <div key={c.label} className="space-y-1">
            <Label className="text-xs">{c.label}</Label>
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="••••"
              value={c.v}
              onChange={(e) => c.set(soloDigitos(e.target.value))}
              className="h-9 text-center text-base tracking-[0.4em]"
            />
          </div>
        ))}
      </div>

      <Button size="sm" className="w-full" disabled={!listo} onClick={guardar}>
        {guardando ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        Cambiar PIN
      </Button>
    </div>
  )
}
