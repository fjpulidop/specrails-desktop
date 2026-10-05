## Why

Successful verification can flood a rail with tens of thousands of Jest console warnings, stack frames and passing-suite lines. The readable log becomes truncated and difficult to inspect even though the runtime already records separate evidence.

## What Changes

- Compact verification output in Desktop's readable log for Jest and other verbose commands, retaining bounded diagnostic context and final summaries.
- Show explicit omission notices and command outcomes without changing verification execution or success rules.
- Preserve original runtime events and evidence, including their existing retention limits, for detailed diagnosis.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `factory-loops`: Readable verification logs remain bounded and expose outcomes even for noisy successful commands.

## Impact

Desktop agent-runtime bridge, its focused regression tests and log documentation. No project-specific rules, test-command changes, Core verification policy changes or credential changes.
