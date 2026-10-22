## Context

Core contract 5.7 (`agentRuntime.rulesInventory`): `<artifactRoot>/.specrails/rules.json` = `{schemaVersion: 1, generatedAt, gates[{id, kind, command, source}], rules[{id, text, source, status: enforcedBy|automatable|humanOnly|unclassified, enforcedBy?, proposedCheck?}], classification{status, provider?, model?, reason?, classifiedAt?}}`. CLI `specrails-core rules inventory [--root] [--artifact-root] [--offline] [--reclassify] [--json]`, exit 0 once written. Core `init` runs it offline, so rules start `unclassified`.

## Goals / Non-Goals

**Goals:** read the file tolerantly, act on it in one click, freeze reviewer reminders per delivery, reuse gates as checks.

**Non-Goals:** classifying rules in Desktop; running gates with a shell; editing rules.json from Desktop.

## Decisions

- **Workspace first.** The file is read from the relocated workspace's `.specrails/`, then the repository's.
- **Re-run verb.** `specrails-core rules inventory --root <repo> [--artifact-root <dir>]` through the resolved Core CLI and the bundled node; one run at a time per project; failures return 502 with the output.
- **Plain gates only.** Core's verification runner uses no shell, so a gate with shell syntax is not offered as a verification command.
- **Frozen reminders.** Human-only rules are copied into `settle_evidence.humanRules` at settle so a later edit does not rewrite an old packet.

## Risks / Trade-offs

- Desktop does not re-run the inventory automatically after setup → rules stay `unclassified` until the user clicks Re-run inventory with a configured provider; the panel says why.
