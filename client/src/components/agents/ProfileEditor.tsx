import { ReactNode, useEffect, useMemo, useState } from 'react'
import { Plus, GripVertical, X, ArrowUp, ArrowDown, Pin, Pencil } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { CustomModelAliasInput } from '../CustomModelAliasInput'
import { getApiBase } from '../../lib/api'
import { formatCommandForProvider } from '../../lib/format-command'
import { RoutingRuleDialog } from './RoutingRuleDialog'
import {
  BASELINE_REQUIRED_AGENTS,
  MODEL_ALIASES,
  type ModelAlias,
  type Profile,
  type ProfileAgent,
  type ProfileModelOption,
  type RoutingDefaultRule,
  type RoutingRule,
  type RoutingTagRule,
} from './types'

const ROUTING_TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const DEFAULT_PROFILE_MODELS = MODEL_ALIASES.map((value) => ({ value, label: value }))
const DEFAULT_BASELINE_AGENTS = [...BASELINE_REQUIRED_AGENTS]

interface CatalogAgent {
  id: string
  kind: 'upstream' | 'custom'
}

export function ProfileEditor({
  profile,
  onChange,
  footer,
  provider = profile.provider ?? 'claude',
  modelCatalog = DEFAULT_PROFILE_MODELS,
  defaultModel = modelCatalog[0]?.value ?? '',
  customModelAliases = false,
  baselineAgents = DEFAULT_BASELINE_AGENTS,
  onValidityChange,
  onSoftWarningsChange,
}: {
  profile: Profile
  onChange: (p: Profile) => void
  footer?: ReactNode
  provider?: string
  modelCatalog?: ProfileModelOption[]
  defaultModel?: string
  customModelAliases?: boolean
  baselineAgents?: readonly string[]
  onValidityChange?: (issues: string[]) => void
  onSoftWarningsChange?: (warnings: { agentsMissingRouting: string[] }) => void
}) {
  // Baseline agents (architect / developer / reviewer / merge-resolver) are
  // required and pinned in every profile — default and custom alike — because
  // the pipeline relies on all four. Routing rules stay fully flexible.
  const { t } = useTranslation('agentstudio')
  const [catalog, setCatalog] = useState<CatalogAgent[]>([])
  const [pickingAgent, setPickingAgent] = useState(false)
  const [addRoutingPrompt, setAddRoutingPrompt] = useState(false)
  const [editRoutingIdx, setEditRoutingIdx] = useState<number | null>(null)
  const requiredAgents = useMemo(() => new Set(baselineAgents), [baselineAgents])

  useEffect(() => {
    let cancelled = false
    fetch(`${getApiBase()}/profiles/catalog?provider=${encodeURIComponent(provider)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ agents: CatalogAgent[] }>) : { agents: [] }))
      .then((data) => {
        if (!cancelled) setCatalog(data.agents)
      })
      .catch(() => {
        if (!cancelled) setCatalog([])
      })
    return () => {
      cancelled = true
    }
  }, [provider])

  const update = (mutate: (draft: Profile) => void) => {
    const draft = JSON.parse(JSON.stringify(profile)) as Profile
    mutate(draft)
    onChange(draft)
  }

  const selectedIds = new Set(profile.agents.map((a) => a.id))
  const availableToAdd = catalog.filter((c) => !selectedIds.has(c.id))

  // ── Live validation (structural checks beyond the JSON schema) ─────────────
  const validationIssues: string[] = useMemo(() => {
    const issues: string[] = []
    // Baseline is required on every profile — default and custom alike.
    for (const baseline of requiredAgents) {
      if (!profile.agents.some((a) => a.id === baseline)) {
        issues.push(t('profileEditor.validation.missingBaseline', { agent: baseline }))
      }
    }
    // Routing: at most one default rule, last if present.
    const defaults = profile.routing.filter((r) => 'default' in r && r.default === true)
    if (defaults.length > 1) {
      issues.push(t('profileEditor.validation.multipleDefaultRules', { found: defaults.length }))
    }
    if (defaults.length === 1) {
      const last = profile.routing[profile.routing.length - 1]
      if (!('default' in last && last.default === true)) {
        issues.push(t('profileEditor.validation.defaultRuleNotLast'))
      }
    }
    for (const rule of profile.routing) {
      if (!profile.agents.some((a) => a.id === rule.agent)) {
        issues.push(t('profileEditor.validation.unknownRoutingAgent', { agent: rule.agent }))
      }
      if ('tags' in rule) {
        const invalidTags = rule.tags.filter((tag) => !ROUTING_TAG_PATTERN.test(tag))
        if (invalidTags.length > 0) {
          issues.push(
            t('profileEditor.validation.invalidTags', {
              agent: rule.agent,
              tags: invalidTags.join(', '),
            }),
          )
        }
      }
    }
    return issues
  }, [profile, requiredAgents, t])

  // ── Soft warnings (non-blocking, surfaced at save-time) ─────────────────────
  // Only surface this when explicit routing exists. If routing is empty the
  // runtime falls back to the first developer-shaped agent in the chain.
  const agentsMissingRouting: string[] = useMemo(() => {
    if (profile.routing.length === 0) return []
    const routedIds = new Set(profile.routing.map((r) => r.agent))
    return profile.agents
      .filter((a) => !requiredAgents.has(a.id) && !routedIds.has(a.id))
      .map((a) => a.id)
  }, [profile, requiredAgents])

  const hasDefaultRoutingRule = useMemo(
    () => profile.routing.some((r) => 'default' in r && r.default === true),
    [profile.routing],
  )

  useEffect(() => {
    if (onValidityChange) onValidityChange(validationIssues)
  }, [validationIssues, onValidityChange])

  useEffect(() => {
    if (onSoftWarningsChange) onSoftWarningsChange({ agentsMissingRouting })
  }, [agentsMissingRouting, onSoftWarningsChange])

  const addAgent = (id: string) => {
    update((d) => {
      // Insert before sr-merge-resolver if present so the merge row stays
      // pinned last without a manual reorder after every add.
      const row: ProfileAgent = { id, model: defaultModel }
      const mergeIdx = d.agents.findIndex((a) => a.id === 'sr-merge-resolver')
      if (mergeIdx >= 0) {
        d.agents.splice(mergeIdx, 0, row)
      } else {
        d.agents.push(row)
      }
    })
    setPickingAgent(false)
  }

  const removeAgent = (idx: number) => {
    const agent = profile.agents[idx]
    // Baseline agents (architect/developer/reviewer/merge-resolver) can't be
    // removed from any profile — the pipeline depends on all four.
    if (requiredAgents.has(agent.id)) return
    update((d) => {
      d.agents.splice(idx, 1)
      // Cascade: drop routing rules that target the removed agent.
      d.routing = d.routing.filter((r) => r.agent !== agent.id)
    })
  }

  const reorderAgents = (activeId: string, overId: string) => {
    if (activeId === overId) return
    const oldIndex = profile.agents.findIndex((a) => a.id === activeId)
    const newIndex = profile.agents.findIndex((a) => a.id === overId)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(profile.agents, oldIndex, newIndex)
    // Pins apply to every profile: architect starts the pipeline, merge runs last.
    const archIdx = reordered.findIndex((a) => a.id === 'sr-architect')
    if (archIdx > 0) {
      const [arch] = reordered.splice(archIdx, 1)
      reordered.unshift(arch)
    }
    const mergeIdx = reordered.findIndex((a) => a.id === 'sr-merge-resolver')
    if (mergeIdx >= 0 && mergeIdx !== reordered.length - 1) {
      const [merge] = reordered.splice(mergeIdx, 1)
      reordered.push(merge)
    }
    update((d) => {
      d.agents = reordered
    })
  }

  const sortableSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    reorderAgents(String(active.id), String(over.id))
  }

  const setAgentModel = (idx: number, model: ModelAlias) => {
    update((d) => {
      d.agents[idx].model = model
    })
  }

  const addRoutingRule = (tags: string[], agent: string) => {
    update((d) => {
      const newRule: RoutingTagRule = { tags, agent }
      const defaultIdx = d.routing.findIndex((r) => 'default' in r && r.default === true)
      if (defaultIdx >= 0) {
        d.routing.splice(defaultIdx, 0, newRule)
      } else {
        d.routing.push(newRule)
      }
    })
    setAddRoutingPrompt(false)
  }

  const addDefaultRoutingRule = () => {
    update((d) => {
      if (d.routing.some((r) => 'default' in r && r.default === true)) return
      // Default rule is the pipeline's last-resort fallback — always sr-developer.
      if (!d.agents.some((a) => a.id === 'sr-developer')) return
      const newRule: RoutingDefaultRule = { default: true, agent: 'sr-developer' }
      d.routing.push(newRule)
    })
  }

  const isDefaultRule = (r: RoutingRule): boolean =>
    'default' in r && r.default === true

  const setRoutingRuleAgent = (idx: number, agent: string) => {
    update((d) => {
      const r = d.routing[idx]
      if (!r) return
      // Default rule is pinned to sr-developer — core fallback is not retargetable.
      if (isDefaultRule(r)) return
      r.agent = agent
    })
  }

  const updateTagRule = (idx: number, tags: string[], agent: string) => {
    update((d) => {
      const r = d.routing[idx]
      if (!r) return
      if (isDefaultRule(r)) return
      ;(r as RoutingTagRule).tags = tags
      r.agent = agent
    })
  }

  const removeRoutingRule = (idx: number) => {
    update((d) => {
      const r = d.routing[idx]
      if (!r) return
      if (isDefaultRule(r)) return
      d.routing.splice(idx, 1)
    })
  }

  const moveRoutingRule = (idx: number, dir: -1 | 1) => {
    const target = idx + dir
    if (target < 0 || target >= profile.routing.length) return
    const rule = profile.routing[idx]
    const targetRule = profile.routing[target]
    if (isDefaultRule(rule)) return
    if (isDefaultRule(targetRule)) return
    update((d) => {
      const [item] = d.routing.splice(idx, 1)
      d.routing.splice(target, 0, item)
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <RoutingRuleDialog
        open={addRoutingPrompt}
        mode="add"
        chainAgents={profile.agents.map((a) => a.id)}
        onConfirm={addRoutingRule}
        onCancel={() => setAddRoutingPrompt(false)}
      />
      <RoutingRuleDialog
        open={editRoutingIdx !== null}
        mode="edit"
        initial={
          editRoutingIdx !== null && profile.routing[editRoutingIdx] && !('default' in profile.routing[editRoutingIdx])
            ? {
                tags: (profile.routing[editRoutingIdx] as RoutingTagRule).tags,
                agent: profile.routing[editRoutingIdx].agent,
              }
            : undefined
        }
        chainAgents={profile.agents.map((a) => a.id)}
        onConfirm={(tags, agent) => {
          if (editRoutingIdx === null) return
          updateTagRule(editRoutingIdx, tags, agent)
          setEditRoutingIdx(null)
        }}
        onCancel={() => setEditRoutingIdx(null)}
      />
      {/* Live validation summary */}
      {validationIssues.length > 0 && (
        <div className="px-3 py-2 text-xs rounded-md border border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/10 aurora-light:bg-accent-warning/10 text-yellow-500 aurora-light:text-accent-warning">
          <div className="font-medium mb-1">{t('profileEditor.validationSummary', { count: validationIssues.length })}</div>
          <ul className="list-disc list-inside space-y-0.5">
            {validationIssues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Metadata */}
      <section className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">{t('profileEditor.nameLabel')}</label>
          <Input value={profile.name} disabled className="text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">{t('profileEditor.descriptionLabel')}</label>
          <Input
            value={profile.description ?? ''}
            onChange={(e) =>
              update((d) => {
                d.description = e.target.value
              })
            }
            className="text-sm"
            placeholder={t('profileEditor.descriptionPlaceholder')}
          />
        </div>
      </section>

      {/* Orchestrator */}
      <section>
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          {t('profileEditor.orchestrator.heading')}
        </h2>
        <div className="flex items-center gap-3 p-3 rounded-md border border-border">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-mono text-foreground truncate">
              {formatCommandForProvider('/specrails:implement', provider)} ·{' '}
              {formatCommandForProvider('/specrails:batch-implement', provider)}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {t('profileEditor.orchestrator.description')}
            </div>
          </div>
          <ModelSelect
            value={profile.orchestrator.model}
            models={modelCatalog}
            customModelAliases={customModelAliases}
            testId="profile-orchestrator-model"
            onChange={(m) =>
              update((d) => {
                d.orchestrator.model = m
              })
            }
          />
        </div>
      </section>

      {/* Agent chain */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('profileEditor.agentChain.heading', { n: profile.agents.length })}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPickingAgent((v) => !v)}
            disabled={availableToAdd.length === 0}
            title={availableToAdd.length === 0 ? t('profileEditor.agentChain.addDisabledTitle') : t('profileEditor.agentChain.addTitle')}
          >
            <Plus className="w-3.5 h-3.5 mr-1" /> {t('common:actions.add')}
          </Button>
        </div>

        {pickingAgent && (
          <div className="mb-2 p-2 rounded-md border border-border bg-muted/30">
            <div className="flex items-center justify-between mb-1.5 px-1">
              <span className="text-[11px] text-muted-foreground">
                {t('profileEditor.agentChain.pickFromCatalog', { n: availableToAdd.length })}
              </span>
              <button
                type="button"
                className="p-1 hover:bg-accent rounded"
                onClick={() => setPickingAgent(false)}
                title={t('common:actions.close')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            {availableToAdd.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                {t('profileEditor.agentChain.emptyCatalog')}
              </div>
            ) : (
              <div className="space-y-0.5 max-h-64 overflow-auto">
                {availableToAdd.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => addAgent(a.id)}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left rounded hover:bg-accent transition-colors"
                  >
                    <span className="text-sm font-mono">{a.id}</span>
                    <span
                      className={
                        'text-[10px] px-1.5 py-0.5 rounded ' +
                        (a.kind === 'custom'
                          ? 'bg-purple-500/15 aurora-light:bg-accent-secondary/15 text-purple-400 aurora-light:text-accent-secondary'
                          : 'bg-muted text-muted-foreground')
                      }
                    >
                      {t(`profileEditor.agentChain.kind.${a.kind}`)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <DndContext sensors={sortableSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={profile.agents.map((a) => a.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {profile.agents.map((agent, idx) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  required={requiredAgents.has(agent.id)}
                  canRemove={!requiredAgents.has(agent.id)}
                  models={modelCatalog}
                  defaultModel={defaultModel}
                  customModelAliases={customModelAliases}
                  onModel={(m) => setAgentModel(idx, m)}
                  onRemove={() => removeAgent(idx)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </section>

      {/* Routing */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('profileEditor.routing.heading', { n: profile.routing.length })}
          </h2>
          <div className="flex items-center gap-1">
            {!hasDefaultRoutingRule && (
              <Button
                size="sm"
                variant="ghost"
                onClick={addDefaultRoutingRule}
                disabled={profile.agents.length === 0}
                title={profile.agents.length === 0 ? t('profileEditor.routing.needAgentsTitle') : undefined}
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> {t('profileEditor.routing.addDefault')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAddRoutingPrompt(true)}
              disabled={profile.agents.length === 0}
              title={profile.agents.length === 0 ? t('profileEditor.routing.needAgentsTitle') : undefined}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> {t('profileEditor.routing.addRule')}
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mb-2">
          {t('profileEditor.routing.explainer')}
        </p>
        {agentsMissingRouting.length > 0 && (
          <div className="mb-2 px-3 py-2 text-xs rounded-md border border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/10 aurora-light:bg-accent-warning/10 text-yellow-500 aurora-light:text-accent-warning">
            <div className="font-medium mb-1">{t('profileEditor.routing.untargetedTitle')}</div>
            <div>
              <Trans
                t={t}
                i18nKey="profileEditor.routing.untargetedDetail"
                values={{ agents: agentsMissingRouting.join(', ') }}
                components={{ mono: <span className="font-mono" /> }}
              />
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          {profile.routing.map((rule, idx) => {
            const isDefault = 'default' in rule && rule.default === true
            return (
              <RoutingRow
                key={idx}
                rule={rule}
                ordinal={idx + 1}
                isLast={idx === profile.routing.length - 1}
                canMove={!isDefault}
                canRemove={!isDefault}
                canEdit={!isDefault}
                chainAgents={profile.agents.map((a) => a.id)}
                onAgentChange={(agent) => setRoutingRuleAgent(idx, agent)}
                onEdit={() => setEditRoutingIdx(idx)}
                onUp={() => moveRoutingRule(idx, -1)}
                onDown={() => moveRoutingRule(idx, 1)}
                onRemove={() => removeRoutingRule(idx)}
              />
            )
          })}
        </div>
      </section>

      {footer && <div className="pt-3 border-t border-border">{footer}</div>}
    </div>
  )
}

function AgentRow({
  agent,
  required,
  canRemove,
  models,
  defaultModel,
  customModelAliases,
  onModel,
  onRemove,
}: {
  agent: ProfileAgent
  required: boolean
  canRemove: boolean
  models: ProfileModelOption[]
  defaultModel: string
  customModelAliases: boolean
  onModel: (m: ModelAlias) => void
  onRemove: () => void
}) {
  const { t } = useTranslation('agentstudio')
  // Baseline is required + pinned on every profile. Architect first,
  // merge-resolver last.
  const isRequired = required
  const pinnedFirst = agent.id === 'sr-architect'
  const pinnedLast = agent.id === 'sr-merge-resolver'
  // sr-merge-resolver and sr-architect stay draggable like the rest; the
  // ProfileEditor's reorder handler snaps them back to first/last slots
  // after any drop so the pipeline invariant is preserved at the data layer
  // without making the UI feel inconsistent.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.id,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 10 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border group hover:bg-accent/30 transition-colors bg-background"
    >
      <button
        type="button"
        className="flex-shrink-0 p-0.5 rounded text-muted-foreground cursor-grab active:cursor-grabbing hover:text-foreground"
        title={t('profileEditor.agentRow.dragTitle')}
        aria-label={t('profileEditor.agentRow.dragHandleAria')}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <span className="text-sm font-mono flex-1 truncate">{agent.id}</span>
      {pinnedFirst && (
        <span
          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-accent-primary/15 text-accent-primary"
          title={t('profileEditor.agentRow.pinnedFirstTitle')}
        >
          <Pin className="w-2.5 h-2.5 rotate-[135deg]" /> {t('profileEditor.agentRow.pinnedFirst')}
        </span>
      )}
      {pinnedLast && (
        <span
          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-accent-primary/15 text-accent-primary"
          title={t('profileEditor.agentRow.pinnedLastTitle')}
        >
          <Pin className="w-2.5 h-2.5 rotate-45" /> {t('profileEditor.agentRow.pinnedLast')}
        </span>
      )}
      {isRequired && !pinnedFirst && !pinnedLast && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          {t('profileEditor.agentRow.required')}
        </span>
      )}
      <ModelSelect
        value={agent.model ?? defaultModel}
        models={models}
        customModelAliases={customModelAliases}
        testId={`profile-agent-model-${agent.id}`}
        onChange={onModel}
      />
      <button
        type="button"
        className="p-1 hover:bg-red-500/20 aurora-light:hover:bg-destructive/15 text-red-400 aurora-light:text-destructive rounded disabled:opacity-30 disabled:cursor-not-allowed opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={onRemove}
        disabled={!canRemove}
        title={
          canRemove
            ? t('common:actions.remove')
            : t('profileEditor.agentRow.requiredRemoveTitle')
        }
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}

function RoutingRow({
  rule,
  ordinal,
  isLast,
  canMove,
  canRemove,
  canEdit,
  chainAgents,
  onAgentChange,
  onEdit,
  onUp,
  onDown,
  onRemove,
}: {
  rule: RoutingRule
  ordinal: number
  isLast: boolean
  canMove: boolean
  canRemove: boolean
  canEdit: boolean
  chainAgents: string[]
  onAgentChange: (agent: string) => void
  onEdit: () => void
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation('agentstudio')
  const isDefault = 'default' in rule && rule.default === true
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border group hover:bg-accent/30 transition-colors">
      <span className="text-[10px] font-mono text-muted-foreground w-5 text-center flex-shrink-0">
        {ordinal}.
      </span>
      {isDefault ? (
        <span className="text-xs text-muted-foreground flex-1">{t('profileEditor.routingRow.everythingElse')}</span>
      ) : (
        <span className="text-xs flex-1 flex gap-1 flex-wrap items-center">
          {(rule as RoutingTagRule).tags.map((t) => (
            <span key={t} className="px-1.5 py-0.5 rounded bg-muted font-mono text-[11px]">
              {t}
            </span>
          ))}
        </span>
      )}
      <span className="text-xs text-muted-foreground">→</span>
      {isDefault ? (
        <span
          className="h-7 max-w-[15rem] px-2 text-xs font-mono rounded border border-border bg-muted/40 text-muted-foreground inline-flex items-center"
          aria-label={t('profileEditor.routingRow.defaultTargetAria')}
          title={t('profileEditor.routingRow.defaultTargetTitle')}
        >
          {rule.agent}
        </span>
      ) : (
        <select
          value={rule.agent}
          onChange={(e) => onAgentChange(e.target.value)}
          aria-label={t('profileEditor.routingRow.targetAria', { ordinal })}
          className="h-7 max-w-[15rem] px-2 text-xs font-mono rounded border border-border bg-background"
        >
          {chainAgents.map((agentId) => (
            <option key={agentId} value={agentId}>
              {agentId}
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {canEdit && (
          <button
            type="button"
            className="p-1 hover:bg-accent rounded"
            onClick={onEdit}
            title={t('profileEditor.routingRow.editTitle')}
            aria-label={t('profileEditor.routingRow.editAria', { ordinal })}
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
        {canMove && !isLast && (
          <button type="button" className="p-1 hover:bg-accent rounded" onClick={onDown} title={t('profileEditor.routingRow.moveDown')}>
            <ArrowDown className="w-3 h-3" />
          </button>
        )}
        {canMove && ordinal > 1 && (
          <button type="button" className="p-1 hover:bg-accent rounded" onClick={onUp} title={t('profileEditor.routingRow.moveUp')}>
            <ArrowUp className="w-3 h-3" />
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            className="p-1 hover:bg-red-500/20 aurora-light:hover:bg-destructive/15 text-red-400 aurora-light:text-destructive rounded"
            onClick={onRemove}
            title={t('common:actions.remove')}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {isDefault && (
        <span
          className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
          title={t('profileEditor.routingRow.coreDefaultTitle')}
        >
          {t('profileEditor.routingRow.coreDefaultBadge')}
        </span>
      )}
    </div>
  )
}

function ModelSelect({
  value,
  models,
  customModelAliases,
  testId,
  onChange,
}: {
  value: ModelAlias
  models: ProfileModelOption[]
  customModelAliases: boolean
  testId?: string
  onChange: (m: ModelAlias) => void
}) {
  if (customModelAliases) {
    return (
      <CustomModelAliasInput
        value={value}
        options={models}
        ariaLabel="Model alias"
        testId={testId}
        className="h-7 w-52 bg-background px-2 text-xs"
        onCommit={onChange}
      />
    )
  }

  // Keep a configured custom alias visible even when it is not part of the
  // provider's static official catalog. The backend validates configured
  // aliases; the client must not silently replace them with a Claude model.
  const options = models.some((model) => model.value === value)
    ? models
    : [...models, { value, label: value }]
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ModelAlias)}
      className="h-7 px-2 text-xs rounded border border-border bg-background"
    >
      {options.map((model) => (
        <option key={model.value} value={model.value}>
          {model.label}
        </option>
      ))}
    </select>
  )
}
