export const meta = {
  name: 'specrails-desktop-bug-audit',
  description: 'Exhaustive multi-agent bug hunt across the whole specrails-desktop codebase (server, client, Tauri/Rust host, CLI, CI/build) with adversarial verification and a synthesized report',
  phases: [
    { title: 'Hunt', detail: '21 subsystem finders read their file cluster and report genuine bugs' },
    { title: 'Verify', detail: 'each finding adversarially verified by 1-2 skeptics against the real code' },
    { title: 'Critic', detail: 'completeness critic proposes missed areas; extra finders run' },
    { title: 'Synthesize', detail: 'one agent ranks all findings and writes BUG-AUDIT-REPORT.md' },
  ],
}

// ---------- schemas ----------
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'category', 'file', 'description', 'impact', 'trigger', 'fix_sketch', 'confidence'],
        properties: {
          title: { type: 'string', description: 'one-line bug summary' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          category: { type: 'string', enum: ['security', 'concurrency-race', 'correctness', 'platform-windows', 'platform-macos', 'resource-leak', 'data-integrity', 'error-handling', 'other'] },
          file: { type: 'string', description: 'path:line of the defect' },
          evidence: { type: 'string', description: 'exact code snippet or quote proving the bug' },
          description: { type: 'string', description: 'what is wrong and why, with the precise code path' },
          impact: { type: 'string', description: 'concrete consequence if hit' },
          trigger: { type: 'string', description: 'how it is reached / reproduced in practice' },
          fix_sketch: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          platform: { type: 'string', enum: ['windows', 'macos', 'both', 'n/a'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'confidence', 'severity_corrected', 'reasoning'],
  properties: {
    real: { type: 'boolean', description: 'true only if you independently confirmed the defect by reading the cited code' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    severity_corrected: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
    reasoning: { type: 'string', description: 'what you read and why the finding holds or fails' },
    already_guarded: { type: 'boolean', description: 'true if a guard/handler elsewhere already prevents this' },
    false_positive_reason: { type: ['string', 'null'] },
  },
}

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['extraTargets'],
  properties: {
    extraTargets: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'files', 'lenses'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          files: { type: 'string', description: 'comma-separated file globs/paths to read' },
          lenses: { type: 'string', description: 'the specific bug classes to hunt and why this area is under-covered' },
        },
      },
    },
  },
}

