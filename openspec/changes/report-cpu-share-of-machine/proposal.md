## Why

The Resources views (app-wide and per mission) showed CPU above 100 % (255 %, 358 %, peaks of 491 %): the
process table measures each process as a percent of ONE core and the views add processes up, so on a
10-core Mac the scale ran to 1000 %. People read a percentage as a share of the computer, like memory.

## What Changes

- Every API response with CPU (`GET /api/resources`, `GET .../missions/:chatId/resources` with its recorded
  history) reports it as a share of the whole machine, 0-100 %: the raw value divided by the logical cores,
  capped at 100. Responses carry `cpuCores`.
- Stored mission history keeps the raw value and is converted on read, so earlier points read on the same
  scale. The MCP (`specrails_insights resources`, mission resources) gets the same values.
- The CPU figure explains the scale on hover ("Of the whole Mac (10 cores): 100 % is every core busy").

## Capabilities

### Modified Capabilities
- `mission-resources`: CPU is a share of the machine.

## Impact

`server/modules/terminals` (domain `cpuShareOfMachine`, the app sampler), the mission resources route, the
client panels and their strings.
