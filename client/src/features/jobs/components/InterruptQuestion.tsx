import { useTranslation } from 'react-i18next'
import { Download, Hand } from 'lucide-react'
import { Button } from '../../../components/ui/button'

/** One structured answer a Core question carries (`options`, contract 5.17). */
export interface InterruptOption { id: string; label: string; meaning: string }
/** A machine-wide install the run needs (`data.kind === 'machine-install'`). */
export interface MachineInstallData { command: string; tool: string }

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** The question's structured options, defensively read; empty when it has none. */
export function readInterruptOptions(value: unknown): InterruptOption[] {
  const options = record(value)?.options
  if (!Array.isArray(options)) return []
  return options.flatMap((option) => {
    const item = record(option)
    return item && typeof item.id === 'string' && item.id && typeof item.label === 'string'
      ? [{ id: item.id.slice(0, 64), label: item.label.slice(0, 120), meaning: typeof item.meaning === 'string' ? item.meaning.slice(0, 400) : '' }] : []
  }).slice(0, 8)
}

export function readMachineInstall(value: unknown): MachineInstallData | null {
  const data = record(record(value)?.data)
  if (!data || data.kind !== 'machine-install' || typeof data.command !== 'string' || !data.command.trim()) return null
  return { command: data.command.trim().slice(0, 300), tool: typeof data.tool === 'string' && data.tool.trim() ? data.tool.trim().slice(0, 120) : data.command.trim().split(/\s+/).pop()! }
}

/**
 * A pending question with structured choices, answered by a button: the choice id is the answer.
 * A machine-wide install reads in the person's language with the exact command; any other
 * question shows Core's prompt and option labels as they are. Without options it renders the
 * prompt only (the text box answers it).
 */
export function InterruptQuestion({ value, onChoose, busy }: { value: unknown; onChoose(id: string): void; busy?: boolean }) {
  const { t } = useTranslation('loops')
  const install = readMachineInstall(value)
  const options = readInterruptOptions(value)
  const prompt = typeof record(value)?.prompt === 'string' ? String(record(value)!.prompt) : ''
  const label = (option: InterruptOption): string => install && (option.id === 'install' || option.id === 'self') ? t(`core.machineInstall.${option.id}`) : option.label
  const meaning = (option: InterruptOption): string => install && (option.id === 'install' || option.id === 'self') ? t(`core.machineInstall.${option.id}Meaning`) : option.meaning
  return (
    <div className="space-y-2" data-testid={install ? 'machine-install-question' : 'interrupt-question'}>
      {install ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('core.machineInstall.question', { tool: install.tool })}</p>
          <pre data-testid="machine-install-command" className="whitespace-pre-wrap break-words rounded-control border border-border/50 bg-background/60 px-2 py-1 font-mono text-caption text-foreground">{install.command}</pre>
          <p className="text-caption text-muted-foreground">{t('core.machineInstall.once')}</p>
        </div>
      ) : prompt ? <p className="whitespace-pre-wrap text-sm">{prompt}</p> : null}
      {options.length > 0 && (
        <div role="group" aria-label={t('core.answerQuestion')} className="flex flex-wrap items-start gap-x-3 gap-y-2">
          {options.map((option, index) => (
            <div key={option.id} className="flex max-w-[17rem] flex-col items-start gap-1">
              <Button type="button" size="sm" variant={index === 0 ? 'default' : 'outline'} disabled={busy} aria-busy={busy || undefined}
                data-testid={`interrupt-option-${option.id}`} aria-describedby={`interrupt-option-meaning-${option.id}`} onClick={() => onChoose(option.id)}>
                {install && option.id === 'install' && <Download className="mr-1 h-3 w-3" aria-hidden />}
                {install && option.id === 'self' && <Hand className="mr-1 h-3 w-3" aria-hidden />}
                {label(option)}
              </Button>
              {meaning(option) && <span id={`interrupt-option-meaning-${option.id}`} className="text-caption text-muted-foreground">{meaning(option)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
