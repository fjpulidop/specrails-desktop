import { useCallback, useEffect, useState } from 'react'
import { Save, Trash2, History, ArrowLeft, AlertCircle, FlaskConical, Loader2, Wand2 } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { getApiBase } from '../../lib/api'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ConfirmDialog } from './PromptDialog'

interface AgentVersion {
  version: number
  body: string
  createdAt: number
}

interface Props {
  /** Existing agent id (e.g. `custom-qa`) when editing; omit for create mode. */
  agentId?: string
  /** Optional initial body (used by "Duplicate" / "Generate" to prefill). */
  initialBody?: string
  /** Optional initial name for create mode (used by Generate flow). */
  initialName?: string
  /**
   * When set in edit mode, hydrate the editor from the matching AI Refine
   * session's draft body instead of the on-disk file. Renders a "Resume AI
   * Edit" pill in the header so the user can hand the draft back to the
   * overlay.
   */
  draftFromRefine?: string
  provider?: string
  defaultModel?: string
  onClose: () => void
  onSaved?: (id: string) => void
  /**
   * Called when the user clicks the "Resume AI Edit" pill. Receives
   * (refineId, agentId, baseBody) so the parent can re-open the overlay.
   */
  onResumeRefine?: (refineId: string, agentId: string, baseBody: string) => void
  /** Safe provider tool policies are required for test/refine automation. */
  automationEnabled?: boolean
}

// Template catalog lives in agentTemplates.ts (45+ entries across 13
// categories). Re-exported here for backward compatibility with callers
// that import AGENT_TEMPLATES from AgentStudio.
export { AGENT_TEMPLATES, type AgentTemplate } from './agentTemplates'

const SAMPLE_TASKS: Array<{ labelKey: string; prompt: string }> = [
  {
    labelKey: 'studio.sampleTasks.pick',
    prompt: '',
  },
  {
    labelKey: 'studio.sampleTasks.terraform',
    prompt: 'Review this Terraform diff:\n+ resource "aws_s3_bucket" "logs" {\n+   bucket = "app-logs"\n+   acl    = "public-read"\n+ }',
  },
  {
    labelKey: 'studio.sampleTasks.sqlInjection',
    prompt: 'Review this Node.js snippet for security issues:\n\n```js\napp.get("/user/:id", async (req, res) => {\n  const row = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)\n  res.json(row)\n})\n```',
  },
  {
    labelKey: 'studio.sampleTasks.accessibility',
    prompt: 'Review this React component for accessibility issues:\n\n```tsx\nfunction ProductCard({ product, onAddToCart }) {\n  return (\n    <div onClick={onAddToCart} className="card">\n      <img src={product.image} />\n      <h3>{product.name}</h3>\n      <div className="price">${product.price}</div>\n    </div>\n  )\n}\n```',
  },
  {
    labelKey: 'studio.sampleTasks.schemaChange',
    prompt: 'Evaluate this migration plan:\n- Add NOT NULL column `email_verified_at` (timestamp) to a 50M-row `users` table\n- Backfill with `NOW()` for existing rows\n- Deploy without downtime\n\nIs this safe? What would you change?',
  },
  {
    labelKey: 'studio.sampleTasks.slowQuery',
    prompt: 'Explain why this Postgres query is slow on a 10M-row `orders` table and propose an index:\n\n```sql\nSELECT * FROM orders\nWHERE customer_id = $1\n  AND status IN (\'pending\', \'paid\')\n  AND created_at > NOW() - INTERVAL \'30 days\'\nORDER BY created_at DESC\nLIMIT 50;\n```',
  },
]

export function blankTemplate(
  provider: string,
  defaultModel: string,
  name = 'custom-<name>',
): string {
  const providerMetadata = provider === 'claude'
    ? 'color: blue\nmemory: project\n'
    : ''
  return `---
name: ${name}
description: "Short description of when to use this agent."
model: ${defaultModel}
${providerMetadata}\
---

# Identity

You are ...

# Mission

...

# Workflow protocol

...

# Personality

- **tone**: terse
- **risk_tolerance**: conservative
- **detail_level**: full
- **focus_areas**: ...
`
}

export function synchronizeFrontmatterName(body: string, name: string): string {
  const match = body.match(/^---(\r?\n)([\s\S]*?)\r?\n---/)
  if (!match) return body
  const newline = match[1]
  const frontmatter = /^name:\s*.*$/m.test(match[2])
    ? match[2].replace(/^name:\s*.*$/m, `name: ${name}`)
    : `name: ${name}${newline}${match[2]}`
  return body.replace(match[0], `---${newline}${frontmatter}${newline}---`)
}

