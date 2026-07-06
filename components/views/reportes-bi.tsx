"use client"

import { useState } from "react"
import { BarChart2 } from "lucide-react"

const BI_REPORTS = [
  {
    id: "recaudos",
    label: "Recaudos",
    title: "Reporte de Recaudos",
    src: "https://app.powerbi.com/view?r=eyJrIjoiOWQzMGE0OWYtMmM0NS00ODQ0LTkyODUtMDcwYzczNDc4ZDliIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9",
  },
  {
    id: "betty",
    label: "Betty",
    title: "INFORME INVERTRAI GERENCIAL BETTY",
    src: "https://app.powerbi.com/view?r=eyJrIjoiZGE3YmZjODQtMDE5MS00MTUxLWE1YzctYTQ4MjFmMGI4OGJmIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9",
  },
  {
    id: "betty2",
    label: "Betty 2",
    title: "INFORME INVERTRAI GERENCIAL BETTY2",
    src: "https://app.powerbi.com/view?r=eyJrIjoiODUxMDUzYzgtYzZmMy00MzdmLTliMjAtNDBhODQ3NTVhNzg5IiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9",
  },
  {
    id: "kevin",
    label: "Kevin",
    title: "INFORME INVERTRAI KEVIN",
    src: "https://app.powerbi.com/view?r=eyJrIjoiMTcyMDQ3ZDQtZjI4YS00MDhjLWE4N2MtMDJmMjgzOGZkOTVhIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9",
  },
  {
    id: "mayela",
    label: "Mayela",
    title: "INFORME INVERTRAI MAYELA",
    src: "https://app.powerbi.com/view?r=eyJrIjoiMTcyMDQ3ZDQtZjI4YS00MDhjLWE4N2MtMDJmMjgzOGZkOTVhIiwidCI6Ijk2YWMwMjE3LTc4OTEtNGNmYy05MjExLTM5MTEyNThjMmMwMyIsImMiOjR9",
  },
] as const

type BiReportId = (typeof BI_REPORTS)[number]["id"]

export function ReportesBi() {
  const [activeId, setActiveId] = useState<BiReportId>("recaudos")
  const active = BI_REPORTS.find((r) => r.id === activeId)!

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

      {/* Sub-pestañas */}
      <div className="flex gap-1 overflow-x-auto border-b" style={{ scrollbarWidth: "none" }}>
        {BI_REPORTS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveId(id)}
            className={`shrink-0 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              activeId === id
                ? "border-brand text-brand"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Iframe activo */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <BarChart2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-semibold text-sm truncate">{active.title}</span>
        </div>
        <div className="relative w-full" style={{ paddingBottom: "62.5%" }}>
          <iframe
            key={activeId}
            title={active.title}
            src={active.src}
            className="absolute inset-0 w-full h-full"
            frameBorder={0}
            allowFullScreen
          />
        </div>
      </div>
    </div>
  )
}
