import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export function RegisterIncome() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-card-foreground">Registrar Ingreso</h2>

      <Card>
        <CardHeader>
          <CardTitle>Información del Ingreso</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="incomeItem">Item de Ingreso</Label>
            <Select>
              <SelectTrigger id="incomeItem">
                <SelectValue placeholder="Seleccione un item" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="payment">Pago de Préstamo</SelectItem>
                <SelectItem value="interest">Intereses</SelectItem>
                <SelectItem value="other">Otro</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="incomeAmount">Monto</Label>
              <Input id="incomeAmount" placeholder="0.00" type="number" step="0.01" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="incomeDate">Fecha</Label>
              <Input id="incomeDate" type="date" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="incomeDescription">Descripción</Label>
            <Textarea id="incomeDescription" placeholder="Descripción del ingreso..." />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline">Cancelar</Button>
            <Button>Guardar Ingreso</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
