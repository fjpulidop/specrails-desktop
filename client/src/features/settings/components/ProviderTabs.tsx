import { Cpu, Server } from 'lucide-react'

export interface ProviderTab {
  /** Stable value (provider id, or '' for "inherit"). */
  value: string
  /** Primary label (e.g. "Claude", the connection's label). */
  label: string
  /** Muted secondary text (the id, or the base URL for a local engine). Shown in the tooltip. */
  detail?: string
  local?: boolean
  /** Accessible name of the radio (defaults to the label). */
  name?: string
}

interface Props {
  name: string
  value: string
  tabs: ProviderTab[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel?: string
}

/**
 * Segmented tab strip for picking a provider — replaces the radio pills
 * (a native radio input inside a pill read as a form control, not a choice).
 * Still a radiogroup for a11y: arrow keys move, the hidden input carries the
 * value, and the visual is one pill rail with the active tab lifted.
 */
export function ProviderTabs({ name, value, tabs, onChange, disabled, ariaLabel }: Props) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-border bg-background/60 p-1">
      {tabs.map((tab) => {
        const active = tab.value === value
        return (
          <label
            key={tab.value || '__inherit'}
            title={tab.detail ? `${tab.label} · ${tab.detail}` : tab.label}
            className={`relative flex cursor-pointer select-none items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${active ? 'bg-primary/15 text-foreground shadow-sm ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'} ${disabled ? 'pointer-events-none opacity-50' : ''}`}
          >
            <input
              type="radio"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
              aria-label={tab.name ?? tab.label}
              name={name}
              value={tab.value}
              checked={active}
              disabled={disabled}
              onChange={() => onChange(tab.value)}
            />
            {tab.local ? <Server className="h-3 w-3 opacity-70" aria-hidden /> : tab.value ? <Cpu className="h-3 w-3 opacity-70" aria-hidden /> : null}
            <span className="font-medium">{tab.label}</span>
            {tab.local && tab.detail && <span className="hidden max-w-[12rem] truncate text-[10px] opacity-60 sm:inline">{tab.detail}</span>}
          </label>
        )
      })}
    </div>
  )
}
