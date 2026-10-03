# Verification

## Completed

- Core PR #400 merged with the explicitly authorized review exception at `cbcc601fb1add56881b1e53ebf03a4e7f48bf2e9`. Its source PR had 23/23 successful checks at `474adf4063e4865dcf8a2cc2c772c29a55cb4ff7`.
- Core main CI [37111155645](https://github.com/fjpulidop/specrails-core/actions/runs/37111155645) passed all 23 checks at that merge commit.
- Generated Core release PR #401 changes only the version, root lock, changelog and release manifest to 6.2.1. It was reviewed and merged at `ae52a5ff0ff9dce024008adf16115e7f04d1ef35`; its source tree is identical to the corrected companion PR, and the fix merge is an ancestor.
- Desktop `npm run test:scripts`: 95 passed, zero failed or skipped.
- Desktop `npm run build`: passed for server, client, CLI, MCP bridge and local runner.
- Desktop `npm run check:package`: passed the production consumer installation, CLI, MCP bridge, shell resource and integrity checks for the Desktop tarball.
- Desktop/Core source pairing at the 6.2.1 release revision: all 70 unique tests passed across the 11 CI-listed suites. The initial sandboxed run passed 69; the HTTP Studio case was blocked by local socket permissions and passed unchanged with that permission enabled.
- Explicit Desktop compatibility check against the compiled 6.2.1 release checkout passed (contract 5.1).
- Core release-commit CI [37112530744](https://github.com/fjpulidop/specrails-core/actions/runs/37112530744) passed all 23 checks at `ae52a5ff0ff9dce024008adf16115e7f04d1ef35`.
- [Core v6.2.1](https://github.com/fjpulidop/specrails-core/releases/tag/v6.2.1) was published to npm. The registry SHA-512 integrity matches both the release manifest and the downloaded tarball from that exact CI run; the tag resolves to the release commit.
- Regenerating the vendored npm lock changed only the root dependency declaration and `node_modules/specrails-core`; transitive entries remain identical.
- Integrity-locked assembly refreshed the generated Tauri Core resource from 5.3.0 to 6.2.1. CLI help, version and runtime API passed; the dependency closure is complete and the staged path budget passed.
- Offline materialization and assembly passed for Claude, Codex, Gemini and Kimi in temporary projects, including no-swap behavior, one final swap, version markers and managed runtime presence.
- Desktop contract compatibility passed against the actual staged published bundle (Core 6.2.1, contract 5.1). Final script checks passed all 95 tests after updating the lock and workflow pins.

## Requirement assessment

| Dimension | Result |
| --- | --- |
| Completeness | Bundle pin, dependency lock, CI release revision, supported Node and guide updated; contributor artifacts complete |
| Correctness | Fresh installation scenario covered by the actual published-bundle smoke; retained execution covered by the paired retention/fork/recovery suites |
| Coherence | Existing integrity-locked assembly and runtime selection retained; no production TypeScript or dependency policy changes |

No implementation gaps or verification failures remain. Desktop GitHub checks for the updated head are inspected separately after push.

## External release limitation

Core's publication job succeeded. Its downstream `notify` job failed with `Bad credentials` for `CROSS_REPO_TOKEN`, so Desktop/website repository dispatch notifications were not delivered. This is separate from the successful publication, tarball evidence and verified Desktop bundle update; credentials were not modified.

Consumer installations and smoke projects use temporary directories. Only the generated Tauri Core resource was refreshed locally. No user project, managed Core installation or live AI job has been changed.
