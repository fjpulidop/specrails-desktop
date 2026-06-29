export const meta = {
  name: 'specrails-desktop-audit-fixes',
  description: 'Implement fixes for the 39 confirmed bugs from BUG-AUDIT-REPORT.md, parallelised across disjoint file-groups, with tests',
  phases: [
    { title: 'Fix', detail: 'one developer agent per disjoint file-group implements its bugs + tests' },
  ],
}

// Each group owns a DISJOINT set of source files (+ their co-located *.test.ts).
// No two groups touch the same file, so the agents can run concurrently in the
// same working tree without write conflicts. Full bug detail lives in
// BUG-AUDIT-REPORT.md (agents search each ID); the `fixes` field is the directive.
const GROUPS = [
  {
    key: 'teardown-explore-stdin',
    files: ['server/explore-stdin-session.ts'],
    fixes: [
      'BUG-CHAT-01: ExploreStdinSessions.kill() uses s.child.kill("SIGTERM"); replace with treeKill(s.child.pid, "SIGTERM") (import treeKill from "tree-kill"), guarded on s.child.pid, then arm an unref\'d 2s SIGKILL-escalation timer (treeKill pid "SIGKILL") cleared on the child "close" event — mirror QueueManager/spawn-lifecycle.',
      'BUG-CHAT-06: in getOrSpawn attach an "error" listener to child.stdin that routes to onClose(null) (so an async EPIPE on a buffered write cannot crash the process); writeTurn should surface a delayed write failure.',
    ],
  },
  {
    key: 'teardown-chat-autotitle',
    files: ['server/chat-manager.ts'],
    fixes: [
      'BUG-CHAT-02: _autoTitle() spawns a claude/codex child never registered for teardown. Track it in a new private _auxProcesses Set<ChildProcess>; remove on its "close"; in shutdown() (and abort if appropriate) treeKill every _auxProcesses entry. Do NOT change unrelated chat logic.',
    ],
  },
  {
    key: 'queue-manager',
    files: ['server/queue-manager.ts'],
    fixes: [
      'BUG-QUEUE-01: relocated claude rails create an openspec PATH shim recorded in _openspecShims but cleanup (removeOpenspecShim + map delete) only happens in _settleInteractiveJob. Mirror that cleanup in _onJobExit and _failWedgedJob, and add a startup sweep of stale shim dirs.',
      'BUG-QUEUE-02: the SIGKILL-failure recovery block (~1894-1918) force-fails in memory+DB but skips _onJobFinished, recordInvocation, and clearing per-job maps (_snapshotRefs/_jobExecution/_openspecShims/_jobModelSelection/_jobProfileSelection/_jobProviderSelection). Route it through the same terminal handling _failWedgedJob uses (fire _onJobFinished failed, recordInvocation, clear all per-job maps + snapshot/exec/shim).',
      'BUG-QUEUE-03: buildTelemetryEnv only emits CLAUDE_CODE_ENABLE_TELEMETRY + OTEL_*; gemini rails need its own env. Make telemetry env provider-aware (verify the Gemini CLI OTLP env contract from the gemini adapter / docs) so gemini rails actually export telemetry; keep claude/codex byte-identical.',
    ],
  },
  {
    key: 'teardown-longtail',
    files: ['server/proposal-manager.ts', 'server/spec-launcher-manager.ts', 'server/agent-refine-manager.ts'],
    fixes: [
      'BUG-LONGTAIL-01: cancel() SIGTERMs + writes status="cancelled" but does not set the disposed/cancelled flag nor remove the close listener, so the killed child\'s non-zero close overwrites "cancelled" with input/review/error + a spurious failure broadcast. Mark the slot intentionally-cancelled (per-id flag) and short-circuit the close handler (or check DB status==="cancelled" before applying onError).',
      'BUG-LONGTAIL-02: all three managers kill with a single treeKill(pid,"SIGTERM") and never escalate. After SIGTERM, arm an unref\'d 2s SIGKILL timer cleared on "close", in cancel() and shutdown() of each manager.',
      'BUG-LONGTAIL-04: SpecLauncherManager.cancel() never removes the "close" listener (later fires spec_launcher_done/error for a cancelled launch) and shutdown() has no _disposed flag. Add a per-id cancelled/disposed flag (or removeAllListeners("close")) short-circuiting the close handler; give SpecLauncherManager a _disposed flag set in shutdown() and checked in the close handler.',
    ],
  },
  {
    key: 'teardown-parser-smash',
    files: ['server/contract-refine-runner.ts', 'server/smash-runner.ts'],
    fixes: [
      'BUG-PARSER-01: readRefineChildOutput and readSmashChildOutput timeout paths call only child.kill("SIGTERM"). Use treeKill(child.pid,"SIGTERM") + a 2s SIGKILL-escalation timer cleared on close, in both readers.',
      'BUG-PARSER-02: SMASH duplicate-run — the _smashInFlight guard returns {ok:false, reason:"in-progress"} WITHOUT broadcasting smash.failed (every other failure branch does), leaving a stuck client spinner. Broadcast smash.failed (or a smash.in_progress) in that early-return.',
      'BUG-PARSER-03: the contract-refine retry path gates only provider==="codex"; resolve the origin conversation\'s provider and treat any non-claude as the codex-style path (do not 202-then-noop). Mirror the capability approach used elsewhere.',
      'BUG-PARSER-04: contract-refine ignores result.is_error/error_max_turns; a truncated max-turns exit-0 result is misclassified "malformed". Short-circuit to a model_error reason on is_error / the max-turns subtype.',
    ],
  },
  {
    key: 'interactive-job',
    files: ['server/interactive-job-session.ts'],
    fixes: [
      'BUG-INTJOB-02: finalize() SIGTERMs + arms a 2s SIGKILL timer, but _settle only runs via _handleClose on "close". If "close" never fires the slot leaks. Have the SIGKILL/hard-deadline timer force _settle(...) even if "close" never arrives, then detach listeners.',
      'BUG-INTJOB-03: the double-count guard relies only on _awaitingResult; a stray/late result for a finished turn is counted into the next turn. Tag each turn with a monotonic turn-id and only accept a result whose id matches the in-flight turn; count per turn-id.',
      'BUG-INTJOB-04: send() echoes the user prompt (persist + job.turn_user) BEFORE _writeTurn, which can silently fail (stdin destroyed/EPIPE). Make _writeTurn return a boolean; only persist/echo after a confirmed write, and surface a delivery-failure note when it cannot be delivered.',
    ],
  },
  {
    key: 'mobile-auth',
    files: ['server/mobile/mobile-webrtc.ts', 'server/mobile/mobile-signal-reconnect.ts', 'server/mobile/mobile-webrtc-peer.ts', 'server/mobile/mobile-gateway.ts', 'server/mobile/mobile-ws.ts', 'server/mobile/mobile-router.ts', 'server/mobile/mobile-devices.ts', 'server/mobile/mobile-redact.ts'],
    fixes: [
      'BUG-AUTH-01 (High): the reconnect path POSTs the offer secret to a public mailbox and registerDevice mints a brand-new full-scope device when input.token is absent/unknown. On the reconnect registration path REQUIRE a valid existing device token — return {ok:false} when input.token is absent/unresolved for that room — and stop publishing the secret in cleartext (bind it to the existing token). Do not break first-time pairing (the QR/pairing path), only the reconnect re-registration.',
      'BUG-MOBILE-02 (High): persist an allowed-project set per device and intersect BOTH state.projects (subscribe) and the /v1 :pid forward against it, so a companion cannot subscribe to or operate on projects it was not granted. (If you determine companion is intentionally all-projects, instead correct the docstring — but prefer enforcing the ACL the docs promise.)',
      'BUG-MOBILE-05: the app-level desktop_daily_budget_exceeded broadcast sends to every socket (continue) bypassing the s.topics.has("alerts") gate. Gate it on s.topics.has("alerts").',
      'BUG-MOBILE-06: redact() only rewrites the $HOME prefix; absolute paths outside $HOME (and under un-keyed fields) leak. Scrub tokens matching an absolute-path regex (POSIX /… and Windows X:\\…) to a placeholder, in addition to the key allowlist.',
    ],
  },
  {
    key: 'browser-and-index-ws',
    files: ['server/browser-capture-manager.ts', 'server/browser-playwright.ts', 'server/browser-network.ts', 'server/index.ts'],
    fixes: [
      'BUG-BROWSER-01 (security): WS {type:"navigate",url} (index.ts ~365) and REST POST /browser/sessions initialUrl reach Chromium with NO scheme validation (REST /navigate already rejects non-http(s)). Centralize an isNavigableUrl() helper (scheme allowlist http/https + block private/loopback/link-local IPs incl. 127/8, ::1, 169.254/16, 10/8, 172.16/12, 192.168/16) inside browser-playwright normalizeUrl/page.goto so EVERY path (WS navigate, REST navigate, create initialUrl) is covered. Add the same guard at the index.ts WS navigate handler. Keep the existing file:/// rejection test passing.',
      'BUG-BROWSER-02: create() reads the session count then awaits before inserting — N concurrent creates bypass MAX_SESSIONS_PER_PROJECT. Reserve the slot synchronously (counter/placeholder) before the awaits; re-check after newPage and tear down the extra.',
      'BUG-BROWSER-03 (security): NetworkRingBuffer stores the full request URL verbatim — leaks query-string tokens/PII into persisted attachments + the LLM prompt. Redact URL query strings before storing (keep origin+path, drop/hash the query) in NetworkRingBuffer.start, mirroring the body-sketch policy.',
      'BUG-BROWSER-04 (security): launchPersistentContext always passes --no-sandbox. Drop --no-sandbox on macOS/Windows (sandbox works there); only keep it where a Linux sandbox cannot initialize, gated on process.platform.',
      'BUG-MOBILE-07: applyWsRateLimiting (120 msg/min + 64KB) is only attached in the main wss connection handler; the terminal (/ws/terminal/:id) and browser (/ws/browser/:id) upgrade callbacks get only the frame cap. Call applyWsRateLimiting(ws) (or a PTY-tuned variant) inside both upgrade callbacks in index.ts.',
    ],
  },
  {
    key: 'jira-sync',
    files: ['server/jira/jira-sync-manager.ts'],
    fixes: [
      'BUG-JIRA-SYNC-01: start() calls resetInflight(db) unconditionally before the early-return guard and is reachable from setEnabled(true)/connect(), resetting inflight ops mid-drain → duplicate sends. Move resetInflight to a construction-only crash-recovery path, or guard it behind `if (this.pollTimer || this.drainTimer) return` before resetting.',
      'BUG-JIRA-SYNC-02: pollOnce has no authPaused guard, so a 401 re-fires jira.auth_expired every 60s. Add `if (this.authPaused) return null` at the top of pollOnce; make onAuth401() broadcast only on the false→true transition.',
      'BUG-JIRA-SYNC-03: onSpecEdited idempotency key update:${localId}:${Date.now().toString(36)} collides on sub-ms double-save. Add a random/monotonic component (e.g. a per-manager counter or randomUUID) to the nonce.',
      'BUG-JIRA-SYNC-04: handleHardError rate_limit branch always markOutboxRetry with no MAX_ATTEMPTS cap. Respect MAX_ATTEMPTS — markOutboxDead + broadcast degraded when exhausted.',
    ],
  },
  {
    key: 'jira-client',
    files: ['server/jira/jira-client.ts', 'server/jira/jira-adf.ts', 'server/jira/jira-backlog-config.ts'],
    fixes: [
      'BUG-JIRA-CLIENT-01 (security): detectDeployment/connect/probe accept any baseUrl; an http:// base sends the PAT/Basic creds in cleartext. Reject non-https base URLs (allow http only for explicit localhost/loopback) and return a 400-style validation error "Jira base URL must use https".',
      'BUG-JIRA-CLIENT-02 (security): detectDeployment derives host via new URL(baseUrl).host and trusts .endsWith(".atlassian.net") — userinfo (https://acme.atlassian.net@evil.com/) spoofs it. Reject base URLs containing url.username/url.password, strip to origin, and match the exact registrable host.',
      'BUG-JIRA-CLIENT-05: writeJiraBacklogConfig early-return compares only provider + write_access, leaving a pre-existing git_auto:true unchanged. Add `&& existing.git_auto === desired.git_auto` to the early-return (or always write idempotently).',
      'BUG-JIRA-ADF-06: adfToText emits "\\n" only for paragraph/heading; codeBlock (direct text children) and trailing separators after blockquote/panel/codeBlock run on. Emit a newline after codeBlock/blockquote/panel/tableRow container nodes.',
    ],
  },
  {
    key: 'ticket-store-db',
    files: ['server/ticket-store.ts', 'server/desktop-db.ts'],
    fixes: [
      'BUG-SQLITE-03 (data-integrity): readStore returns emptyStore() on JSON.parse throw OR wrong shape, so a present-but-unreadable local-tickets.json gets blanked by the next mutateStore. Distinguish ENOENT (→ emptyStore) from a present-but-unparseable/foreign-shaped file (→ throw so mutateStore aborts and preserves on-disk data).',
      'BUG-SQLITE-02: acquireLock writes process.pid but never reads it; staleness is mtime-only (10s). Read the stored PID and treat the lock as stale immediately when process.kill(pid, 0) throws ESRCH; keep the mtime TTL as cross-host fallback.',
      'BUG-SQLITE-05 (desktop-db.ts): migrateLegacyDbFile renames the main DB before its -wal/-shm sidecars → crash-window WAL loss. Rename the -wal/-shm siblings BEFORE the main file (or checkpoint/close the WAL before migrating).',
    ],
  },
  {
    key: 'plugins',
    files: ['server/plugin-manager.ts', 'server/plugins/rail-integration.ts'],
    fixes: [
      'BUG-PLUGIN-02 (concurrency): getProjectState()+mutate+_writeProjectState() is a non-atomic read-modify-write (read outside the lock). Add a lockedUpdateState(projectPath, fn) that reads→applies→writes under ONE withFileLock keyed on the state file path; replace the getProjectState()+_writeProjectState() pattern at all mutation sites (install commit, uninstall, _cacheHealth).',
      'BUG-PLUGIN-03: resolvePluginsForSpawn runs all verify→_cacheHealth writes via Promise.all → lost health updates. Serialize the state-mutating _cacheHealth (verify probes can stay parallel) — fixing lockedUpdateState (PLUGIN-02) and routing _cacheHealth through it resolves this.',
      'BUG-PLUGIN-04: state stores only installedFiles, never the owned mcpServers keys, so orphan removal can never strip the .mcp.json entry. Persist the plugin\'s owned mcpServers keys in state at install time so orphan removal can surgically strip them.',
      'BUG-PLUGIN-05: mergeMcpServers falls back to {} only on null/undefined; a JSON-array mcpServers silently drops the entry. Validate current.mcpServers is a plain object before merging; throw a PluginInstallError (actionable) otherwise.',
    ],
  },
  {
    key: 'attachment-traversal',
    files: ['server/attachment-manager.ts'],
    fixes: [
      'BUG-ROUTER-01 (security): attachmentId flows into sidecarPath as `${attachmentId}.meta.json` with no basename/opaque-token check → path traversal on read/delete. Validate attachmentId against an opaque-token rule (/^[A-Za-z0-9_-]{1,128}$/ or UUID) in getMeta/getFilePath/delete, or reject when attachmentId !== path.basename(attachmentId).',
    ],
  },
  {
    key: 'webhook-ssrf',
    files: ['server/desktop-router.ts'],
    fixes: [
      'BUG-WEBHOOK-01 (security): validateHttpUrl runs only at create/update; isPrivateIp returns false for any non-literal hostname (DNS-rebinding SSRF) and misses decimal IPv4 (2130706433) + hex IPv4-mapped IPv6 ([::ffff:7f00:1]). dns.lookup ALL addresses and reject if any is loopback/private/link-local; re-validate (or pin the validated IP) at delivery time; add hex-mapped IPv6 + decimal/octal IPv4 to the literal checks. ONLY touch the webhook validation code in this file.',
    ],
  },
  {
    key: 'telemetry-receiver',
    files: ['server/telemetry-receiver.ts'],
    fixes: [
      'BUG-WEBHOOK-03: state.uncompressedSize + DB byteSize are advanced synchronously BEFORE the async appendToGzip (whose rejection is swallowed) → byteSize over-reports on append failure. Advance uncompressedSize + update byteSize only inside the enqueued task AFTER appendToGzip resolves; on rejection, log and don\'t advance.',
    ],
  },
  {
    key: 'code-explorer',
    files: ['server/code-explorer-router.ts', 'server/file-summary-manager.ts'],
    fixes: [
      'BUG-CODE-01 (security, P0): GET /diff serves stored patches with NO deny-list or .gitignore check (every sibling endpoint enforces both) → full contents of AI-touched .env/*.pem/id_rsa/gitignored files served verbatim. Add isDeniedRelPath(relPath) + isGitIgnored(projectPath, normalizeRel(relPath)) guards in /diff before getProvenanceDiff (mirror /file).',
      'BUG-CODE-04 (security): the touched-by-ai tree (default filter) applies only isDeniedRelPath, never gitIgnoredSet (the all filter does). Run the touched-by-ai paths through gitIgnoredSet() and drop ignored entries + empty dir nodes, mirroring listAllEntries.',
      'BUG-CODE-02 (file-summary-manager.ts): file-summary.v1.json is never used. Compile it with the existing ajv instance and validate in readSummary (invalid → null/stale) and writeSummary; add a maxLength bound to summary.',
      'BUG-CODE-05 (file-summary-manager.ts): the monthly budget cap can be overshot by up to ~8 in-flight generations (cost recorded only at the end of runOne). Reserve projected spend optimistically when a generation STARTS (in-memory per-project pending-cost accumulator added to monthToDateSpend), reconciled when recordInvocation lands.',
    ],
  },
  {
    key: 'framework',
    files: ['server/framework-manager.ts', 'server/framework-migration.ts'],
    fixes: [
      'BUG-FW-02 (Windows): readCurrentFrameworkVersion returns path.basename ("current") → null on the Windows copy/junction path, causing re-materialize + a false framework.update_failed every startup. When current is a real dir/junction (not a POSIX symlink), read the version from the documented marker file instead of returning basename.',
      'BUG-FW-03 (framework-migration.ts, hygiene): the migration verify uses SHARED_SUBTREES.some(linkResolvesIntoFramework) then unconditionally deletes non-custom .bak. Change .some() to .every(); only delete a .bak when its corresponding live path is a verified symlink into current.',
    ],
  },
  {
    key: 'artifact-registry',
    files: ['server/artifact-registry.ts', 'server/workspace-manager.ts'],
    fixes: [
      'BUG-ARTREG-01 (workspace-manager.ts): projectsBaseDir() uses home ?? os.homedir() and ignores SPECRAILS_REGISTRY_HOME while artifact-registry.resolveHome() consults it → divergent workspace paths. Make projectsBaseDir reuse resolveHome() (import from artifact-registry) so both agree.',
      'BUG-ARTREG-02 (artifact-registry.ts): the adoption/upsert branch spreads existing verbatim and never re-derives paths from workspaceLayout; a partial entry strands the project in legacy mode forever. Guard adoption with isCompleteEntry; on failure rebuild path fields from workspaceLayout using the immutable slug so a partial entry self-heals.',
      'BUG-ARTREG-03 (artifact-registry.ts): atomicWrite fsyncs the temp file but never fsyncs the parent dir after renameSync. After renameSync, best-effort openSync(dir)+fsyncSync+closeSync in a try/catch (Windows rejects dir fsync).',
      'BUG-ARTREG-04 (artifact-registry.ts): withFileLock writes the lock mtime once and never refreshes; a holder paused >30s can be stale-broken while live. Refresh the lock mtime during long holds (heartbeat) so a live holder is not stale-broken.',
    ],
  },
  {
    key: 'terminal-and-usermcp',
    files: ['server/terminal-manager.ts', 'server/user-mcp-config.ts'],
    fixes: [
      'BUG-TERM-02 (terminal-manager.ts): RingBuffer.append keeps the tail of a lone >256KB chunk via head.subarray(excess) — a view pinning the whole original ArrayBuffer. Copy out the tail: this.chunks[0] = Buffer.from(head.subarray(excess)).',
      'user-mcp.json perms (user-mcp-config.ts): writeFileSync mode is ignored when the file pre-exists, leaving loose perms on a pre-existing file. Add an unconditional fs.chmodSync(file, 0o600) after the write.',
    ],
  },
  {
    key: 'cli-bridge',
    files: ['cli/specrails-desktop.ts'],
    fixes: [
      'BUG-CLI-01: runDirect builds argv as ["-p", ...command.trim().split(/\\s+/)] — shatters multi-word prompts. Pass the prompt as a single argv element: "-p", command.trim().',
      'BUG-CLI-03: runDirect reads cost_usd/input_tokens/output_tokens top-level, but real claude result carries total_cost_usd and usage.input_tokens/usage.output_tokens. Parse total_cost_usd and usage.* (mirror finaliseInvocationResult/claude-adapter).',
      'BUG-CLI-04: runDirect prints only type:"text"/content, but real claude emits type:"assistant" with message.content[] {type:"text",text}. Handle type:"assistant" by extracting/printing message.content[].text (mirror parseClaudeStreamLine); also print result.result on the result branch.',
      'BUG-CLI-06: --project name resolution does find(first match) — silently mis-routes on a name collision. Error out listing candidates (id/path) when >1 match; auto-pick only on a unique match.',
      'IMPORTANT: update the cli tests so the mocks emit the REAL claude shapes (total_cost_usd, usage.*, type:"assistant" message.content[]) — the existing tests pass against the wrong shape and mask these bugs.',
    ],
  },
  {
    key: 'client',
    files: ['client/src/hooks/useSharedWebSocket.tsx', 'client/src/hooks/useDesktop.tsx', 'client/src/hooks/useProjectCache.ts', 'client/src/lib/shell-quote.ts'],
    fixes: [
      'BUG-CLIENT-01 (useSharedWebSocket.tsx): the WS fan-out loop has no per-handler try/catch, so one throwing handler starves later handlers. Wrap each handler invocation in try/catch (console.error on throw). Also guard useDesktop\'s desktop.projects branch with Array.isArray(msg.projects) before .find.',
      'BUG-CLIENT-03 (useProjectCache.ts): module-level globalCache Map is never purged. Export purgeProjectCache(projectId) (delete all `${projectId}:` keys) and call it from the desktop.project_removed handler / removeProject in useDesktop.tsx.',
      'BUG-CLIENT-04 (useDesktop.tsx): self-initiated addProject double-fires activation + a redundant "project added" toast via the echoed desktop.project_added broadcast. Track just-added ids in a ref and skip toast+activation when echoing the initiator.',
      'BUG-CLIENT-02 (shell-quote.ts): quoteForHost hard-codes PowerShell single-quote wrapping from a coarse isWindows boolean, but the server may resolve cmd.exe (literal quotes). Add a quoteWindowsCmd path and accept an optional resolved-shell hint so cmd.exe sessions quote correctly (default behaviour unchanged when no hint).',
    ],
  },
  {
    key: 'spawn-arg-rewrite',
    files: ['server/util/cli-prompt.ts'],
    fixes: [
      'BUG-SPAWN-01 (High, Windows): transformClaudeArgsForWindows treats `-p` as a value-bearing prompt flag; when `-p` is passed WITHOUT a following value (persistent-stdin / interactive-ultracode use `-p` as a bare flag with stdin), it consumes the next argv token as the prompt value, corrupting the argv. Fix: only treat `-p`/`--print` as collecting a value when the next token exists AND is not itself a flag AND the flag is actually carrying an inline prompt; a bare trailing `-p` (stdin mode) must pass through untouched. Add a Windows-path test for a bare `-p` + a `-p <multiline value>`.',
    ],
  },
  {
    key: 'tauri-pid',
    files: ['src-tauri/src/lib.rs'],
    fixes: [
      'BUG-TAURI-02 (Rust, no JS test): terminate_process uses a stored sidecar PID captured at spawn, never reset, with no liveness/identity check before kill/taskkill /T /F → on PID reuse it kills an unrelated process. Track the CommandChild handle and use child.kill(), or verify process identity (image name on Windows, cmdline/process-group on Unix) before signaling. Keep it compiling; this file has no vitest coverage.',
    ],
  },
  {
    key: 'ci-release',
    files: ['.github/workflows/desktop-release.yml', 'scripts/assemble-bundled-core.mjs', 'scripts/assemble-bundled-openspec.mjs', 'scripts/smoke-bundled-runtimes.sh'],
    fixes: [
      'BUG-CI-01: in desktop-release.yml the publish order is delete-stale → upload-new → verify → upload-manifest, so the live old manifest references just-deleted installers during the FTP window. Reorder so stale installers are deleted LAST (after the new manifest uploads + HEAD-verifies) — atomic cutover. Do not remove the .htaccess-preserving constraint (only delete .dmg|.exe|.msi).',
      'BUG-CI-02: CORE_BUNDLE_VERSION:"latest" lets the 3 platform jobs bundle different core versions. Pin it to an exact version (or resolve once in a setup job and pass to all builds).',
      'BUG-CI-03 (assemble-bundled-core.mjs + assemble-bundled-openspec.mjs): the bundled npm install resolves the transitive closure unpinned with no lockfile/integrity. Vendor/commit a package-lock.json for the bundled install and use `npm ci` (pinned + integrity) instead of `npm install`.',
      'BUG-CI-04 (smoke-bundled-runtimes.sh): the chromium smoke probe finds an unpacked tree that never matches the shipped obfuscated chromium.pak, silently skipping validation. Add a .pak validation step (XOR-decode/extract + headless --dump-dom against the SHIPPED .pak) across platforms; these are config/script files with no vitest coverage.',
    ],
  },
]

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['group', 'bugsFixed', 'filesTouched', 'testsAdded', 'status'],
  properties: {
    group: { type: 'string' },
    bugsFixed: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'boolean' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    notes: { type: 'string' },
  },
}

