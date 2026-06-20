// Provider adapter contract.
//
// Managers (chat, queue, agent-refine, setup, profile, plugin, explore-cwd,
// result-event, project-router) consume this contract exclusively for
// spawn-time decisions. Branching on `adapter.capabilities.*` is fine;
// branching on `provider === 'claude'` is forbidden.
//
// Spec: openspec/specs/multi-provider-architecture/spec.md

export type ProviderId = string

export type SpawnAction =
  | 'chat-turn'
  | 'chat-resume'
  | 'chat-stream'
  | 'rail-job'
  | 'spec-gen'
  | 'agent-refine'
  | 'setup-enrich'
  | 'setup-enrich-resume'
  | 'auto-title'

export interface SpawnOptions {
  prompt: string
  systemPrompt?: string
  model: string
  sessionId?: string
  /** Bound on agentic tool-use turns. Honoured iff the provider supports it. */
  maxTurns?: number
  /** Pre-extracted text blocks for attachments (image refs or extracted text). */
  attachmentTextBlocks?: string[]
  /** Additional argv to forward verbatim (provider-specific extras). */
  extraArgs?: string[]
  /**
   * Load the user's full Claude environment for this spawn (claude only).
   * When true the claude adapter emits `--setting-sources user,project,local`
   * instead of the isolated `project,local`, so the developer's user-scope,
   * plugin-bundled, and connector MCP servers (the ones `claude mcp add` /
   * plugins register) are discovered. Gated behind the Add Spec "My approved
   * MCPs" toggle — it also re-loads user CLAUDE.md memory + hooks, which the
   * isolated default intentionally excludes.
   */
  loadUserEnv?: boolean
}

export type AdapterEvent =
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool-use'; name: string; inputPreview: string }
  | { kind: 'session-started'; sessionId: string }
  | { kind: 'result'; payload: Record<string, unknown> }
  // Provider reported an explicit failure for the turn (e.g. codex
  // `turn.failed` / top-level `error`). Carries the human-readable reason so
  // callers can surface it instead of swallowing it into `{ kind: 'other' }`.
  | { kind: 'error'; message: string }
  | { kind: 'other'; type: string; raw: Record<string, unknown> }

export interface NormalisedResult {
  tokens_in?: number
  tokens_out?: number
  tokens_cache_read?: number
  tokens_cache_create?: number
  /** Only populated when the provider reports cost natively. Estimation is
   *  the caller's job (see server/pricing.ts). */
  total_cost_usd?: number
  num_turns?: number
  model?: string
  duration_ms?: number
  duration_api_ms?: number
  session_id?: string
}

export interface DetectionResult {
  installed: boolean
  executable: boolean
  version?: string
  meetsMinimum?: boolean
  /** Human-readable error / hint when not usable. */
  error?: string
}

export interface ProviderCapabilities {
  /** CLI supports resuming a session by id natively (no synthetic id workaround). */
  nativeResume: boolean
  /** CLI emits JSONL events natively (e.g. `--json` or stream-json). */
  nativeStreamJson: boolean
  /** CLI reports `total_cost_usd` in its terminal event. */
  nativeCostUsd: boolean
  /** CLI honours environment variables for OTLP export. */
  nativeOtelEnv: boolean
  /** Provider runtime reads `SPECRAILS_PROFILE_PATH` env var. */
  profileEnvSupport: boolean
  /** CLI accepts a `--system-prompt`-style flag. When false, the adapter folds
   *  the system prompt into the user prompt before spawning. */
  systemPromptArg: boolean
  /**
   * CLI supports a persistent multi-turn stdin transport (claude
   * `--input-format stream-json` keeping one child alive across turns). When
   * true, the Explore fast-path may reuse a single long-lived child instead of
   * respawning per turn. Optional — absent/false means spawn-per-turn only.
   */
  persistentStdin?: boolean
}

export interface ProviderAdapter {
  readonly id: ProviderId
  readonly displayName: string
  readonly binary: string
  readonly minCliVersion: string | null

  // Filesystem conventions
  readonly projectDirName: string
  readonly instructionsFilename: string
  readonly mcpRegistration: 'project-json' | 'cli-add'

  // Capability flags — managers gate behaviour on these, never on `id`
  readonly capabilities: ProviderCapabilities

  // Model catalog — populates UI dropdowns and validates profile schemas
  modelCatalog(): readonly { value: string; label: string; default?: boolean }[]
  defaultModel(): string

  // Spawn args by action — every spawn site funnels through one of these
  buildArgs(action: SpawnAction, opts: SpawnOptions): string[]

  // Stream parsing — uniform event shape across providers. Returns null only
  // for empty input lines; unknown JSON event types resolve to { kind: 'other' }.
  parseStreamLine(line: string): AdapterEvent | null

  // Result extraction over an accumulated event stream.
  extractResult(events: readonly AdapterEvent[]): NormalisedResult

  // Baseline agents (rails) — names ProfileManager validation requires present.
  baselineAgents(): readonly string[]

  // Health probe — runs at startup + via /setup-prerequisites. MUST complete
  // within 3 seconds; longer resolves to { installed: false }.
  detectInstalled(): Promise<DetectionResult>

  /**
   * Optional provider-specific filesystem prep run right before a HEADLESS rail
   * spawn (cwd = projectPath). Gemini uses it to pre-acknowledge the project's
   * custom subagents (`~/.gemini/acknowledgments/agents.json`) so they load in
   * `gemini -p` mode instead of falling back to a generic agent; claude/codex
   * omit it. Best-effort — managers wrap the call so a failure never blocks the
   * spawn. Synchronous: it only touches small local JSON.
   */
  prepareHeadlessSpawn?(projectPath: string): void
}

export class UnknownProviderError extends Error {
  readonly unknownId: string
  readonly registered: readonly string[]
  constructor(unknownId: string, registered: readonly string[]) {
    super(
      `unknown provider '${unknownId}'. Registered providers: ${registered.length > 0 ? registered.join(', ') : '(none)'}`,
    )
    this.name = 'UnknownProviderError'
    this.unknownId = unknownId
    this.registered = registered
  }
}
