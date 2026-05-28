-- Create payment plan table
CREATE TABLE IF NOT EXISTS payment_plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  numero_cuota INTEGER NOT NULL,
  fecha_pago DATE NOT NULL,
  valor_cuota DECIMAL(15, 2) NOT NULL,
  capital DECIMAL(15, 2) NOT NULL,
  interes DECIMAL(15, 2) NOT NULL,
  saldo DECIMAL(15, 2) NOT NULL,
  estado VARCHAR(50) DEFAULT 'pendiente',
  fecha_pago_real TIMESTAMP WITH TIME ZONE,
  monto_pagado DECIMAL(15, 2) DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_payment_plan_loan_id ON payment_plan(loan_id);
CREATE INDEX IF NOT EXISTS idx_payment_plan_fecha_pago ON payment_plan(fecha_pago);
CREATE INDEX IF NOT EXISTS idx_payment_plan_estado ON payment_plan(estado);
CREATE INDEX IF NOT EXISTS idx_payment_plan_numero_cuota ON payment_plan(numero_cuota);

-- Disable RLS (Row Level Security)
ALTER TABLE payment_plan DISABLE ROW LEVEL SECURITY;
