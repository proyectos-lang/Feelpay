import { NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const ruta = searchParams.get('ruta') || '1'

    // SOLO los prestamos activos.
    //
    // Sin este filtro, "Ordenar Ruta" listaba tambien los cancelados: en la
    // 190 salian 46 clientes cuando la ruta tiene 42, y los cuatro de mas ya
    // no se visitan. Acomodar la ruta obligaba a saltarselos a ojo, y ademas
    // ocupaban numeros de orden.
    //
    // `loans.estado` solo vale 'activo' o 'cancelado' — verificado sobre las
    // siete rutas de la base — asi que esto es exactamente "los que se van a
    // visitar", el mismo conjunto que muestra la lista de cobro.
    const { data, error } = await supabase
      .from('loans')
      .select('id, valor_cuota, frecuencia_pago, ordenvisita, client_id, clients(nombre_completo, apodo)')
      .eq('ruta', parseInt(ruta))
      .eq('estado', 'activo')
      .order('ordenvisita', { ascending: true, nullsFirst: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data || [])
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch route loans' }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const body = await request.json()
    const { items } = body

    if (!items || !Array.isArray(items)) {
      return NextResponse.json({ error: 'Invalid items' }, { status: 400 })
    }

    // Update each loan's ordenvisita
    const updates = items.map((item: { id: string; ordenvisita: number }) =>
      supabase
        .from('loans')
        .update({ ordenvisita: item.ordenvisita })
        .eq('id', item.id)
    )

    const results = await Promise.all(updates)
    const errors = results.filter(r => r.error)

    if (errors.length > 0) {
      return NextResponse.json({ error: 'Some updates failed' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }
}
