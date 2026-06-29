import { useEffect, useRef, useState, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import jsQR from 'jsqr'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { encodeOffer, decodeAnswer } from '../../lib/companion-signal'

type Phase = 'loading' | 'offer' | 'scanning' | 'connecting' | 'paired'

/** Serverless WebRTC pairing for the web companion (specrails.dev/companion-app):
 *  show the desktop's offer QR, then scan the phone's answer QR back with the
 *  desktop camera. No server in the middle — the SDP travels by QR. */
export function PairWebCompanionModal({ open, onClose, onPaired }: { open: boolean; onClose: () => void; onPaired: () => void }) {
  const { t } = useTranslation('settings')
  const [phase, setPhase] = useState<Phase>('loading')
  const [offerToken, setOfferToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  const stopCamera = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
  }, [])

  const close = useCallback(() => {
    stopCamera()
    setPhase('loading')
    setOfferToken('')
    setError(null)
    onClose()
  }, [onClose, stopCamera])

  const applyAnswer = useCallback(
    async (token: string) => {
      const ans = await decodeAnswer(token)
      if (!ans) {
        toast.error(t('pairWeb.notAnswer'))
        return
      }
      stopCamera()
      setPhase('connecting')
      try {
        const r = await fetch('/api/mobile/webrtc/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sdp: ans.sdp }),
        })
        const body = (await r.json().catch(() => ({}))) as { ok?: boolean }
        if (!r.ok || !body.ok) throw new Error('rejected')
        setPhase('paired')
        toast.success(t('pairWeb.pairedToast'))
        // The device row is created a beat later — after the DataChannel opens
        // and the companion's hello arrives — so refresh the list a few times.
        onPaired()
        let n = 0
        const poll = setInterval(() => {
          onPaired()
          if (++n >= 3) {
            clearInterval(poll)
            close()
          }
        }, 1500)
      } catch {
        setError(t('pairWeb.answerRejected'))
        setPhase('offer')
      }
    },
    [t, stopCamera, onPaired, close],
  )

  // Phase 1 — fetch an offer + render its QR.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setPhase('loading')
    void (async () => {
      try {
        const r = await fetch('/api/mobile/webrtc/offer', { method: 'POST' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const o = (await r.json()) as { sdp: string; secret: string; hubName: string; hubInstanceId: string }
        const token = await encodeOffer({ hubInstanceId: o.hubInstanceId, hubName: o.hubName, sdp: o.sdp, secret: o.secret })
        if (!cancelled) {
          setOfferToken(token)
          setPhase('offer')
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message)
          setPhase('offer')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Phase 2 — when scanning, attach the camera and poll frames with jsQR.
  useEffect(() => {
    if (phase !== 'scanning') return
    const stream = streamRef.current
    const video = videoRef.current
    if (!stream || !video) return
    video.srcObject = stream
    void video.play().catch(() => {})
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    const tick = () => {
      if (!streamRef.current) return
      if (video.videoWidth) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(img.data, img.width, img.height)
        if (code) {
          void applyAnswer(code.data)
          return
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [phase, applyAnswer])

  // Always release the camera on unmount.
  useEffect(() => () => stopCamera(), [stopCamera])

  async function startScan(): Promise<void> {
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error(t('pairWeb.cameraFailed', { message: 'unsupported' }))
      return
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      setPhase('scanning')
    } catch (e) {
      toast.error(t('pairWeb.cameraFailed', { message: (e as Error).message }))
      setPhase('offer')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent movableResizable className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('pairWeb.title')}</DialogTitle>
          <DialogDescription>{t('pairWeb.description')}</DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{t('pairWeb.startFailed', { error })}</p>}

        {phase === 'loading' && <div className="h-56 bg-muted/30 rounded-lg animate-pulse" />}

        {phase === 'offer' && offerToken && (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="bg-white p-3 rounded-lg">
              <QRCodeSVG value={offerToken} size={220} />
            </div>
            <p className="text-xs text-muted-foreground text-center">{t('pairWeb.showThenScan')}</p>
            <Button onClick={() => void startScan()} className="gap-2">{t('pairWeb.scanAnswer')}</Button>
            <button
              type="button"
              className="text-xs text-accent-info underline"
              onClick={() => { void navigator.clipboard?.writeText(offerToken); toast.success(t('pairWeb.codeCopied')) }}
            >
              {t('pairWeb.copyCode')}
            </button>
          </div>
        )}

        {phase === 'scanning' && (
          <div className="flex flex-col items-center gap-3 py-2">
            <video ref={videoRef} playsInline className="w-full max-h-72 rounded-lg bg-black" />
            <p className="text-xs text-muted-foreground text-center">{t('pairWeb.scanning')}</p>
            <Button variant="outline" onClick={() => { stopCamera(); setPhase('offer') }}>{t('pairWeb.cancel')}</Button>
          </div>
        )}

        {phase === 'connecting' && <p className="py-6 text-center text-muted-foreground">{t('pairWeb.connecting')}</p>}
        {phase === 'paired' && <p className="py-6 text-center text-accent-success font-medium">{t('pairWeb.paired')}</p>}
      </DialogContent>
    </Dialog>
  )
}
