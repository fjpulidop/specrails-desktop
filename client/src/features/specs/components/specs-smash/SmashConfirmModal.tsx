import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { Split, Zap } from 'lucide-react'

import { Button } from '../../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../../components/ui/dialog'

export type SmashMode = 'simple' | 'full'

export interface SmashConfirmModalProps {
  open: boolean
  /** Title of the parent spec — shown in the modal header. */
  ticketTitle: string
  /** When true, parent is already an epic with children — the modal warns
   *  that confirming will delete the existing children first. */
  isReSmash: boolean
  childrenCount: number
  /** Disabled while a fetch is in flight. */
  submitting?: boolean
  onCancel: () => void
  onConfirm: (mode: SmashMode) => void
}

const MODE_DESCRIPTION: Record<SmashMode, { titleKey: string; bulletKeys: string[]; etaKey: string }> = {
  simple: {
    titleKey: 'smashModal.modes.simple.title',
    bulletKeys: [
      'smashModal.modes.simple.bullet1',
      'smashModal.modes.simple.bullet2',
      'smashModal.modes.simple.bullet3',
    ],
    etaKey: 'smashModal.modes.simple.eta',
  },
  full: {
    titleKey: 'smashModal.modes.full.title',
    bulletKeys: [
      'smashModal.modes.full.bullet1',
      'smashModal.modes.full.bullet2',
      'smashModal.modes.full.bullet3',
      'smashModal.modes.full.bullet4',
    ],
    etaKey: 'smashModal.modes.full.eta',
  },
}

export function SmashConfirmModal({
  open,
  ticketTitle,
  isReSmash,
  childrenCount,
  submitting = false,
  onCancel,
  onConfirm,
}: SmashConfirmModalProps) {
  const { t } = useTranslation('activity')
  const [mode, setMode] = useState<SmashMode>('simple')

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onCancel() }}>
      {/* Opened from Spec detail (an entity modal), so it climbs to `stacked`. */}
      <DialogContent size="form" layer="stacked" showCloseButton={false} data-testid="smash-confirm-modal">
        <DialogHeader icon={<Split />}>
          <DialogTitle>{t('smashModal.title')}</DialogTitle>
          <p className="truncate text-label text-foreground/80" title={ticketTitle} data-testid="smash-confirm-modal-ticket">
            {ticketTitle}
          </p>
          <DialogDescription>{t('smashModal.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
        {/* Re-SMASH warning */}
        {isReSmash && childrenCount > 0 && (
          <div className="rounded-md border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-xs text-foreground">
            <Trans t={t} i18nKey="smashModal.reSmashWarning" count={childrenCount} />
          </div>
        )}

        {/* Mode picker */}
        <div className="space-y-3">
          <p className="text-label text-muted-foreground">
            {t('smashModal.modePickerLabel')}
          </p>
          {(['simple', 'full'] as SmashMode[]).map((m) => {
            const meta = MODE_DESCRIPTION[m]
            const selected = mode === m
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                disabled={submitting}
                className={`w-full text-left rounded-lg border px-3 py-3 transition-colors ${
                  selected
                    ? 'border-accent-highlight/60 bg-accent-highlight/10'
                    : 'border-border/40 bg-card/40 hover:bg-card/60 hover:border-border/60'
                }`}
                data-testid={`smash-mode-${m}`}
              >
                <div className="flex items-start gap-2">
                  <div
                    className={`mt-0.5 h-3.5 w-3.5 rounded-full border-2 shrink-0 ${
                      selected
                        ? 'border-accent-highlight bg-accent-highlight'
                        : 'border-muted-foreground/60'
                    }`}
                    aria-hidden
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="flex items-center gap-1.5 text-strong text-foreground">
                        {m === 'full' && <Zap className="w-3.5 h-3.5 text-accent-highlight" aria-hidden />}
                        {t(meta.titleKey)}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {t(meta.etaKey)}
                      </span>
                    </div>
                    <ul className="space-y-0.5">
                      {meta.bulletKeys.map((b) => (
                        <li key={b} className="text-xs text-foreground/70 leading-snug">
                          • {t(b)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={submitting}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={() => onConfirm(mode)}
            disabled={submitting}
            data-testid="smash-confirm-modal-continue"
          >
            <Split className="w-3.5 h-3.5 mr-1.5" />
            {submitting ? t('smashModal.starting') : isReSmash ? t('smashModal.confirmReSmash') : t('smashModal.smash')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
