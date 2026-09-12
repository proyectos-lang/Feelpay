/**
 * Auditoría de cierre — de dónde sale cada número del día.
 * ---------------------------------------------------------
 * El Resumen del Día muestra una docena de cifras. Cuando una no cuadra, hoy
 * la única salida es creerle a la pantalla o pedir un script. Este módulo arma
 * la MISMA cuenta que `resumen_diario_v2` (script 070) pero a partir de los
 * hechos crudos, de modo que cada cifra pueda abrirse y mostrar los renglones
 * que la componen.
 *
 * LA REGLA DE ORO: acá no se inventa una segunda contabilidad.
 * Cada total que este módulo calcula tiene al lado el que publica la vista, y
 * la pantalla muestra los dos. Si difieren, esa diferencia ES el hallazgo —
 * no un error que haya que esconder redondeando.
 *
 * Espejo del SQL, cláusula por cláusula:
 *
 *   valor_pago / cantidad_pagos / cantidad_no_pagos
 *       `gestiones` del día, estado 'aplicada', origen <> 'homologacion',
 *       COLAPSADAS POR CLIENTE: un cliente, un día, un resultado. Es
 *       `colapsarPorCliente` de `lib/gestion-core.ts`, la misma que usa el
 *       módulo de pagos — por eso la lista y el contador no pueden discrepar.
 *
 *   valor_pago_campo / valor_pago_ajuste
 *       El mismo neto partido por `origen`: 'campo' es plata de calle, todo lo
 *       demás son correcciones de escritorio. Esta es la columna que explica
 *       por qué el cobrador dice una cifra y la pantalla otra.
 *
 *   pago_efectivo / pago_transferencia
 *       Por `metodo_pago`, con NULL contando como efectivo y una REVERSA
 *       heredando el método del evento que deshace. Sin esa herencia, revertir
 *       una transferencia restaría del efectivo.
 *
 *   valor_gastos / valor_ingresos / valor_retiros
 *       `gastosregistros` por fecha LOCAL de `fechahorasol`, y solo los que la
 *       vista cuenta: aprobados por secretaría o que nunca necesitaron
 *       aprobación ('NA'). Los pendientes y rechazados se cargan igual y se
 *       muestran aparte: son la explicación más común de un gasto "que no
 *       aparece".
 *
 *   valor_ventas / valor_ventas_caja
 *       `loans` por fecha local de creación. Las homologadas se muestran pero
 *       NO descuentan de la caja: esa plata nunca salió de este cajón.
 *
 *   meta_pagos
 *       Suma de `valor_cuota` de las cuotas que VENCEN ese día. Sale del
 *       cronograma, no de lo que se pagó.
 *
 *   efectivo
 *       caja_anterior + ingresos + pagos − ventas_caja − gastos − retiros.
 *
 * Todo se filtra por ruta: no hay RLS que lo haga.
 */

import { getSupabaseSafe } from "@/lib/api-helper"
import {
  colapsarPorCliente,
  montoEfectivo,
  type Gestion,
  type TipoGestion,
} from "@/lib/gestion-core"

/** Tipos que el resumen mira. Los demás (extension, ajuste puro) no son plata. */
const TIPOS_DEL_RESUMEN: TipoGestion[] = [
  "pago",
  "no_pago",
  "cancelacion",
  "abono_venta",
  "reversa",
]

function n(v: unknown): number {
  return Number(v) || 0
}

/** Un evento del libro, ya con el nombre de su cliente y de quien lo hizo. */
export interface EventoCierre extends Gestion {
  cliente: string
  documento: string | null
  usuario: string | null
  /** Método ya resuelto: el propio, o el del evento que revierte, o efectivo. */
  metodoEfectivo: string
  /** Aporte de este evento al neto del día (una reversa va en negativo). */
  aporte: number
}

/** Un cliente en el día: el resultado y todo el rastro que lo produjo. */
export interface FilaCliente {
  loanId: string
  cliente: string
  documento: string | null
  neto: number
  estado: "pagado" | "no_pago"
  /** Parte del neto que vino de la calle (`origen = 'campo'`). */
  netoCampo: number
  efectivo: number
  transferencia: number
  eventos: EventoCierre[]
  /** true = hubo más de un evento, o sea que alguien corrigió algo. */
  corregido: boolean
  hora: string | null
}

