# Feelpay — CLAUDE.md

## Proyecto
Aplicación web de gestión de préstamos y cobranzas (rutas). Construida con Next.js 16 + React 19 + TypeScript + Tailwind v4 + Supabase + shadcn/ui.

## Stack
- **Framework**: Next.js 16 (App Router), React 19
- **Estilos**: Tailwind v4 + shadcn/ui (components.json en raíz)
- **Base de datos**: Supabase (PostgreSQL). RLS eliminado — el filtrado por ruta es 100% a nivel app.
- **Auth**: Custom (tabla `users` en Supabase, sin Supabase Auth). Sesión en localStorage (`currentUser`, `selectedRuta`).
- **Paquetes destacados**: `@supabase/ssr`, `@vercel/blob`, `openai`, `recharts`, `react-leaflet`, `jspdf`, `react-hook-form` + `zod`
- **Package manager**: pnpm

## Arquitectura clave
- **Un solo SPA**: `app/page.tsx` contiene toda la lógica de routing de vistas (sin Next.js routes para el dashboard). Los cambios de vista son `setCurrentView()`.
- **Cliente Supabase**: singleton browser (`lib/supabase/client.ts`). Server-side usa `lib/supabase/server.ts` (también anon key, sin service role).
- **Sesión**: `localStorage.currentUser` (usuario) + `localStorage.selectedRuta` (ruta). Helpers en `lib/api-helper.ts` — `getSupabaseSafe()`, `getSessionIdentity()`, `callRpcAtomic()`.
- **RPCs atómicas**: escrituras críticas (pagos, creación de ventas) usan `callRpcAtomic()` → funciones PostgreSQL con firma `(p_user_id, p_ruta_id, p_rol, p_payload)`.
- **API routes** (`app/api/`): solo para operaciones server-side (escaneo cédula con GPT-4o, upload fotos a Vercel Blob). Las lecturas de datos van directo browser → Supabase.

## Variables de entorno
Ver `.env.local`. Las críticas:
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` — conexión Supabase (tienen fallback hardcoded)
- `OPENAI_API_KEY` — requerida para `/api/escanear-cedula`
- `BLOB_READ_WRITE_TOKEN` — requerida para `/api/upload-photo`

## Comandos
```bash
pnpm dev      # desarrollo local
pnpm build    # build producción
pnpm lint     # eslint
```

## Scripts SQL
Los scripts de base de datos están en `scripts/`:
- `001-create-clients-table.sql`
- `002-create-loans-table.sql`
- `003-create-payment-plan-table.sql`
- `010-fn-registrar-pago-atomico.sql` — función RPC principal de pagos

## Convenciones
- Prefijo `[v0]` en todos los `console.log/error/warn` del servidor y cliente.
- No usar `SUPABASE_SERVICE_ROLE_KEY` en el cliente browser nunca.
- Cada query debe filtrar por `ruta_id` (o `ruta`) — no hay RLS que lo haga automáticamente.
- `getSupabaseSafe()` valida presencia de sesión en localStorage antes de devolver el cliente.
