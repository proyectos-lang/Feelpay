import type { Metadata } from 'next'
import { Geist, Geist_Mono, Nunito_Sans } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { SwRegister } from '@/components/sw-register'
import { Toaster } from '@/components/ui/toaster'
import './globals.css'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });
// La tipografía del Detalle de Ruta (ver components/views/detalle-ruta.css).
// Va como variable CSS para que solo la use esa vista.
const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-nunito-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: 'OPAD APP',
  description: 'OPAD APP — Plataforma de gestión de cobranzas y rutas',
  generator: 'v0.app',
  manifest: '/manifest.json',
  icons: {
    icon: '/opad-logo.png',
    apple: '/opad-logo.png',
  },
}

export const viewport = {
  themeColor: '#163970',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="es" className={`bg-background ${nunitoSans.variable}`}>
      <body className="font-sans antialiased bg-background text-foreground">
        <SwRegister />
        {children}
        <Toaster />
        <Analytics />
      </body>
    </html>
  )
}
