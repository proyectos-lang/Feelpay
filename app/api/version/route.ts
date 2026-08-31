import { NextResponse } from "next/server"

/**
 * Qué versión de la app está publicada AHORA MISMO en el servidor.
 *
 * POR QUÉ HACE FALTA
 * La app es una sola página: se abre por la mañana y no se vuelve a cargar en
 * todo el día. Cuando se despliega algo a las nueve, el teléfono que lleva
 * abierto desde las siete sigue corriendo el paquete viejo hasta que alguien
 * recargue — y nadie recarga una app que "ya está abierta". Eso fue lo que le
 * pasó a David: trabajó el día entero con la versión de la mañana.
 *
 * El service worker no lo resuelve: `sw.js` solo cambia cuando cambia SU
 * contenido, así que un despliegue normal no dispara ningún `updatefound`.
 * Hace falta preguntar por la versión de la APP, y eso solo lo sabe el
 * servidor.
 *
 * `force-dynamic` es obligatorio: si Next la deja estática, la respuesta se
 * congela en el build y siempre diría la versión vieja — justo el problema que
 * viene a resolver.
 */
export const dynamic = "force-dynamic"
export const revalidate = 0

export function GET() {
  return NextResponse.json(
    {
      // En Vercel es el commit desplegado. En local no existe y queda "dev",
      // que nunca cambia: en desarrollo no hay nada que avisar.
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
      desplegado: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  )
}
