# Verification

This change spans Desktop branch `codex/multi-repo-projects` and Core branch
`codex/implement-update-reliability`. Existing unrelated Desktop changes remain
in place. Validation uses temporary repositories, installations and provider
process fixtures; it does not upgrade registered user projects.

## Desktop

- Server/CLI/MCP suite: 7,991 tests verified. The full run passed 7,980 tests;
  11 failures came from the temporary `os.homedir()` isolation overriding two
  suites' own temporary-home fixtures. Those two suites were rerun with their
  own isolation: all 23 tests passed. No production code was changed for this.
- Client: all 4,699 tests in 372 files passed.
- `npm run typecheck` passed for server, CLI, MCP bridge and client.
- `npm run build` passed for server, client and CLI. Existing bundle-size
  warnings remain.
- Compatibility against the actual Core 5 checkout and schema 4.0 passed.
- Actual Desktop admission → compiled installed Core initialization/status →
  repeated Desktop admission passed for one repository and two repositories
  with a secondary artifact repository. Desktop's immutable context remains
  separate from Core's normalized journal context.
- OpenSpec strict validation passed.

## Core

Provider fixtures install real rendered Claude/Codex/Gemini/Kimi artifacts and
exercise shared scope, phase gates, retry and verification on temporary Git
repositories. Update tests cover failure restoration, copied and linked layouts,
version identity, missing compiled runtime and preservation of custom content.

- Complete suite after lifecycle fixes: all 567 tests in 39 files passed.
- Core build and test typecheck passed.
- Package smoke generated a real npm tarball, extracted it, materialized all
  four providers without activation, activated the complete framework once,
  assembled provider workspaces, and executed init/status/verify through the
  packaged CLI and installed runtime. Existing local npm dependencies supplied
  dependency resolution; all Core executable/template/contract bytes came from
  the tarball.
- The later environment-identity hardening passed all 28 runtime regressions,
  including changed/added/deleted application variables and explicit overrides.
  The run deliberately inherited a fake live context to verify test isolation.
  Build, typecheck, package smoke and Desktop/Core compatibility passed again
  with the final source.

## Limits

No paid provider inference or comparative time/cost benchmark was run. Native
provider behavior can still vary by installed CLI version. Windows script-shim
argument handling is branch-tested on macOS, not executed on a Windows machine.
Semantic acceptance remains an explicit reviewer obligation; successful commands
alone cannot prove the feature is complete.

Receipt reuse is conservative when the provider changes ambient environment:
unknown differences require another verification. The journal retains only
environment key names and hashes, not environment values. Linked file/directory
inputs are included in candidate hashes; cyclic, dangling or excessive linked
trees fail explicitly rather than producing a reusable green receipt.

Core changes must be built and distributed before existing Desktop installations
can receive them through the update channel. No package or application release
was published as part of this work.
