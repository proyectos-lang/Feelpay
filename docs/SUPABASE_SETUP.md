# Configuración de Supabase para FEELPAY

## Variables de Entorno

Copia el archivo `.env.local.example` a `.env.local` y asegúrate de que las variables estén configuradas:

```env
NEXT_PUBLIC_SUPABASE_URL=https://dfvicmnsnuoxoanbuddp.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=tu_anon_key
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
```

## Uso de los Clientes

### Cliente del Navegador (Client Components)

```typescript
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

export function MyClientComponent() {
  const supabase = getSupabaseBrowserClient()
  
  // Usar el cliente de Supabase
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
}
```

### Cliente del Servidor (Server Components)

```typescript
import { getSupabaseServerClient } from '@/lib/supabase/server'

export async function MyServerComponent() {
  const supabase = await getSupabaseServerClient()
  
  // Usar el cliente de Supabase
  const { data, error } = await supabase
    .from('clientes')
    .select('*')
}
```

### Server Actions

```typescript
'use server'

import { getSupabaseServerClient } from '@/lib/supabase/server'

export async function createClient(formData: FormData) {
  const supabase = await getSupabaseServerClient()
  
  const { data, error } = await supabase
    .from('clientes')
    .insert({
      nombre: formData.get('nombre'),
      // ...
    })
    
  return { data, error }
}
```

## Autenticación

Para usar Supabase Auth:

```typescript
// Sign Up
const { data, error } = await supabase.auth.signUp({
  email: 'usuario@ejemplo.com',
  password: 'contraseña',
})

// Sign In
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'usuario@ejemplo.com',
  password: 'contraseña',
})

// Sign Out
const { error } = await supabase.auth.signOut()

// Get Current User
const { data: { user } } = await supabase.auth.getUser()
```

## Middleware

El middleware está configurado para actualizar automáticamente las sesiones de usuario en cada request. Esto mantiene las sesiones activas y actualizadas.

## Seguridad

- **NUNCA** expongas `SUPABASE_SERVICE_ROLE_KEY` al cliente
- Solo usa `NEXT_PUBLIC_SUPABASE_ANON_KEY` para el cliente
- Usa Row Level Security (RLS) en tus tablas de Supabase para proteger los datos
