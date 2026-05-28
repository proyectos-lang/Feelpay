import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Plus } from 'lucide-react'

export function ManageProfiles() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-card-foreground">Gestionar Perfiles/Roles</h2>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          Crear Nuevo Perfil
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Perfiles del Sistema</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre del Perfil</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Usuarios Asignados</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  No se encontraron perfiles
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
