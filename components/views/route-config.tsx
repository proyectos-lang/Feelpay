import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export function RouteConfig() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-card-foreground">Configuración de Rutas</h2>

      <div className="grid gap-6 md:grid-cols-[300px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Rutas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Button variant="outline" className="w-full justify-start">
                Ruta 1
              </Button>
              <Button variant="outline" className="w-full justify-start">
                Ruta 2
              </Button>
              <Button variant="outline" className="w-full justify-start">
                Ruta 3
              </Button>
              <Button className="w-full">+ Nueva Ruta</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuración de Ruta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="routeName">Nombre de la Ruta</Label>
              <Input id="routeName" placeholder="Ingrese nombre de la ruta" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="loanLimit">Límite de Monto de Préstamo</Label>
              <Input id="loanLimit" placeholder="0.00" type="number" step="0.01" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="interestLimit">Límite de Tasa de Interés (%)</Label>
              <Input id="interestLimit" placeholder="0.00" type="number" step="0.01" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="authSystem">Habilitar Sistema de Autorización</Label>
                <p className="text-sm text-muted-foreground">
                  Requiere aprobación para préstamos que excedan los límites
                </p>
              </div>
              <Switch id="authSystem" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="renewalCode">Requerir Código para Renovación</Label>
                <p className="text-sm text-muted-foreground">
                  Los usuarios necesitarán un código para renovar préstamos
                </p>
              </div>
              <Switch id="renewalCode" />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline">Cancelar</Button>
              <Button>Guardar Configuración</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
