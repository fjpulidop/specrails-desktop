<!-- guide-revision: mission-first-v1 -->

# Choose a provider and its capabilities

Execution settings belong to the chosen provider. A familiar model name does not imply that every provider supports the same reasoning, structured output or approval controls.

## Check availability first

Authenticate the provider CLI and confirm its status in Specrails. Choose among the models and effort values offered by that provider's controls. An installed CLI can still fail because its session, quota or remote service is unavailable.

Claude and Codex have different adapters. Unsupported combinations should fail before a loop starts; for example, a step requiring a structured no-tools response cannot be assumed to work with every provider.

## Use the right level of control

A rail's provider/model choice controls its execution. Role profiles and per-agent routing depend on the provider and on the Core workflow Desktop installed in the project; inspect the effective configuration rather than assuming a profile changes every call.

When comparing runs, keep the same spec, repository revision and verification criteria. Treat reported, estimated and unavailable cost separately. See [profiles](/docs/agents-profiles-and-the-balanced-default) and [usage](/docs/insights-analytics-and-cost-tracking).

For a mission launch, loop steps inherit the mission provider, model and effort unless an agent explicitly overrides them in the loop editor. General settings manage provider connections; the previous Provider defaults block and the Roles selector are no longer offered.