// ---------- targets ----------
const TARGETS = [
  { key: 'spawn-path', label: 'Spawn + PATH + bundled runtimes', files: 'server/spawn-lifecycle.ts, server/path-resolver.ts, server/setup-prerequisites.ts, server/bundled-core.ts, server/bundled-openspec.ts, server/binary-probe.ts, server/transient-children.ts, server/openspec-shim.ts, cli/win-spawn.ts, top module-patches in server/index.ts', lenses: 'command/argv injection, PATH hijack & ordering, existence-gating fallbacks, Windows stripped-env (missing SystemRoot/COMSPEC), process.execPath != node traps, login-shell augmentation timeout/escape, symlink/junction resolution, spawn cwd correctness, double-spawn / settle-once' },
  { key: 'artifact-registry', label: 'Artifact registry + workspace resolution', files: 'server/artifact-registry.ts, server/workspace-manager.ts, server/workspace-resolution.ts', lenses: 'advisory lock TOCTOU & stale-lock TTL, realpath canonicalization edge cases, atomic temp+rename durability, slug/workspaceDir immutability, registry.json corruption/partial-write recovery, path traversal via slug, two-part activation gate regressions, Windows symlink fallback (project-path.txt), SPECRAILS_REGISTRY_HOME test-safety leak' },
  { key: 'framework', label: 'Framework manager + migration', files: 'server/framework-manager.ts, server/framework-migration.ts', lenses: 'atomic current symlink swap under lock, in-flight rail resolution vs swap ordering, copy-vs-symlink fallback on Windows, O(1) vs O(projects) update, version compare (semver-lite), partial extraction / corrupted bundle, per-file agent linking vs custom-*.md coexistence, agent-memory must stay real writable dir, non-destructive migration skip-on-divergence' },
  { key: 'queue-manager', label: 'QueueManager + rails + result settle', files: 'server/queue-manager.ts, server/result-event.ts, server/rails-store.ts, server/rails-router.ts', lenses: 'per-job provider/profile late-binding consumed-once races, _jobProviderSelection map cleanup, provenance repoDir vs empty workspace cwd split, OTEL env injection correctness, job-exit settle-once (close/error/timeout), ticket-id extraction from command, snapshot/diff lifecycle, env var leakage across jobs, ultracode/profile force-null for non-claude' },
  { key: 'interactive-jobs', label: 'Interactive job session', files: 'server/interactive-job-session.ts', lenses: 'persistent-stdin lifecycle, finalize race, concurrency, orphaned children on shutdown/abort, stdin write after close, in-job chat turn ordering' },
  { key: 'chat-explore', label: 'ChatManager + explore lifecycle', files: 'server/chat-manager.ts, server/explore-stdin-session.ts, server/explore-cwd-manager.ts', lenses: 'idle-kill 2-min timer arming/cancel races, crash auto-respawn infinite-loop guard, concurrency cap of 5 + victim eviction + 30s queue timeout, --resume session rehydration, persistent-stdin single stdout reader fan-out & teardown, explore-cwd symlink + project-path.txt fallback, byte-stable system prompt cache, abort/shutdown child orphans' },
  { key: 'context-scope-mcp', label: 'Context scope + user MCP injection', files: 'server/context-scope.ts, server/user-mcp-config.ts, server/context-budget.ts', lenses: 'tool-gate tier selection (read-only vs high), --dangerously-skip-permissions exposure at high tier, user-mcp.json file perms (chmod 600), reading ~/.claude.json merge precedence, --mcp-config argv injection, denylist vs allowlist correctness, Bash-can-still-write security stance' },
  { key: 'contract-smash-parse', label: 'Contract refine + SMASH + spec parsers', files: 'server/contract-refine-runner.ts, server/explore-contract-refine.ts, server/explore-smash.ts, server/smash-runner.ts, server/spec-draft-parser.ts, server/spec-models.ts', lenses: 'kill-switch gating, per-spec scope gate (contractRefine===true only), untrusted LLM-output parsing robustness (JSON injection, prototype pollution, huge input), process.nextTick scheduling vs job lifecycle, ticket description patch races / lost updates, --max-turns / --disallowedTools correctness, retry consent semantics' },
  { key: 'jira-core', label: 'Jira sync manager + materializer + status', files: 'server/jira/jira-sync-manager.ts, server/jira/jira-materializer.ts, server/jira/jira-status-resolver.ts, server/jira/jira-db.ts', lenses: 'outbox idempotency_key uniqueness, FIFO-per-issue claimDrainable races, resetInflight crash recovery, frozen-status guard vs pending outbox, status BFS walkToCategory infinite-loop / cycle, high-water-mark clock-skew & overlap, surgical mutateStore preserving unlinked specs, collision-safe id allocation UNION, link tombstone on 404, AES key handling in jira-db' },
  { key: 'jira-client-cred', label: 'Jira client + credential store + ADF + router', files: 'server/jira/jira-client.ts, server/jira/jira-credential-store.ts, server/jira/jira-adf.ts, server/jira/jira-issue-fields.ts, server/jira/jira-backlog-config.ts, server/jira-router.ts', lenses: 'AES-256-GCM misuse (IV/nonce reuse, missing auth tag check, key file 0600), token redaction leaks in logs/errors, SSRF to attacker-controlled Jira base URL, ADF/wiki body injection, Cloud vs DC deployment detection spoofing, JiraResult error-code mapping correctness, Retry-After parsing, self-marker comment dedup bypass, backlog-config write_access:false always-injected invariant' },
  { key: 'plugins', label: 'Plugin system (additivity invariant)', files: 'server/plugin-manager.ts, server/plugins/manager.ts, server/plugins/ownership.ts, server/plugins/json-mutation.ts, server/plugins/claude-md-mutation.ts, server/plugins/drift.ts, server/plugins/rail-integration.ts, server/plugins/codex-mcp.ts, server/plugins/contributors.ts, server/plugins/prereq-installer.ts, server/plugins/serena/manifest.ts', lenses: 'additivity (never mutate other plugin/user keys), ownership-conflict detection fail-fast, surgical read-modify-rename atomicity + file mutex, .mcp.json merge correctness, verify timeout, MCP command injection via uvx/git URL, rollback on verify failure, orphan removal, snapshot chmod 400, install/uninstall idempotency' },
  { key: 'db-migrations', label: 'SQLite schemas + migrations', files: 'server/db.ts, server/desktop-db.ts, server/agent-refine-db.ts, server/terminal-marks-store.ts, server/ticket-store.ts', lenses: 'migration idempotency & ordering, desktop-db v10 burned-version self-heal (migration 11), SQL injection via string interpolation, prepared-statement misuse, index correctness, JSON column parse/validate (providers, context_scope), :memory: vs file divergence, NOT NULL/DEFAULT backfill, schema_version bump 1.0->1.1 backward read, FIFO cap eviction' },
  { key: 'http-routers', label: 'HTTP routers + path traversal + input validation', files: 'server/desktop-router.ts, server/project-router.ts, server/project-router-jobs.ts, server/project-router-tickets.ts, server/project-router-setup.ts, server/project-router-settings.ts, server/project-router-spending.ts, server/project-router-chat.ts, server/project-router-terminals.ts, server/docs-router.ts', lenses: 'path traversal (file?path=, docs paths), mount-order precedence bugs, :projectId middleware auth gating, input validation / allow-list bypass (theme, language, providers), missing 400 on bad body, mass-assignment, IDOR across projects, regex DoS, integer/limit clamping' },
  { key: 'auth-ws-pairing', label: 'Auth + WebSocket routing + pairing/mobile', files: 'server/auth.ts, server/ws-routing.ts, server/index.ts (ws upgrade + otlp), server/companion bits, server/metrics.ts', lenses: 'token comparison timing-safety, localhost-only binding enforcement, WS upgrade token validation & origin check, /ws/terminal token+projectId auth, mDNS/QR pairing payload tampering (frozen hub.* wire), CSRF on state-changing GET, projectId injection into broadcast, mobile-ws desktop.*->hub.* translation correctness' },
  { key: 'terminal-pty', label: 'Terminal PTY + OSC parser + shims', files: 'server/terminal-manager.ts, server/terminal-osc-parser.ts, server/terminal-shell-integration.ts, server/terminal-marks-store.ts, server/terminal-settings.ts', lenses: 'OSC/control-sequence parser injection & unbounded-buffer DoS, shim file perms (chmod 600) & path resolution in packaged app, PTY session hard-cap (10) enforcement, 256KB ring buffer correctness, /ws/terminal auth, node-pty external-load patch, drag-drop path shell-quoting (POSIX/Windows), shutdown SIGTERM->SIGKILL grace, stale shim 24h sweep, marks FIFO cap 1000' },
  { key: 'browser-capture', label: 'Browser capture + Playwright + chromium', files: 'server/browser-capture-manager.ts, server/browser-playwright.ts, server/browser-network.ts, server/chromium-resolver.ts, server/browser-capture-types.ts', lenses: 'SSRF / arbitrary URL navigation, Playwright context/page resource leak, network-interception capturing secrets, chromium path resolution & download trust, sandbox flags, file:// or internal-network access, screenshot path traversal, concurrency limits' },
  { key: 'file-code-explorer', label: 'File provenance + summaries + code explorer', files: 'server/file-provenance.ts, server/file-summary-manager.ts, server/file-summary-generator.ts, server/code-explorer-router.ts, server/changes-reader.ts', lenses: 'path traversal in GET /file & /summary, binary refusal + 2MB cap bypass, deny-list & .gitignore respect, monthly budget cap race / double-charge, hash-gated regen invalidation, chokidar stale-marking, orphan sweep cap, summary schema validation of LLM output, tree pagination cap, provenance primary-ticket attribution' },
  { key: 'tauri-rust', label: 'Tauri Rust host', files: 'src-tauri/src/lib.rs, src-tauri/src/main.rs, src-tauri/tauri.conf.json', lenses: 'env var injection into sidecar (SPECRAILS_IS_DESKTOP / RUNTIMES_PATH), runtimes existence-gate correctness, sidecar spawn & cwd, IPC/command surface exposure, CSP & remote-content, updater identity / bundle id frozen, resource path resolution, shell/notification plugin scope, panic/unwrap on missing resources' },
  { key: 'ci-build', label: 'CI + build/packaging scripts', files: 'scripts/build-sidecar.mjs, scripts/assemble-bundled-core.mjs, scripts/assemble-bundled-openspec.mjs, scripts/assemble-runtimes-local.mjs, scripts/fix-desktop-bundle.mjs, scripts/patch-node-pty.mjs, scripts/obfuscate-chromium.mjs, .github/workflows/desktop-release.yml, .github/workflows/ci.yml, .github/workflows/release.yml', lenses: 'supply-chain (SHA256 pin verification, unpinned deps), codesign-before-notarize ordering, symlink-deref by tauri bundler, FTP upload-before-manifest ordering & HEAD verify, secret handling in workflows, exec-bit preservation, npm provenance, latest/ wholesale-wipe risk, smoke-test coverage gaps' },
  { key: 'client-isolation-xss', label: 'Client per-project isolation + XSS + Tauri bridges', files: 'client/src/hooks/useDesktop.tsx, client/src/hooks/useProjectCache.ts, client/src/hooks/useSharedWebSocket.tsx, client/src/context/MinimizedChatsContext.tsx, client/src/context/TerminalsContext.tsx, client/src/context/TicketDetailModalContext.tsx, client/src/lib/html-highlight.ts, client/src/lib/markdown-detect.ts, client/src/lib/tauri-clipboard.ts, client/src/lib/tauri-drag-drop.ts, client/src/lib/shell-quote.ts, client/src/lib/api.ts, client/src/lib/jira-api.ts', lenses: 'per-project module-level cache bleed, stale-closure WS handlers (projectId via ref not closure), dangerouslySetInnerHTML / XSS via markdown/html-highlight/LLM output, localStorage quota & cap (minimized-chats 50, pending-restore), clipboard/drag-drop path injection & shell-quote correctness, getApiBase race on project switch, race on deleted-project state' },
]

