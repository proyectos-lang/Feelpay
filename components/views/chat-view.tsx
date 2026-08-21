"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import {
  Loader2, Send, Paperclip, ArrowLeft, Plus, Users, User, X, Image as ImageIcon, MessageSquare,
  Search, ChevronUp, ChevronDown, Pencil, MoreVertical, Settings2, Check, Trash2,
} from "lucide-react"
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
  carpeta_id: string | null
}

type ChatCarpeta = { id: string; nombre: string }

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, "gi"))
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase()
      ? <mark key={i} className="bg-yellow-300 text-black rounded-sm px-0.5">{part}</mark>
      : <span key={i}>{part}</span>
  )
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
  // Buscador de usuarios: con la lista completa había que bajar a buscar a
  // ojo, y en una empresa con decenas de usuarios eso no escala.
  const [busqueda, setBusqueda] = useState("")

  const contactosFiltrados = contacts.filter((c) =>
    c.nombre.toLowerCase().includes(busqueda.trim().toLowerCase()),
  )

  useEffect(() => {
    if (!open) return
    setLoadingContacts(true)
    setGroupName("")
    setSelectedGroupIds(new Set())
    setSelectedPrivateId(null)
    setBusqueda("")

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

          {/* Buscador fuera de las pestañas: sirve a las dos listas, y
              repetirlo obligaría a escribir el nombre otra vez al cambiar
              de pestaña. */}
          {!loadingContacts && contacts.length > 0 && (
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Buscar usuario..."
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                className="h-8 text-sm pl-8 pr-8"
              />
              {busqueda && (
                <button
                  type="button"
                  onClick={() => setBusqueda("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Limpiar búsqueda"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          <TabsContent value="privado" className="space-y-3">
            {loadingContacts ? (
              <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : contacts.length === 0 ? (
              <p className="text-sm text-center text-muted-foreground py-4">No tienes contactos disponibles</p>
            ) : contactosFiltrados.length === 0 ? (
              <p className="text-sm text-center text-muted-foreground py-4">
                Ningún usuario coincide con &quot;{busqueda}&quot;
              </p>
            ) : (
              <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
                {contactosFiltrados.map((c) => (
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
            ) : contactosFiltrados.length === 0 ? (
              <p className="text-sm text-center text-muted-foreground py-4">
                {contacts.length === 0
                  ? "No tienes contactos disponibles"
                  : `Ningún usuario coincide con "${busqueda}"`}
              </p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {/* Se filtra la lista, NO la selección: quien ya estaba
                    marcado sigue en el grupo aunque el filtro lo oculte. El
                    contador de abajo lo confirma. */}
                {contactosFiltrados.map((c) => (
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

// ─── EditGroupDialog ──────────────────────────────────────────────────────────

interface EditGroupProps {
  open: boolean
  onClose: () => void
  currentUser: AuthenticatedUser
  conversationId: string
  currentName: string
  participants: { user_id: number; user_nombre: string }[]
  onChanged: () => void
}

function EditGroupDialog({ open, onClose, currentUser, conversationId, currentName, participants, onChanged }: EditGroupProps) {
  const { toast } = useToast()
  const [name, setName] = useState(currentName)
  const [savingName, setSavingName] = useState(false)
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [contacts, setContacts] = useState<ContactUser[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [selectedAddIds, setSelectedAddIds] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(currentName)
    setSelectedAddIds(new Set())
    setLoadingContacts(true)

    const memberIds = new Set(participants.map((p) => p.user_id))
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
        const available = ((data ?? []) as ContactUser[]).filter((c) => !memberIds.has(c.id))
        setContacts(available)
        setLoadingContacts(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId])

  const handleSaveName = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === currentName) return
    setSavingName(true)
    try {
      const { error } = await createClient()
        .from("chat_conversations")
        .update({ name: trimmed })
        .eq("id", conversationId)
      if (error) throw new Error(error.message)
      onChanged()
    } catch (err) {
      toast({ title: "Error", description: String(err), variant: "destructive" })
    } finally {
      setSavingName(false)
    }
  }

  const handleRemove = async (userId: number) => {
    setRemovingId(userId)
    try {
      const { error } = await createClient()
        .from("chat_participants")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
      if (error) throw new Error(error.message)
      onChanged()
    } catch (err) {
      toast({ title: "Error", description: String(err), variant: "destructive" })
    } finally {
      setRemovingId(null)
    }
  }

  const toggleAddId = (uid: number) => {
    setSelectedAddIds((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  const handleAddMembers = async () => {
    if (selectedAddIds.size === 0) return
    setAdding(true)
    try {
      const rows = [...selectedAddIds].map((uid) => {
        const u = contacts.find((c) => c.id === uid)!
        return { conversation_id: conversationId, user_id: uid, user_nombre: u.nombre }
      })
      const { error } = await createClient().from("chat_participants").insert(rows)
      if (error) throw new Error(error.message)
      setContacts((prev) => prev.filter((c) => !selectedAddIds.has(c.id)))
      setSelectedAddIds(new Set())
      onChanged()
    } catch (err) {
      toast({ title: "Error", description: String(err), variant: "destructive" })
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-sm rounded-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar grupo</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Nombre */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Nombre del grupo</label>
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm flex-1" />
              <Button
                size="sm"
                className="h-8 shrink-0"
                onClick={handleSaveName}
                disabled={savingName || !name.trim() || name.trim() === currentName}
              >
                {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Guardar"}
              </Button>
            </div>
          </div>

          {/* Miembros actuales */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Miembros ({participants.length})</label>
            <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
              {participants.map((p) => (
                <div key={p.user_id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-muted/40">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand text-[10px] font-bold">
                    {initials(p.user_nombre)}
                  </div>
                  <span className="text-sm flex-1 truncate">
                    {p.user_id === currentUser.id ? "Tú" : p.user_nombre}
                  </span>
                  {p.user_id !== currentUser.id && (
                    <button
                      type="button"
                      onClick={() => handleRemove(p.user_id)}
                      disabled={removingId === p.user_id}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/15 hover:text-destructive transition-colors"
                      title="Quitar del grupo"
                    >
                      {removingId === p.user_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Agregar miembros */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Agregar personas</label>
            {loadingContacts ? (
              <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            ) : contacts.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No hay más contactos disponibles</p>
            ) : (
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                {contacts.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => toggleAddId(c.id)}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 cursor-pointer hover:bg-muted/40 select-none"
                  >
                    <Checkbox checked={selectedAddIds.has(c.id)} className="h-4 w-4 pointer-events-none" />
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand text-[10px] font-bold">
                      {initials(c.nombre)}
                    </div>
                    <span className="text-sm">{c.nombre}</span>
                  </div>
                ))}
              </div>
            )}
            {contacts.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={handleAddMembers}
                disabled={selectedAddIds.size === 0 || adding}
              >
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Agregar (${selectedAddIds.size})`}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── ChatView ─────────────────────────────────────────────────────────────────

const UNSUPPORTED_IMAGE_TYPES = ["image/heic", "image/heif"]

interface ChatViewProps {
  currentUser: AuthenticatedUser
  /**
   * Avisa cuántos mensajes sin leer tiene el usuario EN TOTAL. Con esto la
   * burbuja del menú deja de ser un contador en memoria (que nacía en cero
   * en cada recarga) y pasa a ser el no leído real del servidor.
   */
  onUnreadChange?: (total: number) => void
}

export function ChatView({ currentUser, onUnreadChange }: ChatViewProps) {
  const { toast } = useToast()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [showThread, setShowThread] = useState(false) // móvil: panel visible
  // El canal de tiempo real está vivo. Solo se usa para avisar en pantalla
  // cuando NO lo está; el respaldo periódico corre igual.
  const [canalVivo, setCanalVivo] = useState(true)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [participants, setParticipants] = useState<{ user_id: number; user_nombre: string }[]>([])

  const [msgText, setMsgText] = useState("")
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [showNewConv, setShowNewConv] = useState(false)
  const [showEditGroup, setShowEditGroup] = useState(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)

  // Carpetas personales para organizar los chats (por usuario)
  const [carpetas, setCarpetas] = useState<ChatCarpeta[]>([])
  const [activeFolderFilter, setActiveFolderFilter] = useState<"all" | "sin-carpeta" | string>("all")
  /** Buscador de la LISTA de chats. Distinto de `searchQuery`, que busca
   *  dentro de los mensajes de la conversacion abierta. */
  const [filtroChats, setFiltroChats] = useState("")
  const [showManageFolders, setShowManageFolders] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameFolderValue, setRenameFolderValue] = useState("")
  const [savingFolderRename, setSavingFolderRename] = useState(false)
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const channelMsgsRef = useRef<RealtimeChannel | null>(null)
  const channelInvitesRef = useRef<RealtimeChannel | null>(null)
  const msgRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  /**
   * El campo crece con el texto, hasta 120px.
   *
   * Hacia falta desde que Enter hace salto de linea en el telefono: sin esto
   * el campo se queda en un renglon de 36px y el segundo renglon se escribe
   * "a ciegas", con el texto desplazandose dentro de una caja que no crece.
   *
   * `height = "auto"` antes de medir es obligatorio: sin eso `scrollHeight`
   * devuelve el alto que YA tiene y el campo solo sabe crecer, nunca encoger
   * al borrar.
   */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [msgText])

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

  // ── Carpetas personales ────────────────────────────────────────────────────

  const loadCarpetas = useCallback(async () => {
    const { data, error } = await createClient()
      .from("chat_carpetas")
      .select("id, nombre")
      .eq("user_id", currentUser.id)
      .order("nombre")
    if (error) console.error("[v0] Error cargando carpetas de chat:", error)
    setCarpetas((data ?? []) as ChatCarpeta[])
  }, [currentUser.id])

  useEffect(() => { loadCarpetas() }, [loadCarpetas])

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return
    setCreatingFolder(true)
    try {
      const { data, error } = await createClient()
        .from("chat_carpetas")
        .insert({ user_id: currentUser.id, nombre: newFolderName.trim() })
        .select("id, nombre")
        .single()
      if (error) throw error
      const nueva = data as ChatCarpeta
      setCarpetas((prev) => [...prev, nueva].sort((a, b) => a.nombre.localeCompare(b.nombre)))
      setNewFolderName("")
    } catch (err) {
      console.error("[v0] Error creando carpeta de chat:", err)
      toast({ title: "Error", description: err instanceof Error ? err.message : "No se pudo crear la carpeta", variant: "destructive" })
    } finally {
      setCreatingFolder(false)
    }
  }

  const handleRenameFolder = async (id: string) => {
    if (!renameFolderValue.trim()) return
    setSavingFolderRename(true)
    try {
      const nombre = renameFolderValue.trim()
      const { error } = await createClient().from("chat_carpetas").update({ nombre }).eq("id", id)
      if (error) throw error
      setCarpetas((prev) => prev.map((f) => (f.id === id ? { ...f, nombre } : f)).sort((a, b) => a.nombre.localeCompare(b.nombre)))
      setRenamingFolderId(null)
    } catch (err) {
      console.error("[v0] Error renombrando carpeta de chat:", err)
      toast({ title: "Error", description: err instanceof Error ? err.message : "No se pudo renombrar la carpeta", variant: "destructive" })
    } finally {
      setSavingFolderRename(false)
    }
  }

  const handleDeleteFolder = async (id: string) => {
    setDeletingFolderId(id)
    try {
      const { error } = await createClient().from("chat_carpetas").delete().eq("id", id)
      if (error) throw error
      setCarpetas((prev) => prev.filter((f) => f.id !== id))
      setConversations((prev) => prev.map((c) => (c.carpeta_id === id ? { ...c, carpeta_id: null } : c)))
      setActiveFolderFilter((prev) => (prev === id ? "all" : prev))
    } catch (err) {
      console.error("[v0] Error eliminando carpeta de chat:", err)
      toast({ title: "Error", description: err instanceof Error ? err.message : "No se pudo eliminar la carpeta", variant: "destructive" })
    } finally {
      setDeletingFolderId(null)
    }
  }

  const assignConversationToFolder = async (convId: string, carpetaId: string | null) => {
    // Optimista primero: la UI responde de inmediato, sin esperar la escritura.
    setConversations((prev) => prev.map((c) => (c.conversation_id === convId ? { ...c, carpeta_id: carpetaId } : c)))
    try {
      const supabase = createClient()
      if (carpetaId === null) {
        await supabase.from("chat_conversacion_carpeta").delete().eq("user_id", currentUser.id).eq("conversation_id", convId)
      } else {
        await supabase.from("chat_conversacion_carpeta").upsert(
          { user_id: currentUser.id, conversation_id: convId, carpeta_id: carpetaId },
          { onConflict: "user_id,conversation_id" }
        )
      }
    } catch (err) {
      console.error("[v0] Error moviendo chat de carpeta:", err)
      toast({ title: "Error", description: "No se pudo mover el chat de carpeta", variant: "destructive" })
      loadConversations()
    }
  }

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
      .subscribe((estado: string, err?: Error) => {
        if (estado !== "SUBSCRIBED") {
          console.warn("[v0] canal chat-my-invites:", estado, err?.message ?? "")
        }
      })

    return () => {
      // removeChannel y NO unsubscribe: el cliente de Supabase es un singleton
      // (lib/supabase/client.ts), así que `unsubscribe` corta el flujo pero deja
      // el canal registrado. Al remontar la vista se creaba otro canal con el
      // MISMO nombre sobre el mismo socket, y el servidor podía seguir hablando
      // con el zombi — parte de por qué los mensajes dejaban de llegar.
      const ch = channelInvitesRef.current
      if (ch) { void createClient().removeChannel(ch); channelInvitesRef.current = null }
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

  const refreshParticipants = useCallback(async (convId: string) => {
    const { data: parts } = await createClient()
      .from("chat_participants")
      .select("user_id, user_nombre")
      .eq("conversation_id", convId)
    setParticipants((parts ?? []) as { user_id: number; user_nombre: string }[])
  }, [])

  // ── Realtime: mensajes de la conversación activa ──────────────────────────
  // Sin filter en postgres_changes: filtrar client-side evita el requisito
  // de REPLICA IDENTITY FULL en la tabla para filtros por columna no-PK.

  const activeConvIdRef = useRef<string | null>(null)
  activeConvIdRef.current = activeConvId

  useEffect(() => {
    const supabase = createClient()
    channelMsgsRef.current = supabase
      .channel(`chat-global-msgs-${currentUser.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload: { new: ChatMessage & { conversation_id: string } }) => {
          const msg = payload.new
          const isActive = msg.conversation_id === activeConvIdRef.current
          const isOwn = msg.sender_id === currentUser.id

          if (isActive) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === msg.id)) return prev
              return [...prev, msg]
            })
            if (!isOwn) markAsRead(msg.conversation_id)
          }

          setConversations((prev) =>
            prev.map((c) =>
              c.conversation_id === msg.conversation_id
                ? {
                    ...c,
                    last_body: msg.body,
                    last_sender: msg.sender_nombre,
                    last_at: msg.created_at,
                    unread_count: isActive || isOwn ? 0 : c.unread_count + 1,
                  }
                : c
            )
          )
        }
      )
      // Grupo renombrado (por otro participante) → reflejar el nuevo nombre
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_conversations" },
        (payload: { new: { id: string; name: string | null } }) => {
          const { id, name } = payload.new
          setConversations((prev) => prev.map((c) => (c.conversation_id === id ? { ...c, name } : c)))
        }
      )
      // Alguien agregado a un grupo donde ya participo
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_participants" },
        (payload: { new: { conversation_id: string; user_id: number; user_nombre: string } }) => {
          const p = payload.new
          setConversations((prev) =>
            prev.map((c) => (c.conversation_id === p.conversation_id ? { ...c, members_count: c.members_count + 1 } : c))
          )
          if (p.conversation_id === activeConvIdRef.current && p.user_id !== currentUser.id) {
            setParticipants((prev) =>
              prev.some((x) => x.user_id === p.user_id) ? prev : [...prev, { user_id: p.user_id, user_nombre: p.user_nombre }]
            )
          }
        }
      )
      // Alguien removido de un grupo donde participo (o yo mismo)
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "chat_participants" },
        (payload: { old: { conversation_id: string; user_id: number } }) => {
          const p = payload.old
          if (p.user_id === currentUser.id) {
            setConversations((prev) => prev.filter((c) => c.conversation_id !== p.conversation_id))
            if (activeConvIdRef.current === p.conversation_id) {
              setActiveConvId(null)
              setShowThread(false)
              toast({ title: "Fuiste removido del grupo", description: "Ya no eres parte de esta conversación." })
            }
            return
          }
          setConversations((prev) =>
            prev.map((c) => (c.conversation_id === p.conversation_id ? { ...c, members_count: Math.max(1, c.members_count - 1) } : c))
          )
          if (p.conversation_id === activeConvIdRef.current) {
            setParticipants((prev) => prev.filter((x) => x.user_id !== p.user_id))
          }
        }
      )
      .subscribe((estado: string, err?: Error) => {
        // Antes esto iba sin callback: un CHANNEL_ERROR, TIMED_OUT o CLOSED era
        // completamente silencioso — ni log, ni reintento, ni forma de
        // diagnosticarlo desde el teléfono de un cobrador.
        setCanalVivo(estado === "SUBSCRIBED")
        if (estado !== "SUBSCRIBED") {
          console.warn("[v0] canal chat-global-msgs:", estado, err?.message ?? "")
        }
      })

    // Canal persistente por el ciclo de vida del componente; activeConvId
    // se lee via ref para no tener que resuscribir en cada cambio de conversación.
    return () => {
      const ch = channelMsgsRef.current
      if (ch) { void createClient().removeChannel(ch); channelMsgsRef.current = null }
    }
  // toast (de useToast) es estable entre renders; no hace falta listarlo
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.id, markAsRead])

  // ── El no leído total, hacia afuera ───────────────────────────────────────
  // Se deriva de `unread_count`, que calcula la base comparando cada mensaje
  // contra `chat_participants.last_read_at`. Así la burbuja sobrevive a la
  // recarga y no depende de que la app haya estado abierta cuando llegó.
  useEffect(() => {
    if (!onUnreadChange) return
    onUnreadChange(conversations.reduce((s, c) => s + (c.unread_count || 0), 0))
  }, [conversations, onUnreadChange])

  // ── Traer lo que haya entrado desde el último mensaje que tenemos ─────────
  //
  // Es la red de seguridad del hilo abierto. El WebSocket puede estar caído sin
  // que nadie se entere (en un PWA, apagar la pantalla o pasar de datos a WiFi
  // lo tumba), y hasta ahora el ÚNICO camino para ver un mensaje nuevo era
  // salir de la conversación y volver a entrar — exactamente el síntoma que
  // reportó el usuario.
  const alcanzarMensajes = useCallback(async (convId: string) => {
    try {
      const supabase = createClient()
      const desde = ultimoMsgAtRef.current
      let q = supabase
        .from("chat_messages")
        .select("id, sender_id, sender_nombre, body, image_url, created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true })
        .limit(50)
      if (desde) q = q.gt("created_at", desde)

      const { data, error } = await q
      if (error) throw error
      const nuevos = (data ?? []) as ChatMessage[]
      if (nuevos.length === 0) return

      let entraronDeOtro = false
      setMessages((prev) => {
        const vistos = new Set(prev.map((m) => m.id))
        // Mismo dedupe por id que usa el canal realtime: si los dos caminos
        // traen el mismo mensaje, entra una sola vez.
        const faltantes = nuevos.filter((m) => !vistos.has(m.id))
        if (faltantes.length === 0) return prev
        entraronDeOtro = faltantes.some((m) => m.sender_id !== currentUser.id)
        return [...prev, ...faltantes]
      })
      if (entraronDeOtro) void markAsRead(convId)
    } catch (err) {
      console.error("[v0] alcanzarMensajes:", err)
    }
  }, [currentUser.id, markAsRead])

  // Último mensaje conocido, para pedir solo lo posterior.
  const ultimoMsgAtRef = useRef<string | null>(null)
  useEffect(() => {
    ultimoMsgAtRef.current = messages.length > 0 ? messages[messages.length - 1].created_at : null
  }, [messages])

  // ── Reconexión: volver del segundo plano, recuperar foco o red ────────────
  useEffect(() => {
    const revivir = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void loadConversations()
      const conv = activeConvIdRef.current
      if (conv) void alcanzarMensajes(conv)
    }
    window.addEventListener("focus", revivir)
    window.addEventListener("online", revivir)
    document.addEventListener("visibilitychange", revivir)
    return () => {
      window.removeEventListener("focus", revivir)
      window.removeEventListener("online", revivir)
      document.removeEventListener("visibilitychange", revivir)
    }
  }, [loadConversations, alcanzarMensajes])

  // ── Respaldo periódico mientras el hilo está abierto ──────────────────────
  // Corre SIEMPRE, no solo cuando el canal se reporta caído: el modo de falla
  // observado es justamente que el canal CREE estar vivo. Son unas pocas filas
  // cada 20 segundos, y solo con la app en primer plano.
  useEffect(() => {
    if (!activeConvId) return
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void alcanzarMensajes(activeConvId)
    }, 20_000)
    return () => clearInterval(t)
  }, [activeConvId, alcanzarMensajes])

  // ── Scroll al fondo cuando llegan mensajes ────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── Seleccionar conversación ──────────────────────────────────────────────

  const selectConversation = (convId: string) => {
    setActiveConvId(convId)
    setShowThread(true)
    setSearchOpen(false)
    setSearchQuery("")
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

  /**
   * En el TELEFONO, Enter hace salto de linea y el mensaje se manda SOLO con
   * el boton. En computador se mantiene Enter para enviar y Shift+Enter para
   * el salto, que es lo que espera quien escribe con teclado fisico.
   *
   * POR QUE `pointer: coarse` Y NO EL ANCHO DE PANTALLA
   * Lo que importa no es que la pantalla sea chica, sino que el teclado sea el
   * de la pantalla: ahi la tecla de Enter es el unico salto de linea que hay,
   * y usarla para enviar deja al cobrador sin forma de escribir dos renglones.
   * `pointer: coarse` dice justamente eso — que se escribe con el dedo. Una
   * tablet en horizontal pasa de 768px y seguiria teniendo el problema si se
   * midiera por ancho.
   *
   * Se consulta al momento de la tecla y no se guarda en estado: si alguien le
   * conecta un teclado al telefono, el comportamiento se acomoda solo.
   */
  const escribeConElDedo = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return
    if (escribeConElDedo()) return // salto de linea: no se toca el evento
    e.preventDefault()
    sendMessage()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ""

    if (!file.type.startsWith("image/")) {
      toast({ title: "Archivo no válido", description: "Solo se pueden adjuntar imágenes en el chat.", variant: "destructive" })
      return
    }
    if (UNSUPPORTED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
      toast({
        title: "Formato no compatible",
        description: "Las fotos en formato HEIC/HEIF no se muestran en el chat. Usa JPG o PNG (en iPhone: Ajustes > Cámara > Formatos > \"Más compatible\").",
        variant: "destructive",
      })
      return
    }

    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
  }

  const activeConv = conversations.find((c) => c.conversation_id === activeConvId)

  /**
   * Sin tildes y en minuscula.
   *
   * Buscar "maria" tiene que encontrar a "María". Media agenda esta escrita
   * con tildes y la otra media sin ellas, asi que comparar el texto crudo
   * deja fuera justo a quien uno busca.
   */
  const sinTildes = (t: string) =>
    t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()

  const terminoChats = sinTildes(filtroChats.trim())

  const visibleConversations = conversations.filter((c) => {
    const enCarpeta =
      activeFolderFilter === "all" ? true
      : activeFolderFilter === "sin-carpeta" ? !c.carpeta_id
      : c.carpeta_id === activeFolderFilter
    if (!enCarpeta) return false
    if (!terminoChats) return true
    // Titulo, ultimo mensaje y quien lo escribio: uno se acuerda tanto del
    // nombre del grupo como de "el que mando lo del cierre".
    return (
      sinTildes(c.name ?? "").includes(terminoChats) ||
      sinTildes(c.last_body ?? "").includes(terminoChats) ||
      sinTildes(c.last_sender ?? "").includes(terminoChats)
    )
  })

  // ── Búsqueda dentro de la conversación ────────────────────────────────────

  const matchIds = searchQuery.trim()
    ? messages.filter((m) => m.body?.toLowerCase().includes(searchQuery.trim().toLowerCase())).map((m) => m.id)
    : []

  const scrollToMatch = (id: string) => {
    msgRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  useEffect(() => {
    setMatchIndex(0)
    if (searchQuery.trim() && matchIds.length > 0) {
      scrollToMatch(matchIds[0])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  const goToPrevMatch = () => {
    if (matchIds.length === 0) return
    const prev = (matchIndex - 1 + matchIds.length) % matchIds.length
    setMatchIndex(prev)
    scrollToMatch(matchIds[prev])
  }

  const goToNextMatch = () => {
    if (matchIds.length === 0) return
    const next = (matchIndex + 1) % matchIds.length
    setMatchIndex(next)
    scrollToMatch(matchIds[next])
  }

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery("")
    setMatchIndex(0)
  }

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

        {/* Buscador de chats. Va ARRIBA de las carpetas: las carpetas
            ordenan, el buscador encuentra, y encontrar es lo que uno viene a
            hacer cuando la lista ya es larga. */}
        {conversations.length > 0 && (
          <div className="px-3 py-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={filtroChats}
                onChange={(e) => setFiltroChats(e.target.value)}
                placeholder="Buscar chat, mensaje o persona..."
                className="h-8 pl-8 pr-8 text-sm"
              />
              {filtroChats && (
                <button
                  type="button"
                  onClick={() => setFiltroChats("")}
                  aria-label="Limpiar la busqueda"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Carpetas */}
        {conversations.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-2 border-b overflow-x-auto" style={{ scrollbarWidth: "none" }}>
            <button
              type="button"
              onClick={() => setActiveFolderFilter("all")}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                activeFolderFilter === "all" ? "bg-brand text-white" : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              Todos
            </button>
            <button
              type="button"
              onClick={() => setActiveFolderFilter("sin-carpeta")}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                activeFolderFilter === "sin-carpeta" ? "bg-brand text-white" : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              Sin carpeta
            </button>
            {carpetas.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setActiveFolderFilter(f.id)}
                className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium truncate max-w-[110px] transition-colors ${
                  activeFolderFilter === f.id ? "bg-brand text-white" : "bg-muted text-muted-foreground hover:bg-muted/70"
                }`}
                title={f.nombre}
              >
                {f.nombre}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowManageFolders(true)}
              className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
              title="Gestionar carpetas"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

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
        ) : visibleConversations.length === 0 ? (
          /* El vacio dice QUE esta filtrando. Con un solo texto para los dos
             casos, quien busca dentro de una carpeta cree que el chat no
             existe cuando en realidad esta en otra. */
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground px-4 text-center">
            <Users className="h-8 w-8 opacity-30" />
            <p className="text-sm">
              {terminoChats
                ? `Ningún chat coincide con "${filtroChats.trim()}"`
                : "Sin chats en esta carpeta"}
            </p>
            {(terminoChats || activeFolderFilter !== "all") && (
              <Button
                size="sm"
                variant="outline"
                className="mt-1"
                onClick={() => { setFiltroChats(""); setActiveFolderFilter("all") }}
              >
                Ver todos los chats
              </Button>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto divide-y divide-border">
            {visibleConversations.map((conv) => (
              <div
                key={conv.conversation_id}
                onClick={() => selectConversation(conv.conversation_id)}
                className={`w-full flex items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40 cursor-pointer select-none ${
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Mover a carpeta"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuLabel className="text-[11px]">Mover a carpeta</DropdownMenuLabel>
                    {carpetas.map((f) => (
                      <DropdownMenuItem key={f.id} onClick={() => assignConversationToFolder(conv.conversation_id, f.id)} className="gap-1.5">
                        {conv.carpeta_id === f.id ? <Check className="h-3.5 w-3.5" /> : <span className="w-3.5" />}
                        <span className="truncate">{f.nombre}</span>
                      </DropdownMenuItem>
                    ))}
                    {carpetas.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem onClick={() => assignConversationToFolder(conv.conversation_id, null)} disabled={!conv.carpeta_id}>
                      Sin carpeta
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setShowManageFolders(true)}>
                      + Nueva carpeta...
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
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
              {activeConv?.is_group && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  onClick={() => setShowEditGroup(true)}
                  title="Editar grupo"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => setSearchOpen((v) => !v)}
                title="Buscar en la conversación"
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>

            {/* Barra de búsqueda */}
            {searchOpen && (
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
                <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                <Input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goToPrevMatch() : goToNextMatch() }
                    if (e.key === "Escape") closeSearch()
                  }}
                  placeholder="Buscar en la conversación..."
                  className="h-8 text-sm flex-1"
                />
                {searchQuery.trim() && (
                  <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                    {matchIds.length > 0 ? `${matchIndex + 1}/${matchIds.length}` : "0/0"}
                  </span>
                )}
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={matchIds.length === 0} onClick={goToPrevMatch} title="Anterior">
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={matchIds.length === 0} onClick={goToNextMatch} title="Siguiente">
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={closeSearch} title="Cerrar búsqueda">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}

            {/* Conexión en vivo caída: los mensajes igual entran, pero con
                unos segundos de retraso. Se avisa en vez de dejar al usuario
                creyendo que el otro no le contestó. */}
            {!canalVivo && (
              <div className="px-4 py-1.5 bg-amber-50 border-b border-amber-200">
                <p className="text-[11px] text-amber-800">
                  Conexión en vivo interrumpida. Los mensajes nuevos pueden tardar unos segundos.
                </p>
              </div>
            )}

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

                  const isCurrentMatch = searchQuery.trim() !== "" && matchIds[matchIndex] === msg.id

                  return (
                    <div key={msg.id} ref={(el) => { if (el) msgRefs.current.set(msg.id, el); else msgRefs.current.delete(msg.id) }}>
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
                        } ${isCurrentMatch ? "ring-2 ring-yellow-400" : ""}`}
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
                        {msg.body && (
                          <p className="text-sm leading-snug whitespace-pre-wrap break-words">
                            {searchQuery.trim() ? highlightMatch(msg.body, searchQuery) : msg.body}
                          </p>
                        )}
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
                // `enterKeyHint="enter"` le pide al teclado del telefono que
                // pinte la tecla como salto de linea y no como "Enviar", que
                // es lo que muestra por defecto dentro de un formulario.
                enterKeyHint="enter"
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

      {/* Dialog editar grupo */}
      {activeConvId && activeConv?.is_group && (
        <EditGroupDialog
          open={showEditGroup}
          onClose={() => setShowEditGroup(false)}
          currentUser={currentUser}
          conversationId={activeConvId}
          currentName={activeConv?.name ?? ""}
          participants={participants}
          onChanged={() => { loadConversations(); refreshParticipants(activeConvId) }}
        />
      )}

      {/* Dialog gestionar carpetas */}
      <Dialog open={showManageFolders} onOpenChange={setShowManageFolders}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Carpetas de chat</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder() }}
              placeholder="Nueva carpeta..."
              className="h-9 text-sm flex-1"
            />
            <Button size="sm" className="h-9 shrink-0" onClick={handleCreateFolder} disabled={creatingFolder || !newFolderName.trim()}>
              {creatingFolder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
            {carpetas.map((f) => (
              <div key={f.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/40">
                {renamingFolderId === f.id ? (
                  <>
                    <Input
                      value={renameFolderValue}
                      onChange={(e) => setRenameFolderValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleRenameFolder(f.id) }}
                      className="h-8 text-sm flex-1"
                      autoFocus
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => handleRenameFolder(f.id)} disabled={savingFolderRename || !renameFolderValue.trim()}>
                      {savingFolderRename ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setRenamingFolderId(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="text-sm flex-1 truncate">{f.nombre}</span>
                    <button
                      type="button"
                      onClick={() => { setRenamingFolderId(f.id); setRenameFolderValue(f.nombre) }}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      title="Renombrar"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteFolder(f.id)}
                      disabled={deletingFolderId === f.id}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      title="Eliminar"
                    >
                      {deletingFolderId === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </>
                )}
              </div>
            ))}
            {carpetas.length === 0 && <p className="text-xs text-muted-foreground text-center py-3">Sin carpetas aún</p>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
