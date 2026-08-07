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

// NOTA: los handlers PATCH y POST fueron eliminados (auditoria agosto
// 2026): no tenian ningun caller en la app y permitian modificar/crear
// prestamos con columnas arbitrarias sin validacion. La creacion de
// ventas pasa EXCLUSIVAMENTE por la RPC atomica `crear_venta_atomica` y
// las actualizaciones de saldo/estado por `registrar_pago_atomico`.
