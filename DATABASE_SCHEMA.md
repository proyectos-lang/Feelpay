# Database Schema — Feelpay

> Supabase (PostgreSQL). RLS deshabilitado en todas las tablas — el filtrado es 100% a nivel app.

---

## Tablas principales

### `usuarios`
| Columna | Tipo | Descripción |
|---|---|---|
| `id` | BIGSERIAL PK | Identificador único |
| `usuario` | TEXT | Nombre de usuario (login) |
| `nombre` | TEXT | Nombre completo |
| `password` | TEXT | Contraseña (hash) |
| `rol` | TEXT | Rol: `vendedor`, `asesor`, `secretaria`, `secretario`, `gerencia`, `admin`, `administrador`, `liquidador`, `socioadmin` |
| `activo` | BOOLEAN | Si el usuario está activo |
| `acceso_modulo_reporte` | BOOLEAN | Flag legacy para acceso a reportes |

### `rutas`
| Columna | Tipo | Descripción |
|---|---|---|
| `id` | BIGSERIAL PK | Identificador único |
| `nombre` | TEXT | Nombre de la ruta |
| `ciudad` | TEXT | Ciudad (nullable) |
| `pais` | TEXT | País (nullable) |

### `usuario_rutas`
Asignación N:M entre usuarios y rutas.

| Columna | Tipo | Descripción |
|---|---|---|
| `usuario_id` | BIGINT FK → usuarios.id | |
| `ruta_id` | BIGINT FK → rutas.id | |

### `rutas_diarias`
Estado diario de cada ruta (abierta/cerrada).

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | |
| `ruta_id` | BIGINT | |
| `fecha` | DATE | YYYY-MM-DD en zona Bogotá |
| `estado` | TEXT | `abierta` \| `cerrada` |

### `clientes`
Ver `scripts/001-create-clients-table.sql`.

### `prestamos`
Ver `scripts/002-create-loans-table.sql`.

### `plan_pagos`
Ver `scripts/003-create-payment-plan-table.sql`.

### `push_subscriptions`
Suscripciones Web Push por usuario/rol.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | BIGINT | |
| `rol` | TEXT | Canal de push (admin, secretaria, gerencia, socioadmin) |
| `endpoint` | TEXT | URL del endpoint de push |
| `p256dh` | TEXT | Clave pública |
| `auth` | TEXT | Token de autenticación |
| `created_at` | TIMESTAMPTZ | |

---

## `user_permissions`
> Creada en `scripts/011-user-permissions.sql`.

Permisos individuales de módulos por usuario. Si no hay filas para un `user_id`, se usan los defaults del rol (sin cambios al comportamiento actual).

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | BIGINT | FK lógica → usuarios.id |
| `view_id` | TEXT | ID del módulo (ver catálogo en `lib/modules-catalog.ts`) |
| `enabled` | BOOLEAN | Si el módulo es visible para el usuario |
| `in_mobile_nav` | BOOLEAN | Si aparece en la barra inferior del móvil (máx. 5 por usuario) |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Constraint:** `UNIQUE(user_id, view_id)` — una fila por usuario por módulo.

**Semántica:**
- Sin filas para `user_id` → comportamiento por rol (defaults hardcodeados)
- Con filas → solo se muestran los `view_id` con `enabled = true`
- `in_mobile_nav = true` → aparece en la barra inferior (máx. 5 activos simultáneamente)

---

## Funciones RPC

### `registrar_pago_atomico(p_user_id, p_ruta_id, p_rol, p_payload)`
Ver `scripts/010-fn-registrar-pago-atomico.sql`. Registra pagos de forma atómica.

---

## Catálogo de módulos (`lib/modules-catalog.ts`)

Fuente canónica de todos los módulos de la app. Cada entrada define:
- `viewId`: ID del módulo (mismo que se usa en `user_permissions.view_id` y `renderView()` en `app/page.tsx`)
- `defaultRoles`: roles que tienen acceso por defecto
- `defaultMobileNavRoles`: roles para los que el módulo aparece en la bottom nav por defecto

### Cómo agregar un nuevo módulo al sistema de permisos

1. Agregar el `case` en `renderView()` de `app/page.tsx`
2. Agregar el item al `navGroup` correspondiente en `components/sidebar.tsx`
3. Agregar al array de items correspondiente en `components/mobile-bottom-nav.tsx` (si aplica)
4. Agregar la entrada en `ALL_MODULES` de `lib/modules-catalog.ts` con el mismo `viewId`
5. El sistema de permisos en `user_permissions` lo reconoce automáticamente por `view_id`
