import { put } from '@vercel/blob'
import { type NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File
    const folderPath = formData.get('folder') as string || 'gastos'

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Create a unique filename
    const timestamp = Date.now()
    const filename = `${folderPath}/${timestamp}_${file.name}`

    // Upload to Vercel Blob
    const blob = await put(filename, file, {
      access: 'public',
    })

    return NextResponse.json({
      success: true,
      url: blob.url,
      filename: file.name,
      size: file.size,
    })
  } catch (error) {
    console.error('[v0] Upload error:', error)
    return NextResponse.json({ 
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed' 
    }, { status: 500 })
  }
}
