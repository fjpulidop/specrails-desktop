## 1. Release Core

- [x] 1.1 Merge the CI-passing Core companion PR through the authorized GitHub path.
- [x] 1.2 Complete the generated Core release PR and verify the published version, release revision and npm metadata.

## 2. Bundle the released runtime

- [x] 2.1 Regenerate the vendored Core dependency lock and update the matching release version assertion.
- [x] 2.2 Pair CI with the immutable release revision and align the Windows bundle Node runtime.
- [x] 2.3 Update the narrow Core runtime guide with the released version and contract.

## 3. Verify and deliver

- [x] 3.1 Refresh the generated Tauri Core bundle from the published package, verify its CLI and Desktop contract, and run applicable script/build/package checks.
- [x] 3.2 Validate and sync the contributor specification, record verification evidence and archive the change.
- [x] 3.3 Prepare the Desktop commit and PR description with the exact bundled release and validation evidence.
