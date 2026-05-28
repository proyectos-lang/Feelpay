import { NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase/server"

export async function GET(request: Request) {
  try {
    const supabase = await getSupabaseServerClient()
    const { searchParams } = new URL(request.url)
    const loanId = searchParams.get("loan_id")

    if (!loanId) {
      return NextResponse.json({ error: "loan_id is required" }, { status: 400 })
    }

    // Get saldo_pendiente from saldo_prestamos_clientes table
    const { data: saldoData, error: saldoError } = await supabase
      .from("saldo_prestamos_clientes")
      .select("saldo_pendiente")
      .eq("loan_id", loanId)
      .single()

    if (saldoError) {
      // Fallback: calculate from loans table if not found in saldo_prestamos_clientes
      const { data: loan, error: loanError } = await supabase
        .from("loans")
        .select("saldo, valor")
        .eq("id", loanId)
        .single()

      if (loanError || !loan) {
        return NextResponse.json({ error: "Loan not found" }, { status: 404 })
      }

      return NextResponse.json({
        saldo: loan.saldo ?? 0,
        valor: loan.valor,
      })
    }

    // Get loan valor for reference
    const { data: loan } = await supabase
      .from("loans")
      .select("valor")
      .eq("id", loanId)
      .single()

    return NextResponse.json({
      saldo: saldoData.saldo_pendiente ?? 0,
      valor: loan?.valor ?? 0,
    })
  } catch (error) {
    return NextResponse.json({ error: "Failed to calculate saldo" }, { status: 500 })
  }
}
