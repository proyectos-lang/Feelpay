"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { useToast } from "@/hooks/use-toast"
import { Camera, Loader2, User as UserIcon } from "lucide-react"
import type { AuthenticatedUser } from "./login-view"

function initials(nombre: string): string {
  return nombre.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase()
}

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
    </div>
  )
}
