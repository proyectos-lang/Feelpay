import { createBrowserClient } from "@supabase/ssr"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Singleton: Create client immediately on module load to avoid race conditions
const supabaseClient = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  isSingleton: true,
})

export function getSupabaseBrowserClient() {
  return supabaseClient
}

export const createClient = getSupabaseBrowserClient
