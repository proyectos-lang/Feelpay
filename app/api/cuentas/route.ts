import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/server"

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const ruta = searchParams.get("ruta")

    let query = supabase.from("cuentas").select("id, nombre")

    if (ruta) {
      query = query.eq("ruta", ruta)
    }

    const { data, error } = await query.order("nombre", { ascending: true })

    if (error) {
      console.error("[v0] Error fetching cuentas:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data || [])
  } catch (error) {
    console.error("[v0] Error fetching cuentas:", error)
    return NextResponse.json({ error: "Failed to fetch cuentas" }, { status: 500 })
  }
}
