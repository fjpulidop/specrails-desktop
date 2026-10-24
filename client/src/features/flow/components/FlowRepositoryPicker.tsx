// ─── Flow repository picker ───────────────────────────────────────────────────
// WHERE a Flow runs, in a workspace (folder primary) or a project with several
// Git repositories: one radio per Git member (never a folder), one tab stop,
// arrow keys / Home / End move the choice and the focus. Shared by the Flow
// entry card and the "Start in Flow" repository dialog of an existing spec.

import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, FolderGit2 } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { FlowRepositoryOption } from '../lib/flow-api'

interface Props {
  /** The Git members a Flow can run in (`flowRepositoryChoice().candidates`). */
  candidates: readonly FlowRepositoryOption[]
  selectedId: string | null
  /** The member carrying the badge (the agent's triage, the spec's repository). */
  suggestedId?: string | null
  /** The badge's words (default: "Suggested"). */
  suggestedLabel?: string
  onSelect: (repositoryId: string) => void
  disabled?: boolean
  /** Prefix of the element ids and test ids (`<prefix>-label`, `<prefix>-<id>`). */
  idPrefix: string
}

export function FlowRepositoryPicker({ candidates, selectedId, suggestedId = null, suggestedLabel, onSelect, disabled = false, idPrefix }: Props) {
  const { t } = useTranslation('agent')
  const radioRefs = useRef(new Map<string, HTMLButtonElement>())
  const tabStopId = candidates.some((candidate) => candidate.id === selectedId) ? selectedId : candidates[0]?.id ?? null
  const onRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = candidates.length - 1
    let next: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = index >= last ? 0 : index + 1
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = index <= 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    const target = candidates[next]
    if (!target) return
    onSelect(target.id)
    radioRefs.current.get(target.id)?.focus()
  }
  const labelId = `${idPrefix}-label`
  const hintId = `${idPrefix}-hint`

  return (
    <div data-testid={idPrefix} className="space-y-1.5">
      <p id={labelId} className="flex items-center gap-1.5 text-label text-foreground/80">
        <FolderGit2 className="h-3 w-3 shrink-0" aria-hidden />
        {t('flow.entry.repository.label')}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId} className="grid max-h-44 gap-1 overflow-y-auto pr-0.5">
        {candidates.map((candidate, index) => {
          const checked = candidate.id === selectedId
          return (
            <button
              key={candidate.id}
              ref={(node) => { if (node) radioRefs.current.set(candidate.id, node); else radioRefs.current.delete(candidate.id) }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={candidate.id === tabStopId ? 0 : -1}
              onKeyDown={(event) => onRadioKeyDown(event, index)}
              data-agent-interactive
              data-testid={`${idPrefix}-${candidate.id}`}
              disabled={disabled}
              onClick={() => onSelect(candidate.id)}
              className={cn(
                'group flex w-full min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50 disabled:opacity-50',
                checked ? 'border-accent-flow/60 bg-accent-flow/10' : 'border-border/50 bg-surface/30 hover:border-accent-flow/35 hover:bg-surface/60',
              )}
            >
              <span aria-hidden className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border', checked ? 'border-accent-flow bg-accent-flow text-background' : 'border-foreground/30')}>
                {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn('truncate text-label', checked ? 'text-foreground' : 'text-foreground/80')}>{candidate.name}</span>
                  {candidate.id === suggestedId && (
                    <span className="shrink-0 rounded-full bg-accent-flow/15 px-1.5 py-px text-label text-accent-flow">{suggestedLabel ?? t('flow.entry.repository.suggested')}</span>
                  )}
                </span>
                <span className="block truncate font-mono text-xs text-foreground/70" title={candidate.path}>{candidate.path}</span>
              </span>
            </button>
          )
        })}
      </div>
      <p id={hintId} className="text-xs text-foreground/70">
        {selectedId ? t('flow.entry.repository.hint') : t('flow.entry.repository.choose')}
      </p>
    </div>
  )
}
