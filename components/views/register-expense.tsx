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

export function RegisterExpense() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-card-foreground">Registrar Gasto</h2>

      <Card>
        <CardHeader>
          <CardTitle>Información del Gasto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="expenseItem">Item de Gasto</Label>
            <Select>
              <SelectTrigger id="expenseItem">
                <SelectValue placeholder="Seleccione un item" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="transport">Transporte</SelectItem>
                <SelectItem value="office">Oficina</SelectItem>
                <SelectItem value="marketing">Marketing</SelectItem>
                <SelectItem value="other">Otro</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="expenseAmount">Monto</Label>
              <Input id="expenseAmount" placeholder="0.00" type="number" step="0.01" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="expenseDate">Fecha</Label>
              <Input id="expenseDate" type="date" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expenseDescription">Descripción</Label>
            <Textarea id="expenseDescription" placeholder="Descripción del gasto..." />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline">Cancelar</Button>
            <Button>Guardar Gasto</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
