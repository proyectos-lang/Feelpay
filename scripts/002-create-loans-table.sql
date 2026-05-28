-- Create loans table
CREATE TABLE IF NOT EXISTS loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  valor DECIMAL(15, 2) NOT NULL,
  saldo DECIMAL(15, 2) NOT NULL,
  valor_a_pagar DECIMAL(15, 2) NOT NULL,
  valor_cuota DECIMAL(15, 2) NOT NULL,
  tasa_interes DECIMAL(5, 2) NOT NULL,
  numero_cuotas INTEGER NOT NULL,
  tipo_amortizacion VARCHAR(50) NOT NULL,
  frecuencia_pago VARCHAR(50) NOT NULL,
  dia_semana VARCHAR(20),
  tipo_venta VARCHAR(50) DEFAULT 'efectivo',
  prestamo_empleado BOOLEAN DEFAULT false,
  enrutar_venta UUID REFERENCES clients(id),
  estado VARCHAR(50) DEFAULT 'activo',
  fecha_creacion TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  fecha_primer_pago DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_loans_client_id ON loans(client_id);
CREATE INDEX IF NOT EXISTS idx_loans_estado ON loans(estado);
CREATE INDEX IF NOT EXISTS idx_loans_fecha_creacion ON loans(fecha_creacion);

-- Disable RLS (Row Level Security)
ALTER TABLE loans DISABLE ROW LEVEL SECURITY;