function finderPrompt(t) {
  return [
    `You are a senior security + reliability auditor doing a DEEP, adversarial bug hunt on ONE subsystem of the "specrails-desktop" Electron/Tauri desktop app (Express+WS+SQLite server, React client, Tauri/Rust host). READ-ONLY: do not edit any file.`,
    ``,
    `## Subsystem: ${t.label}`,
    `Read these files FULLY (use Read; follow imports into helpers when a data-flow crosses a boundary): ${t.files}`,
    ``,
    `## Hunt specifically for (but report ANY real defect you find):`,
    t.lenses,
    ``,
    `## Method`,
    `- Trace real data/control flow end to end. Open the actual code; do not speculate from names.`,
    `- For each candidate bug, confirm the defective line exists and reason about when it is reached at runtime.`,
    `- Prefer genuine defects: crashes, races/TOCTOU, security holes (injection, traversal, SSRF, auth bypass, secret leak, weak crypto), resource/process leaks, data corruption, platform-specific breakage (Windows vs macOS), incorrect error handling that silently loses data. Ignore pure style/naming.`,
    `- Distinguish "default-unset => legacy byte-identical" paths (often safe) from genuinely active ones.`,
    `- Check the matching *.test.ts if present to see what is already covered — an untested edge is a prime suspect.`,
    ``,
    `## Output`,
    `Return up to 12 of your highest-value findings via the structured schema. Each MUST cite file:line, include the exact offending code in "evidence", a precise description of the faulty path, the concrete impact, how it triggers, and a fix sketch. Set confidence honestly. If you find nothing real, return an empty findings array — do NOT invent.`,
  ].join('\n')
}

