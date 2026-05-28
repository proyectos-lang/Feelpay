// Database utility functions for clients, loans, and payment plans.
//
// IMPORTANTE: Historicamente estas funciones llamaban a Route Handlers
// (`/api/clients`, `/api/loans`, `/api/payment-plan`) que a su vez hacian
// fetch hacia Supabase desde el runtime Node. Ese segundo hop fallaba
// intermitentemente con `TypeError: fetch failed` (problema de red entre
// el servidor Next y Supabase) y NO se podia mitigar con retries porque
// el origen del fallo era estable durante ventanas de varios segundos.
//
// Solucion: llamar a Supabase DIRECTAMENTE desde el browser via
// `getSupabaseSafe()` — exactamente como ya lo hace el 95 % del resto de
// la app (loans listing, payments, daily summary, etc.). Asi eliminamos
// el hop server-side roto. RLS fue eliminado; el filtrado por ruta es
// 100% a nivel aplicacion.
import { getSupabaseSafe } from "@/lib/api-helper"

type Client = {
  id?: string
  documento: string
  nombre_completo: string
  apodo?: string
  telefono?: string
  direccion?: string
  cedula_image_url?: string
}

type Loan = {
  id?: string
  client_id: string
  valor: number
  saldo: number
  valor_a_pagar: number
  valor_cuota: number
  tasa_interes: number
  numero_cuotas: number
  tipo_amortizacion: string
  frecuencia_pago: string
  dia_semana?: string
  tipo_venta: string
  prestamo_empleado: boolean
  enrutar_venta?: string
  fecha_primer_pago: string
}

/**
 * Create a new client in the database.
 * Browser → Supabase directo (sin Route Handler intermedio).
 */
export async function createClient(client: Client): Promise<{ id: string } | null> {
  try {
    const supabase = await getSupabaseSafe()
    const { data, error } = await supabase
      .from("clients")
      .insert([client])
      .select("id")
      .single()

    if (error) {
      console.error("[v0] Supabase error creating client:", error)
      return null
    }
    return data as { id: string }
  } catch (error) {
    console.error("[v0] Error creating client:", error)
    return null
  }
}

/**
 * Create a new loan in the database.
 * Browser → Supabase directo (sin Route Handler intermedio).
 */
export async function createLoan(loan: Loan): Promise<{ id: string } | null> {
  try {
    console.log("[v0] Attempting to create loan with data:", loan)
    const supabase = await getSupabaseSafe()
    const { data, error } = await supabase
      .from("loans")
      .insert([loan])
      .select("id")
      .single()

    if (error) {
      console.error("[v0] Supabase error creating loan:", error)
      return null
    }
    console.log("[v0] Loan created successfully:", data)
    return data as { id: string }
  } catch (error) {
    console.error("[v0] Error creating loan:", error)
    return null
  }
}

// NOTA: La funcion `createPaymentPlan` que insertaba filas en `payment_plan`
// directamente desde el frontend fue eliminada. La creacion de cuotas se
// hace EXCLUSIVAMENTE via el RPC atomico `crear_venta_atomica` (al crear
// venta) y `EditSaleDialog` (al editar venta, dentro de su transaccion
// DELETE+INSERT). El flujo de pago NUNCA debe insertar en `payment_plan`;
// solo el RPC `registrar_pago_atomico` actualiza filas existentes.

/**
 * Get all clients (with optional search filter)
 */
export async function getClients(search?: string) {
  try {
    const url = search ? `/api/clients?search=${encodeURIComponent(search)}` : '/api/clients'
    const response = await fetch(url)
    
    if (!response.ok) {
      throw new Error('Failed to fetch clients')
    }
    
    return await response.json()
  } catch (error) {
    console.error('[v0] Error fetching clients:', error)
    return []
  }
}

/**
 * Get client by ID
 */
export async function getClientById(id: string) {
  try {
    const response = await fetch(`/api/clients/${id}`)
    
    if (!response.ok) {
      throw new Error('Failed to fetch client')
    }
    
    return await response.json()
  } catch (error) {
    console.error('[v0] Error fetching client:', error)
    return null
  }
}

/**
 * Get loans for a client
 */
export async function getLoansByClientId(clientId: string) {
  try {
    const response = await fetch(`/api/loans?client_id=${clientId}`)
    
    if (!response.ok) {
      throw new Error('Failed to fetch loans')
    }
    
    return await response.json()
  } catch (error) {
    console.error('[v0] Error fetching loans:', error)
    return []
  }
}

/**
 * Get payment plan for a loan
 */
export async function getPaymentPlanByLoanId(loanId: string) {
  try {
    const response = await fetch(`/api/payment-plan?loan_id=${loanId}`)
    
    if (!response.ok) {
      throw new Error('Failed to fetch payment plan')
    }
    
    return await response.json()
  } catch (error) {
    console.error('[v0] Error fetching payment plan:', error)
    return []
  }
}
