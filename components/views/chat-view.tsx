"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Send, Paperclip, ArrowLeft, Plus, Users, User, X, Image as ImageIcon, MessageSquare } from "lucide-react"
import type { AuthenticatedUser } from "./login-view"
import type { RealtimeChannel } from "@supabase/supabase-js"

function formatMsgTime(iso: string) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
}

function formatMsgDate(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return `Hoy · ${formatMsgTime(iso)}`
  if (sameDay(d, yesterday)) return `Ayer · ${formatMsgTime(iso)}`
  return `${d.toLocaleDateString("es-CO", { day: "numeric", month: "short" })} · ${formatMsgTime(iso)}`
}

function dateSeparatorLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return "Hoy"
  if (sameDay(d, yesterday)) return "Ayer"
  return d.toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Conversation = {
  conversation_id: string
  name: string | null
  is_group: boolean
  last_body: string | null
  last_sender: string | null
  last_at: string | null
  unread_count: number
  members_count: number
}

type ChatMessage = {
  id: string
  sender_id: number
  sender_nombre: string
  body: string | null
  image_url: string | null
  created_at: string
}

type ContactUser = {
  id: number
  nombre: string
  rol: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "ahora"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

function initials(nombre: string): string {
  return nombre
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase()
}

// ─── NewConversationDialog ────────────────────────────────────────────────────

interface NewConvProps {
  open: boolean
  onClose: () => void
  currentUser: AuthenticatedUser
  onConversationSelected: (id: string) => void
}

function NewConversationDialog({ open, onClose, currentUser, onConversationSelected }: NewConvProps) {
  const { toast } = useToast()
  const [contacts, setContacts] = useState<ContactUser[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [creating, setCreating] = useState(false)
  const [groupName, setGroupName] = useState("")
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number>>(new Set())
  const [selectedPrivateId, setSelectedPrivateId] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    setLoadingContacts(true)
    setGroupName("")
    setSelectedGroupIds(new Set())
    setSelectedPrivateId(null)

    const supabase = createClient()
    supabase
      .from("chat_allowed_contacts")
      .select("allowed_user_id")
      .eq("user_id", currentUser.id)
      .then(async ({ data: restrictionRows }: { data: { allowed_user_id: number }[] | null }) => {
        let query = supabase
          .from("usuarios")
          .select("id, nombre, rol")
          .eq("activo", true)
          .neq("id", currentUser.id)
          .order("nombre")

        if (restrictionRows && restrictionRows.length > 0) {
          const allowedIds = restrictionRows.map((r: { allowed_user_id: number }) => r.allowed_user_id)
          query = query.in("id", allowedIds)
        }

        const { data } = await query
        setContacts((data ?? []) as ContactUser[])
        setLoadingContacts(false)
      })
  }, [open, currentUser.id])

  const handleCreatePrivate = async () => {
    if (!selectedPrivateId) return
    setCreating(true)
    try {
      const supabase = createClient()
      const otherUser = contacts.find((c) => c.id === selectedPrivateId)!

      // Buscar conversación privada existente entre ambos usuarios
      const { data: myParts } = await supabase
        .from("chat_participants")
        .select("conversation_id")
        .eq("user_id", currentUser.id)

      if (myParts && myParts.length > 0) {
        const myConvIds = myParts.map((p: { conversation_id: string }) => p.conversation_id)
        const { data: existing } = await supabase
          .from("chat_participants")
          .select("conversation_id")
          .eq("user_id", selectedPrivateId)
          .in("conversation_id", myConvIds)

        if (existing && existing.length > 0) {
          // Verificar que sea privada
          const { data: conv } = await supabase
            .from("chat_conversations")
            .select("id, is_group")
            .eq("id", existing[0].conversation_id)
            .eq("is_group", false)
            .single()

          if (conv) {
            onConversationSelected(conv.id)
            onClose()
            return
          }
        }
      }

      // Crear nueva conversación privada
      const { data: conv, error } = await supabase
        .from("chat_conversations")
        .insert({ is_group: false, created_by: currentUser.id })
        .select("id")
        .single()

      if (error || !conv) throw new Error(error?.message ?? "Error al crear conversación")

      await supabase.from("chat_participants").insert([
        { conversation_id: conv.id, user_id: currentUser.id, user_nombre: currentUser.nombre },
        { conversation_id: conv.id, user_id: otherUser.id, user_nombre: otherUser.nombre },
      ])

      onConversationSelected(conv.id)
      onClose()
    } catch (err) {
      toast({ title: "Error", description: String(err), variant: "destructive" })
    } finally {
      setCreating(false)
    }
  }

  const handleCreateGroup = async () => {
    if (!groupName.trim() || selectedGroupIds.size === 0) return
    setCreating(true)
    try {
      const supabase = createClient()
      const { data: conv, error } = await supabase
        .from("chat_conversations")
        .insert({ name: groupName.trim(), is_group: true, created_by: currentUser.id })
        .select("id")
        .single()

      if (error || !conv) throw new Error(error?.message ?? "Error al crear grupo")

      const participants = [
        { conversation_id: conv.id, user_id: currentUser.id, user_nombre: currentUser.nombre },
        ...[...selectedGroupIds].map((uid) => {
          const u = contacts.find((c) => c.id === uid)!
          return { conversation_id: conv.id, user_id: uid, user_nombre: u.nombre }
        }),
      ]
      await supabase.from("chat_participants").insert(participants)

      onConversationSelected(conv.id)
      onClose()
    } catch (err) {
      toast({ title: "Error", description: String(err), variant: "destructive" })
    } finally {
      setCreating(false)
    }
  }

  const toggleGroupId = (uid: number) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle>Nueva conversación</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="privado">
          <TabsList className="grid w-full grid-cols-2 h-8 mb-3">
            <TabsTrigger value="privado" className="text-xs gap-1"><User className="h-3.5 w-3.5" />Chat privado</TabsTrigger>
            <TabsTrigger value="grupo" className="text-xs gap-1"><Users className="h-3.5 w-3.5" />Grupo</TabsTrigger>
          </TabsList>

          <TabsContent value="privado" className="space-y-3">
            {loadingContacts ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : contacts.length === 0 ? (
              <p className="text-sm text-center text-muted-foreground py-4">No tienes contactos disponibles</p>
            ) : (
              <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedPrivateId(c.id === selectedPrivateId ? null : c.id)}
                    className={`w-full text-left flex items-center gap-3 rounded-lg border px-3 py-2 transition-all ${
                      selectedPrivateId === c.id ? "border-brand bg-brand/10" : "border-transparent hover:border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand text-xs font-bold">
                      {initials(c.nombre)}
                    </div>
                    <span className="text-sm font-medium">{c.nombre}</span>
                  </button>
                ))}
              </div>
            )}
            <Button
              className="w-full"
              size="sm"
              onClick={handleCreatePrivate}
              disabled={!selectedPrivateId || creating}
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Iniciar chat"}
            </Button>
          </TabsContent>

          <TabsContent value="grupo" className="space-y-3">
            <Input
              placeholder="Nombre del grupo"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              className="h-8 text-sm"
            />
            {loadingContacts ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {contacts.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => toggleGroupId(c.id)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer hover:bg-muted/40 select-none"
                  >
                    <Checkbox
                      checked={selectedGroupIds.has(c.id)}
                      className="h-4 w-4 pointer-events-none"
                    />
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand text-[10px] font-bold">
                      {initials(c.nombre)}
                    </div>
                    <span className="text-sm">{c.nombre}</span>
                  </div>
                ))}
              </div>
            )}
            <Button
              className="w-full"
              size="sm"
              onClick={handleCreateGroup}
              disabled={!groupName.trim() || selectedGroupIds.size === 0 || creating}
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : `Crear grupo (${selectedGroupIds.size} participantes)`}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ─── ChatView ─────────────────────────────────────────────────────────────────

interface ChatViewProps {
  currentUser: AuthenticatedUser
}

export function ChatView({ currentUser }: ChatViewProps) {
  const { toast } = useToast()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [showThread, setShowThread] = useState(false) // móvil: panel visible

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [participants, setParticipants] = useState<{ user_id: number; user_nombre: string }[]>([])

  const [msgText, setMsgText] = useState("")
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [showNewConv, setShowNewConv] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const channelMsgsRef = useRef<RealtimeChannel | null>(null)
  const channelInvitesRef = useRef<RealtimeChannel | null>(null)

  // ── Cargar conversaciones ─────────────────────────────────────────────────

  const loadConversations = useCallback(async () => {
    try {
      const { data } = await createClient().rpc("get_my_conversations", { p_user_id: currentUser.id })
      setConversations((data ?? []) as Conversation[])
    } catch {
      // silencioso
    } finally {
      setLoadingConvs(false)
    }
  }, [currentUser.id])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  // ── Realtime: nuevas invitaciones ─────────────────────────────────────────

  useEffect(() => {
    const supabase = createClient()
    channelInvitesRef.current = supabase
      .channel("chat-my-invites")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_participants", filter: `user_id=eq.${currentUser.id}` },
        () => { loadConversations() }
      )
      .subscribe()

    return () => {
      channelInvitesRef.current?.unsubscribe()
    }
  }, [currentUser.id, loadConversations])

  // ── Cargar mensajes de conversación activa ────────────────────────────────

  const markAsRead = useCallback(async (convId: string) => {
    await createClient()
      .from("chat_participants")
      .update({ last_read_at: new Date().toISOString() })
      .eq("conversation_id", convId)
      .eq("user_id", currentUser.id)
    // Actualizar badge local
    setConversations((prev) =>
      prev.map((c) => (c.conversation_id === convId ? { ...c, unread_count: 0 } : c))
    )
  }, [currentUser.id])

  const loadMessages = useCallback(async (convId: string) => {
    setLoadingMsgs(true)
    setMessages([])
    try {
      const supabase = createClient()

      // Verificar participación (seguridad app-level)
      const { data: part } = await supabase
        .from("chat_participants")
        .select("user_id")
        .eq("conversation_id", convId)
        .eq("user_id", currentUser.id)
        .single()

      if (!part) {
        toast({ title: "Acceso denegado", description: "No eres participante de esta conversación.", variant: "destructive" })
        return
      }

      const [{ data: msgs }, { data: parts }] = await Promise.all([
        supabase
          .from("chat_messages")
          .select("id, sender_id, sender_nombre, body, image_url, created_at")
          .eq("conversation_id", convId)
          .order("created_at", { ascending: true })
          .limit(200),
        supabase
          .from("chat_participants")
          .select("user_id, user_nombre")
          .eq("conversation_id", convId),
      ])

      setMessages((msgs ?? []) as ChatMessage[])
      setParticipants((parts ?? []) as { user_id: number; user_nombre: string }[])
      await markAsRead(convId)
    } finally {
      setLoadingMsgs(false)
    }
  }, [currentUser.id, markAsRead, toast])

  // ── Realtime: mensajes de la conversación activa ──────────────────────────
  // Sin filter en postgres_changes: filtrar client-side evita el requisito
  // de REPLICA IDENTITY FULL en la tabla para filtros por columna no-PK.

  const activeConvIdRef = useRef<string | null>(null)
  activeConvIdRef.current = activeConvId

  useEffect(() => {
    channelMsgsRef.current?.unsubscribe()
    if (!activeConvId) return

    const supabase = createClient()
    channelMsgsRef.current = supabase
      .channel(`chat-global-msgs-${currentUser.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload: { new: ChatMessage & { conversation_id: string } }) => {
          // Solo procesar mensajes de la conversación activa en este momento
          if (payload.new.conversation_id !== activeConvIdRef.current) return
          const msg = payload.new
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev
            return [...prev, msg]
          })
          if (msg.sender_id !== currentUser.id) {
            markAsRead(msg.conversation_id)
          }
          setConversations((prev) =>
            prev.map((c) =>
              c.conversation_id === msg.conversation_id
                ? { ...c, last_body: msg.body, last_sender: msg.sender_nombre, last_at: msg.created_at, unread_count: 0 }
                : c
            )
          )
        }
      )
      .subscribe()

    return () => {
      channelMsgsRef.current?.unsubscribe()
    }
  // El canal se crea una vez por usuario; activeConvId se lee via ref
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.id, markAsRead])

  // ── Scroll al fondo cuando llegan mensajes ────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── Seleccionar conversación ──────────────────────────────────────────────

  const selectConversation = (convId: string) => {
    setActiveConvId(convId)
    setShowThread(true)
    loadMessages(convId)
  }

  const handleNewConversationSelected = (convId: string) => {
    loadConversations()
    selectConversation(convId)
  }

  // ── Enviar mensaje ────────────────────────────────────────────────────────

  const sendMessage = async () => {
    if (!activeConvId || (!msgText.trim() && !imageFile)) return
    setSending(true)
    try {
      let imageUrl: string | null = null

      if (imageFile) {
        const form = new FormData()
        form.append("file", imageFile)
        const res = await fetch("/api/upload-photo?folder=chat", { method: "POST", body: form })
        if (!res.ok) throw new Error("Error al subir imagen")
        const json = await res.json()
        imageUrl = json.url
      }

      const { data: inserted, error } = await createClient()
        .from("chat_messages")
        .insert({
          conversation_id: activeConvId,
          sender_id: currentUser.id,
          sender_nombre: currentUser.nombre,
          body: msgText.trim() || null,
          image_url: imageUrl,
        })
        .select("id, sender_id, sender_nombre, body, image_url, created_at")
        .single()

      if (error) throw new Error(error.message)

      // Append optimista: el sender ve su mensaje de inmediato sin esperar Realtime
      if (inserted) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === (inserted as ChatMessage).id)) return prev
          return [...prev, inserted as ChatMessage]
        })
        const now = (inserted as ChatMessage).created_at
        setConversations((prev) =>
          prev.map((c) =>
            c.conversation_id === activeConvId
              ? { ...c, last_body: (inserted as ChatMessage).body, last_sender: currentUser.nombre, last_at: now }
              : c
          )
        )
      }

      const recipientIds = participants
        .filter((p) => p.user_id !== currentUser.id)
        .map((p) => p.user_id)

      if (recipientIds.length > 0) {
        const activeConv = conversations.find((c) => c.conversation_id === activeConvId)
        fetch("/api/push/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_ids: recipientIds,
            title: currentUser.nombre,
            body: msgText.trim() || "📷 Imagen",
            tag: `chat-${activeConvId}`,
            url: "/?view=chat",
          }),
        }).catch(() => {})
        void activeConv
      }

      setMsgText("")
      setImageFile(null)
      setImagePreview(null)
    } catch (err) {
      toast({ title: "Error al enviar", description: String(err), variant: "destructive" })
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
    e.target.value = ""
  }

  const activeConv = conversations.find((c) => c.conversation_id === activeConvId)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-[calc(100vh-8rem)] overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* Panel izquierdo — lista de conversaciones */}
      <div className={`flex flex-col border-r ${showThread ? "hidden md:flex" : "flex"} w-full md:w-72 shrink-0`}>
        {/* Header lista */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-sm">Mensajes</h3>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setShowNewConv(true)}
            title="Nueva conversación"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Lista */}
        {loadingConvs ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground px-4 text-center">
            <MessageSquare className="h-8 w-8 opacity-30" />
            <p className="text-sm">Sin conversaciones aún</p>
            <Button size="sm" variant="outline" className="gap-1.5 mt-1" onClick={() => setShowNewConv(true)}>
              <Plus className="h-3.5 w-3.5" />
              Nueva conversación
            </Button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto divide-y divide-border">
            {conversations.map((conv) => (
              <button
                key={conv.conversation_id}
                type="button"
                onClick={() => selectConversation(conv.conversation_id)}
                className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 ${
                  activeConvId === conv.conversation_id ? "bg-muted/60" : ""
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand text-xs font-bold">
                  {conv.is_group ? <Users className="h-4 w-4" /> : initials(conv.name ?? "?")}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-sm font-semibold truncate">{conv.name ?? "—"}</p>
                    <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(conv.last_at)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {conv.last_body ?? (conv.last_sender ? "📷 Imagen" : "Sin mensajes")}
                  </p>
                </div>
                {conv.unread_count > 0 && (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-white text-[10px] font-bold">
                    {conv.unread_count > 9 ? "9+" : conv.unread_count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Panel derecho — hilo de mensajes */}
      <div className={`flex flex-col flex-1 min-w-0 ${showThread ? "flex" : "hidden md:flex"}`}>
        {!activeConvId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <MessageSquare className="h-10 w-10 opacity-20" />
            <p className="text-sm">Selecciona una conversación</p>
          </div>
        ) : (
          <>
            {/* Header hilo */}
            <div className="flex items-center gap-3 px-4 py-3 border-b">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 md:hidden"
                onClick={() => { setShowThread(false); setActiveConvId(null) }}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand text-xs font-bold">
                {activeConv?.is_group ? <Users className="h-4 w-4" /> : initials(activeConv?.name ?? "?")}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{activeConv?.name ?? "—"}</p>
                {activeConv?.is_group && (
                  <p className="text-[11px] text-muted-foreground truncate">
                    {participants.length > 0
                      ? [
                          ...participants.filter((p) => p.user_id === currentUser.id).map(() => "Tú"),
                          ...participants.filter((p) => p.user_id !== currentUser.id).map((p) => p.user_nombre),
                        ].join(", ")
                      : `${activeConv.members_count} participantes`}
                  </p>
                )}
              </div>
            </div>

            {/* Mensajes */}
            {loadingMsgs ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
                {messages.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground py-8">Sin mensajes aún. ¡Sé el primero en escribir!</p>
                )}
                {messages.map((msg, i) => {
                  const isOwn = msg.sender_id === currentUser.id
                  const prevMsg = messages[i - 1]
                  const showSender = activeConv?.is_group && !isOwn && msg.sender_id !== prevMsg?.sender_id
                  const prevDate = prevMsg ? new Date(prevMsg.created_at).toDateString() : null
                  const thisDate = new Date(msg.created_at).toDateString()
                  const showDateSep = prevDate !== thisDate

                  return (
                    <div key={msg.id}>
                    {showDateSep && (
                      <div className="flex items-center gap-2 my-3">
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-[10px] text-muted-foreground font-medium capitalize px-1">
                          {dateSeparatorLabel(msg.created_at)}
                        </span>
                        <div className="flex-1 h-px bg-border" />
                      </div>
                    )}
                    <div className={`flex flex-col ${isOwn ? "items-end" : "items-start"} ${i > 0 && messages[i - 1].sender_id === msg.sender_id && !showDateSep ? "mt-0.5" : "mt-3"}`}>
                      {showSender && (
                        <p className="text-[10px] font-semibold text-muted-foreground px-1 mb-0.5">{msg.sender_nombre}</p>
                      )}
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 ${
                          isOwn
                            ? "bg-brand text-white rounded-tr-sm"
                            : "bg-muted text-foreground rounded-tl-sm"
                        }`}
                      >
                        {msg.image_url && (
                          <button type="button" onClick={() => setLightboxUrl(msg.image_url!)} className="block mb-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={msg.image_url}
                              alt="imagen"
                              className="max-h-48 rounded-lg object-cover cursor-pointer hover:opacity-90 transition-opacity"
                            />
                          </button>
                        )}
                        {msg.body && <p className="text-sm leading-snug whitespace-pre-wrap break-words">{msg.body}</p>}
                        <p className={`text-[10px] mt-0.5 ${isOwn ? "text-white/60 text-right" : "text-muted-foreground text-right"}`}>
                          {formatMsgDate(msg.created_at)}
                        </p>
                      </div>
                    </div>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>
            )}

            {/* Preview imagen */}
            {imagePreview && (
              <div className="flex items-center gap-2 px-4 py-2 border-t bg-muted/30">
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imagePreview} alt="preview" className="h-14 w-14 object-cover rounded-lg" />
                  <button
                    type="button"
                    onClick={() => { setImageFile(null); setImagePreview(null) }}
                    className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-white"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground truncate flex-1">{imageFile?.name}</p>
              </div>
            )}

            {/* Input bar */}
            <div className="flex items-end gap-2 px-3 py-3 border-t">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                onClick={() => fileInputRef.current?.click()}
                title="Adjuntar imagen"
              >
                {imageFile ? <ImageIcon className="h-4 w-4 text-brand" /> : <Paperclip className="h-4 w-4" />}
              </Button>
              <Textarea
                ref={textareaRef}
                value={msgText}
                onChange={(e) => setMsgText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Escribe un mensaje..."
                className="flex-1 min-h-[36px] max-h-[120px] resize-none rounded-xl text-sm py-2 px-3"
                rows={1}
              />
              <Button
                type="button"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={sendMessage}
                disabled={sending || (!msgText.trim() && !imageFile)}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxUrl(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="imagen ampliada"
            className="max-h-full max-w-full rounded-xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Dialog nueva conversación */}
      <NewConversationDialog
        open={showNewConv}
        onClose={() => setShowNewConv(false)}
        currentUser={currentUser}
        onConversationSelected={handleNewConversationSelected}
      />
    </div>
  )
}
