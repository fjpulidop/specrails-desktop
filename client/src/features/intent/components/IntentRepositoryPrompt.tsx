// ─── "Start in Intent": where does it run? ──────────────────────────────────────
// Starting an EXISTING spec in Intent from the board's context menu or the spec
// detail, in a project with several Git repositories, when the spec does not
// target exactly one of them: a small dialog asks which repository the Intent
// runs in (the entry card's picker: Git members only, arrow-key radio group),
// preselecting the spec's repository, else the Git primary.
//
// The dialog lives in this provider (mounted once with the Intent state), not in
// the door that asked: the board's context menu closes — and unmounts its item
// — as the dialog opens. `choose()` resolves with the picked id, or null when
// the person cancels. Without the provider there is no prompt (the server then
// triages and explains).

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Waves } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import type { IntentRepositoryOption } from '../lib/intent-api'
import { IntentRepositoryPicker } from './IntentRepositoryPicker'

export interface IntentRepositoryRequest {
  spec: { id: number; title: string }
  /** The Git members (at least two). */
  candidates: readonly IntentRepositoryOption[]
  /** A repository the spec names (the badge and the preselection). */
  specRepositoryId: string | null
  /** The Git primary, preselected when the spec names none. */
  fallbackId: string | null
}

export interface IntentRepositoryPrompt {
  choose: (request: IntentRepositoryRequest) => Promise<string | null>
}

const PromptContext = createContext<IntentRepositoryPrompt | null>(null)

/** The repository prompt (null ⇒ none mounted). */
export function useFlowRepositoryPrompt(): IntentRepositoryPrompt | null {
  return useContext(PromptContext)
}

interface Pending {
  request: IntentRepositoryRequest
  resolve: (repositoryId: string | null) => void
}

export function IntentRepositoryPromptProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  const settle = useCallback((repositoryId: string | null) => {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    current?.resolve(repositoryId)
  }, [])
  const choose = useCallback((request: IntentRepositoryRequest) => new Promise<string | null>((resolve) => {
    // A newer request replaces an unanswered one (that one is cancelled).
    pendingRef.current?.resolve(null)
    const next = { request, resolve }
    pendingRef.current = next
    setPending(next)
  }), [])
  const value = useMemo<IntentRepositoryPrompt>(() => ({ choose }), [choose])
  return (
    <PromptContext.Provider value={value}>
      {children}
      {pending && <IntentRepositoryDialog key={`${pending.request.spec.id}`} request={pending.request} onSettle={settle} />}
    </PromptContext.Provider>
  )
}

function IntentRepositoryDialog({ request, onSettle }: { request: IntentRepositoryRequest; onSettle: (repositoryId: string | null) => void }) {
  const { t } = useTranslation('agent')
  const has = (id: string | null) => !!id && request.candidates.some((candidate) => candidate.id === id)
  const specRepositoryId = has(request.specRepositoryId) ? request.specRepositoryId : null
  const [selectedId, setSelectedId] = useState<string | null>(specRepositoryId ?? (has(request.fallbackId) ? request.fallbackId : null))
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onSettle(null) }}>
      {/* Opened from the spec detail (entity) or the board menu, possibly over the floating chat: stacked layer. */}
      <DialogContent size="form" layer="stacked" data-testid="flow-start-repository-dialog">
        <DialogHeader icon={<Waves className="text-accent-intent" />}>
          <DialogTitle>{t('flow.startFromSpec.repository.title')}</DialogTitle>
          <DialogDescription>{t('flow.startFromSpec.repository.body')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/40 bg-surface/40 px-3 py-2 text-xs text-foreground">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 font-mono text-muted-foreground">{t('flow.entry.existingSpec.label', { id: request.spec.id })}</span>
            <span className="min-w-0 truncate font-medium" title={request.spec.title}>{request.spec.title}</span>
          </p>
          <IntentRepositoryPicker
            idPrefix="flow-start-repository"
            candidates={request.candidates}
            selectedId={selectedId}
            suggestedId={specRepositoryId}
            suggestedLabel={t('flow.startFromSpec.repository.fromSpec')}
            onSelect={setSelectedId}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onSettle(null)}>{t('flow.entry.cancel')}</Button>
          <Button
            data-testid="flow-start-repository-confirm"
            disabled={!selectedId}
            onClick={() => { if (selectedId) onSettle(selectedId) }}
            className="bg-accent-intent text-background hover:bg-accent-intent/90 focus-visible:ring-accent-intent/60"
          >
            <Waves className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('flow.startFromSpec.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