function prompt(g) {
  return [
    `You are a senior engineer fixing CONFIRMED bugs in the "specrails-desktop" repo (Express+WS+SQLite server / React client / Tauri Rust host / CLI). Implement the fixes below with production quality + tests.`,
    ``,
    `## STRICT file ownership — you may ONLY edit these files and their co-located *.test.ts:`,
    g.files.map((f) => `  - ${f}`).join('\n'),
    `Touching ANY other file will conflict with a concurrent agent. Do NOT create shared modules, do NOT edit barrels/index files you weren't assigned, do NOT edit other managers. If a fix seems to need a shared helper, inline it in your own file instead.`,
    ``,
    `## Bugs to fix (full detail: search each BUG-ID in BUG-AUDIT-REPORT.md at the repo root):`,
    g.fixes.map((x, i) => `${i + 1}. ${x}`).join('\n'),
    ``,
    `## Rules`,
    `- Read each assigned file FULLY (and its existing *.test.ts) before editing. Implement the SMALLEST correct fix per the report's "Fix:".`,
    `- Add or extend tests in the co-located *.test.ts proving EACH behavioural fix. Match the existing test style (vitest; server uses initDb(':memory:') + supertest; client uses @testing-library/react). Default-off/legacy paths must stay byte-identical.`,
    `- Conventions: parameterised SQL only (never string-interpolate input); treeKill from 'tree-kill' for process trees; no module-level caches that bleed between projects; client uses getApiBase() + semantic theme tokens; kebab-case server files, PascalCase components. Strict TS, no implicit any.`,
    `- Security fixes must actually block the attack (add a test feeding the malicious input and asserting rejection).`,
    `- DO NOT run the full test suite or tsc — the orchestrator runs the gates centrally. You MAY run only your single assigned test file if it's quick. DO NOT run git commands.`,
    `- If a file has no JS test harness (Rust .rs, .yml, .mjs, .sh), make the minimal correct change and ensure it stays syntactically valid; note that no vitest covers it.`,
    ``,
    `Return the structured summary. status='partial' or 'blocked' (with notes) if you could not safely complete a fix — do NOT fabricate.`,
  ].join('\n')
}

phase('Fix')
log(`Implementing audit fixes across ${GROUPS.length} disjoint file-groups...`)
const results = await parallel(GROUPS.map((g) => () =>
  agent(prompt(g), { label: `fix:${g.key}`, phase: 'Fix', schema: SCHEMA, effort: 'high' })
))

const ok = results.filter(Boolean)
return {
  groups: GROUPS.length,
  completed: ok.filter((r) => r.status === 'done').length,
  partial: ok.filter((r) => r.status === 'partial').length,
  blocked: ok.filter((r) => r.status === 'blocked').length,
  bugsFixed: ok.flatMap((r) => r.bugsFixed),
  perGroup: ok.map((r) => ({ group: r.group, status: r.status, bugs: r.bugsFixed, files: r.filesTouched, tests: r.testsAdded, notes: r.notes })),
}
