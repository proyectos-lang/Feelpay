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

## El núcleo: cronograma, libro de eventos y estado derivado
Reestructuración de agosto 2026 (scripts 041–049). **Es la regla que gobierna todo lo relacionado con plata.**

- **`payment_plan` = el cronograma pactado.** `fecha_pago` es el VENCIMIENTO y no se pisa nunca. Sus columnas `estado` y `monto_pagado` son un **cache** que escribe únicamente `recalcular_prestamo()`; nadie más las toca.
- **`gestiones` = el libro de eventos, INSERT-only.** Un evento por visita o movimiento: `pago`, `no_pago`, `cancelacion`, `abono_venta`, `extension`, `ajuste`, `reversa`. Un trigger prohíbe borrar y solo permite la transición `en_revision → aplicada|rechazada`. Corregir algo = registrar una **reversa** + el evento nuevo.
- **`fecha_gestion`** es el día de negocio al que aplica el evento. "Gestionado el día D" = existe evento aplicado con esa fecha. Una gestión retro es simplemente `fecha_gestion = ayer`.
- **Todo lo financiero se deriva**: `v_pagos_netos` → `v_cobertura_cuotas` (cascada de la plata sobre las cuotas) → `v_loan_financiero` (saldo, saldo de hoy, mora, X/Y). El resumen del día es `resumen_diario_v2`.
- **Una sola puerta de escritura**: `registrar_gestion`. Nunca falla en silencio ni pierde plata: si algo no cuadra el evento entra igual como `en_revision`. La cuota que manda el cliente es una **pista**, no un requisito.
- `registrar_pago_atomico` sobrevive **solo como adapter** de payloads viejos (colas offline capturadas antes del corte).
- **`payment_plan.fecha_pago_real` ya no se escribe** — la hora y el día reales viven en `gestiones.fecha_hora` / `fecha_gestion`.
- Cliente: `lib/gestion-core.ts` es el único lugar donde viven las fechas Colombia, los predicados de estado, las bandas de mora y las definiciones de métricas. `lib/loan-schedule.ts` es espejo de la función SQL `generar_cronograma` y sirve **solo para vista previa** — el plan que se guarda lo genera el servidor.

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
En `scripts/`, numerados y acumulativos: **el número más alto que define un objeto es el que manda**.
El dueño los corre a mano en el editor de Supabase, así que cada script va en pasos numerados de UNA sentencia, idempotentes y con un paso de verificación de solo lectura.

- `000-tablas-preexistentes.sql` — DDL de las tablas creadas fuera del repo (documentación)
- `041` fundamentos · `042` tabla `gestiones` · `043` vistas derivadas + `recalcular_prestamo`
- `044` `registrar_gestion` + aprobación + adapter · `045` cronograma y ventas (incluye homologación)
- `046` editor de secretaría · `047` multas server-side · `048` resumen v2 + auditoría 360
- `049` el corte (borra préstamos y planes; la ceremonia completa está en su encabezado)

## Convenciones
- Prefijo `[v0]` en todos los `console.log/error/warn` del servidor y cliente.
- No usar `SUPABASE_SERVICE_ROLE_KEY` en el cliente browser nunca.
- Cada query debe filtrar por `ruta_id` (o `ruta`) — no hay RLS que lo haga automáticamente.
- `getSupabaseSafe()` valida presencia de sesión en localStorage antes de devolver el cliente.
- Nunca escribir `payment_plan.estado` / `monto_pagado` ni `loans.saldo` desde la app: son derivados.
- Toda escritura de plata pasa por un evento del libro. Nada se borra ni se edita: se reversa.
