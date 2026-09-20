"use client"

import { useId } from "react"

/**
 * components/bandera.tsx
 * ---------------------------------------------------------------------------
 * LA BANDERA DE UN PAÍS, DIBUJADA A MANO.
 *
 * Primero se intentó con emoji (🇦🇷). Se ve bien en el teléfono, pero el
 * Chrome de Windows —donde se revisa esta pantalla— los pinta como dos letras
 * sueltas: "AR", "US". Y no es solo un problema de quien revisa: cualquiera
 * que abra la app desde un PC con Windows vería lo mismo.
 *
 * Así que van en SVG. Son cuatro banderas de franjas —cuatro rectángulos y un
 * círculo— así que el dibujo es trivial, pesa nada, no pide red y se ve igual
 * en todos lados.
 *
 * Solo están los países donde hay rutas. Para cualquier otro se cae a un
 * círculo con el código de la moneda, que informa aunque no decore.
 */

interface Props {
  /** Código ISO de la moneda: 'ARS', 'USD', 'COP', 'PYG'… */
  moneda: string | null | undefined
  /** Lado del círculo, en píxeles. */
  size?: number
  className?: string
}

export function Bandera({ moneda, size = 20, className = "" }: Props) {
  const cod = (moneda ?? "").trim().toUpperCase()
  // El id del recorte tiene que ser UNICO por instancia: en esta pantalla hay
  // dos banderas a la vez y con el mismo id las dos usarian el primer
  // clipPath del documento. `useId` da uno distinto a cada una.
  const uid = useId().replace(/:/g, "")
  const circ = `circ-${uid}`
  const comun = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    className: `shrink-0 rounded-full ${className}`,
  }

  // Cada bandera se recorta a un círculo con `clipPath`, que es lo que da el
  // "contorno circular" que se pidió.
  const recorte = (
    <clipPath id={circ}>
      <circle cx="12" cy="12" r="12" />
    </clipPath>
  )

  if (cod === "ARS") {
    return (
      <svg {...comun} aria-label="Argentina">
        <defs>{recorte}</defs>
        <g clipPath={`url(#${circ})`}>
          <rect width="24" height="24" fill="#fff" />
          <rect width="24" height="8" fill="#74ACDF" />
          <rect y="16" width="24" height="8" fill="#74ACDF" />
          <circle cx="12" cy="12" r="2.6" fill="#F6B40E" />
        </g>
      </svg>
    )
  }

  if (cod === "USD") {
    return (
      <svg {...comun} aria-label="Estados Unidos">
        <defs>{recorte}</defs>
        <g clipPath={`url(#${circ})`}>
          <rect width="24" height="24" fill="#fff" />
          {[0, 2, 4, 6, 8, 10].map((i) => (
            <rect key={i} y={i * 2 + 1.85} width="24" height="1.85" fill="#B22234" />
          ))}
          <rect width="11" height="13" fill="#3C3B6E" />
        </g>
      </svg>
    )
  }

  if (cod === "COP") {
    return (
      <svg {...comun} aria-label="Colombia">
        <defs>{recorte}</defs>
        <g clipPath={`url(#${circ})`}>
          <rect width="24" height="12" fill="#FCD116" />
          <rect y="12" width="24" height="6" fill="#003893" />
          <rect y="18" width="24" height="6" fill="#CE1126" />
        </g>
      </svg>
    )
  }

  if (cod === "PYG") {
    return (
      <svg {...comun} aria-label="Paraguay">
        <defs>{recorte}</defs>
        <g clipPath={`url(#${circ})`}>
          <rect width="24" height="8" fill="#D52B1E" />
          <rect y="8" width="24" height="8" fill="#fff" />
          <rect y="16" width="24" height="8" fill="#0038A8" />
          <circle cx="12" cy="12" r="2.4" fill="#fff" stroke="#0038A8" strokeWidth="0.5" />
        </g>
      </svg>
    )
  }

  // Sin bandera dibujada: el código de la moneda dentro del mismo círculo.
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-bold text-muted-foreground ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-label={cod || "sin país"}
    >
      {cod.slice(0, 2) || "—"}
    </span>
  )
}