function verifierPrompt(f, target, lens) {
  return [
    `You are an adversarial verifier. A prior auditor reported the bug below in the specrails-desktop codebase. Your job is to REFUTE it. Open the cited code yourself and decide if it is genuinely a defect. Default to real=false unless you can independently confirm the exact faulty code path by reading it.`,
    ``,
    `Verification lens to emphasize: ${lens}`,
    ``,
    `## Reported finding`,
    `- Subsystem: ${target}`,
    `- Title: ${f.title}`,
    `- Severity claimed: ${f.severity}  | Category: ${f.category} | Platform: ${f.platform || 'n/a'}`,
    `- Location: ${f.file}`,
    `- Evidence: ${f.evidence || '(none provided)'}`,
    `- Description: ${f.description}`,
    `- Impact: ${f.impact}`,
    `- Trigger: ${f.trigger}`,
    ``,
    `## Method`,
    `- Read the cited file/lines and the surrounding code. Check whether a guard, validator, early-return, or handler ELSEWHERE already prevents the bug (set already_guarded=true if so).`,
    `- Check whether the path is actually reachable at runtime (not dead code, not a default-unset legacy branch that is byte-identical to old safe behavior).`,
    `- If the bug is real, assess whether the claimed severity is right; correct it.`,
    `- Be concrete: name the lines you read.`,
    `Return the verdict via the schema. real=true ONLY with code-backed confirmation.`,
  ].join('\n')
}

