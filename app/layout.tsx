import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { SwRegister } from '@/components/sw-register'
import './globals.css'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

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
    <html lang="es" className="bg-background">
      <body className="font-sans antialiased bg-background text-foreground">
        <SwRegister />
        {children}
        <Analytics />
      </body>
    </html>
  )
}
