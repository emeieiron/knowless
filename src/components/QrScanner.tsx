/**
 * QrScanner — live camera viewfinder using jsQR.
 *
 * - Requests rear camera (facingMode ideal environment), video-only, muted, playsInline.
 * - Captures at most 640px on the longest side; decodes at most once per 100 ms.
 * - Accepts HAVE_CURRENT_DATA readyState or better.
 * - Tries both normal and inverted QR codes (inversionAttempts: 'attemptBoth').
 * - Calls onScan(text): return true = accepted (camera stops), false = keep scanning.
 * - Stops all tracks and the frame loop on: accepted scan, unmount, or manual entry.
 * - A getUserMedia promise resolving after unmount/manual-stop has its tracks stopped immediately.
 * - Play failure: stops tracks and shows a camera-unavailable message with manual fallback.
 * - Canvas/decode errors are caught; loop does not die silently.
 * - NEVER logs or stores QR text payloads.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import jsQR from 'jsqr'

interface QrScannerProps {
  /** Called with raw QR text. Return true to accept (camera stops), false to keep scanning. */
  onScan: (text: string) => boolean
  /** Called when the user taps "Enter address instead". Camera is stopped before calling. */
  onManualEntry: () => void
}

const MAX_DIM = 640
const DECODE_INTERVAL_MS = 100

export function QrScanner({ onScan, onManualEntry }: QrScannerProps) {
  const videoRef     = useRef<HTMLVideoElement>(null)
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const streamRef    = useRef<MediaStream | null>(null)
  const rafRef       = useRef<number | null>(null)
  const stoppedRef   = useRef(false)       // set before any stopCamera path (incl. manual)
  const lastDecodeRef = useRef(0)
  const onScanRef    = useRef(onScan)

  // Keep onScanRef current without letting onScan change trigger the camera effect.
  useEffect(() => { onScanRef.current = onScan }, [onScan])

  const [cameraError, setCameraError] = useState<string | null>(null)

  const stopCamera = useCallback(() => {
    stoppedRef.current = true
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) { videoRef.current.srcObject = null }
  }, [])

  const handleManual = useCallback(() => {
    stopCamera()
    onManualEntry()
  }, [stopCamera, onManualEntry])

  useEffect(() => {
    stoppedRef.current = false
    let active = true

    if (!navigator?.mediaDevices?.getUserMedia) {
      setCameraError('Camera not supported in this browser. Use "Enter address instead".')
      return
    }

    const tick = (now: number) => {
      if (!active || stoppedRef.current) return
      const video  = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      // Throttle decode cadence
      if (now - lastDecodeRef.current >= DECODE_INTERVAL_MS) {
        lastDecodeRef.current = now
        try {
          const vw = video.videoWidth
          const vh = video.videoHeight
          if (vw > 0 && vh > 0) {
            const scale = Math.min(1, MAX_DIM / Math.max(vw, vh))
            const w = Math.round(vw * scale)
            const h = Math.round(vh * scale)
            canvas.width  = w
            canvas.height = h
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            if (ctx) {
              ctx.drawImage(video, 0, 0, w, h)
              const imageData = ctx.getImageData(0, 0, w, h)
              const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'attemptBoth',
              })
              if (code) {
                const accepted = onScanRef.current(code.data)
                if (accepted) { stopCamera(); return }
              }
            }
          }
        } catch {
          // canvas/decode error — keep scanning
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    }).then(stream => {
      if (!active || stoppedRef.current) {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      streamRef.current = stream
      const video = videoRef.current
      if (!video) { stream.getTracks().forEach(t => t.stop()); return }
      video.srcObject = stream
      video.play().then(() => {
        if (!active || stoppedRef.current) return
        rafRef.current = requestAnimationFrame(tick)
      }).catch(() => {
        if (!active || stoppedRef.current) return
        stopCamera()
        setCameraError('Camera could not start playback. Use "Enter address instead".')
      })
    }).catch((e: unknown) => {
      if (!active || stoppedRef.current) return
      const name = (e instanceof Error ? e.name : '')
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraError('Camera access denied. Tap "Enter address instead" to type the recipient.')
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setCameraError('No camera found on this device. Use "Enter address instead".')
      } else {
        setCameraError('Camera unavailable. Use "Enter address instead".')
      }
    })

    return () => { active = false; stopCamera() }
  }, [stopCamera])

  return (
    <div className="flex flex-col items-center w-full gap-4">
      {cameraError ? (
        <div className="w-full rounded-2xl flex flex-col items-center justify-center gap-3 py-10 px-6 text-center"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', minHeight: '260px' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden style={{ color: 'var(--muted)' }}>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
          <p className="text-sm" style={{ color: 'var(--muted)' }} role="alert" aria-live="polite">
            {cameraError}
          </p>
        </div>
      ) : (
        <div className="relative w-full overflow-hidden rounded-2xl"
          style={{ background: '#000', aspectRatio: '1 / 1', maxWidth: '360px', alignSelf: 'center' }}>
          <video
            ref={videoRef}
            playsInline muted
            className="absolute inset-0 w-full h-full object-cover"
            aria-label="Camera viewfinder"
          />
          <canvas ref={canvasRef} className="hidden" aria-hidden />
          <div className="absolute inset-0 pointer-events-none" aria-hidden>
            {(['tl','tr','bl','br'] as const).map(corner => (
              <span key={corner} className="absolute w-8 h-8"
                style={{
                  top:    corner.startsWith('t') ? '12px' : undefined,
                  bottom: corner.startsWith('b') ? '12px' : undefined,
                  left:   corner.endsWith('l')   ? '12px' : undefined,
                  right:  corner.endsWith('r')   ? '12px' : undefined,
                  borderColor: 'rgba(255,255,255,0.7)',
                  borderTopWidth:    corner.startsWith('t') ? '3px' : 0,
                  borderBottomWidth: corner.startsWith('b') ? '3px' : 0,
                  borderLeftWidth:   corner.endsWith('l')   ? '3px' : 0,
                  borderRightWidth:  corner.endsWith('r')   ? '3px' : 0,
                  borderStyle: 'solid',
                  borderRadius:
                    corner === 'tl' ? '6px 0 0 0' :
                    corner === 'tr' ? '0 6px 0 0' :
                    corner === 'bl' ? '0 0 0 6px' : '0 0 6px 0',
                }} />
            ))}
          </div>
        </div>
      )}

      {!cameraError && (
        <p className="text-sm text-center" style={{ color: 'var(--muted)' }}>
          Scan a payment QR code
        </p>
      )}

      <button
        type="button"
        onClick={handleManual}
        className="text-sm font-medium underline"
        style={{ color: 'var(--accent)', minHeight: '44px', padding: '0 8px' }}>
        Enter address instead
      </button>
    </div>
  )
}

export type { QrScannerProps }