// ---------- run ----------
async function huntAndVerify(targetList) {
  return pipeline(
    targetList,
    (t) => agent(finderPrompt(t), { label: `find:${t.key}`, phase: 'Hunt', schema: FINDINGS_SCHEMA, effort: 'high' }),
    (res, t) => {
      const findings = (res && Array.isArray(res.findings)) ? res.findings.slice(0, 12) : []
      if (findings.length === 0) return { target: t.key, label: t.label, findings: [] }
      return parallel(findings.map((f, i) => () => {
        const hi = f.severity === 'critical' || f.severity === 'high'
        const lenses = hi
          ? ['real-world exploitability & whether the dangerous path is actually reachable', 'code-path correctness & whether a guard already exists elsewhere']
          : ['code-path correctness & whether a guard already exists elsewhere']
        return parallel(lenses.map((lens, k) => () =>
          agent(verifierPrompt(f, t.label, lens), { label: `verify:${t.key}#${i}.${k}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'medium' })
        )).then((verdicts) => {
          const vs = verdicts.filter(Boolean)
          const realVotes = vs.filter((v) => v.real).length
          return { ...f, target: t.key, targetLabel: t.label, verdicts: vs, n: vs.length, realVotes, confirmed: vs.length > 0 && realVotes >= Math.ceil(vs.length / 2) }
        })
      })).then((arr) => ({ target: t.key, label: t.label, findings: arr.filter(Boolean) }))
    }
  )
}

phase('Hunt')
log(`Hunting bugs across ${TARGETS.length} subsystems...`)
const round1 = (await huntAndVerify(TARGETS)).filter(Boolean)

const round1Findings = round1.flatMap((r) => r.findings)
log(`Round 1: ${round1Findings.length} findings (${round1Findings.filter((f) => f.confirmed).length} confirmed). Running completeness critic...`)

// ---------- completeness critic ----------
phase('Critic')
const coveredSummary = TARGETS.map((t) => `- ${t.key}: ${t.label}`).join('\n')
const titlesSummary = round1Findings.map((f) => `[${f.target}/${f.severity}] ${f.title}`).slice(0, 200).join('\n')
const critic = await agent([
  `You are a completeness critic for a whole-codebase bug audit of "specrails-desktop". 21 subsystem audits already ran. Identify GENUINELY under-covered areas — a subsystem, a cross-cutting concern, a platform path, or a bug class that the existing targets did not focus on — and propose up to 6 EXTRA focused audit targets to close the gaps.`,
  ``,
  `Subsystems already audited:`,
  coveredSummary,
  ``,
  `Findings produced so far (titles):`,
  titlesSummary || '(none)',
  ``,
  `Think about what is missing: e.g. cross-module interaction bugs, shutdown/cleanup ordering across managers, the CLI (cli/specrails-desktop.ts), webhook-manager/telemetry-receiver SSRF & gzip-bomb, attachment-manager, proposal-manager, spec-launcher-manager, agent-refine-manager, hooks.ts, ws message schema drift, i18n/locale parity, demo-mode build, Windows-specific spawn/symlink/path code, codex-otel-bridge, pricing rounding. Only propose areas with real bug potential and concrete files to read. Return via schema (empty array if truly nothing is missing).`,
].join('\n'), { label: 'critic:completeness', phase: 'Critic', schema: CRITIC_SCHEMA, effort: 'high' })

let round2 = []
const extra = (critic && Array.isArray(critic.extraTargets)) ? critic.extraTargets.slice(0, 6) : []
if (extra.length > 0) {
  log(`Critic proposed ${extra.length} extra targets. Auditing them...`)
  phase('Hunt')
  round2 = (await huntAndVerify(extra.map((e) => ({ key: 'x-' + e.key, label: e.label, files: e.files, lenses: e.lenses })))).filter(Boolean)
}

// ---------- synthesize ----------
phase('Synthesize')
const all = [...round1, ...round2]
const flat = all.flatMap((r) => r.findings)
const confirmed = flat.filter((f) => f.confirmed)
log(`Total ${flat.length} findings, ${confirmed.length} confirmed. Writing report...`)

const payload = all.map((r) => ({
  subsystem: r.label,
  findings: r.findings.map((f) => ({
    title: f.title, severity: f.severity, severity_corrected: (f.verdicts && f.verdicts[0] && f.verdicts[0].severity_corrected) || f.severity,
    category: f.category, file: f.file, platform: f.platform, confidence: f.confidence,
    description: f.description, impact: f.impact, trigger: f.trigger, evidence: f.evidence, fix_sketch: f.fix_sketch,
    confirmed: f.confirmed, realVotes: f.realVotes, votes: f.n,
    verdicts: (f.verdicts || []).map((v) => ({ real: v.real, confidence: v.confidence, sev: v.severity_corrected, already_guarded: v.already_guarded, reasoning: v.reasoning, fp: v.false_positive_reason })),
  })),
}))

const reportSummary = await agent([
  `You are the lead auditor. Below is the full JSON of every finding from a 21+ subsystem bug audit of "specrails-desktop", each with adversarial-verification verdicts. Produce the definitive report.`,
  ``,
  `Write the report to the file BUG-AUDIT-REPORT.md at the repository root (use the Write tool). Structure it:`,
  `1. Executive summary: counts by severity (use the corrected severity), the single most important risks, overall codebase health read.`,
  `2. "Confirmed bugs" ordered by corrected severity then subsystem — for each: a stable ID, title, severity, subsystem, file:line, what's wrong, impact, trigger, fix. Mark platform when Windows/macOS-specific.`,
  `3. "Disputed / needs-human-review" — findings the verifiers refuted or split on, with the dispute reasoning, so the user can adjudicate.`,
  `4. "Cross-cutting themes" — recurring root causes (e.g. lock TOCTOU, untrusted-LLM-output parsing, Windows path handling, secret handling) with the affected files.`,
  `5. "Recommended next actions" — a prioritized, concrete fix order.`,
  `Deduplicate findings that are the same root cause reported by two subsystems (note the overlap). Be precise and do not inflate severity. Do NOT fix any code — report only.`,
  ``,
  `After writing the file, RETURN (as your final message) a concise plain-text executive summary: total findings, confirmed count, counts by corrected severity, and a bulleted list of the top 8 most important confirmed bugs (ID + one line each).`,
  ``,
  `## FINDINGS JSON`,
  JSON.stringify(payload),
].join('\n'), { label: 'synthesize:report', phase: 'Synthesize', effort: 'high' })

return {
  totalFindings: flat.length,
  confirmed: confirmed.length,
  bySeverity: flat.reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a }, {}),
  subsystems: all.length,
  extraTargetsAudited: extra.length,
  reportFile: 'BUG-AUDIT-REPORT.md',
  executiveSummary: reportSummary,
}
