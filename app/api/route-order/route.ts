import { NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const ruta = searchParams.get('ruta') || '1'

    const { data, error } = await supabase
      .from('loans')
      .select('id, valor_cuota, frecuencia_pago, ordenvisita, client_id, clients(nombre_completo, apodo)')
      .eq('ruta', parseInt(ruta))
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
