/**
 * FileStoryManager — on-demand, budget-gated generation of the plain-language
 * "what this spec contributed to this file" paragraph shown on each card of
 * the Code/Files construction story.
 *
 * Mirrors FileSummaryManager's cost discipline: the SAME monthly budget
 * setting (`summary_monthly_budget_usd`) and the SAME ai_invocations surface
 * (`'file-summary'`) — one budget covers the whole Code-section AI spend and
 * analytics need no new surface. Generation is user-initiated (per-card
 * "Explain" button), in-flight-deduped per provenanceId, and persists to
 * `file_story_contributions.summary` (see file-story.ts / migration 37).
 */
import { randomUUID } from 'crypto'
import type { DbInstance } from './db'
import type { WsMessage, FileStoryUpdatedMessage } from './types'
import { recordInvocation, type Surface } from './ai-invocations'
import { getContribution, setContributionSummary, type TicketSpecLookup } from './file-story'
import type { GenerateInput, GenerateOutput, SummaryLanguage } from './file-summary-manager'

const STORY_PROMPT_EN =
  'You are telling a non-developer how one part of an app was built. Below is one change made to a file: ' +
  'the goal it implemented (a spec title) and the code changes (a diff). Write 1 to 3 sentences in plain ' +
  'language describing what this specific change contributed to this file. No code, no jargon, no lists. ' +
  'Output only the explanation, nothing else.'

const STORY_PROMPT_ES =
  'Estás contando a una persona no desarrolladora cómo se construyó una parte de una app. Abajo hay un cambio ' +
  'hecho a un archivo: el objetivo que implementó (el título de una spec) y los cambios de código (un diff). ' +
  'Escribe entre 1 y 3 frases en lenguaje llano describiendo qué aportó este cambio concreto a este archivo. ' +
  'Sin código, sin jerga, sin listas. Devuelve solo la explicación, nada más.'

export function buildStorySystemPrompt(language: SummaryLanguage): string {
  return language === 'es' ? STORY_PROMPT_ES : STORY_PROMPT_EN
}

/** Bound on the generated paragraph (defensive, mirrors SUMMARY_MAX_LENGTH scale). */
export const STORY_SUMMARY_MAX_LENGTH = 2000
/** Bound on the diff excerpt fed to the model. */
const PROMPT_PATCH_MAX_CHARS = 12000

export type ExplainResult =
  | 'generated'
  | 'skipped:budget'
  | 'skipped:not-found'
  | 'failed'

export interface ExplainRequest {
  projectId: string
  /** POSIX-normalized rel path of the file (guarded by the router). */
  relPath: string
  provenanceId: number
  overrideBudget?: boolean
}

export interface FileStoryDeps {
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  generate: (input: GenerateInput, signal?: AbortSignal) => Promise<GenerateOutput>
  monthToDateSpend: (projectId: string) => number
  monthlyBudgetUsd: () => number
  language?: () => SummaryLanguage
  providerId?: () => string
  getTicketSpec?: TicketSpecLookup
  now?: () => number
}

export class FileStoryManager {
  private readonly deps: FileStoryDeps
  /** In-flight dedupe: a second Explain for the same intervention rides the first. */
  private readonly inFlight = new Map<number, Promise<ExplainResult>>()

  constructor(deps: FileStoryDeps) {
    this.deps = deps
  }

  explain(req: ExplainRequest): Promise<ExplainResult> {
    const existing = this.inFlight.get(req.provenanceId)
    if (existing) return existing

    // Synchronous gates run BEFORE registering in-flight so a skip result is
    // never cached in the dedupe map (a budget skip followed immediately by an
    // override retry must not ride the stale skipped promise).
    //
    // Resolve the intervention: the provenance row must exist AND belong to
    // the requested path (the router already guarded the path; this pins the id).
    const prov = this._loadProvenance(req.provenanceId)
    if (!prov || prov.file_path !== req.relPath) return Promise.resolve('skipped:not-found')

    // Budget gate — same monthly cap as file summaries; explicit override only.
    if (!req.overrideBudget) {
      const spend = this.deps.monthToDateSpend(req.projectId)
      if (spend >= this.deps.monthlyBudgetUsd()) return Promise.resolve('skipped:budget')
    }

    const p = this._explainInner(req, prov)
    this.inFlight.set(req.provenanceId, p)
    void p.catch(() => undefined).finally(() => {
      if (this.inFlight.get(req.provenanceId) === p) this.inFlight.delete(req.provenanceId)
    })
    return p
  }

