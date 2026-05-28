import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function NewClient() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-card-foreground">Nuevo Cliente</h2>

      <Card>
        <CardHeader>
          <CardTitle>Información del Cliente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="firstName">Nombre</Label>
              <Input id="firstName" placeholder="Ingrese el nombre" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Apellido</Label>
              <Input id="lastName" placeholder="Ingrese el apellido" />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="phone">Teléfono</Label>
              <Input id="phone" placeholder="Ingrese el teléfono" type="tel" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Correo Electrónico</Label>
              <Input id="email" placeholder="Ingrese el correo" type="email" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">Dirección</Label>
            <Textarea id="address" placeholder="Ingrese la dirección completa" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="route">Ruta</Label>
              <Select>
                <SelectTrigger id="route">
                  <SelectValue placeholder="Seleccione una ruta" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="route1">Ruta 1</SelectItem>
                  <SelectItem value="route2">Ruta 2</SelectItem>
                  <SelectItem value="route3">Ruta 3</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="referencePoint">Punto de Referencia</Label>
              <Input id="referencePoint" placeholder="Ingrese punto de referencia" />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline">Cancelar</Button>
            <Button>Guardar Cliente</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
