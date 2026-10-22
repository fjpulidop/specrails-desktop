import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, Sparkles } from 'lucide-react'
import { readUpdateChannel, saveUpdateChannel, type UpdateChannel } from '../../../lib/app-updater'

const CHANNELS: Array<{ value: UpdateChannel; icon: typeof Sparkles }> = [
  { value: 'latest', icon: Sparkles },
  { value: 'stable', icon: ShieldCheck },
]

/**
 * App settings ▸ Updates ▸ Update channel. One choice drives both the Desktop
 * updater manifest and the Core npm dist-tag (`stable` pins Core `stable`,
 * falling back to `latest` while Core publishes none). Optimistic with revert.
 */
export function UpdateChannelSection() {
  const { t } = useTranslation('settings')
  const [channel, setChannel] = useState<UpdateChannel | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void readUpdateChannel().then((value) => { if (alive) setChannel(value) })
    return () => { alive = false }
  }, [])

  async function choose(next: UpdateChannel): Promise<void> {
    if (next === channel || saving) return
    const previous = channel
    setChannel(next)
    setSaving(true)
    try {
      await saveUpdateChannel(next)
      toast.success(t('updateChannel.saved', { channel: t(`updateChannel.${next}.label`) }))
    } catch (err) {
      setChannel(previous)
      toast.error(t('updateChannel.saveFailed', { message: (err as Error).message }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('updateChannel.heading')}
      </h3>
      <div className="rounded-md border border-border p-3 space-y-2">
        <div
          role="radiogroup"
          aria-label={t('updateChannel.heading')}
          className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-border bg-background/60 p-1"
        >
          {CHANNELS.map(({ value, icon: Icon }) => {
            const active = value === channel
            return (
              <label
                key={value}
                className={`relative flex cursor-pointer select-none items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${active ? 'bg-primary/15 text-foreground shadow-sm ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'} ${channel === null || saving ? 'pointer-events-none opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                  aria-label={t(`updateChannel.${value}.label`)}
                  name="update-channel"
                  value={value}
                  checked={active}
                  disabled={channel === null || saving}
                  onChange={() => void choose(value)}
                />
                <Icon className="h-3 w-3 opacity-70" aria-hidden />
                <span className="font-medium">{t(`updateChannel.${value}.label`)}</span>
              </label>
            )
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {channel ? t(`updateChannel.${channel}.description`) : t('updateChannel.loading')}
        </p>
        <p className="text-[10px] text-muted-foreground/70">{t('updateChannel.scope')}</p>
      </div>
    </div>
  )
}
