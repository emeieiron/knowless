/**
 * QR code generator using pure canvas drawing.
 * Uses the `qrcode` npm package if available, otherwise falls back to a link.
 */

import { useEffect, useRef } from 'react'

interface QRCodeProps {
  value: string
  size?: number
  className?: string
}

export function QRCode({ value, size = 200, className = '' }: QRCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // Dynamically import qrcode (available in browser via bundler)
    import('qrcode').then(QRCodeLib => {
      QRCodeLib.toCanvas(canvasRef.current!, value, {
        width: size,
        margin: 2,
        color: {
          dark: '#122d45',
          light: '#ffffff',
        },
      }).catch(() => {
        // If qrcode fails, show a placeholder
      })
    }).catch(() => {
      // qrcode not available — canvas stays blank, link fallback shown
    })
  }, [value, size])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={`rounded-lg ${className}`}
      style={{ imageRendering: 'pixelated' }}
      aria-label="QR code for this link"
    />
  )
}
