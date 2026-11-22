# MCP v2 settings coverage

Every setting a person can change in the Specrails window, where it lives in the GUI, and the MCP v2 call that reads
and changes it. Audited against `client/src/features/settings/**` (App Settings, the ⌘K settings registry
`settings-registry.ts`, Project Settings `project-settings-sections.tsx`) and the toggles elsewhere that persist a
setting. Contracts: [mcp-v2.md](mcp-v2.md). Tests: `server/mcp/v2/tools/settings.test.ts` ("coverage of the Settings
window"), `blueprint.test.ts`, `integrations.test.ts`, `server/mcp/mcp-admin-router.test.ts`.

Rules every row follows:

- **Same validation as the GUI.** A `set` goes through the route the window uses (loopback), after a strict check of
  its own where the route would silently ignore a bad value (caps, retention days).
- **`source`** of every effective value: `default`, `app`, `project`, `env`, `os` (`milestone` for a blueprint
  milestone's own engine).
- **Confirmation policy.** `risky` for a change that lowers a safeguard or runs commands; `costly` for raising or
  removing a spending cap (above "Ask before spending"); `external` for an outside address or text leaving the machine;
  `irreversible` for what cannot be taken back. Turning an MCP tier **on** needs the person's yes in the client's own
  dialog (a confirm token is not enough).
- **Window-only settings are named, with the reason.** `specrails_settings(get)` without a section lists them under
  `guiOnly`; a `set` of one answers `settings.error.gui_only` with the reason instead of "unknown key".

Status: **rw** read and write (before this audit), **added** new in MCP with this audit, **policy**/**source** an
existing key that gained its confirmation class or its source, **action** a one-off operation (not a stored setting) on
another tool, **GUI-only** with the reason, **API-only** a route with no GUI control.

## App Settings (native window)

| Setting | GUI location | MCP call | Status |
|---|---|---|---|
| Theme | Appearance ▸ Theme | `settings(set, appearance, {theme})` | rw |
| Language | Appearance ▸ Language | `settings(set, language, {language})` (`os` when unset) | rw |
| Density | Appearance ▸ Density | — | GUI-only: kept in the window's own storage (`localStorage`), which the server cannot reach |
| Reduce motion | Appearance ▸ Motion | — | GUI-only: window storage |
| Replay the platform tour | Appearance ▸ Onboarding | — | GUI-only: an in-window walkthrough, not a setting |
| Agent thinking halo | Effects | — | GUI-only: window storage |
| Editor to open files in | Code ▸ Editor | — | GUI-only: window storage |
| Summary language | Code ▸ Code Explorer | `settings(set, code, {language})` | rw |
| Summary monthly budget | Code ▸ Code Explorer | `settings(set, code, {monthlyBudgetUsd})` (costly raise) | rw |
| Terminal font family, font size, render mode, copy on select, shell integration, notify on completion, image rendering, long-command threshold, quick script (9) | Terminal | `settings(set, terminal, {…})` (route `validatePartial`) | rw, **source** added (`app` / `default`) |
| Terminal browser shortcut URL | Terminal | `settings(set, terminal, {browserShortcutUrl})` | rw, **policy** added: external |
| Notifications on/off, categories (question, review, failed, budget, done), sound, dock badge, muted projects (5) | Notifications | `settings(set, notifications, {…})` (route `applyAttentionPrefsPatch` rejects unknown fields) | rw, **source** added (per key, `categories.<id>`) |
| Provider connections (local / OpenAI-compatible) | Specrails Agents ▸ Providers | `providers(runtime_save)` (remote URL: external), `providers(runtime_list)` | rw |
| Test a connection | Specrails Agents ▸ Providers | `providers(runtime_test)` | action |
| Allow sub-agents (project-less missions) | Specrails Agents ▸ Sub-agents | `settings(set, app, {allowSubagents})` (on: risky) | rw |
| Run sub-agents with | Specrails Agents ▸ Sub-agents | `settings(set, app, {subagentRuntime})` | rw |
| Auto-continue runs | Specrails Agents ▸ Auto-continue | `settings(set, app, {autoContinueRuns})` | rw |
| Remembered machine installs (revoke) | Specrails Agents ▸ Machine installs | `settings(set, machine_installs, {revoke})` (also `system(machine_installs)`) | rw |
| Mission connectors (per provider, per connector) | Specrails Agents ▸ Mission connectors | `settings(set, connectors, {provider, name, enabled})` | rw, **source** added (`<provider>/<name>`: `app` when turned off), **policy** added: turning one back on is risky |
| Subscription usage | Subscription usage | `insights(quota)` | read only (nothing to change) |
| MCP server on/off | MCP | — | GUI-only: it is the server the client talks through (off cuts the session; on cannot be asked of a server that is off) |
| MCP tiers: write, ai-spawn, destructive | MCP ▸ Permissions | `settings(set, mcp, {write, aiSpawn, destructive})` (on: risky, in-client dialog only; reachable while a tier is off) | rw |
| Ask before spending (USD) | MCP ▸ Preferences | `settings(set, mcp, {confirmAboveUsd})` or `settings(set, budget, {confirmAboveUsd})`, both through `PATCH /mcp-admin/preferences` (0–1000, cents) | **added** to the `mcp` section; the budget key now uses the window's route (it wrote the row directly, without the 1000 limit or rounding); any value but 0 is risky |
| Simplified MCP tools (v2 surface) | MCP ▸ Preferences | `settings(set, mcp, {v2})` (`env` when `SPECRAILS_MCP_V2` forces it) | **added** |
| Ask in the client's own dialog (confirmations) | — (no GUI control; `desktop_settings.mcp_confirm_in_client`) | `settings(set, mcp, {confirmInClient})` | **added**, and the route `PATCH /mcp-admin/preferences` now takes it |
| Ask in the client's own form (choices) | — (`mcp_choices_in_client`) | `settings(set, mcp, {choicesInClient})` | **added** (same route) |
| Connect Claude Code / Codex | MCP ▸ Connect | — | GUI/CLI-only: edits another app's configuration file; Settings ▸ MCP ▸ Connect or `specrails-desktop mcp connect` |
| Copy / regenerate the MCP token | MCP ▸ Token | — | GUI-only: the secret the client signs in with; regenerating closes the open sessions |
| External MCP servers (discovered and custom) | MCP ▸ External servers | `settings(set, external_mcp, {servers})` (env values write-only; enabling: risky) | rw |
| Mobile companion on/off | Mobile | `settings(set, mobile, {enabled})` → `integrations(mobile, op enable/disable)` (enable: risky) | rw |
| Revoke a paired device | Mobile | `settings(set, mobile, {revokeDevice})` → `integrations(mobile, op revoke)` (irreversible) | rw |
| Rotate the gateway certificate | Mobile | `settings(set, mobile, {rotateCert: true})` → `integrations(mobile, op rotate)` (irreversible: every device pairs again) | **added** |
| Pair the web companion | Mobile ▸ Pair | — | GUI-only: pairing scans a QR code between the two devices |
| Remove a registered project | Projects | `projects(unregister)` | action |
| Retained worktrees, safety archives | Storage | `system(worktrees)` | action |
| Daily budget (shown here) | Advanced ▸ Budget alerts | `settings(set, budget, {dailyBudgetUsd})` | rw |
| Resume on daily reset | Advanced | `settings(set, app | budget, {resumeOnDailyReset})` | rw |
| Per-run cost alert (app) | Advanced ▸ Budget alerts | `settings(set, budget, {costAlertThresholdUsd})` | rw |
| Webhooks (add, edit, enable, delete, test) | Webhooks | `settings(set, webhooks, …)` → `integrations(webhooks)` (URL: external; delete: irreversible) | rw |
| Update channel | Updates | `settings(set, app, {updateChannel})` | rw |
| App / Core update | Updates | `system(updates)` (apply: irreversible) | action |
| Report a problem | About | `system(report)` | action |
| Settings window size and position | the window | — | GUI-only: window geometry in window storage |

## Project Settings

| Setting | GUI location | MCP call | Status |
|---|---|---|---|
| Repositories (add, edit, remove) | General ▸ Repositories | `projects(repository_add / repository_update / repository_remove)` | rw |
| Pre-prompt | General | `settings(set, general, {prePrompt})` (untrusted on read) | rw |
| Verification commands | Agent runtime ▸ Verification | `settings(set, verification, {verification})` | rw, **policy** added: risky (they run on this machine) |
| Setup commands | Agent runtime ▸ Verification | `settings(set, verification, {setup})` | rw, **policy** added: risky |
| Use the suggested commands | Agent runtime ▸ Verification | `settings(set, verification, {useSuggestions: true})`; `get` with `view: detail` lists them | rw, **policy** added: risky |
| Agent runtime: enabled, role routes, fixer, custom roles, review, architect, efficiency, approval before archive, role prompts | Agent runtime | `settings(set, runtime, {…})` (merged into the config; route `validateAgentRuntimeConfig`) | rw |
| Runtime limits | Agent runtime | `settings(set, runtime, {limits})` (`limits.maxCostUsd` raise: costly) | rw |
| Guardrails | Agent runtime ▸ Guardrails | `settings(set, guardrails, {<id>: bool})` (off: risky) | rw |
| Environment plan | Agent runtime | `settings(set, environment_plan, {apply})` | rw |
| Triage engine (and the verifier and decider loop roles) | Agent runtime ▸ Triage engine | `settings(set, loop_roles, {roles})` (route `validateLoopRoleEngines`) | rw, **source** added (`project` / `default` = inherit) |
| Allow sub-agents (project) | Sub-agents | `settings(set, subagents, {allowSubagents})` (on: risky) | rw, **source** fixed: the default is on (it read as `project` when unset) |
| Run sub-agents with (project) | Sub-agents | `settings(set, subagents, {subagentRuntime})` | rw |
| Integration branch | Branch | `settings(set, branch, {integrationBranch})`; `get` adds the resolved branch | rw |
| Env passthrough names | Environment | `settings(set, env, {worktreeEnvPassthrough | addNames | addScanned})`, `settings(env_scan / env_status)` | rw |
| Copy env files into worktrees | Environment | `settings(set, env, {worktreeEnvFiles})` (on: risky) | rw |
| Agent environment (inherit / minimal) | Environment | `settings(set, env, {agentEnvMode})` (inherit: risky) | rw |
| Project caps (daily, weekly, monthly, run) | Budget (read-only there) / Analytics ▸ Budget | `settings(set, budget, project, {…})` (raise above the threshold or removal: costly) | rw |
| Per-run cost alert (project) | Budget | `settings(set, budget, project, {jobCostThresholdUsd})` | rw |
| Review WIP limit | Budget ▸ Review limit | `settings(set, budget, project, {reviewWipLimit})` | rw |
| Pipeline telemetry | Telemetry | `settings(set, telemetry, {pipelineTelemetryEnabled})` | rw |
| Agent audit retention (days) | Telemetry ▸ Agent audit | `settings(set, telemetry | retention, {agentAuditRetentionDays})` | rw |
| Post clarifications to Jira | Rules ▸ Anchoring | `settings(set, general, {jiraPostClarifications})` | rw, **policy** added: on is external |
| Baseline on touch | Rules ▸ Anchoring | `settings(set, general, {baselineOnTouch})` | rw |
| Project rules (inventory, spec from a rule) | Rules | `settings(get, rules)` | read; running the inventory is an action in the window |
| Terminal overrides (the 10 terminal fields; null clears one) | Terminal | `settings(set, terminal, project, {…})` (`source`: `project` / `app`) | rw |
| Recently deleted (restore, purge) | Recently deleted | `specs(trash / restore / purge)` | action |
| Runtime artifact retention | Rails ▸ Runtime runs ▸ Retention | `settings(set, retention, {runtimeArtifacts: {days}})` | rw, **source** added |

## Blueprint and Builder

| Setting | GUI location | MCP call | Status |
|---|---|---|---|
| Usual configuration (provider, model, effort) | Builder ▸ Milestone generation | `blueprint(settings_set, options)` / `settings_get` (route `validateMilestoneGenerationSelection`) | rw, **source** added (`project` when saved, `default` = the primary provider; the route now says which) |
| One milestone's own engine | Builder ▸ "only for M<n>" | `blueprint(settings_set, milestone, options | options.clear)` | rw (`source`: `milestone`) |
| M1 launch engine | Builder ▸ Launch | `blueprint(chain_launch, options.provider/model/effort)` | per launch (not stored) |
| Auto-advance, remembered for the next launch | Builder conversation | `blueprint(chain_launch, options.autoAdvance)` per launch | GUI-only as a remembered default: window storage |
| Auto-advance of a live chain | Builder ▸ Milestone done | `blueprint(chain_auto_advance, enabled)` (on at a checkpoint: costly) | rw |

## Elsewhere in the app

| Setting | GUI location | MCP call | Status |
|---|---|---|---|
| App caps (daily, weekly, monthly, run) | Analytics ▸ Budget | `settings(set, budget, {…})` (costly raise or removal) | rw |
| Dismiss the reviewer-family suggestion | Loops | `settings(set, general, {reviewerFamilySuggestionDismissed})` | rw |
| Add Spec context scope (specrails, openspec, full, mcp, contract refine, your MCP servers) | Add Spec composer | `settings(set, composer, {contextScope: {…}})` (booleans only, as the route) | **added** (`userMcp: true` is risky: Explore starts with your own MCP servers); per call `specs(create, options.contextScope)` |
| Quick mode contract refine (last used) | Add Spec quick mode | `settings(set, composer, {quickContractRefine})` | **added** |
| Rail profile, AI engine, name | Dashboard ▸ rail header | `rails(configure)`, `rails(rename)` | rw |
| Rail mode, loop, model, effort, target PR | Dashboard ▸ rail header | per launch: `runs(launch)` / `rails` options | GUI-only as remembered defaults: window storage |
| Loop definitions (roles, prompts, guardrails, limits, policies) | Loops ▸ Loop Builder | `integrations(loops_save)` | rw (a library object, not a setting) |
| Loop constants | Loops | `integrations(loops_constants)` | rw |
| Jira connection | Integrations | `integrations(jira_connect / jira_disconnect)` (external) | rw |
| Headroom and plugins | Plugins | `integrations(plugins_*)` | rw |
| Agent profiles, agent catalog | Agents | `providers(profiles_*, catalog_*)` | rw |
| UI mode, native surfaces, sidebar, filters, panel sizes and other layout state | across the window | — | GUI-only: window storage |

## Routes with no GUI control

| Setting | Route | MCP call | Status |
|---|---|---|---|
| Orchestrator model, freestyle pre-prompt | `PATCH /projects/:id/settings` | `settings(set, general, {orchestratorModel, freestylePrePrompt})` | rw |
| Agent defaults per provider | `PATCH /agent-defaults` | `settings(set, agent_defaults, …)` | rw |
| Runtime role prompts | `PUT /runtime-role-prompts` | `settings(set, role_prompts, …)` | rw |
| In-client confirmations and choices | `PATCH /mcp-admin/preferences` | `settings(set, mcp, …)` | **added** (above) |
| Server port, specrails.tech URL | `PUT /settings` | `settings(get, app)` shows the port | API-only, not exposed: the port needs a restart and the URL is a development override |
| Agent models in the install config | `PATCH /projects/:id/agent-models` | — | API-only, not exposed (no GUI control; profiles and runtime routes cover model choice) |
| Capacity limits | env `SPECRAILS_MAX_*`, `SPECRAILS_RUN_ADMISSION` | `settings(get, app)` → `capacity` (`source: env`) | read only: set in the environment, not in the GUI |

## Summary

94 rows above (about 130 keys once the terminal, notification, tier and scope fields are counted one by one). This audit
**added** 7 settings to MCP (`mcp.confirmAboveUsd`, `mcp.v2`, `mcp.confirmInClient`, `mcp.choicesInClient`,
`mobile.rotateCert`, `composer.contextScope`, `composer.quickContractRefine`), gave 7 existing ones their confirmation
class (verification, setup and suggested commands: risky; the terminal's browser URL and Jira clarifications:
external; turning a connector back on: risky; "Ask before spending" through the window's route), added the `source` of
notifications, the app-wide terminal, connectors, loop roles, runtime retention, the MCP preferences and the blueprint's
usual configuration, and fixed the project sub-agents source. 9 keys are window-only and listed with their reason in
`settings(get).guiOnly` (`appearance.density`, `appearance.reduceMotion`, `appearance.agentThinkingHalo`,
`appearance.windowLayout`, `code.editor`, `mcp.enabled`, `mcp.connect`, `mcp.token`, `mobile.pair`); the remaining
window-storage preferences (rail defaults, auto-advance default, layout) are per-launch options in MCP.
