"use client"

/**
 * Registrar un ingreso, gasto o retiro desde Control Total.
 *
 * POR QUÉ EXISTE, SI YA HAY UNA PANTALLA PARA ESTO
 * La de siempre (`register-transaction`) es la del cobrador y está atada a su
 * jornada: registra en SU ruta, con la fecha de HOY, y contra el tope del
 * concepto — si se pasa, el movimiento se va a la cola de revisión y no cuenta
 * hasta que alguien lo firme. Eso es correcto para quien está en la calle.
 *
 * Secretaría hace otra cosa: cuadra cajas. Necesita meter el gasto del martes
 * que llegó en papel el viernes, o el ingreso de una ruta que ella no recorre,
 * y no tiene sentido que se pida permiso a sí misma. Acá:
 *
 *   · la FECHA se elige (cualquier día, incluso uno ya cerrado),
 *   · la RUTA se elige,
 *   · NO hay tope: el valor entra tal cual,
 *   · queda APROBADO por ella en el mismo acto, con su nombre firmando.
 *
 * No se escribe a la tabla directo: se pasa por `saveTransaction`, la misma
 * puerta de siempre. Lo que cambia es lo que se le manda —`limite: null` apaga
 * el tope y `aprobadoPorSecretaria` deja la firma—, así que la idempotencia y
 * el formato de la fila siguen siendo los mismos de siempre. Una segunda
 * puerta habría sido una segunda forma de escribir plata, y tarde o temprano
 * las dos se habrían separado.
 *
 * SOBRE EL PERMISO: quien abre este diálogo ya resolvió que puede, igual que
 * en el de edición. No hay comprobación de rol en el servidor porque en esta
 * app no hay sesión de servidor — la identidad vive en localStorage y no hay
 * RLS. Es la misma postura del resto del módulo, no una excepción de acá.
 */

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ConceptoCombobox } from "@/components/concepto-combobox"
import { Loader2, Plus, ShieldCheck } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { useToast } from "@/hooks/use-toast"
import { saveTransaction } from "@/lib/actions/save-transaction"
import { fmtMoneda, mostrarMonto, leerMonto } from "@/lib/gestion-core"
import { todayColombia } from "@/lib/colombia-date"
import {
  getUsuarioSesion, TIPOS_MOVIMIENTO, TABLA_CATALOGO, conceptosElegiblesAMano,
  type TipoMovimiento,
} from "@/lib/movimientos"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** La ruta que el panel tiene seleccionada. Sirve de valor por defecto. */
  rutaActual: number | "todas"
  rutas: { id: number; nombre: string }[]
  onSaved: () => void
}

/**
 * El instante que se guarda en `fechahorasol`.
 *
 * Los informes agrupan por `(fechahorasol AT TIME ZONE 'America/Bogota')::date`,
 * así que lo único que importa es caer en el día correcto de Colombia. Para un
 * día pasado se usa el MEDIODÍA: a las 12:00 −05:00 no hay corrimiento de zona
 * que pueda empujarlo al día anterior o al siguiente. Para hoy se usa la hora
 * real, y así el movimiento queda en su lugar cronológico dentro de la lista
 * en vez de aparecer siempre a las 12 del día.
 */
function instanteDelDia(fecha: string): string {
  if (fecha === todayColombia()) return new Date().toISOString()
  return new Date(`${fecha}T12:00:00-05:00`).toISOString()
}

