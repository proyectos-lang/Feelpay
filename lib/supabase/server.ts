import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Singleton instance for server-side usage
let supabaseInstance: ReturnType<typeof createClient> | null = null

function getSupabaseInstance() {
  if (!supabaseInstance) {
    supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  }
  return supabaseInstance
}

export async function getSupabaseServerClient() {
  return getSupabaseInstance()
}

// Alias para compatibilidad
export const getSupabaseServer = getSupabaseServerClient
