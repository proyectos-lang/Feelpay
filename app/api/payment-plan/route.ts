import { NextResponse } from 'next/server'
import { getSupabaseServerClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
} as const

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const loanId = searchParams.get('loan_id')
    const loanIds = searchParams.get('loan_ids') // Comma-separated list of loan IDs
    const rutaId = searchParams.get('ruta')
    const estado = searchParams.get('estado')
    const fechaPago = searchParams.get('fecha_pago')
    
    let query = supabase.from('payment_plan').select('*, loans(*, clients(nombre_completo, apodo, documento))')
    
    if (loanIds) {
      // Support multiple loan IDs in a single request
      const ids = loanIds.split(',').filter(id => id.trim())
      if (ids.length > 0) {
        query = query.in('loan_id', ids)
      }
    } else if (loanId) {
      query = query.eq('loan_id', loanId)
    }
    if (rutaId) {
      query = query.eq('ruta', rutaId)
    }
    if (estado) {
      query = query.eq('estado', estado)
    }
    if (fechaPago) {
      query = query.eq('fecha_pago', fechaPago)
    }
    
    const { data, error } = await query.order('numero_cuota', { ascending: true })
    
    if (error) {
      console.error('[v0] Supabase error fetching payment plan:', error.message || error)
      return NextResponse.json({ error: error.message }, { status: 500, headers: NO_CACHE_HEADERS })
    }
    
    return NextResponse.json(data || [], { headers: NO_CACHE_HEADERS })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[v0] Error fetching payment plan:', errorMessage)
    return NextResponse.json({ error: errorMessage }, { status: 500, headers: NO_CACHE_HEADERS })
  }
}

// PATCH - Update a single payment plan entry (register payment or no-payment)
export async function PATCH(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const body = await request.json()
    const { id, ...updateData } = body
    
    if (!id) {
      return NextResponse.json({ error: 'Payment plan ID is required' }, { status: 400 })
    }
    
    // Convert empty strings and 0 values to null for specific fields that need to be cleared
    const processedData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const [key, value] of Object.entries(updateData)) {
      if (key === 'fecha_pago_real' && (value === '' || value === null)) {
        processedData[key] = null
      } else if (key === 'monto_pagado' && (value === 0 || value === null)) {
        processedData[key] = null
      } else {
        processedData[key] = value
      }
    }
    
    console.log('[v0] PATCH payment_plan - id:', id, 'data:', processedData)
    
    const { data, error } = await supabase
      .from('payment_plan')
      .update(processedData)
      .eq('id', id)
      .select()
      .single()
    
    if (error) {
      console.error('[v0] Supabase error updating payment plan:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    console.log('[v0] PATCH payment_plan - success, result:', data)
    return NextResponse.json(data)
  } catch (error) {
    console.error('[v0] Error updating payment plan:', error)
    return NextResponse.json({ error: 'Failed to update payment plan' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const body = await request.json()
    const { items } = body
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'Invalid payment plan items' }, { status: 400 })
    }
    
    const { data, error } = await supabase
      .from('payment_plan')
      .insert(items)
      .select()
    
    if (error) {
      console.error('[v0] Supabase error creating payment plan:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    return NextResponse.json({ success: true, data })
  } catch (error) {
    console.error('[v0] Error creating payment plan:', error)
    return NextResponse.json({ error: 'Failed to create payment plan' }, { status: 500 })
  }
}
