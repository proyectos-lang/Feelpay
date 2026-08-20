"use client"

/**
 * Compartir un comprobante
 * ------------------------
 * Tres salidas para la misma imagen: mandarla por fuera (WhatsApp, correo),
 * guardarla en el teléfono, o dejarla como evidencia en el chat de la app.
 *
 * La imagen se genera al momento de elegir, no al abrir: si el usuario abre
 * y cierra sin compartir, no se dibujó nada.
 */

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ChevronLeft, FileDown, Loader2, MessageSquare, Share2, Users } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { createClient } from "@/lib/supabase/client"

interface Conversacion {
  conversation_id: string
  /** En un grupo, su nombre. En un chat de a dos, el nombre de LA OTRA
   *  persona: la RPC `get_my_conversations` ya lo resuelve asi. */
  name: string | null
  is_group: boolean
}

export interface CompartirComprobanteDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** Genera la imagen. Se llama al elegir una opción, no al abrir. */
  construirImagen: () => Promise<{ blob: Blob; dataUrl: string; filename: string }>
  /** Texto que acompaña la imagen en el chat. */
  mensajeChat: string
  /** `id` puede venir como texto: asi lo guarda la sesion. */
  currentUser: { id: number | string; nombre: string }
  titulo?: string
}

export function CompartirComprobanteDialog({
  open,
  onOpenChange,
  construirImagen,
  mensajeChat,
  currentUser,
  titulo = "Compartir",
}: CompartirComprobanteDialogProps) {
  const { toast } = useToast()
  const [ocupado, setOcupado] = useState(false)
  const [eligiendoChat, setEligiendoChat] = useState(false)
  const [conversaciones, setConversaciones] = useState<Conversacion[]>([])
  const [cargandoConvs, setCargandoConvs] = useState(false)

  useEffect(() => {
    if (!open) { setEligiendoChat(false); setOcupado(false) }
  }, [open])

  const fallar = (err: unknown, queHacia: string) => {
    // Cancelar el menú nativo de compartir lanza AbortError. No es un error:
    // es el usuario diciendo que no.
    if (err instanceof Error && err.name === "AbortError") return
    console.error(`[v0] ${queHacia}:`, err)
    toast({
      title: `No se pudo ${queHacia}`,
      description: err instanceof Error ? err.message : "Intenta de nuevo.",
      variant: "destructive",
    })
  }

  const compartirFuera = async () => {
    setOcupado(true)
    try {
      const { blob, dataUrl, filename } = await construirImagen()
      const file = new File([blob], filename, { type: "image/png" })
      // `canShare({files})` es la guarda que importa: Chrome de escritorio
      // tiene `share` pero no admite archivos, y sin esto fallaría ahí.
      if (
        typeof navigator !== "undefined" &&
        navigator.share &&
        navigator.canShare &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({ files: [file], title: titulo })
      } else {
        const a = document.createElement("a")
        a.href = dataUrl
        a.download = filename
        a.click()
        toast({ title: "Imagen descargada", description: "Este dispositivo no permite compartir archivos." })
      }
      onOpenChange(false)
    } catch (err) {
      fallar(err, "compartir")
    } finally {
      setOcupado(false)
    }
  }

  const descargar = async () => {
    setOcupado(true)
    try {
      const { dataUrl, filename } = await construirImagen()
      const a = document.createElement("a")
      a.href = dataUrl
      a.download = filename
      a.click()
      onOpenChange(false)
    } catch (err) {
      fallar(err, "guardar la imagen")
    } finally {
      setOcupado(false)
    }
  }

  const abrirListaChats = async () => {
    setEligiendoChat(true)
    setCargandoConvs(true)
    try {
      const { data, error } = await createClient().rpc("get_my_conversations", {
        p_user_id: Number(currentUser.id),
      })
      if (error) throw error
      setConversaciones((data ?? []) as Conversacion[])
    } catch (err) {
      fallar(err, "cargar las conversaciones")
      setEligiendoChat(false)
    } finally {
      setCargandoConvs(false)
    }
  }

  const enviarAlChat = async (conv: Conversacion) => {
    setOcupado(true)
    try {
      const { blob, filename } = await construirImagen()
      const supabase = createClient()

      const form = new FormData()
      form.append("file", new File([blob], filename, { type: "image/png" }))
      const res = await fetch("/api/upload-photo?folder=chat", { method: "POST", body: form })
      if (!res.ok) throw new Error("No se pudo subir la imagen")
      const { url } = await res.json()

      const { error } = await supabase.from("chat_messages").insert({
        conversation_id: conv.conversation_id,
        sender_id: Number(currentUser.id),
        sender_nombre: currentUser.nombre,
        body: mensajeChat,
        image_url: url,
      })
      if (error) throw error

      // Avisar a los demás participantes, igual que al mandar un mensaje.
      const { data: parts } = await supabase
        .from("chat_participants")
        .select("user_id")
        .eq("conversation_id", conv.conversation_id)
      const otros = ((parts ?? []) as { user_id: number }[])
        .map((p) => p.user_id)
        .filter((id) => id !== Number(currentUser.id))
      if (otros.length > 0) {
        void fetch("/api/push/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_ids: otros,
            title: currentUser.nombre,
            body: mensajeChat,
            tag: `chat-${conv.conversation_id}`,
            url: "/?view=chat",
          }),
        }).catch(() => {})
      }

      toast({ title: "Enviado al chat", description: nombreDe(conv) })
      onOpenChange(false)
    } catch (err) {
      fallar(err, "enviar al chat")
    } finally {
      setOcupado(false)
    }
  }

  // Antes leia `other_user_nombre`, un campo que `get_my_conversations` NO
  // devuelve: llegaba `undefined` y la lista mostraba "Conversación" en todas
  // las filas, o sea que no se sabia a quien se le estaba mandando el cierre.
  const nombreDe = (c: Conversacion) =>
    c.name ?? (c.is_group ? "Grupo" : "Conversación")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            {eligiendoChat && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 -ml-1"
                onClick={() => setEligiendoChat(false)}
                disabled={ocupado}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            {eligiendoChat ? "¿A qué chat?" : titulo}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {eligiendoChat
              ? "La imagen queda en la conversación como evidencia."
              : "Se comparte como imagen: se ve dentro del chat sin tener que abrir un archivo."}
          </DialogDescription>
        </DialogHeader>

        {eligiendoChat ? (
          <div className="max-h-72 overflow-auto -mx-1 px-1">
            {cargandoConvs ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : conversaciones.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No tienes conversaciones abiertas.
              </p>
            ) : (
              <ul className="divide-y">
                {conversaciones.map((c) => (
                  <li key={c.conversation_id}>
                    <button
                      type="button"
                      disabled={ocupado}
                      onClick={() => void enviarAlChat(c)}
                      className="flex w-full items-center gap-2 px-1 py-2.5 text-left hover:bg-muted/50 disabled:opacity-50"
                    >
                      {c.is_group ? (
                        <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-sm truncate">{nombreDe(c)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="grid gap-2">
            <Button className="h-11 justify-start gap-2" onClick={() => void compartirFuera()} disabled={ocupado}>
              {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              Compartir
            </Button>
            <Button
              variant="outline"
              className="h-11 justify-start gap-2"
              onClick={() => void abrirListaChats()}
              disabled={ocupado}
            >
              <MessageSquare className="h-4 w-4" />
              Enviar al chat de la app
            </Button>
            <Button variant="outline" className="h-11 justify-start gap-2" onClick={() => void descargar()} disabled={ocupado}>
              <FileDown className="h-4 w-4" />
              Guardar imagen
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
