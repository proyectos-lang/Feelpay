"use client"

import { useEffect, useMemo, useRef } from "react"
import { MapContainer, TileLayer, Marker, Popup, Polyline, Tooltip, useMap } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

export type MapPoint = {
  id: string
  lat: number
  lng: number
  estado: "pagado" | "no_pago" | "parcial" | "cancelada" | string
  cliente: string
  monto: number
  hora: string
  orden: number
}

interface AdminRouteMonitorMapProps {
  points: MapPoint[]
}

/**
 * Builds a small divIcon with a colored circle + numeric label for ordering.
 */
function buildMarkerIcon(color: string, label: number) {
  return L.divIcon({
    className: "admin-route-marker",
    html: `
      <div style="
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: ${color};
        color: white;
        font-weight: 700;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid white;
        box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      ">${label}</div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  })
}

/**
 * Ensures the map re-centers whenever the points change.
 */
function FitBoundsToPoints({ points }: { points: MapPoint[] }) {
  const map = useMap()
  useEffect(() => {
    if (!points.length) return
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 })
  }, [points, map])
  return null
}

export default function AdminRouteMonitorMap({ points }: AdminRouteMonitorMapProps) {
  const center = useMemo<[number, number]>(() => {
    if (points.length > 0) return [points[0].lat, points[0].lng]
    // Default center (Bogotá, Colombia)
    return [4.711, -74.0721]
  }, [points])

  const polylinePositions = useMemo<[number, number][]>(
    () => points.map((p) => [p.lat, p.lng] as [number, number]),
    [points],
  )

  const mapRef = useRef<L.Map | null>(null)

  const getColor = (estado: string) => {
    if (estado === "pagado" || estado === "parcial" || estado === "cancelada") return "#10b981" // green
    if (estado === "no_pago") return "#ef4444" // red
    return "#64748b" // slate (fallback)
  }

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl shadow-steel">
      <MapContainer
        center={center}
        zoom={14}
        scrollWheelZoom
        className="h-full w-full"
        ref={(instance) => {
          if (instance) mapRef.current = instance
        }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {polylinePositions.length > 1 && (
          <Polyline
            positions={polylinePositions}
            pathOptions={{ color: "#2f6690", weight: 4, opacity: 0.7, dashArray: "6, 8" }}
          />
        )}

        {points.map((p, idx) => {
          const color = getColor(p.estado)
          const isSinPago = p.estado === "no_pago"
          return (
          <Marker
            key={p.id}
            position={[p.lat, p.lng]}
            icon={buildMarkerIcon(color, idx + 1)}
          >
            {/* Amount label permanently visible next to the marker */}
            <Tooltip
              permanent
              direction="right"
              offset={[12, 0]}
              className="admin-route-amount-tooltip"
            >
              <span
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  borderRadius: "9999px",
                  background: "white",
                  color: color,
                  border: `1.5px solid ${color}`,
                  fontWeight: 700,
                  fontSize: "12px",
                  lineHeight: "1.2",
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
                }}
              >
                {isSinPago ? "Sin pago" : `$${p.monto.toLocaleString()}`}
              </span>
            </Tooltip>
            <Popup>
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-foreground">{p.cliente}</p>
                <p className="text-muted-foreground">
                  Orden: <span className="font-medium text-foreground">#{idx + 1}</span>
                </p>
                <p className="text-muted-foreground">
                  Monto:{" "}
                  <span className="font-medium text-foreground">
                    ${p.monto.toLocaleString()}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  Hora: <span className="font-medium text-foreground">{p.hora || "—"}</span>
                </p>
                <p className="text-muted-foreground">
                  Estado:{" "}
                  <span
                    className="font-semibold"
                    style={{ color: getColor(p.estado) }}
                  >
                    {p.estado}
                  </span>
                </p>
                <a
                  href={`https://www.google.com/maps?q=${p.lat},${p.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    marginTop: "6px",
                    padding: "4px 10px",
                    borderRadius: "6px",
                    background: "#1a73e8",
                    color: "white",
                    fontWeight: 600,
                    fontSize: "12px",
                    textDecoration: "none",
                  }}
                >
                  📍 Ubicar en Google Maps
                </a>
              </div>
            </Popup>
          </Marker>
          )
        })}

        <FitBoundsToPoints points={points} />
      </MapContainer>
    </div>
  )
}
