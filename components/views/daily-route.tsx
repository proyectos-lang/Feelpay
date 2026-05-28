'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { GripVertical, CheckCircle, XCircle, Clock } from 'lucide-react'

export function DailyRoute() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-card-foreground">Ruta Diaria</h2>

      <Card>
        <CardHeader>
          <CardTitle>Clientes para Hoy</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {/* Example empty state */}
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              No hay clientes programados para hoy
            </div>

            {/* Example of what items would look like */}
            <div className="hidden space-y-3">
              <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
                <GripVertical className="h-5 w-5 cursor-grab text-muted-foreground" />
                <div className="flex-1">
                  <h3 className="font-semibold">Juan Pérez</h3>
                  <p className="text-sm text-muted-foreground">Cuota: $50.00</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="gap-1" variant="default">
                    <CheckCircle className="h-4 w-4" />
                    Pagar
                  </Button>
                  <Button size="sm" className="gap-1" variant="destructive">
                    <XCircle className="h-4 w-4" />
                    No Pagó
                  </Button>
                  <Button size="sm" className="gap-1" variant="outline">
                    <Clock className="h-4 w-4" />
                    Después
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