export function NuevoMovimientoDialog({ open, onOpenChange, rutaActual, rutas, onSaved }: Props) {
  const { toast } = useToast()
  const [tipo, setTipo] = useState<TipoMovimiento>("Gasto")
  const [ruta, setRuta] = useState<string>("")
  const [fecha, setFecha] = useState(todayColombia())
  const [concepto, setConcepto] = useState("")
  const [valor, setValor] = useState("")
  const [observacion, setObservacion] = useState("")
  const [conceptos, setConceptos] = useState<string[]>([])
  const [cargandoConceptos, setCargandoConceptos] = useState(false)
  const [guardando, setGuardando] = useState(false)

  // Al abrir se parte de la ruta del panel. Si está en "todas" no hay una
  // sensata que asumir, y la caja de una ruta no es sitio para adivinar.
  useEffect(() => {
    if (!open) return
    setTipo("Gasto")
    setRuta(rutaActual === "todas" ? "" : String(rutaActual))
    setFecha(todayColombia())
    setConcepto("")
    setValor("")
    setObservacion("")
  }, [open, rutaActual])

  // El catálogo se lee del mismo sitio que en Registrar y en Editar: si acá se
  // pudiera escribir cualquier texto, el mismo gasto terminaría con tres
  // nombres distintos y ningún informe podría agruparlo.
  useEffect(() => {
    if (!open) return
    const tabla = TABLA_CATALOGO[tipo]
    if (!tabla) return
    let vigente = true
    setCargandoConceptos(true)
    ;(async () => {
      // `*` y no "nombre": hace falta `solo_sistema` para esconder los
      // conceptos que solo escribe el sistema, y pedirla por nombre reventaria
      // la consulta en `gastos` y `retiros`, que no la tienen.
      const { data, error } = await createClient().from(tabla).select("*").order("nombre")
      if (!vigente) return
      if (error) {
        console.error("[v0] Error cargando conceptos:", error.message)
        setConceptos([])
      } else {
        const filas = (data ?? []) as { nombre: string; solo_sistema?: boolean | null }[]
        setConceptos(conceptosElegiblesAMano(filas).map((c) => c.nombre))
      }
      setCargandoConceptos(false)
    })()
    return () => { vigente = false }
  }, [open, tipo])

  // Al cambiar de tipo el concepto anterior deja de existir en el catálogo.
  useEffect(() => { setConcepto("") }, [tipo])

  const valorNum = Number(valor)
  const puedeGuardar =
    !guardando && ruta !== "" && !!concepto && Number.isFinite(valorNum) && valorNum > 0

  const guardar = async () => {
    const usuario = getUsuarioSesion()
    if (!usuario.id) {
      toast({ title: "Sesión no encontrada", description: "Vuelve a entrar.", variant: "destructive" })
      return
    }
    if (!puedeGuardar) return

    setGuardando(true)
    try {
      const res = await saveTransaction({
        concepto,
        // SIN TOPE. `saveTransaction` solo compara contra el límite cuando no
        // es null, así que esto apaga la revisión por monto de raíz en vez de
        // saltársela con una bandera.
        limite: null,
        valor: valorNum,
        observacion: observacion.trim(),
        foto: null,
        tipo,
        ruta: Number(ruta),
        adminid: usuario.id,
        fechaCaptura: instanteDelDia(fecha),
        // La firma de quien lo autoriza. Con esto el movimiento nace
        // `estadosecre = 'aprobado'` y entra al Resumen del Día de una vez,
        // sin pasar por la bandeja de revisión.
        aprobadoPorSecretaria: usuario.nombre || "Secretaría",
        idempotencyKey: crypto.randomUUID(),
      })

      if (!res.success) {
        toast({
          title: "No se pudo registrar",
          description: res.error ?? "Error desconocido",
          variant: "destructive",
        })
        return
      }

      const nombreRuta = rutas.find((r) => r.id === Number(ruta))?.nombre ?? `Ruta ${ruta}`
      toast({
        title: `${tipo} registrado`,
        description: `${concepto} · ${fmtMoneda(valorNum)} · ${nombreRuta} · ${fecha}`,
      })
      onOpenChange(false)
      onSaved()
    } catch (e) {
      console.error("[v0] Error registrando movimiento:", e)
      toast({
        title: "No se pudo registrar",
        description: e instanceof Error ? e.message : "Error desconocido",
        variant: "destructive",
      })
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Plus className="h-4 w-4 text-brand" />
            Registrar movimiento
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Tipo</Label>
              <Select value={tipo} onValueChange={(v) => setTipo(v as TipoMovimiento)}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIPOS_MOVIMIENTO.map((t) => (
                    <SelectItem key={t} value={t} className="text-sm">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Fecha</Label>
              <Input
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Ruta</Label>
            <Select value={ruta} onValueChange={setRuta}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Elige la ruta" />
              </SelectTrigger>
              <SelectContent>
                {rutas.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)} className="text-sm">{r.nombre}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Concepto</Label>
            <ConceptoCombobox
              opciones={conceptos.map((c) => ({ valor: c, etiqueta: c }))}
              valor={concepto}
              onValorChange={setConcepto}
              cargando={cargandoConceptos}
              placeholder="Elige el concepto"
              vacioTexto={`No hay conceptos de ${tipo.toLowerCase()} configurados`}
              className="h-9 text-sm"
            />
            {!cargandoConceptos && conceptos.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                No hay conceptos de {tipo.toLowerCase()} configurados. Se agregan en Usuarios y Rutas.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Valor</Label>
            <Input
              type="text"
              inputMode="decimal"
              value={mostrarMonto(valor)}
              onChange={(e) => setValor(leerMonto(e.target.value))}
              placeholder="$ 0"
              className="h-9 text-sm"
            />
            {Number.isFinite(valorNum) && valorNum > 0 && (
              <p className="text-[11px] font-semibold tabular-nums text-muted-foreground">
                {fmtMoneda(valorNum)}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Observación (opcional)</Label>
            <Textarea
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              rows={2}
              placeholder="Por qué se registra"
              className="text-sm"
            />
          </div>

          {/* Se dice antes de guardar, no después: quien registra tiene que
              saber que este movimiento no pasa por ninguna revisión y que
              entra a la caja de ese día con su nombre encima. */}
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-2.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <p className="text-[11px] leading-snug text-muted-foreground">
              Sin tope de valor y sin pasar por revisión: queda aprobado por{" "}
              <span className="font-semibold text-foreground">
                {getUsuarioSesion().nombre || "Secretaría"}
              </span>{" "}
              y entra a la caja del {fecha} de una vez.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button size="sm" onClick={guardar} disabled={!puedeGuardar}>
              {guardando ? (
                <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Guardando…</>
              ) : (
                <><Plus className="mr-1.5 h-3.5 w-3.5" /> Registrar</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
