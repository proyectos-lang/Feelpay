import { NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')
    const ruta = searchParams.get('ruta')
    const sinPrestamoActivo = searchParams.get('sin_prestamo_activo')

    let query = supabase.from('clients').select('id, nombre_completo, apodo, documento, tiene_prestamo_activo')

    if (ruta) {
      query = query.eq('ruta', ruta)
    }
    if (search) {
      query = query.ilike('apodo', `%${search}%`)
    }
    if (sinPrestamoActivo === 'true') {
      query = query.eq('tiene_prestamo_activo', false)
    }

    const { data, error } = await query.order('apodo', { ascending: true })

    if (error) {
      console.error('[v0] Supabase error fetching clients:', error.message || error)
      return NextResponse.json([], { status: 200 })
    }

    return NextResponse.json(data || [])
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[v0] Error fetching clients:', errorMessage)
    // Return empty array on error to prevent client-side JSON parse errors
    return NextResponse.json([], { status: 200 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const body = await request.json()

    // ── Retry para fallos transitorios de red (TypeError: fetch failed) ──
    //
    // En logs producción aparece intermitentemente `TypeError: fetch failed`
    // cuando este Route Handler hace el fetch interno hacia Supabase. La
    // causa son cortes de red puntuales (DNS, TLS handshake, keep-alive
    // cerrado por el peer). Reintentar 2 veces con backoff lineal de
    // 300 ms / 700 ms resuelve la gran mayoría de casos sin afectar a
    // las requests sanas (que pasan en el primer intento sin overhead).
    // Helper para detectar mensajes de error transitorios de red.
    // supabase-js a veces LANZA (throw) la excepción y a veces la devuelve
    // como objeto `{ error }` con `message: "fetch failed"` — hay que
    // manejar ambos caminos.
    const isTransientMessage = (msg: string) =>
      msg.includes('fetch failed') ||
      msg.includes('FetchError') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('EAI_AGAIN') ||
      msg.includes('socket hang up') ||
      msg.includes('network')

    const MAX_ATTEMPTS = 3
    let lastTransientMsg: string | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { data, error } = await supabase
          .from('clients')
          .insert([body])
          .select()
          .single()

        if (error) {
          const msg = error.message || String(error)
          // Si supabase-js devolvió un error transitorio de red en el campo
          // `error` (sin lanzarlo), también lo reintentamos. Es el caso
          // observado en los logs: `Supabase error creating client: TypeError: fetch failed`
          // venía por aquí y abortaba sin retry.
          if (isTransientMessage(msg)) {
            lastTransientMsg = msg
            if (attempt < MAX_ATTEMPTS) {
              console.warn(
                `[v0] createClient transient supabase error (attempt ${attempt}/${MAX_ATTEMPTS}):`,
                msg,
              )
              await new Promise((r) => setTimeout(r, attempt === 1 ? 300 : 700))
              continue
            }
            // Agotados los reintentos: devolver 503 con mensaje legible.
            console.error('[v0] Supabase error creating client (final, transient):', msg)
            return NextResponse.json(
              { error: 'Network error talking to database. Please retry.' },
              { status: 503 },
            )
          }
          // Error real de Postgres / RLS / validación: NO reintentar.
          console.error('[v0] Supabase error creating client:', error)
          return NextResponse.json({ error: msg }, { status: 500 })
        }

        return NextResponse.json(data)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Errores lanzados por la capa fetch antes de que supabase-js
        // pueda envolverlos en `{ error }`.
        if (isTransientMessage(msg) && attempt < MAX_ATTEMPTS) {
          lastTransientMsg = msg
          console.warn(
            `[v0] createClient transient fetch error (attempt ${attempt}/${MAX_ATTEMPTS}):`,
            msg,
          )
          await new Promise((r) => setTimeout(r, attempt === 1 ? 300 : 700))
          continue
        }
        throw err
      }
    }
    // Solo se alcanza si todos los intentos cayeron en `continue` transitorio
    // y no entraron en el `if (attempt < MAX_ATTEMPTS)` final. Defensivo.
    return NextResponse.json(
      { error: 'Network error talking to database. Please retry.', detail: lastTransientMsg },
      { status: 503 },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[v0] Error creating client:', msg)
    return NextResponse.json(
      { error: msg.includes('fetch failed') ? 'Network error talking to database. Please retry.' : 'Failed to create client' },
      { status: 503 },
    )
  }
}

// PATCH - Update a single client (e.g., set tiene_prestamo_activo)
export async function PATCH(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const body = await request.json()
    const { id, ...updateData } = body

    if (!id) {
      return NextResponse.json({ error: 'Client ID is required' }, { status: 400 })
    }

    console.log('[v0] PATCH clients - id:', id, 'data:', updateData)

    const { data, error } = await supabase
      .from('clients')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('[v0] Supabase error updating client:', error.message || error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[v0] Error updating client:', errorMessage)
    return NextResponse.json({ error: 'Failed to update client' }, { status: 500 })
  }
}
