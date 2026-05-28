-- Create clients table
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento VARCHAR(50) NOT NULL UNIQUE,
  nombre_completo VARCHAR(255) NOT NULL,
  apodo VARCHAR(100),
  telefono VARCHAR(20),
  direccion TEXT,
  cedula_image_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on documento for faster lookups
CREATE INDEX IF NOT EXISTS idx_clients_documento ON clients(documento);

-- Create index on apodo for search functionality
CREATE INDEX IF NOT EXISTS idx_clients_apodo ON clients(apodo);

-- Disable RLS (Row Level Security)
ALTER TABLE clients DISABLE ROW LEVEL SECURITY;