export interface MovimientoCierre {
  id: number
  tipo: string
  concepto: string
  valor: number
  observacion: string | null
  fechahorasol: string
  estadoadmin: string
  estadosecre: string
  /** true = la vista lo cuenta. false = está pendiente o rechazado. */
  cuenta: boolean
}

export interface VentaCierre {
  id: string
  cliente: string
  valor: number
  homologada: boolean
  fechaCreacion: string
}

export interface CuotaMeta {
  loanId: string
  cliente: string
  valorCuota: number
  numeroCuota: number | null
  estado: string | null
  /** Lo que ese cliente puso ese día, para comparar contra lo que debía. */
  pagado: number
  /**
   * false = el crédito ya estaba cancelado antes de este día, así que su cuota
   * NO entra en la meta (regla del script 104). Se muestra igual, tachada: es
   * la explicación de por qué la meta es menor que la suma del cronograma.
   */
  cuentaEnMeta: boolean
}

/** Lo que publica `resumen_diario_v2`, tal cual, sin tocar. */
export interface FilaResumen {
  fecha_pago: string
  ruta: number
  meta_pagos: number
  valor_pago: number
  cantidad_pagos: number
  cantidad_no_pagos: number
  cantidad_canceladas: number
  valor_canceladas: number
  pago_efectivo: number
  pago_transferencia: number
  valor_pago_campo: number
  valor_pago_ajuste: number
  valor_ingresos: number
  cantidad_ingresos: number
  valor_gastos: number
  cantidad_gastos: number
  valor_retiros: number
  cantidad_retiros: number
  cantidad_ventas: number
  valor_ventas: number
  valor_ventas_caja: number
  efectivo: number
  caja_anterior: number
  hora_ultimo_movimiento: string | null
}

/** Los totales recalculados acá desde los hechos crudos. */
export interface TotalesCalculados {
  valorPago: number
  cantidadPagos: number
  cantidadNoPagos: number
  valorCampo: number
  valorAjuste: number
  efectivoPagos: number
  transferenciaPagos: number
  gastos: number
  ingresos: number
  retiros: number
  ventas: number
  ventasCaja: number
  meta: number
  /** caja_anterior + ingresos + pagos − ventasCaja − gastos − retiros */
  efectivoCierre: number
}

export interface AuditoriaCierre {
  fecha: string
  ruta: number
  /** null = ese día la ruta no tiene fila en el resumen (nunca abrió). */
  resumen: FilaResumen | null
  jornada: {
    estado: string | null
    hora_inicio: string | null
    hora_fin: string | null
    aprobacion_admin: string | null
  } | null
  clientes: FilaCliente[]
  /** Eventos que NO entran en ningún total: en revisión o rechazados. */
  eventosFuera: EventoCierre[]
  movimientos: MovimientoCierre[]
  ventas: VentaCierre[]
  cuotas: CuotaMeta[]
  totales: TotalesCalculados
}

/** Se lee en lotes: un `.in()` con cientos de UUIDs revienta la URL. */
const LOTE = 120

async function nombresDeLoans(
  loanIds: string[],
): Promise<Map<string, { cliente: string; documento: string | null }>> {
  const mapa = new Map<string, { cliente: string; documento: string | null }>()
  if (loanIds.length === 0) return mapa
  const sb = await getSupabaseSafe()

  for (let i = 0; i < loanIds.length; i += LOTE) {
    const lote = loanIds.slice(i, i + LOTE)
    const { data, error } = await sb
      .from("loans")
      .select("id, clients(nombre_completo, apodo, documento)")
      .in("id", lote)
    if (error) {
      console.error("[v0] auditoria de cierre: nombres:", error.message)
      continue
    }
    for (const fila of (data ?? []) as unknown as {
      id: string
      clients: {
        nombre_completo: string | null
        apodo: string | null
        documento: string | null
      } | null
    }[]) {
      const c = fila.clients
      mapa.set(fila.id, {
        cliente: c?.apodo?.trim() || c?.nombre_completo?.trim() || "Sin nombre",
        documento: c?.documento ?? null,
      })
    }
  }
  return mapa
}

/**
 * Arma la auditoría de un día de una ruta.
 *
 * No lanza por una parte que falle: si los movimientos no cargan, el resto del
 * día igual se puede leer. Una pantalla de auditoría que se cae entera por una
 * consulta no sirve para auditar nada.
 */
