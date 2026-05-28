"use client"

import { useEffect, useState } from "react"

interface LoginSplashProps {
  /** Called once the splash animation completes (default ~2200ms) */
  onComplete: () => void
  /** Optional user name to greet during transition */
  userName?: string
  /** Total duration in ms (default 2200) */
  duration?: number
}

/**
 * Pantalla de transicion mostrada tras un login exitoso.
 *
 * Caracteristicas:
 *  - Fondo con degradado intenso azul → teal (paleta del logo OPAD)
 *  - Orbes flotantes con blur que se mueven en bucle
 *  - Lineas de brillo diagonales en bucle (shimmer)
 *  - Logo con entrada (scale + fade) + flotacion sutil y anillo pulsante
 *  - Saludo personalizado y subtitulo con fade-in escalonado
 *  - Auto-dismiss con fade-out al finalizar
 */
export function LoginSplash({ onComplete, userName, duration = 2200 }: LoginSplashProps) {
  const [phase, setPhase] = useState<"in" | "out">("in")

  useEffect(() => {
    // Empezamos el fade-out 500ms antes del onComplete para una salida suave
    const fadeOutTimer = setTimeout(() => setPhase("out"), Math.max(0, duration - 500))
    const completeTimer = setTimeout(() => onComplete(), duration)
    return () => {
      clearTimeout(fadeOutTimer)
      clearTimeout(completeTimer)
    }
  }, [duration, onComplete])

  const firstName = userName?.trim().split(/\s+/)[0] ?? ""

  return (
    <>
      {/* Keyframes locales — sin dependencias externas */}
      <style jsx>{`
        @keyframes opadFloat {
          0%, 100% { transform: translateY(0) }
          50% { transform: translateY(-12px) }
        }
        @keyframes opadPulseRing {
          0%, 100% { transform: scale(1); opacity: 0.45 }
          50% { transform: scale(1.18); opacity: 0 }
        }
        @keyframes opadOrbA {
          0%, 100% { transform: translate(0, 0) scale(1) }
          50% { transform: translate(40px, -30px) scale(1.1) }
        }
        @keyframes opadOrbB {
          0%, 100% { transform: translate(0, 0) scale(1) }
          50% { transform: translate(-50px, 40px) scale(1.15) }
        }
        @keyframes opadOrbC {
          0%, 100% { transform: translate(0, 0) scale(1) }
          50% { transform: translate(30px, 50px) scale(0.92) }
        }
        @keyframes opadShimmer {
          0% { transform: translateX(-100%) rotate(15deg) }
          100% { transform: translateX(200%) rotate(15deg) }
        }
        @keyframes opadLogoIn {
          0% { transform: scale(0.6) rotate(-6deg); opacity: 0 }
          60% { transform: scale(1.06) rotate(2deg); opacity: 1 }
          100% { transform: scale(1) rotate(0deg); opacity: 1 }
        }
        @keyframes opadFadeUp {
          0% { transform: translateY(14px); opacity: 0 }
          100% { transform: translateY(0); opacity: 1 }
        }
        @keyframes opadProgress {
          0% { transform: translateX(-100%) }
          100% { transform: translateX(100%) }
        }
        @keyframes opadGradientShift {
          0%, 100% { background-position: 0% 50% }
          50% { background-position: 100% 50% }
        }
      `}</style>

      <div
        role="status"
        aria-live="polite"
        aria-label="Iniciando sesion"
        className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden transition-opacity duration-500"
        style={{
          opacity: phase === "out" ? 0 : 1,
          background:
            "linear-gradient(135deg, #0E2A56 0%, #163970 25%, #2870BC 55%, #3FA89E 85%, #6EC2A7 100%)",
          backgroundSize: "200% 200%",
          animation: "opadGradientShift 6s ease-in-out infinite",
        }}
      >
        {/* Orbes flotantes con blur — capa decorativa */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 -left-20 h-[420px] w-[420px] rounded-full opacity-50 blur-3xl"
          style={{
            background: "radial-gradient(circle, #6EC2A7 0%, transparent 70%)",
            animation: "opadOrbA 5s ease-in-out infinite",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/4 -right-24 h-[480px] w-[480px] rounded-full opacity-45 blur-3xl"
          style={{
            background: "radial-gradient(circle, #5BB5E0 0%, transparent 70%)",
            animation: "opadOrbB 7s ease-in-out infinite",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 left-1/3 h-[520px] w-[520px] rounded-full opacity-40 blur-3xl"
          style={{
            background: "radial-gradient(circle, #2870BC 0%, transparent 70%)",
            animation: "opadOrbC 8s ease-in-out infinite",
          }}
        />

        {/* Linea de brillo diagonal — shimmer */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <div
            className="absolute -top-1/2 left-0 h-[200%] w-1/3"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)",
              animation: "opadShimmer 3.5s ease-in-out infinite",
            }}
          />
        </div>

        {/* Contenido central */}
        <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
          {/* Logo con anillo pulsante y flotacion */}
          <div className="relative">
            {/* Anillos pulsantes */}
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-3xl bg-white/30"
              style={{ animation: "opadPulseRing 2.2s ease-out infinite" }}
            />
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-3xl bg-white/20"
              style={{ animation: "opadPulseRing 2.2s ease-out 0.7s infinite" }}
            />

            {/* Contenedor del logo con entrada animada y flotacion en bucle */}
            <div
              className="relative flex h-32 w-32 items-center justify-center rounded-3xl bg-white p-3 ring-4 ring-white/30 md:h-40 md:w-40"
              style={{
                animation:
                  "opadLogoIn 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) both, opadFloat 3.5s ease-in-out 0.9s infinite",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/opad-logo.png"
                alt="OPAD APP"
                className="h-full w-full object-contain"
              />
            </div>
          </div>

          {/* Saludo */}
          <div className="flex flex-col items-center gap-2">
            <h1
              className="text-3xl font-extrabold tracking-tight text-white drop-shadow-sm md:text-4xl"
              style={{ animation: "opadFadeUp 0.6s ease-out 0.4s both" }}
            >
              {firstName ? `Hola, ${firstName}` : "Bienvenido"}
            </h1>
            <p
              className="text-sm font-medium text-white/85 md:text-base"
              style={{ animation: "opadFadeUp 0.6s ease-out 0.7s both" }}
            >
              Estamos preparando tu espacio en OPAD APP...
            </p>
          </div>

          {/* Barra de progreso indeterminada */}
          <div
            className="mt-2 h-1 w-48 overflow-hidden rounded-full bg-white/20 md:w-64"
            style={{ animation: "opadFadeUp 0.6s ease-out 1s both" }}
          >
            <div
              className="h-full w-1/3 rounded-full bg-white"
              style={{ animation: "opadProgress 1.4s ease-in-out infinite" }}
            />
          </div>
        </div>
      </div>
    </>
  )
}
