import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Github, Rocket } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '../../lib/utils'
import { usePrerequisites } from '../../hooks/usePrerequisites'
import type { Blueprint } from '../../lib/blueprint-draft'

// Commit mini-form (add-project-builder D3/D8): the LAST screen before any
// disk mutation. Name prefilled from the blueprint, location defaulting to
// ~/projects/<slug>, provider multi-select (same semantics as
// AddProjectDialog), GitHub checkbox gated on gh present + authenticated.

export interface CommitFormValue {
  name: string
  location: string
  providers: string[]
  createGithubRepo: boolean
}

interface BlueprintCommitFormProps {
  blueprint: Blueprint
  onSubmit: (value: CommitFormValue) => void
  onBack: () => void
  submitting: boolean
  error: string | null
  errorDetail?: string | null
}

const PROVIDER_META: Record<string, { icon: string; label: string }> = {
  claude: { icon: '🤖', label: 'Claude' },
  codex: { icon: '⚡', label: 'Codex' },
  gemini: { icon: '✨', label: 'Gemini' },
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}

export function BlueprintCommitForm({ blueprint, onSubmit, onBack, submitting, error, errorDetail }: BlueprintCommitFormProps) {
  const { t } = useTranslation('builder')
  const { status: prereqStatus } = usePrerequisites()

  const [name, setName] = useState(blueprint.product.name || '')
  const [locationTouched, setLocationTouched] = useState(false)
  const [location, setLocation] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set(['claude']))
  const [available, setAvailable] = useState<Record<string, boolean>>({ claude: true })
  const [createGithubRepo, setCreateGithubRepo] = useState(false)

  const defaultLocation = useMemo(() => `~/projects/${slugifyProjectName(name)}`, [name])
  const effectiveLocation = locationTouched ? location : defaultLocation

  useEffect(() => {
    fetch('/api/available-providers')
      .then((r) => r.json())
      .then((data: Record<string, unknown>) => {
        const avail: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(data)) {
          if (k === 'tiers') continue
          avail[k] = Boolean(v)
        }
        setAvailable(avail)
        const next = new Set<string>()
        for (const [id, ok] of Object.entries(avail)) if (ok) next.add(id)
        if (next.size > 0) setSelected(next)
      })
      .catch(() => { /* defaults to claude */ })
  }, [])

  const gh = prereqStatus?.prerequisites.find((p) => p.key === 'gh')
  const ghInstalled = Boolean(gh?.installed && gh?.executable !== false)
  const ghReady = ghInstalled && Boolean(gh?.authenticated)

  const orderedSelected = ['claude', 'codex', 'gemini', ...Object.keys(available)]
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .filter((id) => selected.has(id) && available[id])

  const canSubmit = name.trim() !== '' && effectiveLocation.trim() !== '' && orderedSelected.length > 0 && !submitting

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-6" data-testid="commit-form">
      <div>
        <h2 className="text-sm font-semibold">{t('commit.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('commit.description')}</p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive" data-testid="commit-error">
          <p>{t(`commit.errors.${error}`, { defaultValue: t('commit.errors.generic') })}</p>
          {errorDetail && <p className="mt-1 opacity-80">{errorDetail}</p>}
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium">{t('commit.nameLabel')} <span className="text-destructive">*</span></label>
        <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="commit-name" />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium">{t('commit.locationLabel')} <span className="text-destructive">*</span></label>
        <Input
          value={effectiveLocation}
          onChange={(e) => { setLocationTouched(true); setLocation(e.target.value) }}
          data-testid="commit-location"
        />
        <p className="text-[10px] text-muted-foreground">{t('commit.locationHint')}</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('commit.providersLabel')}</label>
        <div className="flex gap-2">
          {Object.keys(available).map((id) => {
            const { icon, label } = PROVIDER_META[id] ?? { icon: '•', label: id }
            const avail = available[id]
            const checked = selected.has(id) && avail
            return (
              <button
                key={id}
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={!avail}
                data-testid={`commit-provider-${id}`}
                onClick={() => {
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (next.has(id)) {
                      if (next.size === 1) return prev
                      next.delete(id)
                    } else {
                      next.add(id)
                    }
                    return next
                  })
                }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors',
                  checked ? 'border-accent-primary/60 bg-accent-primary/10' : 'border-border/30 text-muted-foreground',
                  !avail && 'cursor-not-allowed opacity-40',
                )}
              >
                <span>{icon}</span>
                <span className="font-medium">{label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {ghInstalled && (
        <label
          className={cn(
            'flex items-center gap-2 rounded-md border border-border/30 px-3 py-2 text-xs',
            !ghReady && 'opacity-50',
          )}
        >
          <input
            type="checkbox"
            checked={createGithubRepo && ghReady}
            disabled={!ghReady}
            onChange={(e) => setCreateGithubRepo(e.target.checked)}
            data-testid="commit-github"
          />
          <Github className="h-3.5 w-3.5" />
          <span>{t('commit.githubLabel')}</span>
          {!ghReady && <span className="ml-auto text-[10px] text-muted-foreground">{t('commit.githubAuthHint')}</span>}
        </label>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" size="sm" onClick={onBack} disabled={submitting}>
          {t('commit.back')}
        </Button>
        <Button
          size="sm"
          disabled={!canSubmit}
          data-testid="commit-submit"
          onClick={() => onSubmit({
            name: name.trim(),
            location: effectiveLocation.trim(),
            providers: orderedSelected,
            createGithubRepo: createGithubRepo && ghReady,
          })}
        >
          <Rocket className="mr-1.5 h-3.5 w-3.5" />
          {submitting ? t('commit.creating') : t('commit.submit')}
        </Button>
      </div>
    </div>
  )
}
