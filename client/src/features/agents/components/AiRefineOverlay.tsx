import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDesktop } from '../../../hooks/useDesktop'
import { useAgentRefine, type AgentRefineState } from '../hooks/useAgentRefine'
import {
  AiEditShell,
  PlainComposer,
  WordDiffView,
  computeWordDiff,
  type AiEditUiPhase,
} from '../../code/components/ai-edit/AiEditShell'

const SUGGESTION_CHIP_KEYS = [
  'refine.chips.tightenTools',
  'refine.chips.stricterPersonality',
  'refine.chips.workflowSection',
  'refine.chips.sharpenDescription',
  'refine.chips.matchDeveloperStyle',
]

interface Props {
  agentId: string
  baseBody: string
  resumeRefineId?: string
  onClose: () => void
  /** Optional minimize affordance — fires with the current refine session id
   *  (or null when no session has started yet) so the parent can park the
   *  session in the dock and resume later via `rehydrate(refineId)`. */
  onMinimize?: (refineId: string | null) => void
  /** Push the current refineId up so the parent can drive programmatic
   *  auto-minimize (mutual-exclusion when another AiEdit is restored). */
  onStateChange?: (state: { refineId: string | null }) => void
  onOpenInStudio?: (refineId: string, draftBody: string) => void
  onApplied?: (agentId: string, version: number) => void
}

export function AiRefineOverlay({
  agentId,
  baseBody,
  resumeRefineId,
  onClose,
  onMinimize,
  onStateChange,
  onOpenInStudio,
  onApplied,
}: Props) {
  const { t } = useTranslation('agentstudio')
  const { activeProjectId } = useDesktop()
  const r = useAgentRefine(activeProjectId)
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    if (resumeRefineId) {
      void r.rehydrate(resumeRefineId, agentId)
    } else {
      r.open(agentId, baseBody)
    }
  }, [agentId, baseBody, resumeRefineId, r])

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  // Push refineId up so the parent can auto-minimize on mutual-exclusion.
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  useEffect(() => {
    onStateChangeRef.current?.({ refineId: r.state.refineId ?? null })
  }, [r.state.refineId])

  const lastAppliedRef = useRef<number | null>(null)
  useEffect(() => {
    if (
      r.state.uiState === 'applied' &&
      r.state.appliedVersion !== null &&
      r.state.appliedVersion !== lastAppliedRef.current
    ) {
      lastAppliedRef.current = r.state.appliedVersion
      if (onApplied && r.state.agentId) onApplied(r.state.agentId, r.state.appliedVersion)
    }
  }, [r.state.uiState, r.state.appliedVersion, r.state.agentId, onApplied])

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setInput('')
      if (!r.state.refineId) {
        await r.start(trimmed)
      } else {
        await r.sendTurn(trimmed)
      }
    },
    [r],
  )

  const handleSubmit = useCallback(() => {
    void submit(input)
  }, [input, submit])

  const handleDiscard = useCallback(async () => {
    if (
      r.state.refineId &&
      (r.state.uiState === 'streaming' || r.state.uiState === 'reviewing')
    ) {
      await r.cancel()
    }
    onClose()
  }, [r, onClose])

  const uiPhase = mapToUiPhase(r.state)
  const diff = useMemo(() => {
    if (!r.state.draftBody || !r.state.baseBody) return null
    return <WordDiffView hunks={computeWordDiff(r.state.baseBody, r.state.draftBody)} />
  }, [r.state.baseBody, r.state.draftBody])

  return (
    <AiEditShell
      uiPhase={uiPhase}
      errorMessage={r.state.errorMessage}
      applyConflict={r.state.applyConflict}
      eyebrow={t('refine.eyebrow')}
      targetLabel={agentId}
      targetLabelMono
      headline={t('refine.headline')}
      streamingHeadline={t('refine.streamingHeadline')}
      description={extractDescription(baseBody)}
      chips={SUGGESTION_CHIP_KEYS.map((key) => t(key))}
      onChipSubmit={(text) => void submit(text)}
      composer={
        <PlainComposer
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={uiPhase === 'streaming' || uiPhase === 'applied'}
          placeholder={
            r.state.refineId
              ? t('refine.placeholderFollowUp')
              : t('refine.placeholderInitial')
          }
          inputRef={inputRef}
        />
      }
      streamingText={r.state.streamingText}
      history={r.state.history}
      diff={diff}
      diffHeaderLabel={`.claude/agents/${agentId}.md`}
      baseBody={baseBody}
      baseBodyDisclosureLabel={t('refine.viewCurrentBody')}
      appliedNotice={
        r.state.appliedVersion !== null ? (
          <div className="rounded-md border border-green-500/40 aurora-light:border-accent-success/40 bg-green-500/10 aurora-light:bg-accent-success/10 p-3 text-xs text-green-300 aurora-light:text-accent-success">
            {t('refine.appliedAsVersion', { version: r.state.appliedVersion })}
          </div>
        ) : undefined
      }
      canApply={
        r.state.uiState === 'reviewing' &&
        !!r.state.draftBody &&
        !r.state.applyConflict
      }
      onApply={() => void r.apply()}
      onForceApply={() => void r.apply(true)}
      onDiscard={() => void handleDiscard()}
      onClose={() => void handleDiscard()}
      onMinimize={
        onMinimize ? () => onMinimize(r.state.refineId ?? null) : undefined
      }
      secondaryAction={
        onOpenInStudio && r.state.draftBody && r.state.refineId
          ? {
              label: t('refine.openInStudio'),
              icon: <ExternalLink className="w-3 h-3" />,
              onClick: () => {
                if (r.state.refineId && r.state.draftBody && onOpenInStudio) {
                  onOpenInStudio(r.state.refineId, r.state.draftBody)
                }
              },
            }
          : undefined
      }
    />
  )
}

function mapToUiPhase(s: AgentRefineState): AiEditUiPhase {
  switch (s.uiState) {
    case 'streaming':
      return 'streaming'
    case 'reviewing':
      return 'reviewing'
    case 'applied':
      return 'applied'
    case 'error':
      return 'error'
    case 'cancelled':
    case 'composing':
    case 'closed':
    case 'applying':
    default:
      return 'composing'
  }
}

function extractDescription(body: string): string | null {
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return null
  const block = fm[1]
  const m = block.match(/^description:\s*([\s\S]*?)(?=^[a-z_]+:\s|\Z)/m)
  if (!m) return null
  let raw = m[1].trim()
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1)
  }
  raw = raw
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim()
  if (raw.length > 240) raw = raw.slice(0, 237) + '…'
  return raw || null
}
