import { NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'

// Asegurar que el route handler NUNCA sea cacheado por Next.js o por la
// edge. Cada llamada GET tiene que ejecutar la query contra Supabase.
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

// Headers comunes para evitar cache HTTP en navegador / CDN
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
} as const

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const clientId = searchParams.get('client_id')
    const rutaId = searchParams.get('ruta')
    const estado = searchParams.get('estado')

    let query = supabase.from('loans').select('*, clients(nombre_completo, apodo, documento)')

    if (clientId) {
      query = query.eq('client_id', clientId)
    }
    if (rutaId) {
      query = query.eq('ruta', rutaId)
    }
    if (estado) {
      query = query.eq('estado', estado)
    }

    const { data, error } = await query.order('ordenvisita', { ascending: true })

    if (error) {
      // Antes devolviamos 200/[] silenciosamente lo que ocultaba fallos reales
      // como "no se encontraron clientes activos" cuando en realidad la consulta
      // habia fallado por RLS o por error transitorio. Ahora respondemos con
      // 500 para que el cliente pueda mostrar un error real / reintentar.
      console.error('[v0] Supabase error fetching loans:', error.message || error)
      return NextResponse.json(
        { error: error.message || 'Error fetching loans' },
        { status: 500, headers: NO_CACHE_HEADERS },
      )
    }

    return NextResponse.json(data || [], { headers: NO_CACHE_HEADERS })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[v0] Error fetching loans:', errorMessage)
    return NextResponse.json(
      { error: errorMessage },
      { status: 500, headers: NO_CACHE_HEADERS },
    )
  }
}

// PATCH - Update loan fields (saldo, estado, etc.)
export async function PATCH(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const body = await request.json()
    const { id, ...updateData } = body
    
    if (!id) {
      return NextResponse.json({ error: 'Loan ID is required' }, { status: 400 })
    }
    
    const { data, error } = await supabase
      .from('loans')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()
    
    if (error) {
      console.error('[v0] Supabase error updating loan:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json(data)
  } catch (error) {
    console.error('[v0] Error updating loan:', error)
    return NextResponse.json({ error: 'Failed to update loan' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const body = await request.json()
    console.log('[v0] Received loan data:', body)
    
    const { data, error } = await supabase
      .from('loans')
      .insert([body])
      .select()
      .single()
    
    if (error) {
      console.error('[v0] Supabase error creating loan:', error)
      console.error('[v0] Supabase error details:', JSON.stringify(error, null, 2))
      return NextResponse.json({ error: error.message, details: error }, { status: 500 })
    }
    
    console.log('[v0] Loan created in Supabase:', data)
    return NextResponse.json(data)
  } catch (error) {
    console.error('[v0] Error creating loan:', error)
    return NextResponse.json({ error: 'Failed to create loan' }, { status: 500 })
  }
}
