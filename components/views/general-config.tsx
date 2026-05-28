import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function GeneralConfig() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-card-foreground">Configuración General</h2>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Información de la Empresa</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="companyName">Nombre de la Empresa</Label>
                <Input id="companyName" defaultValue="FEELPAY" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="companyPhone">Teléfono</Label>
                <Input id="companyPhone" type="tel" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="companyAddress">Dirección</Label>
              <Input id="companyAddress" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Configuración del Sistema</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="currency">Moneda</Label>
              <Select defaultValue="usd">
                <SelectTrigger id="currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="usd">USD - Dólar</SelectItem>
                  <SelectItem value="eur">EUR - Euro</SelectItem>
                  <SelectItem value="mxn">MXN - Peso Mexicano</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="notifications">Habilitar Notificaciones</Label>
                <p className="text-sm text-muted-foreground">
                  Enviar notificaciones por correo electrónico
                </p>
              </div>
              <Switch id="notifications" />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="autoBackup">Respaldo Automático</Label>
                <p className="text-sm text-muted-foreground">
                  Crear respaldos automáticos de los datos
                </p>
              </div>
              <Switch id="autoBackup" />
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
