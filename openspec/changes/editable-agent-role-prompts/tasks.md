## 1. Core definitions
- [x] 1.1 Expose actual role defaults, validate overrides, and compose them with required dynamic contracts; add tests.
## 2. Global settings and admission
- [x] 2.1 Persist and serve overrides and defaults atomically, freezing effective prompts only for new jobs; add validation and resume tests.
## 3. Editor
- [ ] 3.1 Add translated role tabs, editable definitions, reset, discard and save feedback beneath provider connections; cover editing and failure states.
## 4. Integration
- [x] 4.1 Validate the feature, document it and refresh the paired Core bundle.

Status 2026-10-21: not archivable as written — the backend shipped (#660, #664: `GET/PUT /runtime-role-prompts`,
`~/.specrails/runtime-role-prompts.json`, frozen per job), but #718 unmounted the global editor (3.1, unchecked again):
`RuntimeRolePrompts.tsx` is no longer rendered and role definitions are edited per workflow in `LoopAgentsEditor`. The
"Global role definition editor" requirement is therefore false today (and the code has a fourth role, `fixer`).
Remaining — decide whether to restore a global editor or rewrite the delta around per-workflow definitions, then
archive.
