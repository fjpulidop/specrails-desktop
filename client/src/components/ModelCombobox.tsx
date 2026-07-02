import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from './ui/select'

interface ModelOption {
  alias: string
  label: string
  /** Key under `addspec:modelCombobox.tier.*` for the displayed tier badge. */
  tierKey: 'balanced' | 'mostCapable' | 'fastest' | 'frontier'
  tierColor: 'neutral' | 'accent' | 'green' | 'gold'
}

export const MODEL_OPTIONS: ModelOption[] = [
  { alias: 'sonnet', label: 'Sonnet', tierKey: 'balanced',    tierColor: 'neutral' },
  { alias: 'fable',  label: 'Fable',  tierKey: 'frontier',    tierColor: 'gold'    },
  { alias: 'opus',   label: 'Opus',   tierKey: 'mostCapable', tierColor: 'accent'  },
  { alias: 'haiku',  label: 'Haiku',  tierKey: 'fastest',     tierColor: 'green'   },
]

function tierBadgeClass(color: ModelOption['tierColor']): string {
  switch (color) {
    case 'neutral': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 aurora-light:bg-accent-info/10 aurora-light:text-accent-info'
    case 'accent':  return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 aurora-light:bg-accent-primary/10 aurora-light:text-accent-primary'
    case 'green':   return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 aurora-light:bg-accent-success/10 aurora-light:text-accent-success'
    case 'gold':    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 aurora-light:bg-accent-warning/10 aurora-light:text-accent-warning'
  }
}

interface ModelComboboxProps {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}

export function ModelCombobox({ value, onChange, disabled }: ModelComboboxProps) {
  const { t } = useTranslation('addspec')
  const selected = MODEL_OPTIONS.find(o => o.alias === value) ?? MODEL_OPTIONS[0]

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      {/* Compact single-line trigger */}
      <SelectTrigger className="w-[168px] h-7 text-xs gap-1.5 px-2.5">
        <span className="font-medium text-foreground">{selected.label}</span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${tierBadgeClass(selected.tierColor)}`}>
          {t(`modelCombobox.tier.${selected.tierKey}`)}
        </span>
      </SelectTrigger>
      {/* Rich dropdown items */}
      <SelectContent>
        {MODEL_OPTIONS.map((opt) => (
          <SelectItem key={opt.alias} value={opt.alias} className="py-2 pr-6">
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{opt.label}</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${tierBadgeClass(opt.tierColor)}`}>
                  {t(`modelCombobox.tier.${opt.tierKey}`)}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">{t('modelCombobox.alias', { alias: opt.alias })}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
