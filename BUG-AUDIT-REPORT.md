# specrails-desktop — Bug Audit Report

> Lead-auditor synthesis of a 21-subsystem adversarial audit. Every finding below carries a **corrected severity** (the verifier-adjudicated severity, not the reporter's first guess). Findings the verifiers refuted are in "Disputed / needs-human-review". No code was changed — this is report-only.

---

## 1. Executive summary

### Counts (corrected severity, confirmed bugs only)

| Severity | Confirmed count |
|----------|----------------|
| **High** | 4 |
| **Medium** | 16 |
| **Low** | 19 |
| **Confirmed total** | **39** |

Total findings adjudicated: **78**. Confirmed real: **39**. Refuted / disputed (corrected to `info` or `real=false`): **39**.

> Note on "info": several findings the reporter rated low/medium/high were downgraded by verifiers to `info` because the faulty path is unreachable, already guarded, or working-as-designed. Those are listed in §3 (Disputed) rather than counted as confirmed bugs. A handful of confirmed bugs were also rated `info` after correction (genuine but negligible) — they are noted but excluded from the severity tallies above.

### The single most important risks

1. **Companion reconnect mints a fully-scoped device from a publicly-broadcast pairing secret (`BUG-AUTH-01`, High).** The serverless WebRTC reconnect path publishes the per-room pairing secret to a public third-party mailbox and the registration closure never requires the device's existing token — so anyone who can read that mailbox can mint a brand-new, non-revoked `companion` device that drives the entire `/v1` surface (launch rails → `claude --dangerously-skip-permissions`, delete tickets/jobs, read all projects). This is the highest-impact confirmed finding: a remote-ish credential/authorization break, not merely local.

2. **`/diff` serves secret-file contents to the non-developer Code Explorer (`BUG-CODE-01`, Medium→split-High).** Every sibling content endpoint enforces the deny-list + `.gitignore`; `/diff` enforces neither, so the full contents of any AI-touched `.env`/`*.pem`/`id_rsa`/gitignored credential file are served verbatim.

3. **Windows persistent-stdin / interactive-freestyle argv corruption (`BUG-SPAWN-01`, High).** The Windows arg-rewrite consumes the valueless `-p` as if it carried a value, silently breaking two whole features on Windows.

4. **Cross-cutting child-process lifecycle gaps.** Multiple managers (`ExploreStdinSessions`, contract-refine/SMASH, proposal/spec-launcher/agent-refine) kill children with bare `child.kill`/single-SIGTERM and no tree-kill / SIGKILL escalation — orphaning full-permission, spend-burning CLI trees (worst on Windows).

### Overall codebase health read

The codebase is **mature and largely well-guarded** — the high false-positive rate (half of all findings refuted) reflects that many superficially-scary patterns are already defended by existing guards (atomic writes, single-instance port locks, parent-PID watchdogs, existence-gated fallbacks, the Origin gate on WS). The confirmed bugs cluster in a few **systemic blind spots** rather than being pervasive: (a) child-process teardown consistency, (b) the mobile/companion authorization boundary, (c) endpoint-to-endpoint guard parity (one endpoint in a family forgets the deny-list/scheme/scope check its siblings enforce), and (d) untrusted-content egress sinks (webhook SSRF, browser-capture URL handling, captured-URL secret retention). The pre-release artifact-relocation branch adds several latent-but-real lifecycle leaks that only activate once relocation ships. No evidence of widespread architectural rot; the issues are addressable as a focused batch.

---

## 2. Confirmed bugs

Ordered by corrected severity (High → Medium → Low), then subsystem.

### HIGH

#### BUG-SPAWN-01 — Windows arg-rewrite corrupts valueless `-p` in claude `chat-stream`
- **Severity:** High · **Subsystem:** Spawn + PATH + bundled runtimes · **Platform:** Windows
- **File:** `server/util/cli-prompt.ts:40-58` (with `server/providers/claude-adapter.ts:126`)
- **What's wrong:** `transformClaudeArgsForWindows` treats `-p` as value-bearing and unconditionally consumes the next token. The `chat-stream` action emits a **valueless** `-p` followed by `--input-format stream-json` (prompt arrives over stdin), so the transform collects `--input-format` as a fake prompt, drops it from argv, re-appends a bare `-p`, and routes the literal string `--input-format` to stdin. Additionally `spawnClaude` then `stdin.end()`s the bogus payload — incompatible with the persistent-stdin transport.
- **Impact:** On Windows, Explore persistent-stdin (`SPECRAILS_EXPLORE_PERSISTENT_STDIN=1`) and interactive-freestyle rails spawn claude with a corrupted command line and garbage stdin — the feature silently does nothing or errors. POSIX unaffected.
- **Trigger:** Windows + persistent-stdin Explore turn, or an interactive freestyle rail.
- **Fix:** Only treat `-p`/`--print` as value-bearing when the next token does not start with `-`; leave the valueless chat-stream `-p` untouched (stdin is already piped). Mirror the codex transform's existing `a.startsWith('-')` flag guard.

#### BUG-FW-01 — Core-update swap of `framework/current` runs without the registry lock
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** Framework manager + migration
- **File:** `server/core-update-manager.ts:178-190`
- **What's wrong:** The documented contract is that `swapCurrent`/`materialize` run under the registry file-lock (as `index.ts:479` does for `versionCheck`). `CoreUpdateManager.update()` calls `fm.materialize` then `fm.swapCurrent` directly with **no `withFileLock`**, while `swapCurrent`/`materialize` take no lock internally. The mutex is therefore not mutual.
- **Impact:** A user-triggered core update can repoint `framework/current` concurrently with a lock-holding workspace migration relinking/verifying against the old `current`, or with startup `versionCheck` — yielding workspaces whose symlinks point at a moved-away version, or a verify passing against a now-stale target.
- **Trigger:** "Update core" (POST `/api/core-update/update`) coinciding with an in-flight migration or startup versionCheck. Narrow window; the swap pointer-move is itself atomic and a resolved rail keeps its handle, hence Medium.
- **Fix:** Wrap the `materialize + swapCurrent` sequence in `withFileLock(this.home, …)`, or make `swapCurrent` acquire the lock internally so every swap is serialized regardless of caller.
> **Dedup:** This is the root cause behind the disputed `BUG-FW-DISP-02` (dangling-symlink verify race), which is reachable only if this unlocked swap exists.

#### BUG-CHAT-01 — Persistent-stdin children killed with `child.kill` instead of `treeKill` (Windows orphan)
- **Severity:** High · **Subsystem:** ChatManager + explore lifecycle · **Platform:** Both (Windows-critical)
- **File:** `server/explore-stdin-session.ts:158`
- **What's wrong:** `ExploreStdinSessions.kill()` does `s.child.kill('SIGTERM')`, whereas every other child teardown in `chat-manager.ts` (idle-kill, victim-eviction, abort, shutdown) uses `treeKill(child.pid, 'SIGTERM')`. On Windows the child is the `cmd.exe` cross-spawn wrapper; the real claude (+ MCP subprocesses) is a grandchild that `child.kill` does not reach.
- **Impact:** On Windows, every persistent-stdin Explore session torn down by idle-kill, eviction, conversation delete, or app shutdown orphans a claude (+ MCP) process — consuming CPU, API quota, file locks indefinitely. On POSIX the MCP grandchildren still leak.
- **Trigger:** `SPECRAILS_EXPLORE_PERSISTENT_STDIN=1` + minimize/idle, 6th-turn eviction, conversation delete, or app quit. Default-OFF flag caps real-world exposure.
- **Fix:** Replace `s.child.kill('SIGTERM')` with `treeKill(s.child.pid, 'SIGTERM')` (guard on `s.child.pid`).
> **Dedup / theme:** Same root cause as `BUG-LONGTAIL-02` and `BUG-PARSER-01` (see Cross-cutting §4: tree-kill / SIGKILL escalation).

#### BUG-AUTH-01 — Companion reconnect broadcasts the pairing secret to a public mailbox; tokenless registration mints a new device
- **Severity:** High · **Subsystem:** Auth + WebSocket routing + pairing/mobile
- **File:** `server/mobile/mobile-gateway.ts:262-265` + `server/mobile/mobile-signal-reconnect.ts:57-66` + `server/mobile/mobile-webrtc-peer.ts:56-63` + `server/mobile/mobile-webrtc.ts:31-62`
- **What's wrong:** The reconnect poller POSTs the freshly-minted per-room WebRTC offer **including its secret** (`sec: offer.secret`) to a public third-party mailbox. The `registerDevice` closure gates only on `safeEqual(input.secret, secret)` — the token is threaded but never required. `buildRegisterDevice` falls through to `createDevice()` when the token is absent/unknown, minting a brand-new non-revoked device with a full `companion` bearer token. The reconnect path's own comments claim token-authentication that the code never enforces.
- **Impact:** Anyone able to read the mailbox (the signaling server itself, a MITM, or anyone with the device's room UUID + reach to the public endpoint) can answer the offer and mint a fully-scoped companion device driving the entire `/v1` surface across all projects (rail launches → `claude --dangerously-skip-permissions`, ticket/job deletion, full project read).
- **Trigger:** Mobile gateway enabled + ≥1 non-revoked device (poller runs every 3s per room).
- **Fix:** On the reconnect path, require a valid existing device token — `registerDevice` must return `{ok:false}` when `input.token` is absent/unresolved for that room. Do not publish the secret in cleartext; bind it to the existing token so reading the mailbox alone cannot register.
> The device-room UUID is a 122-bit `randomUUID()`, which raises the bar for an arbitrary internet attacker, but the signaling server / MITM sees both room and secret for every reconnect.

---

### MEDIUM

#### BUG-FW-02 — `readCurrentFrameworkVersion` can't read the Windows copy/junction `current` dir → re-materialize + false `update_failed` every startup
> Reporter rated Low; verifier confirmed real at **Low**. Listed here adjacent to BUG-FW-01 for the framework cluster but counted as Low. See Low section.

#### BUG-ARTREG-01 — `workspace-manager` resolves `$HOME` via `os.homedir()` while `artifact-registry` uses `SPECRAILS_REGISTRY_HOME` → divergent workspace paths
- **Severity:** Medium (reporter) → **Low (corrected)** · See Low section (`BUG-ARTREG-01`).

#### BUG-QUEUE-01 — Relocated claude rails never clean up their per-job openspec PATH shim (disk + map leak)
- **Severity:** Medium · **Subsystem:** QueueManager + rails + result settle
- **File:** `server/queue-manager.ts:1546-1822` (`_onJobExit`); shim created at `1296-1302`
- **What's wrong:** `_startJob` creates an openspec PATH shim dir and records it in `_openspecShims` for every relocated claude job. Cleanup (`removeOpenspecShim` + map delete) lives only in `_settleInteractiveJob`. The dominant **non-interactive** rail path settles via `_onJobExit`, which never removes the shim. `_failWedgedJob` omits it too. No startup sweep exists; `shutdown()` only `clear()`s the in-memory map, leaving on-disk dirs.
- **Impact:** Unbounded growth of `_openspecShims` (memory) plus one orphaned `chmod-700` dir per rail under `~/.specrails/projects/<slug>/openspec-shim/<jobId>/` forever. Gated behind artifact-relocation but on its primary code path.
- **Trigger:** Any implement/batch-implement rail on a relocated claude project.
- **Fix:** Mirror `_settleInteractiveJob` in `_onJobExit` (and `_failWedgedJob`); add a startup sweep of stale shim dirs.
> **Theme:** Same lifecycle-cleanup-asymmetry pattern as `BUG-QUEUE-02`.

#### BUG-QUEUE-02 — SIGKILL-failure cleanup path skips `onJobFinished` + `ai_invocations` + per-job map cleanup
- **Severity:** Medium · **Subsystem:** QueueManager + rails
- **File:** `server/queue-manager.ts:1894-1918`
- **What's wrong:** When `treeKill('SIGKILL')` returns an error (escalation kill failed), the recovery block force-fails the job in memory + DB and releases the slot, but does **not** call `_onJobFinished`, does not `recordInvocation`, and does not clear `_snapshotRefs`/`_jobExecution`/`_openspecShims`/`_jobModelSelection`/`_jobProfileSelection`/`_jobProviderSelection`. The codebase's own `_failWedgedJob` applies exactly this fix for the analogous wedge — this branch doesn't.
- **Impact:** A child surviving SIGKILL (more likely on Windows via taskkill) wedges the rail in `running` forever; ticket status never reverts/flags, budget/webhook/Jira write-back never fires, per-job maps + git-stash snapshot leak.
- **Trigger:** Cancel/zombie-terminate a rail whose child survives the 5s grace and whose SIGKILL `treeKill` errors.
- **Fix:** Route terminal handling through a shared helper: fire `_onJobFinished(jobId, 'failed')`, `recordInvocation`, and clear all per-job maps + snapshot/exec/shim entries.

#### BUG-INTJOB-03 — Stray/late `result` frame from a finished turn is counted into the next turn
- **Severity:** Medium · **Subsystem:** Interactive job session · **Category:** data-integrity
- **File:** `server/interactive-job-session.ts:272-318`
- **What's wrong:** The double-count guard relies solely on `_awaitingResult`. After a turn's result, the next queued prompt's `_writeTurn` re-sets `_awaitingResult = true` immediately. A second (stray/duplicate) `result` line for the prior turn then passes the guard and is finalized against the new turn's (reset) `_turnEvents`, corrupting running totals/`num_turns`. The existing test only covers back-to-back results within one turn.
- **Impact:** Job token/cost/`num_turns` totals (the "honest, never an estimate" figures persisted to the row and `ai_invocations`) can be inflated/corrupted when a turn emits a late/duplicate result after the next turn begins.
- **Trigger:** A queued prompt fed on the first result, then a second buffered/duplicate result line for the prior turn.
- **Fix:** Tag each turn with a monotonic turn-id; only accept a `result` whose id matches the in-flight turn. Reset/count per turn-id, not per `_awaitingResult`.

#### BUG-PARSER-01 — Quick contract-refine and SMASH orphan the AI-CLI subtree on timeout (SIGTERM-only)
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** Contract refine + SMASH + spec parsers · **Category:** resource-leak
- **File:** `server/contract-refine-runner.ts:197-204`; `server/smash-runner.ts:231-238`
- **What's wrong:** `readRefineChildOutput` and `readSmashChildOutput` implement a timeout path that calls only `child.kill('SIGTERM')` on the direct child, with no tree-kill and no SIGKILL escalation — unlike the shared `spawn-lifecycle.ts` which escalates. SMASH full mode runs with a 900 000 ms (15 min) timeout and Read/Grep/Glob enabled (worst case).
- **Impact:** Orphaned `claude` (+ grandchild) processes accumulate across repeated quick-spec-refine / SMASH timeouts; a signal-swallowing CLI is never force-killed. Only on the timeout edge, hence Medium.
- **Trigger:** Quick spec with `contractRefine:true`, or POST `/tickets/:id/smash` (esp. `mode='full'`), against a model/CLI that hangs.
- **Fix:** Use `treeKill(child.pid,'SIGTERM')` + a SIGKILL-escalation timer in both readers, or route through `runAiCliInvocation` like the non-quick refine already does.

#### BUG-JIRA-CLIENT-01 — Jira PAT/token transmitted over plaintext HTTP (no https enforcement on `baseUrl`)
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** Jira client + credential store · **Category:** security
- **File:** `server/jira/jira-client.ts:375-390` (+ `jira-router.ts`, `jira-sync-manager.ts`)
- **What's wrong:** `detectDeployment` / connect / probe paths accept any `baseUrl` with no protocol validation. An `http://` base URL sends the Bearer PAT / Basic `email:token` in cleartext on every poll/drain (`baseUrl` is reused forever).
- **Impact:** A long-lived Jira token with the user's full permissions is exposed to passive capture / MITM whenever an `http://` base URL is configured (realistic for DC/Server installs on plain HTTP). Opt-in user misconfiguration on a loopback app, hence Medium.
- **Trigger:** Configure a Jira connection with an `http://` base URL via POST `…/jira/test` or `/connect`.
- **Fix:** Reject non-https base URLs (allow `http` only for explicit localhost/loopback) in `detectDeployment`/connect; return 400 "Jira base URL must use https".

#### BUG-JIRA-CLIENT-02 — Cloud-vs-DC detection spoofable via URL userinfo → PAT sent to wrong host
- **Severity:** Medium · **Subsystem:** Jira client · **Category:** security
- **File:** `server/jira/jira-client.ts:380-389`
- **What's wrong:** `detectDeployment` derives host via `new URL(baseUrl).host` and tests `.endsWith('.atlassian.net')`. `https://acme.atlassian.net@evil.com/` parses to host `evil.com` → classified DC → Bearer PAT sent to `evil.com`. Any host ending in `.atlassian.net` is auto-trusted as Cloud (Basic `email:token`). The request is built from the same unmodified `baseUrl`, so the credential reaches `evil.com`.
- **Impact:** Credential exfiltration / auth-scheme spoofing disguised as a legitimate Cloud connection.
- **Trigger:** Paste/import a base URL containing userinfo into the connect wizard.
- **Fix:** Reject base URLs containing `url.username`/`url.password`, strip to origin, and match the exact registrable host.

#### BUG-JIRA-SYNC-01 — `start()` unconditionally resets inflight outbox ops to pending mid-drain → duplicate sends
- **Severity:** Medium (reporter) → **Low (corrected)** · See Low section (`BUG-JIRA-SYNC-01`).

#### BUG-PLUGIN-02 — `getProjectState→mutate→_writeProjectState` is a non-atomic read-modify-write (read outside the lock)
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** Plugin system · **Category:** concurrency-race
- **File:** `server/plugin-manager.ts:121-133, 429-449, 704-719`
- **What's wrong:** `getProjectState()` reads `state.json` with no lock; `_writeProjectState()` wraps only the final write in `withFileLock`. The read→mutate→write window is unguarded, so install commit, uninstall, and `_cacheHealth` each read a full snapshot, mutate one key, and write the whole object back — last-writer-wins. The same module's `surgicalMergeJson` (used for `.mcp.json`) holds the lock across the whole round-trip; `state.json` doesn't.
- **Impact:** A plugin install record can be dropped, a health flag lost, or an uninstall resurrected when a rail-spawn `verify`→`_cacheHealth` races a router install/uninstall on the same project. Recoverable cache drift (self-heals on next verify); `.mcp.json` additivity is independently protected — hence Medium not High.
- **Trigger:** Install/uninstall serena while a rail job spawns (`resolvePluginsForSpawn` → verify → `_cacheHealth`).
- **Fix:** A `lockedUpdateState(projectPath, fn)` that reads→applies→writes under one lock keyed on `stateFilePath`; replace the `getProjectState()+_writeProjectState()` pattern at all mutation sites.

#### BUG-SQLITE-03 — `emptyStore()` returned on any read/parse error → a present-but-unreadable tickets file gets blanked on next mutate
- **Severity:** Medium · **Subsystem:** SQLite schemas + migrations · **Category:** data-integrity
- **File:** `server/ticket-store.ts:280`
- **What's wrong:** `readStore` returns `emptyStore()` on `JSON.parse` throw OR a missing/wrong top-level shape. `mutateStore` does `readStore → fn → writeStore`, so a present-but-corrupt/foreign-shaped `local-tickets.json` yields an empty store that is then mutated and atomically written back — wiping all tickets and resetting `next_id`. There's no ENOENT-vs-unreadable distinction. The per-ticket corruption case was already hardened; the top-level case was left returning `emptyStore`.
- **Impact:** A corrupt/hand-edited/externally-partial-write file can wipe the entire project's spec backlog. Atomic temp+rename + the advisory lock defend against in-process truncation, so triggers are out-of-band (hand-edit, disk corruption, foreign tool) — real but not in-process.
- **Trigger:** `readStore` inside `mutateStore` hits a present-but-unparseable/foreign-shaped file.
- **Fix:** Distinguish ENOENT (→ `emptyStore`) from a present-but-unparseable file (→ throw, so `mutateStore` aborts and preserves on-disk data).

#### BUG-ROUTER-01 — Unvalidated `attachmentId` path segment enables traversal in attachment read/delete
- **Severity:** Medium · **Subsystem:** HTTP routers + path traversal · **Category:** security
- **File:** `server/attachment-manager.ts:91-103, 163-197` (reached from `server/project-router-tickets.ts:1910-1960`)
- **What's wrong:** The attachment GET/DELETE routes pass `req.params.attachmentId` straight into `getMeta/getFilePath/delete` with no validation. `ticketKey` is validated in `ticketDir()`, but `attachmentId` is concatenated into `sidecarPath` as `${attachmentId}.meta.json` with no basename check, so `../../…` segments resolve outside the per-ticket dir. URL-encoded traversal reaches the param intact (verified against Express 5.2.1).
- **Impact:** An authenticated local caller (or a rebound/malicious-local-web origin holding the loopback token) can read any `*.meta.json` outside the attachment tree, and DELETE can `unlink` an arbitrary `*.meta.json`. Suffix-constrained and local-auth-gated — defense-in-depth failure mirroring the validated `ticketKey`.
- **Trigger:** GET/DELETE `…/attachments/<../traversal>`.
- **Fix:** Validate `attachmentId` against the opaque-token rule (`/^[A-Za-z0-9_-]{1,128}$/` or UUID) in the handlers, or add `attachmentId !== path.basename(attachmentId)` rejection in `sidecarPath`.

#### BUG-MOBILE-02 — Paired companion devices can subscribe to and operate on ANY project (no per-project ACL)
- **Severity:** Medium · **Subsystem:** Auth + WebSocket routing + pairing/mobile · **Category:** security
- **File:** `server/mobile/mobile-ws.ts:178-184` + `mobile-router.ts:109-115` + `mobile-devices.ts:18-21`
- **What's wrong:** `ws-routing.ts` claims the gateway "always subscribes each device to exactly the project(s) it may see." No such scoping exists: `subscribe` sets `state.projects` verbatim from device-supplied `msg.projects`; every device carries a hardcoded `'companion'` scope; the `/v1` REST allow-list validates only the **shape** of `:pid` and forwards to any project.
- **Impact:** A single over-shared/compromised pairing grants full visibility and control of every project. Combined with BUG-AUTH-01 the blast radius is the whole machine's project set.
- **Trigger:** Any paired companion sending `{type:'subscribe',projects:[<any pid>]}` or calling `/v1/projects/<any pid>/…`.
- **Fix:** Persist an allowed-project set per device and intersect both `state.projects` (subscribe) and `:pid` (forward) against it; or correct the docs to state companion is intentionally all-projects.

#### BUG-BROWSER-01 — WS `navigate` (and REST `initialUrl`) bypass the http(s)-only SSRF guard
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** Browser capture + Playwright · **Category:** security
- **File:** `server/index.ts:365-366` (+ `browser-capture-manager.ts` create/navigate, `browser-playwright.ts` `normalizeUrl`)
- **What's wrong:** REST `/browser/sessions/:id/navigate` rejects non-http(s) schemes (with a passing test for `file:///etc/passwd`), but the browser screencast WS forwards `{type:'navigate', url}` to `mgr.navigate` with **zero** validation, and `normalizeUrl` passes any `scheme://…` through. REST `POST /browser/sessions` `initialUrl` is also unvalidated. So `file:///etc/passwd`, `http://169.254.169.254/…`, loopback URLs all reach embedded Chromium.
- **Impact:** Local-file disclosure and link-local/loopback SSRF; rendered content + DOM + captured network shapes exfiltratable via `/capture`. WS upgrade is token-gated and server is loopback, so it's defense-in-depth / SSRF-via-XSS-or-compromised-client — hence Medium.
- **Trigger:** Open a browser session, send `{"type":"navigate","url":"file:///etc/passwd"}` over `/ws/browser/:id`; or POST with `initialUrl`. Then `/capture`.
- **Fix:** Centralize an `isNavigableUrl()` scheme-allowlist + private/link-local/loopback IP block inside `normalizeUrl`/`page.goto` so every navigation path (WS, REST navigate, create `initialUrl`) is covered.

#### BUG-BROWSER-03 — Captured network request/response URLs stored raw — leaks tokens/PII despite "never store bodies" invariant
- **Severity:** Medium · **Subsystem:** Browser capture · **Category:** security
- **File:** `server/browser-network.ts:98-108`
- **What's wrong:** The module reduces bodies to a key-name shape (privacy invariant) but stores the full request URL verbatim (`slice(0, 2000)`) with no query-string/credential stripping. Captured URLs are persisted into the `page-dom-<ts>.json` ticket attachment, then ride into the spec-ticket prompt + on-disk attachment. `captureNetwork` defaults ON.
- **Impact:** Bearer tokens, API keys, signed-URL signatures, OAuth `code`/`state`, session ids in request URLs of any browsed site are persisted into spec attachments, fed to the LLM, and shared with ticket recipients — exactly the leak the invariant claims to prevent.
- **Trigger:** Browse a query-string-authenticated/signed-URL site, then capture with `captureNetwork` on.
- **Fix:** Redact URL query strings before storing (keep origin+path, drop/hash query, or strip a sensitive-param denylist) in `NetworkRingBuffer.start`, mirroring the body-sketch policy.

#### BUG-BROWSER-04 — Headless Chromium launched with `--no-sandbox` while navigating arbitrary (and `file://`/internal) URLs
- **Severity:** Medium · **Subsystem:** Browser capture · **Category:** security
- **File:** `server/browser-playwright.ts:792-797`
- **What's wrong:** `launchPersistentContext` always passes `args: ['--no-sandbox', …]`, disabling Chromium's renderer sandbox unconditionally, while navigating fully attacker-influenceable URLs (incl. `file://`/internal per BUG-BROWSER-01).
- **Impact:** A renderer-level exploit on any browsed page escalates from sandboxed-renderer to full host code execution in the desktop app's context (filesystem, master token, terminals/spawn). Removes the primary mitigation for an inherently-untrusted-content feature. Conditional on a live Chromium exploit → Medium.
- **Trigger:** User browses a malicious page exploiting a Chromium renderer bug.
- **Fix:** Drop `--no-sandbox` on macOS/Windows (sandbox works there); only fall back where a Linux sandbox can't initialize, gated behind a platform check.

#### BUG-CI-01 — `latest/` channel: old `manifest.json` points at deleted installers during the upload window (no atomic swap)
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** CI + build/packaging · **Category:** data-integrity
- **File:** `.github/workflows/desktop-release.yml:1009-1098`
- **What's wrong:** Publish order is delete-stale-installers → upload-new → HEAD-verify → upload-manifest. Filenames are version-stamped, so the still-live OLD manifest references the previous version's filenames that step 1 already deleted, and the new manifest is only written last. Between delete and manifest-upload (multi-hundred-MB FTP window), `latest/manifest.json` (served `no-cache`) names binaries that 404.
- **Impact:** During every desktop release, specrails-web (and any manifest consumer) renders a Download CTA whose URL 404s for the upload window. Transient/self-healing → Medium.
- **Trigger:** Any tag push running `desktop-release`.
- **Fix:** Delete stale installers LAST (after the new manifest uploads). The new manifest only references already-uploaded+verified filenames, making the cutover atomic.

#### BUG-CI-02 — `CORE_BUNDLE_VERSION` pinned to `latest` breaks reproducibility; 3 jobs can bundle different core versions
- **Severity:** Medium · **Subsystem:** CI + build/packaging · **Category:** security/reproducibility
- **File:** `.github/workflows/desktop-release.yml:22`
- **What's wrong:** `CORE_BUNDLE_VERSION: "latest"` while node/openspec versions are deliberately pinned. The three platform build jobs each `npm install specrails-core@latest` on independent runners at different wall-clock times.
- **Impact:** A core publish landing mid-build embeds different core versions in the macOS `.dmg` vs Windows `.exe` of the same release; defeats tag-rebuild reproducibility; pulls a freshly-published (potentially compromised) core unpinned. `--ignore-scripts` limits install-time RCE.
- **Trigger:** Every release; skew manifests when a core publish overlaps the build window.
- **Fix:** Pin `CORE_BUNDLE_VERSION` to an exact version (PR-bumped), or resolve the concrete version once in a setup job and pass it to all three builds.

#### BUG-CI-03 — Bundled core/openspec npm install resolves transitive deps unpinned (no lockfile / integrity)
- **Severity:** Medium · **Subsystem:** CI + build/packaging · **Category:** security
- **File:** `scripts/assemble-bundled-core.mjs:124-149` (+ `assemble-bundled-openspec.mjs`)
- **What's wrong:** Installs into an empty temp prefix with a synthetic `package.json` and no lockfile, so `npm install <pinned-top-level>` resolves the entire transitive closure against the live registry with no captured integrity hashes. The resolved `node_modules` is copied into `src-tauri/core`/`openspec` and signed+notarized into the app. `--ignore-scripts` blocks install-time RCE but not bundling a malicious transitive version executed at runtime via `node <cli>`.
- **Impact:** Any compromised transitive dep published before a build is silently bundled into the signed installer; builds are non-reproducible.
- **Trigger:** Every release build.
- **Fix:** Vendor a committed `package-lock.json` for the bundled install and use `npm ci` (pinned + integrity); review lock changes in PRs.

#### BUG-MOBILE-DISP / BUG-WEBHOOK-01 — Webhook SSRF allow-list only inspects literal IPs (DNS rebinding + alternate IP encodings bypass)
- **Severity:** Medium · **Subsystem:** Outbound egress sinks: webhook-manager SSRF · **Category:** security
- **File:** `server/desktop-router.ts:146`
- **What's wrong:** `validateHttpUrl` runs only at create/update (never re-checked at delivery, where the stored URL is fetched raw). `isPrivateIp` returns false for any hostname `net.isIP()` doesn't recognize as a literal IP, so (a) a public DNS name resolving to `127.0.0.1`/`169.254.169.254`/RFC1918 passes (DNS-rebinding SSRF), and (b) decimal IPv4 (`https://2130706433/`) and hex IPv4-mapped IPv6 (`https://[::ffff:7f00:1]/`) evade the dotted-decimal-only mapped regex. HMAC is computed over the body regardless of destination.
- **Impact:** A user (or anyone reaching the local admin API) can register an https webhook resolving to an internal/loopback address → server issues HMAC-signed POSTs to internal services. TOCTOU: a validated public host can be rebound before delivery.
- **Trigger:** POST `/api/webhooks` with `url=https://<attacker-DNS>/` or `https://[::ffff:7f00:1]/`.
- **Fix:** `dns.lookup` all addresses and reject if any is loopback/private/link-local; re-validate (or pin the validated IP) at delivery; add hex-mapped IPv6 + decimal/octal IPv4 to the literal checks; prefer an outbound-host allowlist.

#### BUG-LONGTAIL-01 — `cancel()` clobbers `cancelled` status with `error`/`input`/`review` and emits a spurious failure (settle race)
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** Long-tail AI-CLI managers · **Category:** concurrency-race
- **File:** `server/proposal-manager.ts:193-206, 293-306`; `server/agent-refine-manager.ts:141-156, 331-383`
- **What's wrong:** `cancel()` SIGTERMs the child and writes `status='cancelled'`, but does not set `_disposed` and does not remove the child's close listener. When the killed child closes (non-zero), the close path runs with `_disposed===false`: ProposalManager calls `onError()` → `updateProposal(status:'input'|'review')` + `proposal_error`; AgentRefineManager sets `status:'error'` + `_emitError`. The authoritative `cancelled` state is overwritten and the client gets a spurious failure toast.
- **Impact:** A user-initiated cancel shows a false "failed" error and the DB row ends `input`/`review`/`error` instead of `cancelled`, confusing the state machine/retry logic.
- **Trigger:** Cancel a propose/refine while a turn is streaming.
- **Fix:** Mark the slot intentionally-cancelled (per-id flag or `removeAllListeners('close')`) so the close handler short-circuits; or check current DB status `=== 'cancelled'` before applying `onError`.
> **Dedup:** Shares root cause with `BUG-LONGTAIL-04` (listeners left attached after cancel/shutdown).

#### BUG-LONGTAIL-02 — No SIGKILL escalation on `cancel()`/`shutdown()` → SIGTERM-ignoring child orphaned (skip-permissions spend leak)
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** Long-tail AI-CLI managers · **Category:** resource-leak
- **File:** `server/proposal-manager.ts:43,196`; `server/spec-launcher-manager.ts:35,164`; `server/agent-refine-manager.ts:97,144`
- **What's wrong:** All three managers terminate children with a single `treeKill(pid,'SIGTERM')` and never escalate to SIGKILL, diverging from `spawn-lifecycle.ts`/`QueueManager._kill`. On project removal/shutdown the cleared `_activeProcesses` map drops the only handle.
- **Impact:** A child that swallows SIGTERM (or a blocked git/gh/build tool subprocess) becomes an unkillable orphan running with `--dangerously-skip-permissions`, burning API tokens for the host's lifetime. Conditional on signal-swallowing → Medium.
- **Trigger:** Project removed or user cancel while a child is mid-tool-exec/blocked-I/O.
- **Fix:** After `treeKill SIGTERM`, arm an unref'd 2s SIGKILL timer cleared on `'close'`, in `cancel()` and `shutdown()` of all three managers.
> **Dedup:** Same tree-kill/escalation theme as `BUG-CHAT-01` and `BUG-PARSER-01`.

#### BUG-LONGTAIL-04 — `cancel()`/`shutdown()` leave the child's close/error listeners attached → broadcasts on a removed project
- **Severity:** Medium · **Subsystem:** Long-tail AI-CLI managers · **Category:** error-handling
- **File:** `server/spec-launcher-manager.ts:161-169`; `server/proposal-manager.ts:193-206`
- **What's wrong:** `SpecLauncherManager.cancel()` deletes map entries and broadcasts `cancelled` but never removes the `'close'` listener, which later fires and broadcasts `spec_launcher_done`/`spec_launcher_error('Spec generation failed')` for a cancelled launch (reading the already-deleted buffer as `''`). `SpecLauncherManager.shutdown()` has no `_disposed` flag at all, so close handlers fire on a removed project. ProposalManager guards `shutdown` via `_disposed` but `cancel()` doesn't set it (the clobber in BUG-LONGTAIL-01).
- **Impact:** Duplicate/contradictory WS messages after cancel; broadcasts emitted for a torn-down/removed project.
- **Trigger:** Cancel a spec-launch (or remove a project) while the child is alive; the killed child closes a moment later.
- **Fix:** Per-id cancelled/disposed flag (or `removeAllListeners('close')`) short-circuiting the close handler; give `SpecLauncherManager` a `_disposed` flag set in `shutdown()` and checked in the close handler.

#### BUG-CLI-03 — `runDirect` parses the wrong result-event field names → cost/tokens summary always blank with real claude
- **Severity:** Medium · **Subsystem:** CLI bridge · **Category:** correctness
- **File:** `cli/specrails-desktop.ts:730-737`
- **What's wrong:** `runDirect` reads `cost_usd` / `input_tokens` / `output_tokens` as top-level fields, but real claude stream-json `result` carries `total_cost_usd` and nests tokens under `usage.*` (per `claude-adapter.ts:251-261`). The CLI test's mock emits the wrong top-level shape, so it passes while production never matches.
- **Impact:** Direct-mode end-of-run summary never shows real cost/tokens — silently loses the accounting the CLI advertises.
- **Trigger:** Any direct-mode invocation against a real claude binary.
- **Fix:** Parse `total_cost_usd` and `usage.input_tokens`/`usage.output_tokens` (mirror `finaliseInvocationResult`).
> **Dedup:** Same root cause class as `BUG-CLI-04` (wrong event-shape parsing in `runDirect`).

#### BUG-CLI-04 — `runDirect` renders the wrong assistant-text event shape → real claude output text never printed
- **Severity:** Medium · **Subsystem:** CLI bridge · **Category:** correctness
- **File:** `cli/specrails-desktop.ts:701-708`
- **What's wrong:** `runDirect` prints only `parsed.type === 'text'` / `parsed.content`, but real claude emits assistant text as `type:'assistant'` with `message.content[]` `{type:'text', text}` blocks — which fall into the silently-ignored bucket. The `type:'result'` branch also never prints `result.result`. Test mock uses the wrong shape, masking it.
- **Impact:** In direct (manager-down) mode the user sees no streamed assistant output at all — the offline fallback is effectively unusable for showing results.
- **Trigger:** Direct-mode run against real claude.
- **Fix:** Handle `type:'assistant'` by extracting/printing `message.content[].text` (mirror `parseClaudeStreamLine`).

#### BUG-CLI-01 — `runDirect` shatters multi-word raw prompts into separate argv elements after `-p`
- **Severity:** High (reporter) → **Medium (corrected)** · **Subsystem:** CLI bridge · **Category:** correctness
- **File:** `cli/specrails-desktop.ts:654-660`
- **What's wrong:** Builds argv as `['-p', ...command.trim().split(/\s+/), …]`. `-p` takes one operand; splitting on whitespace spreads each word as a separate positional, so claude gets `-p <firstWord>` plus stray positionals. Quotes/whitespace normalization are irretrievably lost. Test mock ignores argv, masking it.
- **Impact:** Every multi-word prompt run through the offline/direct fallback (manager down) is corrupted — wrong/failed output with no error. (Recent claude space-joins trailing positionals, partially recovering text but still losing quoting — hence Medium, not High.)
- **Trigger:** `specrails-desktop "any multi word prompt"` while the manager is not running.
- **Fix:** Pass the prompt as a single argv element: `'-p', command.trim()`.

#### BUG-WEBHOOK-03 — Receiver records `telemetry_blobs.byteSize` before the append completes, no rollback on failure
- **Severity:** Low · See Low section (`BUG-WEBHOOK-03`).

---

### LOW

#### BUG-FW-02 — `readCurrentFrameworkVersion` can't read the Windows copy/junction `current` dir
- **Severity:** Low · **Subsystem:** Framework manager · **Platform:** Windows
- **File:** `server/framework-manager.ts:82-101`
- **What's wrong:** On the Windows copy-fallback/junction path, `current` is a real dir/junction (not a POSIX symlink); the function returns `path.basename` = `'current'` → null. So version detection is always null on Windows, making `versionCheck` re-materialize every startup and `swapCurrent` return false (its post-swap `=== version` check fails), emitting a misleading `framework.update_failed` broadcast every boot. Reachable on the default Windows junction path, broader than the stated trigger.
- **Impact:** Wasted re-materialization + false `update_failed` each boot; framework still assembles, so functional impact is low.
- **Trigger:** Windows host (junction or copy fallback for `current`).
- **Fix:** When `current` is a real dir/junction, read the version from the documented marker file instead of returning basename `'current'` → null.

#### BUG-ARTREG-01 — `workspace-manager` `$HOME` resolution diverges from `artifact-registry` under `SPECRAILS_REGISTRY_HOME`
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Artifact registry + workspace resolution
- **File:** `server/workspace-manager.ts:27-28`
- **What's wrong:** `projectsBaseDir()` uses `home ?? os.homedir()` and ignores `SPECRAILS_REGISTRY_HOME`; `artifact-registry.resolveHome()` consults it. When the env var is set but no explicit home is threaded, the registry's `workspaceDir` and the `./project` symlink `ensureWorkspace` creates land in different trees. `project-registry.ts:257` already works around this for `removeWorkspace` but `resolveProjectExecution` doesn't.
- **Impact:** If `SPECRAILS_REGISTRY_HOME` is set in a real deployment, the `./project` symlink is created in the wrong workspace, breaking repo-relative tool I/O. Masked in production (var unset → both fall to `os.homedir()`) → latent footgun, Low.
- **Trigger:** Any env setting `SPECRAILS_REGISTRY_HOME` then calling `resolveProjectExecution` without an explicit home.
- **Fix:** Make `projectsBaseDir` reuse `resolveHome()`, or thread `resolveHome(home)` into `ensureWorkspace` like `removeWorkspace`.

#### BUG-ARTREG-02 — Adopting a partial/hand-edited core-standalone entry permanently strands the project in legacy mode
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Artifact registry · **Category:** data-integrity
- **File:** `server/artifact-registry.ts:425-440`
- **What's wrong:** The adoption/upsert branch spreads `existing` verbatim and never re-derives path/identity fields from `workspaceLayout`; `isCompleteEntry` is consulted only on the read side. A partial/hand-edited entry missing one path field is written back as `source:'desktop'` and `resolveArtifacts` treats it as ABSENT → `isLegacy=true` forever, contradicting the `reconcileFromProjects` "self-heals" comment.
- **Impact:** A relocated project silently and permanently behaves as legacy (artifacts back into the repo) with no recovery short of manual registry surgery. Outcome is the safe legacy fallback (no data loss) and trigger requires out-of-band corruption → Low.
- **Trigger:** A core-standalone allocator/AV truncates an entry missing a path key, then the repo is imported/reconciled.
- **Fix:** Guard adoption with `isCompleteEntry`; on failure rebuild paths from `workspaceLayout` using the immutable slug so a partial entry self-heals.

#### BUG-ARTREG-03 — `atomicWrite` never fsyncs the parent directory after rename
- **Severity:** Low · **Subsystem:** Artifact registry · **Category:** data-integrity
- **File:** `server/artifact-registry.ts:246-279`
- **What's wrong:** fsyncs the temp file before rename but never opens+fsyncs the containing dir after `renameSync`. On POSIX the rename's directory entry isn't durable until the dir is fsynced; a crash in that window can lose the write.
- **Impact:** After unclean shutdown a registry write may be lost. Bounded — desktop-owned entries self-heal via `reconcileFromProjects` at next boot.
- **Trigger:** Power loss/crash immediately after a registry rename.
- **Fix:** After `renameSync`, `openSync(dir)` + `fsyncSync` + `closeSync` (best-effort try/catch; Windows rejects dir fsync).

#### BUG-ARTREG-04 — Live registry lock can be stale-broken mid-`fn()` (TTL has no heartbeat) → lost update
- **Severity:** Low · **Subsystem:** Artifact registry · **Category:** concurrency-race
- **File:** `server/artifact-registry.ts:287-344`
- **What's wrong:** `withFileLock` writes the lock mtime once at acquisition and never refreshes it; the stale-break measures wall-clock since acquisition. A holder paused > 30s (suspend/swap/debugger) can be stale-broken while live, letting a second writer run a concurrent read-modify-write (lost update). The token-guard prevents deleting the wrong file but not the concurrent execution.
- **Impact:** Two writers racing read-modify-write can drop one entry update. Self-heals on next reconcile for desktop-owned entries; a dropped core-standalone allocation could be lost. `fn()` is sub-ms so realistically only cross-process + a frozen holder.
- **Trigger:** A lock holder stalls > 30s while another process contends.
- **Fix:** Refresh the lock mtime during long holds, or use OS advisory locks (flock) that release on process death and need no TTL.

#### BUG-FW-03 — Partial re-link + `.some()` verify deletes byte-identical backups (latent)
- **Severity:** High (reporter) → **Low (corrected)** · **Subsystem:** Framework migration · **Category:** data-integrity
- **File:** `server/framework-migration.ts:289-334`
- **What's wrong:** Migration verifies with `SHARED_SUBTREES.some(linkResolvesIntoFramework)` (one linked subtree passes) then unconditionally deletes every non-`custom-*` `.bak`. `.some()` should be `.every()`.
- **Impact:** Verifiers refuted the data-loss path: a partial assemble exits non-zero → `assembled=false` → full revert restores all backups; an exit-0 assemble materializes every subtree (symlink or copy fallback); and `framework/current` is the untouched recovery source self-healed by `assembleWorkspace` on the same call. So this is a **code-hygiene smell** (`.some` → `.every`), not irreversible loss.
- **Trigger:** N/A in current code (the partial-mix-with-exit-0 precondition is unreachable).
- **Fix:** Change verify to `.every()`; only delete a `.bak` when its corresponding live path is a verified symlink into `current` (defense-in-depth for a future core regression).

#### BUG-INTJOB-02 — No settle fallback if the child never emits `'close'` after finalize SIGTERM/SIGKILL
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Interactive job session · **Category:** resource-leak
- **File:** `server/interactive-job-session.ts:191-203`
- **What's wrong:** `finalize()` SIGTERMs + arms a 2s SIGKILL timer, but `_settle()` (→ active-slot release, terminal status, queue drain) is only reached via `_handleClose` on the child `'close'` event. If `'close'` never fires (D-state/uninterruptible process), the SIGKILL timer fires and then nothing settles — the slot leaks, the job stays `running`, the queue never drains. No independent timeout. The interactive path notably arms no zombie watchdog.
- **Impact:** A stuck child wedges the interactive job permanently until restart. Narrow reachability (direct `child.kill` usually reaps via SIGKILL) → Low.
- **Trigger:** `finalize()`/cancel on a child that never emits `'close'` after SIGTERM+SIGKILL.
- **Fix:** Have the SIGKILL timer (or a hard-deadline timer) force `_settle('finalized'/'crashed')` even if `'close'` never arrives, then detach listeners.

#### BUG-INTJOB-04 — `send()` echoes the user prompt to the transcript before confirming delivery
- **Severity:** Low · **Subsystem:** Interactive job session · **Category:** correctness
- **File:** `server/interactive-job-session.ts:154-178`
- **What's wrong:** `send()` persists+emits the `🧑 <text>` log line and broadcasts `job.turn_user` before `_writeTurn`, which can silently fail to deliver (stdin destroyed early-return or caught EPIPE). The only guard is `_disposed`/`_finalizing`/`!_child`; a child alive but with closed stdin passes.
- **Impact:** In-job chat shows turns as accepted that were never delivered to the agent. Transient (narrow stdin-destroyed-while-alive race).
- **Trigger:** Any `send()` while the child is alive but stdin isn't writable (mid-crash/EPIPE).
- **Fix:** Have `_writeTurn` return a boolean; only persist/echo after a confirmed write (or queue), and surface a delivery-failure note + settle when it can't be delivered.

#### BUG-CHAT-02 — Auto-title CLI child is untracked and orphaned on shutdown/abort
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** ChatManager · **Category:** resource-leak
- **File:** `server/chat-manager.ts:1372`
- **What's wrong:** `_autoTitle()` spawns a fresh claude/codex child but never registers it in `_activeProcesses`; `shutdown()`/`abort()` only iterate that set + `_stdinSessions`, so an in-flight auto-title child is never signaled on shutdown/project removal.
- **Impact:** One orphaned (Windows `cmd.exe`-wrapped) auto-title child per first-turn completion right before shutdown. Self-terminating, one-per-completion → Low.
- **Trigger:** Complete the first turn of an Explore/sidebar conversation, then immediately quit/remove the project before the title CLI returns.
- **Fix:** Track the auto-title child in an `_auxProcesses` set and tree-kill it in `shutdown()`; remove on its `'close'`.

#### BUG-CHAT-06 — Persistent-stdin `writeTurn` returns success after backpressured write; no `'error'` listener on `child.stdin`
- **Severity:** Low · **Subsystem:** ChatManager · **Category:** error-handling
- **File:** `server/explore-stdin-session.ts:138`
- **What's wrong:** `writeTurn` checks `stdin.destroyed` once then returns true on any non-throw; a buffered write that later emits async EPIPE has **no `'error'` listener** attached to `child.stdin` in `getOrSpawn`. (The "hang" half of the report is refuted — process death routes to `onClose`/settle — but the missing stdin `'error'` listener is real: an unhandled `'error'` on a Writable can crash the process, and there is no process-level `uncaughtException` handler.)
- **Impact:** A buffered stdin write that errors asynchronously could crash the server. Gated by the default-OFF persistent-stdin flag + a narrow race → Low.
- **Trigger:** Persistent child dies exactly as a new turn is written; the buffered write later emits EPIPE.
- **Fix:** Attach an `'error'` listener to `child.stdin` in `getOrSpawn` (route to `onClose(null)`); surface a delayed write-error path so ChatManager fails the turn.

#### BUG-QUEUE-03 — Gemini rails get claude-shaped telemetry env (`CLAUDE_CODE_ENABLE_TELEMETRY`); no `GEMINI_TELEMETRY_*` ever set
- **Severity:** Low · **Subsystem:** QueueManager · **Category:** correctness
- **File:** `server/queue-manager.ts:1176-1185 / 43-65`
- **What's wrong:** `buildTelemetryEnv` is provider-agnostic and emits only `CLAUDE_CODE_ENABLE_TELEMETRY` + generic `OTEL_*`. The gemini adapter declares `nativeOtelEnv:true` and its comment claims OTLP via `GEMINI_TELEMETRY_*` "set by QueueManager" — but no code sets any `GEMINI_TELEMETRY_*` var (the only occurrence is the adapter comment).
- **Impact:** Pipeline telemetry likely doesn't flow for gemini rails despite being enabled — empty diagnostic ZIPs / missing spans, no error. Opt-in, default-off → Low.
- **Trigger:** Enable pipeline telemetry on a multi-provider project; launch a gemini rail.
- **Fix:** Make `buildTelemetryEnv` (or a per-adapter `adapter.buildTelemetryEnv`) provider-aware; verify the exact Gemini CLI env contract.

#### BUG-JIRA-SYNC-01 — `start()` resets inflight outbox ops to pending mid-drain → duplicate sends
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Jira sync manager · **Category:** concurrency-race
- **File:** `server/jira/jira-sync-manager.ts:165-170`
- **What's wrong:** `start()` calls `resetInflight(db)` unconditionally before the early-return guard, and is reachable from `setEnabled(true)`/`connect()` (not just construction). If a toggle/reconnect lands during a live `drainOnce()` awaiting HTTP, in-flight ops are reset to pending and re-claimed/re-executed by the next 10s tick. Terminal mutators (`markOutboxDone`/`Retry`) write by id with no `state='inflight'` precondition.
- **Impact:** Duplicate write-backs. Transitions/comments are largely idempotent (re-GET, marker dedup), but `executeUpdate` sets identical values and the concrete harm is outbox-state churn (attempts inflation → premature dead-letter). Narrow trigger → Low.
- **Trigger:** Hot-swap toggle / disconnect-reconnect while the drain timer has ops inflight.
- **Fix:** Move `resetInflight` to a construction-only crash-recovery path, or guard it behind `if (this.pollTimer || this.drainTimer) return`.

#### BUG-JIRA-SYNC-02 — `pollOnce` has no `authPaused` guard → a 401 re-fires `jira.auth_expired` every 60s forever
- **Severity:** Low · **Subsystem:** Jira sync manager · **Category:** error-handling
- **File:** `server/jira/jira-sync-manager.ts:512-561`
- **What's wrong:** `onAuth401()` sets `authPaused=true` to halt the drainer, but `pollOnce` has no `authPaused` check; the 60s poll keeps firing, `searchJql` returns `auth`, `pollOnce` re-calls `onAuth401()`, re-broadcasting `jira.auth_expired` unconditionally (no de-dup on already-paused).
- **Impact:** Toast/banner spam every 60s + a wasted authed request to an expired credential (mild rate-limit risk).
- **Trigger:** Token expires/revokes while a project stays connected.
- **Fix:** `if (this.authPaused) return null` at the top of `pollOnce`; make `onAuth401()` broadcast only on the false→true transition.

#### BUG-JIRA-SYNC-03 — `onSpecEdited` idempotency key collides on sub-ms double-save → second edit silently dropped
- **Severity:** Low · **Subsystem:** Jira sync manager · **Category:** data-integrity
- **File:** `server/jira/jira-sync-manager.ts:641-649`
- **What's wrong:** Key is `update:${localId}:${Date.now().toString(36)}`. Two edits to the same ticket in one millisecond produce identical keys; `INSERT OR IGNORE` on the UNIQUE `idempotency_key` drops the second op, so its field changes never reach Jira while the local cache reflects them — silent divergence.
- **Impact:** Silent loss of a field-edit write-back; local↔Jira diverge until an unrelated edit re-triggers. Narrow ms window → Low; self-heals on later edit.
- **Trigger:** Two saves of the same Jira-backed spec within the same wall-clock millisecond.
- **Fix:** Add a random/monotonic component to the nonce (`${Date.now().toString(36)}:${crypto.randomUUID()}` or a per-manager counter).

#### BUG-JIRA-SYNC-04 — Persistent 429 retries never dead-letter (unbounded retry loop)
- **Severity:** Low · **Subsystem:** Jira sync manager · **Category:** error-handling
- **File:** `server/jira/jira-sync-manager.ts:906-910`
- **What's wrong:** `handleHardError`'s `rate_limit` branch always `markOutboxRetry` + returns true, with **no** `MAX_ATTEMPTS` cap (unlike `retryOrDead`). A perpetual-429 op is re-queued and re-claimed forever, never dead-lettered/surfaced.
- **Impact:** An op stuck on perpetual 429 never surfaces as dead-lettered to the operator and perpetually re-occupies its own issue's drain slot. (Note: it does NOT starve other issues — `claimDrainable`'s dedup is per-pass.)
- **Trigger:** Jira returns 429 repeatedly for an op.
- **Fix:** Respect `MAX_ATTEMPTS` in the rate_limit branch — `markOutboxDead` + broadcast degraded when exhausted.

#### BUG-JIRA-CLIENT-05 — `writeJiraBacklogConfig` idempotency check ignores `git_auto` → can leave `git_auto:true` (core auto-commits)
- **Severity:** Low · **Subsystem:** Jira backlog-config · **Category:** correctness
- **File:** `server/jira/jira-backlog-config.ts:38-41`
- **What's wrong:** The early-return compares only `provider` + `write_access`, not `git_auto`. A pre-existing `{provider:'local', write_access:false, git_auto:true}` returns early and never gets rewritten to `git_auto:false`, so core keeps auto-committing on a Jira-backed project. An existing test documents the (buggy) unchanged behavior.
- **Impact:** Core may keep auto-committing where desktop intends to own commits → unexpected repo commits. Narrow (desktop's own writers always pair these fields) → Low.
- **Trigger:** A pre-existing backlog-config with `write_access:false` but `git_auto:true` when connecting Jira.
- **Fix:** Add `&& existing.git_auto === desired.git_auto` to the early-return (or always write idempotently).

#### BUG-JIRA-ADF-06 — `adfToText` flatten drops separators for list/table/code-block containers → run-on text
- **Severity:** Low · **Subsystem:** Jira ADF · **Category:** data-integrity
- **File:** `server/jira/jira-adf.ts:91-107`
- **What's wrong:** Emits `'\n'` only for `paragraph`/`heading`. `codeBlock` (direct text children, no inner paragraph) and trailing separators after `blockquote`/`panel`/`codeBlock` are dropped, concatenating onto adjacent text. (List/table content is mostly fine since `listItem`/`tableCell` wrap text in `paragraph`.)
- **Impact:** Jira-authored specs with code blocks render as run-on text in the local cache (display-fidelity only; text content preserved). Low.
- **Trigger:** Sync an issue whose ADF description uses code blocks.
- **Fix:** Emit a newline after `codeBlock`/`blockquote`/`panel`/`tableRow` container nodes.

#### BUG-PLUGIN-04 — Orphan removal of `.mcp.json` is impossible → unowned `mcpServers` key loaded by Claude forever
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Plugin system · **Category:** data-integrity
- **File:** `server/plugin-manager.ts:532-550`
- **What's wrong:** State stores only `installedFiles`, never the owned `mcpServers` keys. Orphan-removal (plugin dropped from the registry) deletes `installedFiles` + the state entry but explicitly leaves `.mcp.json` alone, and with the plugin code gone there's no record of which key to strip — so the merged `mcpServers.<key>` can never be removed by the app and Claude keeps launching it.
- **Impact:** After a future build drops a bundled plugin, its MCP server entry persists in `.mcp.json` and runs indefinitely with no UI affordance to remove it. Not reachable today (only serena bundled) → Low.
- **Trigger:** Install serena → ship a build dropping serena from `BUNDLED_PLUGINS` → orphan-remove it.
- **Fix:** Persist the plugin's owned `mcpServers` keys in state at install time so orphan removal can surgically strip them even when the code is gone.

#### BUG-PLUGIN-03 — `resolvePluginsForSpawn` runs all `verify→_cacheHealth` writes in parallel (`Promise.all`) → lost health updates
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Plugin system · **Category:** concurrency-race
- **File:** `server/plugins/rail-integration.ts:33-40` + `server/plugin-manager.ts:704-719`
- **What's wrong:** Maps every installed plugin's `verify()` (→ `_cacheHealth` full-state read-modify-write) through one `Promise.all`. With ≥2 plugins both changing health in one spawn, parallel `_cacheHealth` calls each read the same start state and last-writer-wins. (Same root cause as BUG-PLUGIN-02.)
- **Impact:** Only one plugin's degraded-health update + broadcast persists; the other reverts. Not reachable today (single plugin); self-heals next spawn → Low.
- **Trigger:** ≥2 installed plugins whose verify results both change during one `resolvePluginsForSpawn`.
- **Fix:** Serialize the state-mutating `_cacheHealth` (verify probes can stay parallel), or make `_cacheHealth` a single locked read-modify-write.
> **Dedup:** Same `state.json` read-modify-write race as BUG-PLUGIN-02; fixing `lockedUpdateState` resolves both.

#### BUG-PLUGIN-05 — `mergeMcpServers` silently drops the plugin entry when `.mcp.json` `mcpServers` is a non-object (array)
- **Severity:** Low · **Subsystem:** Plugin system · **Category:** error-handling
- **File:** `server/plugin-manager.ts:736-747`
- **What's wrong:** `((next.mcpServers as Record) ?? {})` falls back to `{}` only on null/undefined. If `mcpServers` is a JSON array, the ownership pre-check (`key in array`) passes, `servers['serena']=v` attaches a non-index property that `JSON.stringify` drops, and verify (only probes `uv`) passes — so state records the plugin installed while `.mcp.json` never gained a usable entry. (A string/number value throws a 500 instead — loud, not silent.)
- **Impact:** On a malformed `.mcp.json` with `mcpServers` as an array, the plugin is reported installed but its MCP server is never loaded. Requires a schema-violating file → Low.
- **Trigger:** Install serena on a project whose `.mcp.json` has `mcpServers` as an array.
- **Fix:** Validate `current.mcpServers` is a plain object before merging; throw a `PluginInstallError` (actionable 409) otherwise.

#### BUG-SQLITE-02 — Stale-lock detection is mtime-only, never owner-PID liveness → crashed writer holds the lock for a fixed 10s
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** SQLite/ticket-store · **Category:** concurrency-race
- **File:** `server/ticket-store.ts:170`
- **What's wrong:** `acquireLock` writes `process.pid` into the lock but never reads it back; the only staleness signal is `mtime > 10s`. A crashed writer's lock is "held" for a full 10s even though the PID is dead, and the recorded PID is dead-weight.
- **Impact:** After a hard kill while holding the ticket lock, concurrent ticket writes can exhaust the 50×50ms (2.5s) retry budget and throw "Could not acquire lock", losing a mutation, until mtime ages past 10s. The lock is held only across a synchronous small-JSON read-modify-write (sub-ms crash window) → Low.
- **Trigger:** Server SIGKILLed while in `writeStore`/`mutateStore`, then another write before mtime ages.
- **Fix:** Read the stored PID and treat the lock as stale immediately when `process.kill(pid, 0)` throws ESRCH; keep mtime TTL as cross-host fallback.

#### BUG-SQLITE-05 — `migrateLegacyDbFile` renames the main DB before its WAL sidecar → crash-window WAL loss
- **Severity:** Low · **Subsystem:** SQLite migrations · **Category:** data-integrity
- **File:** `server/desktop-db.ts:92`
- **What's wrong:** The `hub.sqlite → desktop.sqlite` rebrand renames the main DB first, then loops to rename `-wal`/`-shm`. SQLite matches WAL by base filename; a crash between the two renames leaves `desktop.sqlite` with no adjacent WAL → un-checkpointed commits in the orphaned `hub.sqlite-wal` are silently discarded.
- **Impact:** One-time rebrand upgrade can drop the most recent un-checkpointed registry/settings/webhook writes if interrupted. Sub-ms two-renameSync window; default `wal_autocheckpoint`/close-checkpoint usually fold the WAL first → Low.
- **Trigger:** Crash after the main rename but before the `-wal` rename on first post-rebrand launch.
- **Fix:** Checkpoint/close the WAL before migrating, or rename `-wal`/`-shm` siblings BEFORE the main file.

#### BUG-MOBILE-05 — App-level `desktop_daily_budget_exceeded` pushed to every mobile socket regardless of `alerts` subscription
- **Severity:** Low · **Subsystem:** Auth/WebSocket/mobile · **Category:** correctness
- **File:** `server/mobile/mobile-ws.ts:211-214`
- **What's wrong:** The special-case for the app-level budget alert sends to every socket unconditionally (`continue`), bypassing the `s.topics.has(topic)` gate every other topic message honors. New sockets init with empty topics, so a device that never subscribed to `alerts` still receives these frames. The code's own comment says it should deliver only to `alerts` subscribers.
- **Impact:** Over-delivery (no isolation leak — payload is app-wide spend, no `projectId` secret): unsubscribed clients get budget-alert frames + wasted bandwidth.
- **Trigger:** Gateway enabled, any connected device (even `topics=[]`) when a desktop daily budget alert fires.
- **Fix:** Gate on `s.topics.has('alerts')` like other deliveries, or document it as an always-delivered system alert.

#### BUG-MOBILE-06 — `redact()` doesn't scrub absolute paths outside `$HOME` → leaks local layout to the phone
- **Severity:** Low · **Subsystem:** Auth/WebSocket/mobile · **Category:** security
- **File:** `server/mobile/mobile-redact.ts:11,23-27,35-46`
- **What's wrong:** `redact()` drops a fixed `SENSITIVE_KEYS` set and replaces only the `$HOME` prefix with `~`. Any absolute path NOT under `os.homedir()` (`/Volumes/Work/repo`, `/tmp/x`, a second Windows drive) and paths under un-keyed fields (job command, error message, ticket text) survive verbatim into forwarded/pushed payloads.
- **Impact:** Local filesystem layout (mount points, drive letters, non-HOME project locations) leaks to a paired, token-authenticated phone. Metadata only, single-user desktop → Low.
- **Trigger:** Any forwarded REST/WS payload whose string fields carry an absolute path not under `$HOME`.
- **Fix:** Scrub tokens matching an absolute-path regex (POSIX `/…`, Windows `X:\…`) to a placeholder; treat the key allowlist as defense-in-depth.

#### BUG-MOBILE-07 — Terminal/browser PTY WebSockets have no inbound message-rate limiting
- **Severity:** Low · **Subsystem:** Auth/WebSocket/mobile · **Category:** resource-leak
- **File:** `server/index.ts:300-328,347-378,426-447,534`
- **What's wrong:** `applyWsRateLimiting` (120 msg/min + 64KB/message) is attached only inside the main `wss` `connection` handler. The terminal (`/ws/terminal/:id`) and browser (`/ws/browser/:id`) sockets (handled in the upgrade callback) get only the 1MB frame cap — no message-count throttle.
- **Impact:** A flood of tiny control frames drives high CPU (PTY writes, resize storms, Playwright input) uncapped — a local DoS. Token+projectId-authed and loopback → Low.
- **Trigger:** Authenticated terminal/browser WS client sending a high rate of small control frames.
- **Fix:** Call `applyWsRateLimiting(ws)` (or a PTY-tuned variant) inside the terminal and browser handleUpgrade callbacks.

#### BUG-TERM-02 — `RingBuffer.append` retains the full original chunk's ArrayBuffer when trimming a lone oversized chunk (subarray view)
- **Severity:** Low · **Subsystem:** Terminal PTY · **Category:** resource-leak
- **File:** `server/terminal-manager.ts:129-134`
- **What's wrong:** When a single chunk > 256KB arrives, the buffer keeps the tail via `head.subarray(excess)` — a view over the same underlying ArrayBuffer — so the trimmed 256KB view pins the entire original (multi-MB) allocation until the next append.
- **Impact:** Transient memory over-retention: a `cat bigfile` (~10MB single chunk) then idle keeps ~10MB resident instead of 256KB. Bounded to one chunk/session, self-healing on next append; scales with concurrent idle sessions → Low.
- **Trigger:** A command flooding stdout in one >256KB `onData` chunk, then idle.
- **Fix:** Copy out the tail: `this.chunks[0] = Buffer.from(head.subarray(excess))`.

#### BUG-TERM-01 — Per-session shim directory created world-traversable (defense-in-depth gap)
- **Severity:** Low (reporter) → **Info (corrected)** · See note. The dir holds only non-secret `source '<bundled>'` lines; files are `chmod 600`; only session-ID metadata enumeration on a non-default world-traversable `$HOME` is at risk. Listed for completeness; fix is `mkdirSync(dir, { mode: 0o700 })` + `chmodSync` on the leaf. Counted as info, not in the Low tally.

#### BUG-BROWSER-02 — Concurrent `create()` calls race past `MAX_SESSIONS_PER_PROJECT` (resource-limit TOCTOU)
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Browser capture · **Category:** concurrency-race
- **File:** `server/browser-capture-manager.ts:199-222`
- **What's wrong:** `create()` reads the live-session count and throws if `>= 4`, then awaits `ensureContext()`+`ctx.newPage()` before inserting into `this.sessions`. The cap check and the map insertion are separated by two awaits with no reservation, so N concurrent `POST /browser/sessions` all observe `< 4` and proceed.
- **Impact:** The per-project page/memory cap is bypassable by firing N parallel creates. Bounded by burst concurrency (shared context reused), loopback-only → Low.
- **Trigger:** `Promise.all` of `POST …/browser/sessions` on a fresh manager.
- **Fix:** Reserve the slot synchronously (counter/placeholder) before the awaits; re-check after `newPage` and tear down the extra.

#### BUG-CODE-01 — `GET /diff` serves stored patches without deny-list or `.gitignore` checks → leaks secret-file contents
- **Severity:** High/Medium (split) → reported as Medium-to-High · **Subsystem:** File provenance + code explorer · **Category:** security
- **File:** `server/code-explorer-router.ts:841-859`
- **What's wrong:** Every other content endpoint (`/file`, `/summary`, `/file/regenerate-summary`, `/provenance`) enforces `isDeniedRelPath` AND `isGitIgnored` after `resolveSafePath`. `/diff` enforces **neither** — only path-traversal. Provenance + diffs are recorded for any AI-touched path with no deny filter, and an added-file patch contains the full file content. So an AI job that creates/modifies a secret file (`.env`, `*.pem`, `id_rsa`, `*.key`, gitignored creds) has its complete contents served verbatim via `/diff?jobId=…&path=.env`. Feature defaults ON.
- **Impact:** Disclosure of secret/credential file contents to a UI tier explicitly for non-developers, defeating the deny-list hardening every sibling endpoint applies. Local-only (loopback) disclosure → split High/Medium; treated as **Medium** in the tally given loopback + requires an AI job to touch a secret file.
- **Trigger:** AI rail touches/creates a denied/gitignored file, then GET `…/code/diff?jobId=<job>&path=.env`.
- **Fix:** Add `isDeniedRelPath(relPath)` + `isGitIgnored(projectPath, normalizeRel(relPath))` guards in `/diff` before `getProvenanceDiff`; optionally skip denied paths at record time.

#### BUG-CODE-02 — `file-summary.v1.json` schema is never used — LLM output and on-disk summaries never validated
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** File summaries · **Category:** data-integrity
- **File:** `server/file-summary-manager.ts:140-149`
- **What's wrong:** Docs claim summaries are "Schema validated by file-summary.v1.json", but no module imports/compiles it (unlike `profile.v1.json` via ajv). `writeSummary` persists the manager payload directly; `readSummary` does `JSON.parse(raw) as SummaryPayload` with a bare cast. LLM `out.summary` is written with no length bound.
- **Impact:** A corrupt/tampered/cross-version summary is trusted and surfaced verbatim (and consumed by orphan-sweep via `payload.path`); unbounded length can bloat WS/file payloads; the documented invariant gives false assurance. App-internal writes are well-formed → Low.
- **Trigger:** Read of a summary file that's valid JSON but non-conformant (hand-edited/cross-version/oversized).
- **Fix:** Compile `file-summary.v1.json` with the existing ajv instance and validate in `readSummary` (invalid → null/stale) and `writeSummary`; add `maxLength` to `summary`.

#### BUG-CODE-04 — `touched-by-ai` tree does not apply `.gitignore` → gitignored AI-touched files listed
- **Severity:** Low · **Subsystem:** Code explorer · **Category:** security
- **File:** `server/code-explorer-router.ts:441-448`
- **What's wrong:** The `all` filter applies `gitIgnoredSet()`; the `touched-by-ai` branch (the default) applies only `isDeniedRelPath`, never `gitIgnoredSet`. A gitignored AI-touched file not caught by the deny-list (project-specific `config.local.json`, custom build dirs) appears with path/ticket-attribution/mtime, inconsistent with the documented `.gitignore`-respect contract. (`/file` gates content via gitignore, but `/diff` — BUG-CODE-01 — does not.)
- **Impact:** Filename + ticket-attribution + mtime of gitignored AI-touched files surface; combined with BUG-CODE-01 the content is reachable. Low.
- **Trigger:** AI job modifies a gitignored file whose name/extension isn't deny-listed; open Code with the default filter.
- **Fix:** Run the touched-by-ai file paths through `gitIgnoredSet()` and drop ignored entries (and empty dir nodes), mirroring `listAllEntries`.

#### BUG-CODE-05 — Monthly budget cap can be overshot by the entire in-flight set (no spend reserved until completion)
- **Severity:** Low · **Subsystem:** File summaries · **Category:** concurrency-race
- **File:** `server/file-summary-manager.ts:376-383`
- **What's wrong:** `monthToDateSpend()` reads recorded `ai_invocations` cost, but a generation's cost row is written only at the end of `runOne`. Up to `desktopConcurrency` (8) generations can all pass the budget check, start, and bill before any records its cost; the pump re-check only bounds still-queued entries.
- **Impact:** The "hard" monthly cap (default $5) can be exceeded by up to ~8 in-flight generations' cost. Bounded, acknowledged in a code comment → Low.
- **Trigger:** Many files enqueued for summary just as the project crosses its budget.
- **Fix:** Reserve projected spend optimistically when a generation STARTS (in-memory per-project pending-cost accumulator added to `monthToDateSpend`), reconciled when `recordInvocation` lands.

#### BUG-TAURI-02 — `terminate_process` uses a stored PID that may have been reused (TOCTOU) → kills wrong process
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** Tauri Rust host · **Category:** concurrency-race
- **File:** `src-tauri/src/lib.rs:37-91`
- **What's wrong:** The sidecar PID is captured once at spawn and stored, never reset (the `Terminated` event only logs). `terminate_process` (CloseRequested + `restart_app`) issues raw `kill`/`taskkill /T /F` on the stale PID with no liveness/identity check. If the sidecar exited early and the OS recycled its PID, the host SIGKILLs (Unix) or force-kills a whole tree (Windows `/T /F`) of an unrelated process.
- **Impact:** On PID reuse, data loss/crash of unrelated user software the OS assigned the recycled PID. Requires PID-wrap + a narrow window → Low.
- **Trigger:** Sidecar crashes/exits early, OS recycles its PID, then window-close/`restart_app` fires `terminate_process`.
- **Fix:** Track the `CommandChild` handle / use `child.kill()`, or verify process identity (image name on Windows, cmdline/process-group on Unix) before signaling.

#### BUG-CI-04 — Bundled-runtimes smoke test skips chromium validation (ships as obfuscated `chromium.pak`); Windows has no round-trip verify
- **Severity:** Medium (reporter) → **Low (corrected)** · **Subsystem:** CI + build/packaging · **Category:** error-handling
- **File:** `scripts/smoke-bundled-runtimes.sh:55-70`
- **What's wrong:** Chromium ships as a single obfuscated `chromium.pak`, but the smoke probe `find`s for an unpacked `*.app/.../chrome`/`chrome.exe`/`chromium` tree — never matching the `.pak`, so the chromium probe is silently skipped. The only round-trip verify is macOS-only; both Windows Assemble steps only `test -f chromium.pak`.
- **Impact:** A broken/truncated/mis-keyed `chromium.pak` (esp. Windows) ships in a signed release; browser-capture dead-ends at runtime with no CI signal. Optional feature with a Playwright-download fallback; macOS key-drift is caught by the round-trip → Low.
- **Trigger:** Any release with `BUNDLE_CHROMIUM=true` where the `.pak` is corrupted/key-skewed, especially Windows.
- **Fix:** Add a `.pak` validation step on all three platforms (XOR-decode, extract, headless `--dump-dom` against the SHIPPED `.pak`); add the round-trip verify to both Windows Assemble steps.

#### BUG-CI-05 — `build-sidecar.mjs` codesign/curl/tar helpers interpolate paths into shell strings (execSync injection footgun)
- **Severity:** Low (reporter) → **Info (corrected)** · CI-only, all interpolated values CI-controlled (signing identity, npm semver, internal triple maps); worst case today is a build break on an unexpected character. Fix: use `execFileSync` with an argv array. Counted as info.

#### BUG-CLIENT-01 — WebSocket fan-out invokes handlers with no per-handler try/catch — one throwing handler starves later handlers
- **Severity:** High (reporter) / split (Low + Medium) → **Low (corrected, lead adjudication)** · **Subsystem:** Client per-project isolation · **Category:** error-handling
- **File:** `client/src/hooks/useSharedWebSocket.tsx:60-64`
- **What's wrong:** The shared WS fan-out loop has no per-handler try/catch and the handler Map is insertion-ordered, so one throwing handler aborts delivery to every later-registered handler for that message. The cited concrete trigger — `useDesktop`'s `desktop.projects` branch calling `incoming.find` without `Array.isArray` (`useDesktop.tsx:127-131`) — would throw on a malformed frame.
- **Impact:** A buggy/order-unlucky handler silently drops a WS message for all subsequently-registered consumers (stale UI, lost real-time updates), nondeterministic by registration order. The malformed-`desktop.projects` trigger isn't reachable from the trusted local server (always sends an array, loopback no public ingress), so the real exposure is a latent-bug-amplifier robustness gap, not an active break → Low.
- **Trigger:** Any handler throwing during message processing aborts the loop mid-fan-out.
- **Fix:** Wrap each invocation in try/catch (`console.error` on throw); also guard `useDesktop`'s `desktop.projects` branch with `Array.isArray(msg.projects)`.

#### BUG-CLIENT-02 — Drag-drop path quoting hard-codes PowerShell quoting on Windows but the server can spawn `cmd.exe`
- **Severity:** Low · **Subsystem:** Client / shell-quote · **Platform:** Windows · **Category:** correctness
- **File:** `client/src/lib/shell-quote.ts:47-49`
- **What's wrong:** `quoteForHost` picks PowerShell single-quote wrapping from a coarse `isWindows` boolean (`navigator.platform`), but the server's `resolveShellFor` falls back to `COMSPEC`/`cmd.exe`. cmd.exe passes single quotes literally, so a dropped path arrives wrapped in literal quotes. The client has no signal about the resolved shell.
- **Impact:** On a Windows host that resolved cmd.exe (no pwsh/powershell), drag-dropping a path yields a broken single-quote-wrapped string the user must hand-edit. Not injection (PS quoting is safe); cosmetic; uncommon shell-resolution path → Low.
- **Trigger:** Windows terminal where the server resolved cmd.exe; user drags a file in.
- **Fix:** Have the server expose the resolved shell family per session and thread it into `quoteForHost` so cmd.exe sessions use `quoteWindowsCmd`.

#### BUG-CLIENT-03 — `useProjectCache` `globalCache` entries are never purged on project removal (unbounded growth)
- **Severity:** Low · **Subsystem:** Client per-project isolation · **Category:** resource-leak
- **File:** `client/src/hooks/useProjectCache.ts:15`
- **What's wrong:** Module-level `Map<string, unknown>` keyed `projectId:namespace` with no deletion path; `removeProject`/`disposeProject` never clear it. Keying by projectId prevents cross-project bleed, but a long session adding/removing many projects grows the map unbounded; a reused project id would flash stale data first (stale-while-revalidate).
- **Impact:** Slow unbounded memory growth across add/remove cycles; brief stale flash on id reuse. Small payloads, unique ids → Low.
- **Trigger:** Repeatedly add/remove projects in one session, or reuse a project id.
- **Fix:** Export `purgeProjectCache(projectId)` (delete all `${projectId}:` keys) called from `removeProject` / the `desktop.project_removed` handler.

#### BUG-CLIENT-04 — Self-initiated Add Project double-fires activation + redundant "project added" toast via the echoed WS broadcast
- **Severity:** Low · **Subsystem:** Client per-project isolation · **Category:** correctness
- **File:** `client/src/hooks/useDesktop.tsx:146-154`
- **What's wrong:** `addProject` appends + activates locally; the server then broadcasts `desktop.project_added` back to the same WS, whose handler shows `toast.success('projects.added')` and re-activates. The append is idempotent and the second `setActiveProjectId` is a no-op, but the toast (intended for peers) fires for the initiator.
- **Impact:** The initiating user sees a "project added" toast as if a different/automatic event added it; activation logic runs twice (cosmetic).
- **Trigger:** Add a project from this client.
- **Fix:** Tag the broadcast with the originating client/request id and skip toast+activation when echoing the initiator (or track just-added ids in a ref).

#### BUG-LONGTAIL-05 — `cancel()`/`shutdown()` settle race re-broadcasts (proposal/agent-refine variant)
> Covered under BUG-LONGTAIL-01 / BUG-LONGTAIL-04 (same root cause). Not double-counted.

#### BUG-CLI-06 — `--project` name resolution is exact case-insensitive with no disambiguation on name collision
- **Severity:** Low · **Subsystem:** CLI bridge · **Category:** correctness
- **File:** `cli/specrails-desktop.ts:435-442`
- **What's wrong:** Resolve-by-name does `find(p => p.name.toLowerCase() === override.toLowerCase())` — first match wins. Project names aren't unique (two repos with the same basename register the same name); `find` silently picks whichever the server lists first, mis-routing to the wrong project with no ambiguity error.
- **Impact:** `--project app` runs against the wrong `app` repo when two share a name (e.g. an implement job mutates the wrong codebase). Self-inflicted, narrow → Low.
- **Trigger:** Two same-named projects + `--project <name>`.
- **Fix:** Error out listing candidates (id/path) when >1 match; auto-pick only on a unique match.

#### BUG-WEBHOOK-03 — Receiver records `telemetry_blobs.byteSize` before append completes; no rollback on append failure
- **Severity:** Low · **Subsystem:** Outbound egress sinks (telemetry receiver) · **Category:** data-integrity
- **File:** `server/telemetry-receiver.ts:225`
- **What's wrong:** `state.uncompressedSize` is advanced and the DB `byteSize` updated synchronously before the async enqueued `appendToGzip` runs. `enqueueWrite`'s `task().then(drain, drain)` swallows a rejection (ENOSPC/EACCES) with no rollback, so the counter/`byteSize` stay advanced as though the bytes landed.
- **Impact:** On a transient append failure, `byteSize` over-reports actual disk content and cap math over-accounts (fails safe — drops earlier, never overruns). Compaction/export read the real gzip file, so no content corruption. Low.
- **Trigger:** Any I/O error inside `appendToGzip` after the synchronous size/DB bump.
- **Fix:** Advance `uncompressedSize` + update `byteSize` only inside the enqueued task after `appendToGzip` resolves; on rejection, log and don't advance.

---

## 3. Disputed / needs-human-review

Findings the verifiers refuted or split on. Adjudicate before acting.

| ID | Title | Reporter sev | Verifier verdict | Dispute reasoning |
|----|-------|--------------|------------------|-------------------|
| SPAWN-DISP-01 | Login-shell PATH parses sentinel-delimited output trusting rc noise | Low | **Refuted (info)** | `printf` emits BEGIN+PATH+END as one atomic write; nothing can interleave between markers. Captured segment IS `$PATH` by construction; rc banners land before BEGIN and are discarded. |
| SPAWN-DISP-02 | `ensureWindowsBaseEnv` pollutes `process.env` with `C:\Users\Default` | Low | **Refuted (info)** | Every Windows spawn site already applies the identical `windowsSpawnEnv()` per-call; the global write is documented defense-in-depth, not the causal mechanism. Fallback only triggers on a genuinely stripped env where the alternative is npm failure. |
| SPAWN-DISP-03 | openspec shim falls back to bare `node`/`npx` | Low | **Refuted (info)** | Documented, existence-gated degradation; `resolveStartupPath` already falls through to system PATH on a partial bundle; the "offline guarantee" explicitly carves out the npx fallback. |
| SPAWN-DISP-04 | spawn-lifecycle timeout leaves a detached killTimer | Low | **Refuted (info)** | SIGKILL is uncatchable → child reaped → `'close'` fires → teardown. Listeners are GC-reclaimable; matches the sanctioned QueueManager pattern. |
| ARTREG-DISP-05 | `realpathSafe` non-canonical when leaf absent | Low | **Refuted (info)** | The add-project route hard-rejects non-existent paths (400) before `realpathSync`, so the stored path is always fully resolved; the catch branch is never exercised on the allocation path. |
| FW-DISP-02 | Migration verify accepts dangling symlinks → orphan after concurrent swap | Medium | **Refuted (low)** | Both swap sites enforce materialize-all-providers-then-swap-once; no code prunes old version dirs; workspace symlinks route through `current` so never dangle. (Depends on BUG-FW-01 to even be considered.) |
| FW-DISP-03 | `swapCurrent` no-op guard TOCTOU on stale `current` | Low | **Refuted (info)** | Materialize-then-swap ordering means the guard is never reached with a corrupt `current`; the crash-between-swap-and-materialize trigger is structurally impossible. |
| FW-DISP-04 | core-update swaps `current` with zero providers materialized | Medium | **Refuted (info)** | `uniqueProviders` returns `['claude']` when empty; `materialize` always processes ≥1 provider; the empty-provider precondition is unreachable. |
| FW-DISP-05 | `preserveAgentMemory` guards existence not emptiness | Medium | **Refuted (info)** | `agent-memory` is invariantly a real dir at the providerDir root, never nested under a backed-up subtree, so the buggy branch is unreachable in every real layout. |
| FW-DISP-06 | Custom-agent preservation loop partly dead / unconditional `.bak` delete | Low | **Refuted (info)** | Intentional defensive uniformity, tested; the `.bak` deletion only removes byte-identical backups behind a verified guard. |
| QUEUE-DISP-04 | `_jobProviderSelection` leaks on vanished job | Low | **Refuted (info)** | `_resolveJobAdapter` (which deletes the entry) is the first real step of `_startJob` before any throw; jobs are never removed from `_jobs`; the queued-cancel path already deletes the entry. |
| QUEUE-DISP-05 | Freestyle rail loop enqueues with no rollback on mid-loop CLI-not-found | Low | **Refuted (info)** | `binaryOnPath` memoizes per-binary (30s TTL); the whole sub-ms loop shares one cached probe result, so a mid-loop found→not-found transition is unreachable. |
| INTJOB-DISP-01 | `_writeTurn` marks streaming even when stdin is gone → permanent hang | High | **Refuted (low)** | stdin only becomes destroyed when the child is dying, which always fires `'close'` → `_settle` resets flags + drains pending with a visible warning + removes the session. Transient ordering quirk, not a permanent wedge. |
| CTX-DISP-01 | High-tier `--disallowedTools` bypassable by skip-permissions | High | **Refuted (info)** | The high tier is documented as NOT a sandbox; Bash is intentionally enabled (can already write files), so callable Write/Edit adds no real attack surface — UX shaping, not a security guarantee. |
| CTX-DISP-03 | Duplicate `--tools` relies on undocumented last-wins | Medium | **Refuted (info)** | Last-wins verified against the targeted claude 2.1.177; no real CLI version fails open; the privilege-escalation impact is entirely hypothetical. |
| CTX-DISP-04 | userMcp uses `project.path` not realpath for `~/.claude.json` key | Low | **Refuted (info)** | claude keys `projects[]` by the literal invocation cwd string, not a realpath; no realpath divergence is introduced; explore-cwd default doesn't even spawn from project.path. |
| PARSER-DISP-02 | SMASH duplicate-run `in-progress` early-return emits no failure WS event | Low | **Confirmed (low)** | (Actually confirmed.) Double-submit → two 202s but the in-progress branch alone omits `smash.failed`, leaving a stuck spinner. See note. |
| JIRA-DISP-05 | Jira project key string-interpolated into JQL without escaping | Low | **Refuted (info)** | The interpolated value is `proj.data.key` from Jira's own validation (canonical uppercase-alphanumeric), not attacker-controllable through any existing path. Defense-in-depth only. |
| JIRA-DISP-04 | `parseRetryAfter` treats empty/whitespace Retry-After as 0ms | Low | **Refuted (info)** | Empty string is guarded by the call-site `retryAfter ?` falsy check; only pure-whitespace (nonexistent in practice) reaches it, and a 0 delay is intentional "retry now". |
| JIRA-DISP-07 | Comment dedup matches marker by substring not exact equality | Low | **Refuted (info)** | Marker embeds an unpredictable app-generated jobId (+ nonce for discards); a user can't predict a future jobId to suppress a real completion comment. Standard idempotency-key pattern. |
| PLUGIN-DISP-01 | Install rollback clobbers a concurrently-installed plugin (additivity) | High | **Refuted (low)** | Requires two distinct plugins installing concurrently; only serena is bundled and v1 is bundled-only. Genuine latent design defect, not reachable today. |
| PLUGIN-DISP-06 | Prereq installer pipes remote shell script (curl|sh) | Medium | **Refuted (info)** | Hardcoded, non-user-controlled, vendor-official uv installer; "RCE" only under a third-party compromise (same trust model as npm/pip/brew). Hardening preference (pin a checksum), not a bug. |
| PLUGIN-DISP-07 | `codexMcpList` line-scan can mis-classify serena | Low | **Refuted (info)** | Sole caller is the uninstall probe; standard codex output puts the name first; hard list failures fall through to attempt removal; state.json is cleaned regardless. |
| SQLITE-DISP-01 | `acquireLock` busy-wait blocks the event loop | High | **Refuted (low)** | The entire acquire→read→fn→write→release critical section is synchronous; in-process callers serialize naturally and never observe EEXIST. The busy-wait is reachable only via a stale lock from a crashed external process (handled by the 10s TTL). |
| SQLITE-DISP-04 | `parseProviders` doesn't guarantee primary is in `providers[]` | Low | **Refuted (info)** | The route always sets `provider = providers[0]`; consumers fall back to `project.provider` directly, so the default engine is never rejected. Divergence unreachable via production paths. |
| TERM-DISP-03 | `GET /terminals/:id/marks` has no session→project ownership check | Low | **Refuted (info)** | Marks live in the per-project `jobs.sqlite` with no `project_id` column; the `:projectId` middleware selects the DB, so a foreign session id yields zero rows. The per-project DB IS the boundary. |
| TERM-DISP-04 | `killSession` SIGKILL timer not unref'd/cleared on shutdown | Low | **Refuted (info)** | Exit is driven by `process.exit` (+3s forced fallback), not by draining the loop, so a dangling 2s timer can't delay port release. |
| TERM-DISP-05 | OSC body-overflow discard desyncs mark accounting | Low | **Refuted (info)** | The >8KB discard is the documented adversarial-input guard; only the variable-length `1337;CurrentDir` (bounded, cosmetic stale cwd) is realistic; 133;C/D pairing self-heals on the next prompt. |
| BROWSER-DISP-05 | Chromium extraction fast-path trusts attacker-writable cache | Low | **Refuted (info)** | Cache + marker live entirely in the user's own `$HOME`; the attack requires same-user write access = already full code-exec; the slow path is equally unverified; the XOR key is documented "obfuscation, not security". No boundary crossed. |
| BROWSER-DISP-06 | Chromium extraction temp dir keyed only by PID | Low | **Refuted (info)** | A single-instance port guard prevents two desktop servers sharing `$HOME`; non-desktop dev servers don't extract; the swap degrades gracefully to one re-extraction. |
| CODE-DISP-03 | Forced regenerate can silently no-op (dedupe key ignores `force`) | Medium | **Refuted (info)** | The only production enqueue caller always sends `force:true` and never `jobId`; no `force:false` summary enqueue path exists, so the dedupe collision is unreachable. |
| TAURI-DISP-01 | Health-check `process::exit(1)` orphans the sidecar | High | **Refuted (info)** | The sidecar runs a parent-PID watchdog (1s poll of `--parent-pid`) that self-reaps (tree-kills rails/PTYs, frees port 4200) within ~1-4s; the next-launch port check has a 10s grace. No orphan. |
| TAURI-DISP-03 | `shell:allow-open` scoped to `http(s)://**` opens arbitrary URLs | Low | **Confirmed (info)** | Real no-host-allowlist gap, but scheme-constrained to http/https in the user's external browser; worst case is one-click open of an attacker's https URL from the user's own Jira board — equivalent to clicking any link. Info-level hardening. |
| TAURI-DISP-04 | macOS sidecar PATH taken verbatim from zsh login shell | Low | **Refuted (info)** | No trust boundary crossed (user's own dotfiles/dirs at the user's own privilege); the bundled-runtime-shadowing concern is already prevented by `path-resolver` re-prepending bundled bins. |
| TAURI-DISP-05 | `restart_app` `lock().unwrap()` can panic on poison | Low | **Refuted (info)** | No code path panics while holding the guard (the guard only spans a trivial `Copy`/assignment; `terminate_process` runs on a separate thread with a copied PID), so the mutex can't be poisoned. |
| TAURI-DISP-06 | Runtimes existence-gate checks only node, not git | Low | **Refuted (info)** | Every downstream git path is independently existence-gated with a working system fallback designed for the partial-bundle case; no git operation dead-ends. |
| CLI-DISP-02 | runDirect child never killed on Ctrl-C → orphan | High | **Refuted (info, split)** | The child isn't detached/own-process-group, so OS-level group/console signaling delivers Ctrl-C to the subtree; the "own process group" premise is false (the only `detached:true` is the manager-start path). |
| CLI-DISP-05 | `runViaWebManager` exit detection depends on a log sentinel | Medium | **Refuted (low)** | The `[process exited with code N]` sentinel is emitted by QueueManager itself (provider-invariant, both close branches) over the kept-alive socket; the start-then-finish-before-WS-attach window is unreachable because /spawn returns 202 before the child even spawns. |
| CLI-DISP-07 | `desktopStart` spawns server with raw `process.env`, no PATH resolution | Medium | **Refuted (info)** | The spawned (non-desktop) server self-runs `resolveStartupPath`+`augmentPathFromLoginShell` at startup; the finding inverted which mode is special-cased. |
| CLI-DISP-08 | `loadDesktopToken` accepts ≥32-char content + legacy fallback | Low | **Refuted (info)** | Mirrors the server's identical ≥32 gate; `hub.token` is renamed (moved) to `desktop.token` on startup, so the fallback reads the same live token. No stale-credential gap. |
| WEBHOOK-DISP-01 | Telemetry receiver inflates `uncompressedSize` for dropped logs | High | **Refuted (info)** | The line-211 early-return fires for every post-soft-cap logs payload BEFORE the line-225 increment, so dropped logs add zero bytes; the line-259 inner drop is dead code. No phantom-byte starvation. |
| WEBHOOK-DISP-02 | WebhookManager retry timers never cleared on removal/shutdown | Medium | **Refuted (info)** | The retry path does zero DB access (no DB-close race); `index.ts` shutdown force-exits within 3s; each chain self-terminates after `MAX_ATTEMPTS=3`. Bounded ~3s of POSTs to the user's own URL. |

### Note on PARSER-DISP-02 (SMASH duplicate-run)
This was verifier-**confirmed real at Low** but is listed here because it sits adjacent to disputed SMASH findings. The HTTP handler replies `202 {scheduled:true}` then schedules `runSmash`; the `_smashInFlight` guard lives inside `runSmash`, so a double-submit yields two 202s and the second `runSmash` returns `{ok:false, reason:'in-progress'}` **without** broadcasting `smash.failed` (every other failure branch does). The client sees a stuck spinner. **Fix:** broadcast `smash.failed`/`smash.in_progress` in the in-flight early-return, or move the reservation to the HTTP handler so the duplicate gets a 409. (Counted in the Low tally as `BUG-PARSER-02`.)

### Other confirmed-Low not separately tallied above
- `BUG-PARSER-03` — Contract-refine retry endpoint gates only `provider==='codex'`, ignoring gemini/multi-provider (202-then-silent-noop instead of 409). Low, UX-only (runner guards the spawn). Fix: resolve the origin conversation's provider and 409 when non-claude.
- `BUG-PARSER-04` — Contract-refine ignores `result.is_error`/`error_max_turns`; a truncated max-turns exit-0 result is misclassified `malformed`. Low, misleading reason only. Fix: short-circuit to `model_error` on `is_error`/`subtype`.

---

## 4. Cross-cutting themes

### Theme A — Child-process teardown: missing tree-kill / SIGKILL escalation (the single largest cluster)
The codebase has a correct shared pattern (`spawn-lifecycle.ts` / `QueueManager._kill`: tree-kill SIGTERM → SIGKILL after grace), but multiple managers diverge to bare `child.kill`/single-SIGTERM, orphaning full-permission, spend-burning CLI trees (worst on Windows's `cmd.exe`-wrapper grandchildren).
- `BUG-CHAT-01` `server/explore-stdin-session.ts:158`
- `BUG-PARSER-01` `server/contract-refine-runner.ts:197-204`, `server/smash-runner.ts:231-238`
- `BUG-LONGTAIL-02` `server/proposal-manager.ts:43,196`, `server/spec-launcher-manager.ts:35,164`, `server/agent-refine-manager.ts:97,144`
- `BUG-CHAT-02` (untracked auto-title child) `server/chat-manager.ts:1372`
- Related settle-never-fires: `BUG-INTJOB-02` `server/interactive-job-session.ts:191-203`, `BUG-QUEUE-02` `server/queue-manager.ts:1894-1918`
- **Root fix:** route every AI-CLI spawn teardown through one shared `treeKill + SIGKILL-escalation + force-settle` helper.

### Theme B — Mobile/companion authorization boundary
The documented "hard authorization boundary" is unimplemented, and the reconnect path leaks the pairing gate.
- `BUG-AUTH-01` (tokenless device mint from a publicly-broadcast secret) `server/mobile/mobile-webrtc.ts:31-62`, `mobile-signal-reconnect.ts:57-66`
- `BUG-MOBILE-02` (companion can reach ANY project) `server/mobile/mobile-ws.ts:178-184`, `mobile-router.ts:109-115`
- `BUG-MOBILE-05` (alert bypasses topic gate), `BUG-MOBILE-06` (path redaction gap)
- **Root fix:** require existing-token auth on reconnect registration; persist + enforce a per-device allowed-project set.

### Theme C — Endpoint-family guard parity (one sibling forgets a check the others enforce)
A recurring pattern where N-1 endpoints in a family enforce a guard and the Nth omits it.
- `BUG-CODE-01` `/diff` omits deny-list + gitignore that `/file`,`/summary`,`/provenance` enforce — leaks secret file contents.
- `BUG-CODE-04` `touched-by-ai` tree omits `gitIgnoredSet` that the `all` tree applies.
- `BUG-ROUTER-01` `attachmentId` unvalidated while `ticketKey` is.
- `BUG-BROWSER-01` WS `navigate` + REST `initialUrl` omit the scheme-allowlist the REST `navigate` enforces.
- **Root fix:** extract shared guard helpers (`isNavigableUrl`, `assertReadableRelPath`) and apply uniformly; add a test that every endpoint in a family rejects the same denied input.

### Theme D — Untrusted-LLM/content-output & egress sinks
- `BUG-BROWSER-03` (captured URLs retain secrets), `BUG-BROWSER-04` (`--no-sandbox` on untrusted pages), `BUG-WEBHOOK-01` (webhook SSRF, DNS-rebinding + IP-encoding bypass), `BUG-CODE-02` (LLM summary never validated), `BUG-PARSER-04`/`BUG-INTJOB-03` (trusting/double-counting result events).
- **Root fix:** treat every browsed page / synced board / LLM result as untrusted at the boundary — redact, schema-validate, IP-allowlist, and re-resolve at use time.

### Theme E — Lock / TOCTOU / read-modify-write races
- `BUG-FW-01` (unlocked `current` swap), `BUG-PLUGIN-02`/`BUG-PLUGIN-03` (`state.json` read outside the lock), `BUG-JIRA-SYNC-01` (reset-inflight mid-drain), `BUG-ARTREG-04` (lock TTL no heartbeat), `BUG-SQLITE-02` (mtime-only stale lock), `BUG-BROWSER-02` (session-cap TOCTOU), `BUG-TAURI-02` (PID-reuse TOCTOU), `BUG-CODE-05` (budget-cap overshoot).
- **Root fix:** lock the whole read-modify-write round-trip (the codebase already has the right pattern in `surgicalMergeJson` / the registry lock — apply it consistently); prefer OS advisory locks + PID-liveness over mtime TTLs.

### Theme F — Secret/credential handling
- `BUG-JIRA-CLIENT-01` (PAT over plaintext http), `BUG-JIRA-CLIENT-02` (userinfo-spoof → PAT to wrong host), `BUG-CODE-01`/`BUG-CODE-04` (secret-file disclosure), `BUG-BROWSER-03` (URL tokens persisted), plus the `user-mcp.json` perms finding (see §below) and `BUG-MOBILE-06`.
- Note: a confirmed-but-Low/info finding — `user-mcp.json` keeps loose perms when the file pre-exists (`writeFileSync mode` ignored on existing files), `server/user-mcp-config.ts:106` — fits this theme. Verifiers split High vs Low; the in-repo writer always creates `0o600`, so the vulnerable state requires an out-of-band loose-perm file → **Low** (add an explicit `fs.chmodSync(file, 0o600)` after write).

### Theme G — Windows-specific path/quoting/process handling
- `BUG-SPAWN-01` (arg-rewrite), `BUG-CHAT-01` (cmd.exe-wrapper orphan), `BUG-FW-02` (junction version read), `BUG-CLIENT-02` (drag-drop quoting), `BUG-TAURI-02` (taskkill `/T /F` on reused PID).
- **Root fix:** thread the actual shell/process kind rather than a coarse `isWindows` boolean; handle junctions explicitly; use `treeKill` everywhere.

---

## 5. Recommended next actions (prioritized fix order)

### P0 — Security boundary breaks (do first)
1. **`BUG-AUTH-01`** — Require existing-token auth on companion reconnect registration; stop broadcasting the pairing secret in cleartext. *(Highest impact: remote-ish full-control device mint.)*
2. **`BUG-CODE-01`** — Add deny-list + `.gitignore` guards to `GET /diff` (and `BUG-CODE-04` to the touched-by-ai tree). *(Secret-file disclosure on a default-on feature.)*
3. **`BUG-MOBILE-02`** — Implement the per-device allowed-project ACL the docs already promise.
4. **`BUG-ROUTER-01`** — Validate `attachmentId` against the opaque-token rule.
5. **`BUG-BROWSER-01`** — Centralize the URL scheme-allowlist + private-IP block inside `normalizeUrl`/`page.goto`.

### P1 — Data-loss / correctness on common paths
6. **`BUG-SPAWN-01`** — Fix the Windows valueless-`-p` arg rewrite (breaks two features on Windows).
7. **`BUG-SQLITE-03`** — Distinguish ENOENT from unreadable in `readStore` (prevents tickets-backlog wipe).
8. **`BUG-CLI-01`/`BUG-CLI-03`/`BUG-CLI-04`** — Fix the three `runDirect` shape bugs (single-arg prompt, `total_cost_usd`/`usage.*`, `type:'assistant'`). *(Offline CLI fallback is currently unusable.)*
9. **`BUG-INTJOB-03`** — Turn-id tagging so a stray `result` can't corrupt honest job metrics.

### P2 — Child-process lifecycle cluster (Theme A — fix as one batch via a shared helper)
10. Route all teardown in `BUG-CHAT-01`, `BUG-PARSER-01`, `BUG-LONGTAIL-01/02/04`, `BUG-CHAT-02`, `BUG-INTJOB-02`, `BUG-QUEUE-02` through one `treeKill + SIGKILL-escalation + force-settle` helper.

### P3 — Lock / race hardening (Theme E — fix as one batch)
11. **`BUG-FW-01`** — Wrap core-update materialize+swap in the registry lock.
12. **`BUG-PLUGIN-02`/`BUG-PLUGIN-03`** — Introduce `lockedUpdateState` (resolves both).
13. **`BUG-JIRA-SYNC-01`** — Gate `resetInflight` behind the construction-only path.

### P4 — Egress/secret hardening
14. **`BUG-WEBHOOK-01`** — DNS-resolve + private-IP reject + delivery-time re-validation; add IP-encoding forms.
15. **`BUG-JIRA-CLIENT-01`/`BUG-JIRA-CLIENT-02`** — Enforce https + reject userinfo on Jira base URLs.
16. **`BUG-BROWSER-03`** — Redact URL query strings before storing captured network entries.
17. **`BUG-BROWSER-04`** — Drop `--no-sandbox` on macOS/Windows.
18. `user-mcp.json` perms — unconditional `chmodSync(file, 0o600)` after write.

### P5 — CI / release integrity
19. **`BUG-CI-01`** — Delete stale installers LAST (atomic manifest cutover).
20. **`BUG-CI-02`/`BUG-CI-03`** — Pin `CORE_BUNDLE_VERSION` + vendor a lockfile + `npm ci` for bundled installs.
21. **`BUG-CI-04`** — Add cross-platform `chromium.pak` validation.

### P6 — Remaining Low / latent (batch as capacity allows)
22. Framework Windows/junction (`BUG-FW-02`, `BUG-FW-03` hygiene), artifact-registry durability (`BUG-ARTREG-01/02/03/04`), telemetry/Jira/plugin/terminal/client Lows, and the pre-release relocation leaks (`BUG-QUEUE-01`) — schedule before the artifact-relocation branch ships.

---

*End of report. No code changes were made.*
