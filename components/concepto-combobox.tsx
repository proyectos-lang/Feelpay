"use client"

/**
 * Elegir un concepto escribiendo, no bajando.
 *
 * POR QUÉ NO UN SELECT
 * Hay 40 conceptos de gasto. En un `Select` eso es una lista que hay que
 * recorrer con el dedo, parado en la calle, con sol encima. Escribiendo
 * "alim" quedan uno o dos y se acabó.
 *
 * ES EL MISMO PATRÓN QUE YA USA NUEVA VENTA para buscar clientes. Se sacó a
 * un componente en vez de copiarlo por cuarta vez, porque lo que se copiaría
 * son justamente los dos detalles de móvil que costó encontrar:
 *
 *  · `onOpenAutoFocus` cancelado: en el celular el teclado virtual roba el
 *    foco al abrir, y sin esto Radix lo devuelve al botón — el campo pierde
 *    el cursor apenas se toca.
 *
 *  · El popover se fuerza al ancho del botón (`--radix-popover-trigger-width`),
 *    o en pantallas angostas sale más angosto que el campo y se ve torcido.
 *
 * El filtrado lo hace `cmdk` en memoria: son cuarenta nombres que ya están
 * cargados, y una consulta al servidor por cada letra sería peor en la calle.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command"
import { Check, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface OpcionConcepto {
  /** Lo que se guarda. En Registrar es el id del item; en los diálogos, el nombre. */
  valor: string
  etiqueta: string
}

/**
 * Sin tildes, en minúsculas y sin espacios de sobra.
 *
 * Seis conceptos llevan tilde o ñ —Alimentación, Médico/Medicinas, Pérdidas,
 * Trámites, Inversión, Interés— y NADIE escribe la tilde en el teclado de un
 * celular, con el dedo, parado en la calle. El filtro que trae `cmdk` compara
 * los textos tal cual, así que escribir "alimentacion" no encontraba
 * "Alimentación" y el buscador quedaba peor que la lista que reemplaza.
 *
 * De paso recorta: "Inversión " está guardado con un espacio al final.
 */
const normalizar = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim()

interface Props {
  opciones: OpcionConcepto[]
  valor: string
  onValorChange: (valor: string) => void
  id?: string
  placeholder?: string
  /** Qué decir cuando el catálogo está vacío (varía según el tipo). */
  vacioTexto?: string
  cargando?: boolean
  disabled?: boolean
  /** Alturas: el módulo del cobrador usa campos más bajos que los diálogos. */
  className?: string
}

export function ConceptoCombobox({
  opciones,
  valor,
  onValorChange,
  id,
  placeholder = "Seleccione un concepto",
  vacioTexto = "No hay conceptos disponibles",
  cargando = false,
  disabled = false,
  className,
}: Props) {
  const [abierto, setAbierto] = useState(false)
  const seleccionada = opciones.find((o) => o.valor === valor)

  return (
    <Popover open={abierto} onOpenChange={setAbierto}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={abierto}
          disabled={disabled || cargando}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className={cn("truncate", seleccionada ? "" : "text-muted-foreground")}>
            {cargando ? "Cargando…" : (seleccionada?.etiqueta ?? placeholder)}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command
          // El filtro propio: `cmdk` compara los textos tal cual y acá hacen
          // falta las tildes ignoradas. Devuelve 1 si coincide y 0 si no —
          // basta con eso, no hace falta puntuar la cercanía.
          filter={(value, search) =>
            normalizar(value).includes(normalizar(search)) ? 1 : 0
          }
        >
          <CommandInput placeholder="Escribe para buscar…" className="text-sm" />
          <CommandList className="max-h-56">
            <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">
              {opciones.length === 0 ? vacioTexto : "Ningún concepto coincide"}
            </CommandEmpty>
            <CommandGroup>
              {opciones.map((o) => (
                <CommandItem
                  key={o.valor}
                  // `value` es lo que `cmdk` usa para buscar: tiene que ser el
                  // NOMBRE, no el id. Con el id, escribir "alim" no encontraría
                  // nada porque estaría comparando contra "7".
                  value={o.etiqueta}
                  onSelect={() => {
                    onValorChange(o.valor)
                    setAbierto(false)
                  }}
                  className="text-sm"
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      o.valor === valor ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{o.etiqueta}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