  private async _explainInner(
    req: ExplainRequest,
    prov: { id: number; file_path: string; ticket_id: number | null; job_id: string | null; kind: string },
  ): Promise<ExplainResult> {
    const startedIso = new Date((this.deps.now ?? Date.now)()).toISOString()
    const lang: SummaryLanguage = this.deps.language?.() ?? 'en'

    // Compose the change description: spec title (live lookup, tolerant) +
    // kind + the stored patch (full patch preferred, excerpt fallback,
    // honest note when neither survived).
    let ticketTitle: string | null = null
    if (prov.ticket_id != null) {
      try { ticketTitle = this.deps.getTicketSpec?.(prov.ticket_id)?.title ?? null } catch { ticketTitle = null }
    }
    const patch = this._loadPatch(req.provenanceId)
    const parts: string[] = []
    parts.push(`Spec: ${ticketTitle ?? (prov.ticket_id != null ? `#${prov.ticket_id}` : 'unknown')}`)
    parts.push(`Change kind: ${prov.kind}`)
    parts.push(patch ? `Diff:\n${patch.slice(0, PROMPT_PATCH_MAX_CHARS)}` : 'Diff: (not stored for this change)')

    try {
      const out = await this.deps.generate({
        relPath: req.relPath,
        contents: parts.join('\n\n'),
        truncated: (patch?.length ?? 0) > PROMPT_PATCH_MAX_CHARS,
        language: lang,
      })
      const bounded = out.summary.length > STORY_SUMMARY_MAX_LENGTH
        ? out.summary.slice(0, STORY_SUMMARY_MAX_LENGTH)
        : out.summary
      const persisted = setContributionSummary(
        this.deps.db,
        req.provenanceId,
        bounded,
        out.model,
        new Date((this.deps.now ?? Date.now)()).toISOString(),
      )
      this._recordInvocation(req, startedIso, 'success', out)
      this.deps.broadcast(this._storyMsg(req, persisted, persisted ? undefined : 'persist-failed'))
      this.deps.broadcast({ type: 'spending.invalidated', projectId: req.projectId })
      return persisted ? 'generated' : 'failed'
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      // Carry any partial usage the generator captured (mirrors FileSummaryManager).
      const partial = (err as { partial?: Partial<GenerateOutput> }).partial
      this._recordInvocation(req, startedIso, 'failed', partial)
      this.deps.broadcast(this._storyMsg(req, false, reason))
      return 'failed'
    }
  }

  private _storyMsg(req: ExplainRequest, ok: boolean, reason?: string): FileStoryUpdatedMessage {
    return {
      type: 'file.story_updated',
      projectId: req.projectId,
      path: req.relPath,
      provenanceId: req.provenanceId,
      ok,
      ...(reason ? { reason } : {}),
    }
  }

  private _loadProvenance(provenanceId: number): { id: number; file_path: string; ticket_id: number | null; job_id: string | null; kind: string } | null {
    try {
      const row = this.deps.db.prepare(
        `SELECT id, file_path, ticket_id, job_id, kind FROM file_provenance WHERE id = ?`,
      ).get(provenanceId) as { id: number; file_path: string; ticket_id: number | null; job_id: string | null; kind: string } | undefined
      return row ?? null
    } catch {
      return null
    }
  }

  private _loadPatch(provenanceId: number): string | null {
    try {
      const row = this.deps.db.prepare(
        `SELECT patch FROM file_provenance_diffs WHERE provenance_id = ?`,
      ).get(provenanceId) as { patch: string } | undefined
      if (row?.patch) return row.patch
    } catch { /* fall through to excerpt */ }
    return getContribution(this.deps.db, provenanceId)?.patch_excerpt ?? null
  }

  private _recordInvocation(
    req: ExplainRequest,
    startedIso: string,
    status: 'success' | 'failed',
    out?: Partial<GenerateOutput>,
  ): void {
    try {
      recordInvocation(this.deps.db, {
        id: randomUUID(),
        project_id: req.projectId,
        provider: out?.provider ?? this.deps.providerId?.() ?? 'claude',
        surface: 'file-summary' as Surface,
        surface_ref_id: null,
        ticket_id: this._loadProvenance(req.provenanceId)?.ticket_id ?? null,
        status,
        started_at: startedIso,
        finished_at: new Date((this.deps.now ?? Date.now)()).toISOString(),
        model: out?.model,
        total_cost_usd: out?.costUsd ?? undefined,
        tokens_in: out?.tokensIn ?? undefined,
        tokens_out: out?.tokensOut ?? undefined,
        tokens_cache_read: out?.tokensCacheRead,
        tokens_cache_create: out?.tokensCacheCreate,
        duration_ms: out?.durationMs ?? 0,
        num_turns: 1,
        total_cost_usd_estimated: !!out?.costEstimated,
      })
    } catch (err) {
      console.error('[file-story] recordInvocation failed:', err)
    }
  }
}
