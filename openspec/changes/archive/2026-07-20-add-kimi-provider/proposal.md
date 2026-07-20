## Why

SpecRails Desktop exposes Claude, Codex, and Gemini as selectable AI providers but cannot use Kimi Code despite Kimi offering headless agent execution, sessions, tools, skills, MCP, images through file tools, and configurable models. Users should be able to select Kimi throughout the product without installing Claude Code or running a separate Kimi daemon.

## What Changes

- Add a first-class Kimi provider adapter based on `kimi -p --output-format stream-json`, with model, effort, session-resume, tool, result, and health contracts.
- Add Kimi to provider discovery, setup prerequisites, project creation, provider/model/effort selectors, terminal launch, and provider labels.
- Enable Kimi for autonomous Project Chat, Agent Chat, Explore/proposals,
  agentic Quick Launcher commands (including `/opsx:ff`), rail jobs,
  Implement/Batch/Freestyle, custom loops without a Decider, retry/rerun,
  profiles, manually-authored custom roles, MCP, Serena, provider-scoped
  plugins, attachments, terminal, and truthful invocation metadata.
- Allow Kimi as a Project Builder target provider and for launching an already
  committed milestone rail; do not use it to generate a day-0 blueprint or
  later detailed milestone batch.
- Capability-gate every pure-output/read-only transform that Kimi 0.27 prompt
  mode cannot enforce: Quick Spec, AI Edit, Contract Refine, SMASH/Re-SMASH,
  Project Builder blueprint/milestone generation, Loop Decider, file
  summaries, construction-story AI, and Agent Studio generation/test/refine.
  Hide/disable the UI and reject direct requests before spawn or mutation. AI
  auto-title uses the existing deterministic fallback without spawning Kimi.
- Consume the Kimi framework produced by the compatible SpecRails Core release, including `.kimi-code/skills`, instructions, relocated workspaces, and OpenSpec overlays.
- Keep cancellation process-based and represent unsupported native cost as unavailable rather than reporting a false zero.
- Preserve CLI-only installation: Desktop detects the user's `kimi` executable and authentication but does not bundle Kimi, start `kimi server`, register an OS service, or store Kimi credentials.
- Replace remaining Claude-ID gates with adapter capabilities or structured
  actions; application parity never weakens a safety contract merely to expose
  a Kimi selector.

## Capabilities

### New Capabilities

- `kimi-provider`: Complete Desktop discovery, invocation, UI, workflow, integration, and telemetry behavior for Kimi Code CLI.

### Modified Capabilities

None.

## Impact

- Provider adapter contract, registry, stream normalization, spawning, session persistence, and result accounting.
- Setup, project, chat, specs, rails, loops, profiles, plugins, MCP, analytics, terminal, and UI capability surfaces.
- Core compatibility/version requirements and relocated framework overlays.
- Unit, integration, packaged cross-platform, and live-provider contract fixtures.
