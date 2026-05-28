"use client"

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Search, Plus, Eye } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'

interface Client {
  id: string
  documento: string
  nombre_completo: string
  apodo?: string
  telefono?: string
  direccion?: string
  cedula_image_url?: string
  created_at: string
  updated_at: string
}

export function ViewClients() {
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const { toast } = useToast()

  useEffect(() => {
    fetchClients()
  }, [])

  const fetchClients = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/clients')
      
      if (!response.ok) {
        throw new Error('Error al cargar clientes')
      }
      
      const data = await response.json()
      console.log('[v0] Clients loaded:', data)
      setClients(data)
    } catch (error) {
      console.error('[v0] Error fetching clients:', error)
      toast({
        title: 'Error',
        description: 'No se pudieron cargar los clientes',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const filteredClients = clients.filter((client) => {
    const search = searchTerm.toLowerCase()
    return (
      client.nombre_completo.toLowerCase().includes(search) ||
      client.apodo?.toLowerCase().includes(search) ||
      client.documento.includes(search) ||
      client.telefono?.includes(search)
    )
  })

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl md:text-2xl font-bold text-card-foreground">Clientes</h2>
        <Button className="gap-2 h-8 md:h-10 text-xs md:text-sm">
          <Plus className="h-4 w-4" />
          Nuevo Cliente
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input 
                placeholder="Buscar por nombre, apodo, documento o teléfono..." 
                className="pl-9 h-8 md:h-10 text-xs md:text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <Button 
              variant="outline" 
              size="sm"
              onClick={fetchClients}
              className="h-8 md:h-10 text-xs md:text-sm"
            >
              Actualizar
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-32 flex items-center justify-center text-muted-foreground">
              Cargando clientes...
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs md:text-sm">Documento</TableHead>
                    <TableHead className="text-xs md:text-sm">Nombre Completo</TableHead>
                    <TableHead className="text-xs md:text-sm">Apodo</TableHead>
                    <TableHead className="text-xs md:text-sm">Teléfono</TableHead>
                    <TableHead className="text-xs md:text-sm">Dirección</TableHead>
                    <TableHead className="text-xs md:text-sm">Registro</TableHead>
                    <TableHead className="text-right text-xs md:text-sm">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredClients.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-32 text-center text-muted-foreground text-xs md:text-sm">
                        {searchTerm ? 'No se encontraron clientes con ese criterio de búsqueda' : 'No hay clientes registrados'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredClients.map((client) => (
                      <TableRow key={client.id}>
                        <TableCell className="font-medium text-xs md:text-sm">{client.documento}</TableCell>
                        <TableCell className="text-xs md:text-sm">{client.nombre_completo}</TableCell>
                        <TableCell className="text-xs md:text-sm">
                          {client.apodo ? (
                            <Badge variant="secondary" className="text-xs">
                              {client.apodo}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs md:text-sm">{client.telefono || '-'}</TableCell>
                        <TableCell className="text-xs md:text-sm max-w-[200px] truncate" title={client.direccion}>
                          {client.direccion || '-'}
                        </TableCell>
                        <TableCell className="text-xs md:text-sm">
                          {new Date(client.created_at).toLocaleDateString('es-CO')}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                            <Eye className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {!loading && filteredClients.length > 0 && (
        <div className="text-xs md:text-sm text-muted-foreground text-center">
          Mostrando {filteredClients.length} de {clients.length} cliente(s)
        </div>
      )}
    </div>
  )
}