export async function cargarAuditoriaCierre(
  ruta: number,
  fecha: string,
): Promise<AuditoriaCierre> {
  const sb = await getSupabaseSafe()

  const desdeUtc = new Date(`${fecha}T00:00:00-05:00`).toISOString()
  const hastaDt = new Date(`${fecha}T00:00:00-05:00`)
  hastaDt.setUTCDate(hastaDt.getUTCDate() + 1)
  const hastaUtc = hastaDt.toISOString()

  const [resResumen, resGes, resMov, resVentas, resCuotas, resJornada] =
    await Promise.all([
      sb
        .from("resumen_diario_v2")
        .select("*")
        .eq("ruta", ruta)
        .eq("fecha_pago", fecha)
        .maybeSingle(),
      sb
        .from("gestiones")
        .select("*")
        .eq("ruta", ruta)
        .eq("fecha_gestion", fecha)
        .order("fecha_hora", { ascending: true }),
      sb
        .from("gastosregistros")
        .select("*")
        .eq("ruta", ruta)
        .gte("fechahorasol", desdeUtc)
        .lt("fechahorasol", hastaUtc)
        .order("fechahorasol", { ascending: true }),
      sb
        .from("loans")
        .select("id, valor, origen, fecha_creacion, clients(nombre_completo, apodo)")
        .eq("ruta", ruta)
        .gte("fecha_creacion", desdeUtc)
        .lt("fecha_creacion", hastaUtc),
      sb
        .from("payment_plan")
        .select("loan_id, valor_cuota, numero_cuota, estado")
        .eq("ruta", ruta)
        .eq("fecha_pago", fecha),
      sb
        .from("rutas_diarias")
        .select("estado, hora_inicio, hora_fin, aprobacion_admin")
        .eq("ruta_id", ruta)
        .eq("fecha", fecha)
        .maybeSingle(),
    ])

  const resumen = (resResumen.data as unknown as FilaResumen | null) ?? null
  const crudas = (resGes.data ?? []) as unknown as Gestion[]

  // ── Los nombres de quien hizo cada evento ────────────────────────────────
  const userIds = [...new Set(crudas.map((g) => g.user_id).filter(Boolean))]
  const usuarios = new Map<string, string>()
  if (userIds.length > 0) {
    const { data } = await sb
      .from("usuarios")
      .select("id, nombre")
      .in("id", userIds as never[])
    for (const u of (data ?? []) as unknown as { id: number | string; nombre: string }[]) {
      usuarios.set(String(u.id), u.nombre)
    }
  }

  // ── El método de una reversa lo hereda del evento que deshace ────────────
  // La referencia puede ser de OTRO día (una reversa de hoy sobre un pago de
  // ayer), así que no alcanza con mirar dentro del día: hay que ir a buscarla.
  const propios = new Map(crudas.map((g) => [g.id, g]))
  const refsFuera = [
    ...new Set(
      crudas
        .map((g) => g.referencia_gestion_id)
        .filter((id): id is string => !!id && !propios.has(id)),
    ),
  ]
  const metodoRef = new Map<string, string | null>()
  for (let i = 0; i < refsFuera.length; i += LOTE) {
    const { data } = await sb
      .from("gestiones")
      .select("id, metodo_pago")
      .in("id", refsFuera.slice(i, i + LOTE))
    for (const r of (data ?? []) as unknown as { id: string; metodo_pago: string | null }[]) {
      metodoRef.set(r.id, r.metodo_pago)
    }
  }

  const mapaNombres = await nombresDeLoans([...new Set(crudas.map((g) => g.loan_id))])

  const enriquecer = (g: Gestion): EventoCierre => {
    const nom = mapaNombres.get(g.loan_id)
    const heredado = g.referencia_gestion_id
      ? propios.get(g.referencia_gestion_id)?.metodo_pago ??
        metodoRef.get(g.referencia_gestion_id) ??
        null
      : null
    return {
      ...g,
      cliente: nom?.cliente ?? "Sin nombre",
      documento: nom?.documento ?? null,
      usuario: g.user_id ? usuarios.get(String(g.user_id)) ?? null : null,
      metodoEfectivo: (g.metodo_pago?.trim() || heredado || "efectivo").toLowerCase(),
      aporte: montoEfectivo(g),
    }
  }

  // ── Lo que el resumen mira, y lo que deja fuera ──────────────────────────
  // La vista exige estado 'aplicada' y origen <> 'homologacion'. Lo demás
  // existe en el libro pero no toca ningún total: se muestra aparte para que
  // nadie lo busque dentro de una cifra donde nunca estuvo.
  const cuentanIds = new Set(
    crudas
      .filter(
        (g) =>
          g.estado === "aplicada" &&
          g.origen !== "homologacion" &&
          TIPOS_DEL_RESUMEN.includes(g.tipo),
      )
      .map((g) => g.id),
  )
  const cuentan = crudas.filter((g) => cuentanIds.has(g.id))
  const fuera = crudas.filter((g) => !cuentanIds.has(g.id))

  const eventosCuentan = cuentan.map(enriquecer)
  const colapsadas = colapsarPorCliente(eventosCuentan)
  const clientes: FilaCliente[] = colapsadas.map((f) => {
    const evs = f.eventos
    const netoCampo = evs.reduce((s, e) => s + (e.origen === "campo" ? e.aporte : 0), 0)
    const efectivo = evs.reduce(
      (s, e) => s + (e.metodoEfectivo === "transferencia" ? 0 : e.aporte),
      0,
    )
    const transferencia = evs.reduce(
      (s, e) => s + (e.metodoEfectivo === "transferencia" ? e.aporte : 0),
      0,
    )
    return {
      loanId: f.loanId,
      cliente: evs[0]?.cliente ?? "Sin nombre",
      documento: evs[0]?.documento ?? null,
      neto: f.neto,
      estado: f.estado,
      netoCampo,
      efectivo,
      transferencia,
      eventos: evs,
      corregido: evs.length > 1,
      hora: f.representante?.fecha_hora ?? null,
    }
  })

  // ── Movimientos de caja ──────────────────────────────────────────────────
  const movimientos: MovimientoCierre[] = (
    (resMov.data ?? []) as unknown as Record<string, unknown>[]
  ).map((m) => ({
    id: Number(m.id),
    tipo: String(m.tipo ?? ""),
    concepto: String(m.concepto ?? ""),
    valor: n(m.valor),
    observacion: (m.observacion as string) ?? null,
    fechahorasol: String(m.fechahorasol ?? ""),
    estadoadmin: String(m.estadoadmin ?? ""),
    estadosecre: String(m.estadosecre ?? ""),
    // El MISMO predicado de la vista, letra por letra.
    cuenta: m.estadosecre === "aprobado" || m.estadoadmin === "NA",
  }))

  const ventas: VentaCierre[] = (
    (resVentas.data ?? []) as unknown as {
      id: string
      valor: unknown
      origen: string | null
      fecha_creacion: string
      clients: { nombre_completo: string | null; apodo: string | null } | null
    }[]
  ).map((v) => ({
    id: v.id,
    cliente: v.clients?.apodo?.trim() || v.clients?.nombre_completo?.trim() || "Sin nombre",
    valor: n(v.valor),
    homologada: (v.origen ?? "normal") === "homologado",
    fechaCreacion: v.fecha_creacion,
  }))

  // ── La meta: lo que el cronograma decía que vencía hoy ───────────────────
  const filasCuota = (resCuotas.data ?? []) as unknown as {
    loan_id: string
    valor_cuota: unknown
    numero_cuota: unknown
    estado: string | null
  }[]
  const nombresCuotas = await nombresDeLoans([
    ...new Set(filasCuota.map((c) => c.loan_id).filter((id) => !mapaNombres.has(id))),
  ])
  // UN CRÉDITO CANCELADO DEJA DE SUMAR EL DÍA DESPUÉS DE CANCELARSE.
  // Es la regla del script 104, y sin ella la meta de la 190 salía 275.200
  // más alta que la que muestra el Resumen: el cronograma de quien terminó
  // de pagar antes de tiempo conserva las cuotas que ya nadie va a pagar.
  // Se cuenta HASTA el día del cierre —no antes— para no reescribir la
  // historia: un crédito cancelado el 3 SÍ era cobrable el 1.
  //
  // El día del cierre sale del LIBRO: el último evento aplicado del crédito.
  const idsCuota = [...new Set(filasCuota.map((c) => c.loan_id))]
  const estadoLoan = new Map<string, string | null>()
  const diaCierre = new Map<string, string>()
  for (let i = 0; i < idsCuota.length; i += LOTE) {
    const lote = idsCuota.slice(i, i + LOTE)
    const [rl, rg] = await Promise.all([
      sb.from("loans").select("id, estado").in("id", lote),
      sb.from("gestiones").select("loan_id, fecha_gestion")
        .in("loan_id", lote).eq("estado", "aplicada"),
    ])
    for (const l of (rl.data ?? []) as unknown as { id: string; estado: string | null }[]) {
      estadoLoan.set(l.id, l.estado)
    }
    for (const g of (rg.data ?? []) as unknown as {
      loan_id: string
      fecha_gestion: string
    }[]) {
      const prev = diaCierre.get(g.loan_id)
      if (!prev || g.fecha_gestion > prev) diaCierre.set(g.loan_id, g.fecha_gestion)
    }
  }

  const pagadoPorLoan = new Map(clientes.map((c) => [c.loanId, c.neto]))
  const cuotas: CuotaMeta[] = filasCuota.map((c) => {
    const cerrado = diaCierre.get(c.loan_id) ?? null
    return {
      loanId: c.loan_id,
      cliente:
        mapaNombres.get(c.loan_id)?.cliente ??
        nombresCuotas.get(c.loan_id)?.cliente ??
        "Sin nombre",
      valorCuota: n(c.valor_cuota),
      numeroCuota: c.numero_cuota == null ? null : Number(c.numero_cuota),
      estado: c.estado,
      pagado: pagadoPorLoan.get(c.loan_id) ?? 0,
      cuentaEnMeta:
        estadoLoan.get(c.loan_id) !== "cancelado" || (!!cerrado && fecha <= cerrado),
    }
  })

  // ── Los totales, recalculados desde los hechos ───────────────────────────
  const valorPago = clientes.reduce((s, c) => s + c.neto, 0)
  // OJO: el campo/ajuste se suma sobre TODOS los eventos que cuentan, NO sobre
  // los clientes colapsados. Es lo que hace el SQL, y la diferencia es real:
  // un cliente que pagó $97.500 en la calle y a quien un ajuste se lo revirtió
  // el mismo día queda en neto cero —así que no aparece como pago— pero SÍ
  // hubo $97.500 de calle y −$97.500 de escritorio ese día. Colapsar primero
  // borraría justamente el movimiento que se quiere auditar.
  const valorCampo = eventosCuentan.reduce(
    (s, e) => s + (e.origen === "campo" ? e.aporte : 0),
    0,
  )
  const suma = (tipo: string) =>
    movimientos.filter((m) => m.cuenta && m.tipo === tipo).reduce((s, m) => s + m.valor, 0)
  const gastos = suma("Gasto")
  const ingresos = suma("Ingreso")
  const retiros = suma("Retiro")
  const ventasCaja = ventas.filter((v) => !v.homologada).reduce((s, v) => s + v.valor, 0)
  const cajaAnterior = n(resumen?.caja_anterior)

  const totales: TotalesCalculados = {
    valorPago,
    cantidadPagos: clientes.filter((c) => c.estado === "pagado").length,
    cantidadNoPagos: clientes.filter((c) => c.estado === "no_pago").length,
    valorCampo,
    valorAjuste: valorPago - valorCampo,
    efectivoPagos: clientes.reduce((s, c) => s + c.efectivo, 0),
    transferenciaPagos: clientes.reduce((s, c) => s + c.transferencia, 0),
    gastos,
    ingresos,
    retiros,
    ventas: ventas.reduce((s, v) => s + v.valor, 0),
    ventasCaja,
    meta: cuotas.reduce((s, c) => s + (c.cuentaEnMeta ? c.valorCuota : 0), 0),
    efectivoCierre: cajaAnterior + ingresos + valorPago - ventasCaja - gastos - retiros,
  }

  return {
    fecha,
    ruta,
    resumen,
    jornada: (resJornada.data as AuditoriaCierre["jornada"]) ?? null,
    clientes,
    eventosFuera: fuera.map(enriquecer),
    movimientos,
    ventas,
    cuotas,
    totales,
  }
}
