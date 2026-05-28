import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const loanId = searchParams.get("loan_id")
    const loanIds = searchParams.get("loan_ids") // Comma-separated list

    let query = supabase.from("v_loan_mora_status").select("loan_id, dias_mora_calculada")

    if (loanIds) {
      const ids = loanIds.split(",").filter((id) => id.trim())
      if (ids.length > 0) {
        query = query.in("loan_id", ids)
      }
    } else if (loanId) {
      query = query.eq("loan_id", loanId)
    }

    const { data, error } = await query

    if (error) {
      console.error("[v0] Supabase error fetching mora status:", error.message || error)
      return NextResponse.json({ error: error.message }, { status: 500, headers: NO_CACHE_HEADERS })
    }

    return NextResponse.json(data || [], { headers: NO_CACHE_HEADERS })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[v0] Error fetching mora status:", errorMessage)
    return NextResponse.json({ error: errorMessage }, { status: 500, headers: NO_CACHE_HEADERS })
  }
}
