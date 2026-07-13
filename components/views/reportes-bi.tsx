"use client"

import { useEffect, useState } from "react"
import { BarChart2, Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import type { AuthenticatedUser } from "./login-view"

type BiReporte = {
  id: string
  nombre: string
  url: string
  created_at: string
}

interface ReportesBiProps {
  currentUser: AuthenticatedUser
}

export function ReportesBi({ currentUser }: ReportesBiProps) {
  const [reportes, setReportes] = useState<BiReporte[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    createClient()
      .from("bi_reporte_permisos")
      .select("bi_reportes(id, nombre, url, created_at)")
      .eq("user_id", currentUser.id)
      .then(({ data }: { data: { bi_reportes: BiReporte | null }[] | null }) => {
        const rows = (data ?? [])
          .map((r) => r.bi_reportes)
          .filter((r): r is BiReporte => !!r)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
        setReportes(rows)
        setActiveId(rows[0]?.id ?? null)
        setLoading(false)
      })
  }, [currentUser.id])

  const active = reportes.find((r) => r.id === activeId)

  return (
    <div className="space-y-4">
      {/* Encabezado */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-border overflow-hidden p-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opad-logo.png" alt="OPAD" className="h-full w-full object-contain" />
        </div>
        <div>
          <h2 className="text-base md:text-lg font-bold leading-tight">Reportes Power BI</h2>
          <p className="text-[11px] text-muted-foreground">Dashboards gerenciales</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : reportes.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
          <BarChart2 className="h-8 w-8 opacity-30" />
          <p className="text-sm">No tienes reportes asignados aún</p>
        </div>
      ) : (
        <>
          {/* Sub-pestañas */}
          <div className="flex gap-1 overflow-x-auto border-b" style={{ scrollbarWidth: "none" }}>
            {reportes.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setActiveId(r.id)}
                className={`shrink-0 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                  activeId === r.id
                    ? "border-brand text-brand"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.nombre}
              </button>
            ))}
          </div>

          {/* Iframe activo */}
          {active && (
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b">
                <BarChart2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-semibold text-sm truncate">{active.nombre}</span>
              </div>
              <div className="relative w-full" style={{ paddingBottom: "62.5%" }}>
                <iframe
                  key={active.id}
                  title={active.nombre}
                  src={active.url}
                  className="absolute inset-0 w-full h-full"
                  frameBorder={0}
                  allowFullScreen
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