export function customRoleDisplayPath(provider: string, agentId: string): string {
  if (provider === 'kimi') return `.kimi-code/skills/${agentId}/SKILL.md`
  if (provider === 'codex') return `.codex/skills/rails/${agentId}/SKILL.md`
  if (provider === 'gemini') return `.gemini/agents/${agentId}.md`
  return `.claude/agents/${agentId}.md`
}

export function AgentStudio({
  agentId,
  initialBody,
  initialName,
  draftFromRefine,
  provider = 'claude',
  defaultModel = 'sonnet',
  onClose,
  onSaved,
  onResumeRefine,
  automationEnabled = true,
}: Props) {
  const { t } = useTranslation('agentstudio')
  const isCreate = !agentId
  const initialId = agentId ?? initialName ?? ''
  const [id, setId] = useState(initialId)
  const [body, setBody] = useState(
    initialBody ?? blankTemplate(provider, defaultModel, initialId || undefined),
  )
  const [loading, setLoading] = useState(!isCreate && !initialBody && !draftFromRefine)
  const [refineDraftLoading, setRefineDraftLoading] = useState(!!draftFromRefine && !isCreate)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [versions, setVersions] = useState<AgentVersion[]>([])
  const [showVersions, setShowVersions] = useState(false)
  const [dirty, setDirty] = useState(!!initialBody && isCreate)
  const [testPaneOpen, setTestPaneOpen] = useState(false)
  const [sampleTask, setSampleTask] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<
    { output: string; tokens: number | null; durationMs: number } | null
  >(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (isCreate || initialBody !== undefined) return
    // Refine handoff path: load draft body from the in-flight session.
    if (draftFromRefine) {
      let cancelled = false
      fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId!)}/refine/${draftFromRefine}?provider=${encodeURIComponent(provider)}`)
        .then((r) => {
          if (!r.ok) throw new Error(t('studio.errors.loadDraftFailed', { status: r.status }))
          return r.json() as Promise<{ draftBody: string | null }>
        })
        .then((data) => {
          if (!cancelled && data.draftBody) {
            setBody(data.draftBody)
            setDirty(true)
          }
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message)
        })
        .finally(() => {
          if (!cancelled) setRefineDraftLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
    let cancelled = false
    fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId!)}?provider=${encodeURIComponent(provider)}`)
      .then((r) => {
        if (!r.ok) throw new Error(t('studio.errors.loadFailed', { status: r.status }))
        return r.json() as Promise<{ id: string; body: string }>
      })
      .then((data) => {
        if (!cancelled) setBody(data.body)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, draftFromRefine, initialBody, isCreate, provider, t])

  const loadVersions = useCallback(() => {
    if (isCreate) return
    fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId!)}/versions?provider=${encodeURIComponent(provider)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ versions: AgentVersion[] }>) : { versions: [] }))
      .then((d) => setVersions(d.versions))
      .catch(() => setVersions([]))
  }, [agentId, isCreate, provider])

  useEffect(() => {
    if (showVersions) loadVersions()
  }, [showVersions, loadVersions])

  // Local validation
  const nameValid = /^custom-[a-z0-9][a-z0-9-]*$/.test(id)
  const bodyValid = body.trim().length > 0
  const hasFrontmatter = /^---\s*\n[\s\S]*?\n---/.test(body)
  const canSave = bodyValid && hasFrontmatter && (isCreate ? nameValid : true) && dirty

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      let res: Response
      const persistedBody = isCreate && provider === 'kimi'
        ? synchronizeFrontmatterName(body, id)
        : body
      if (isCreate) {
        res = await fetch(`${getApiBase()}/profiles/catalog?provider=${encodeURIComponent(provider)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, body: persistedBody, provider }),
        })
      } else {
        res = await fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId!)}?provider=${encodeURIComponent(provider)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        })
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? t('studio.errors.saveFailed', { status: res.status }))
      }
      setDirty(false)
      if (persistedBody !== body) setBody(persistedBody)
      toast.success(isCreate ? t('studio.toasts.agentCreated') : t('studio.toasts.agentSaved'), {
        description: isCreate ? id : agentId,
      })
      if (onSaved) onSaved(isCreate ? id : agentId!)
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      toast.error(isCreate ? t('studio.toasts.createFailed') : t('studio.toasts.saveFailed'), {
        description: message,
      })
    } finally {
      setSaving(false)
    }
  }, [agentId, body, id, isCreate, onSaved, provider, t])

  const remove = useCallback(async () => {
    if (isCreate) return
    setConfirmDelete(false)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId!)}?provider=${encodeURIComponent(provider)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? t('studio.errors.deleteFailed', { status: res.status }))
      }
      toast.success(t('studio.toasts.agentDeleted'), { description: agentId })
      if (onSaved) onSaved(agentId!)
      onClose()
    } catch (e) {
      const message = (e as Error).message
      setError(message)
      toast.error(t('studio.toasts.deleteFailed'), { description: message })
    } finally {
      setSaving(false)
    }
  }, [agentId, isCreate, onClose, onSaved, provider, t])

  const restore = useCallback((v: AgentVersion) => {
    setBody(v.body)
    setDirty(true)
    setShowVersions(false)
  }, [])

  const runTest = useCallback(async () => {
    if (!automationEnabled) return
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const res = await fetch(`${getApiBase()}/profiles/catalog/test?provider=${encodeURIComponent(provider)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: isCreate ? id || 'draft' : agentId,
          draftBody: body,
          sampleTask,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? t('studio.errors.testFailed', { status: res.status }))
      }
      const data = (await res.json()) as { output: string; tokens: number | null; durationMs: number }
      setTestResult(data)
    } catch (e) {
      setTestError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }, [agentId, automationEnabled, body, id, isCreate, provider, sampleTask, t])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">{t('studio.loadingAgent')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {!isCreate && (
        <ConfirmDialog
          open={confirmDelete}
          title={t('studio.deleteConfirm.title', { agentId })}
          description={t('studio.deleteConfirm.description')}
          confirmLabel={t('common:actions.delete')}
          destructive
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border">
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          title={t('common:actions.back')}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            {isCreate ? t('studio.modeCreate') : t('studio.modeEdit')}
          </div>
          {isCreate ? (
            <Input
              value={id}
              onChange={(e) => {
                const nextId = e.target.value
                setId(nextId)
                if (provider === 'kimi') {
                  setBody((current) =>
                    synchronizeFrontmatterName(current, nextId || 'custom-<name>'),
                  )
                }
                setDirty(true)
              }}
              placeholder="custom-my-agent"
              className="text-sm font-mono mt-1 max-w-sm"
            />
          ) : (
            <div className="flex items-center gap-2">
              <div className="text-sm font-mono">{agentId}</div>
              {automationEnabled && draftFromRefine && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!onResumeRefine || !agentId) return
                    try {
                      const r = await fetch(
                        `${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}?provider=${encodeURIComponent(provider)}`,
                      )
                      if (!r.ok) return
                      const data = (await r.json()) as { body: string }
                      onResumeRefine(draftFromRefine, agentId, data.body)
                    } catch { /* ignore */ }
                  }}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border border-accent-primary/40 bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
                  title={t('studio.resumeAiEditTitle')}
                >
                  <Wand2 className="w-3 h-3" /> {t('studio.resumeAiEdit')}
                </button>
              )}
              {refineDraftLoading && (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> {t('studio.loadingAiDraft')}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {automationEnabled && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTestPaneOpen((v) => !v)
                if (!testPaneOpen) setShowVersions(false)
              }}
              title={t('studio.testButtonTitle')}
            >
              <FlaskConical className="w-3.5 h-3.5 mr-1" />
              {t('studio.testButton')}
            </Button>
          )}
          {!isCreate && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowVersions((v) => !v)
                if (!showVersions) setTestPaneOpen(false)
              }}
              title={t('studio.historyButtonTitle')}
            >
              <History className="w-3.5 h-3.5 mr-1" />
              {t('studio.historyButton')}
            </Button>
          )}
          {!isCreate && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              disabled={saving}
              className="text-red-400 hover:text-red-300 aurora-light:text-destructive aurora-light:hover:text-destructive"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              {t('common:actions.delete')}
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={!canSave || saving}>
            <Save className="w-3.5 h-3.5 mr-1" />
            {saving ? t('common:states.saving') : isCreate ? t('studio.create') : t('common:actions.save')}
          </Button>
        </div>
      </div>

      {/* Error strip */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs border-b border-red-500/30 aurora-light:border-destructive/30 bg-red-500/10 aurora-light:bg-destructive/10 text-red-400 aurora-light:text-destructive">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Validation hints */}
      {isCreate && id.length > 0 && !nameValid && (
        <div className="px-4 py-1.5 text-[11px] border-b border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/10 aurora-light:bg-accent-warning/10 text-yellow-500 aurora-light:text-accent-warning">
          <Trans t={t} i18nKey="studio.validation.namePattern" components={{ code: <code /> }} />
        </div>
      )}
      {!hasFrontmatter && (
        <div className="px-4 py-1.5 text-[11px] border-b border-yellow-500/30 aurora-light:border-accent-warning/30 bg-yellow-500/10 aurora-light:bg-accent-warning/10 text-yellow-500 aurora-light:text-accent-warning">
          <Trans t={t} i18nKey="studio.validation.missingFrontmatter" components={{ code: <code /> }} />
        </div>
      )}

      {/* Body + versions */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 py-1.5 border-b border-border text-[11px] font-mono text-muted-foreground flex items-center justify-between">
            <span>{customRoleDisplayPath(provider, isCreate ? id || 'custom-…' : agentId!)}</span>
            {dirty && <span className="text-yellow-500 aurora-light:text-accent-warning">{t('studio.unsaved')}</span>}
          </div>
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
            className="flex-1 w-full p-4 text-xs font-mono bg-background text-foreground outline-none resize-none leading-relaxed"
          />
        </div>

        {automationEnabled && testPaneOpen && (
          <aside className="w-96 flex-shrink-0 border-l border-border flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <FlaskConical className="w-3.5 h-3.5" /> {t('studio.testPane.header')}
            </div>
            <div className="p-3 border-b border-border">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] text-muted-foreground">{t('studio.testPane.sampleTaskLabel')}</label>
                <select
                  className="h-6 text-[11px] rounded border border-border bg-background px-1"
                  value=""
                  onChange={(e) => {
                    const idx = parseInt(e.target.value, 10)
                    if (!isNaN(idx) && idx > 0) setSampleTask(SAMPLE_TASKS[idx].prompt)
                  }}
                  disabled={testing}
                >
                  {SAMPLE_TASKS.map((s, i) => (
                    <option key={i} value={i}>{t(s.labelKey)}</option>
                  ))}
                </select>
              </div>
              <textarea
                value={sampleTask}
                onChange={(e) => setSampleTask(e.target.value)}
                placeholder={t('studio.testPane.placeholder')}
                className="w-full text-xs p-2 rounded border border-border bg-background min-h-[80px] resize-y font-mono"
                disabled={testing}
              />
              <div className="flex items-center gap-2 mt-2">
                <Button
                  size="sm"
                  onClick={runTest}
                  disabled={testing || !sampleTask.trim() || !body.trim()}
                >
                  {testing ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> {t('studio.testPane.running')}
                    </>
                  ) : (
                    <>
                      <FlaskConical className="w-3.5 h-3.5 mr-1.5" /> {t('studio.testPane.run')}
                    </>
                  )}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {t('studio.testPane.sandboxNote')}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-3 min-h-0">
              {testError && (
                <div className="px-3 py-2 text-xs rounded border border-red-500/30 aurora-light:border-destructive/30 bg-red-500/10 aurora-light:bg-destructive/10 text-red-400 aurora-light:text-destructive mb-2">
                  {testError}
                </div>
              )}
              {testResult && (
                <>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-2">
                    <span>
                      {testResult.tokens === null ? (
                        <span
                          className="text-foreground font-mono"
                          title={t('studio.testPane.tokensUnavailable')}
                          aria-label={t('studio.testPane.tokensUnavailable')}
                        >
                          —
                        </span>
                      ) : (
                        <Trans
                          t={t}
                          i18nKey="studio.testPane.tokens"
                          count={testResult.tokens}
                          components={{ mono: <span className="text-foreground font-mono" /> }}
                        />
                      )}
                    </span>
                    <span>
                      <span className="text-foreground font-mono">
                        {(testResult.durationMs / 1000).toFixed(1)}s
                      </span>
                    </span>
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed rounded border border-border bg-background p-3">
                    {testResult.output}
                  </pre>
                </>
              )}
              {!testing && !testResult && !testError && (
                <p className="text-[11px] text-muted-foreground italic">
                  {t('studio.testPane.emptyHint')}
                </p>
              )}
            </div>
          </aside>
        )}
        {showVersions && !isCreate && (
          <aside className="w-72 flex-shrink-0 border-l border-border flex flex-col">
            <div className="px-3 py-2 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('studio.versions.header')}
            </div>
            <div className="flex-1 overflow-auto p-2 space-y-1">
              {versions.length === 0 ? (
                <div className="text-[11px] text-muted-foreground italic px-2 py-2">
                  {t('studio.versions.empty')}
                </div>
              ) : (
                versions.map((v) => (
                  <button
                    key={v.version}
                    type="button"
                    onClick={() => restore(v)}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-accent/50 transition-colors"
                  >
                    <div className="text-xs font-mono text-foreground">v{v.version}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="px-3 py-2 border-t border-border text-[11px] text-muted-foreground">
              {t('studio.versions.restoreHint')}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
