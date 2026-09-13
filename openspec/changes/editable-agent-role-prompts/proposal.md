## Why
Users can choose models for agent roles but cannot inspect or change their instructions. Global role definitions should be editable beside provider connections and apply consistently across providers.
## What Changes
- Add global editors for architect, developer and reviewer definitions with factory defaults and per-role reset.
- Freeze effective definitions into new implementation jobs; preserve saved jobs on resume.
- Keep dynamic spec context, OpenSpec binding and output contracts outside the editable definition.
## Capabilities
### New Capabilities
- `editable-agent-role-prompts`: inspect, customize and reset global agent definitions.
### Modified Capabilities
None.
## Impact
Desktop settings UI, local settings API and job admission; paired Core config, prompt assembly and defaults catalog. No provider calls are needed to edit settings.
