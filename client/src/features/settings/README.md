# settings

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AgentRuntimeMetrics.tsx](components/AgentRuntimeMetrics.tsx)
- [components/AgentRuntimeRuns.tsx](components/AgentRuntimeRuns.tsx)
- [components/CustomRuntimeRoles.tsx](components/CustomRuntimeRoles.tsx)
- [components/RuntimeEfficiencyControls.tsx](components/RuntimeEfficiencyControls.tsx)
- [components/RuntimeExecutionEvidence.tsx](components/RuntimeExecutionEvidence.tsx)
- [components/RuntimeGuardrails.tsx](components/RuntimeGuardrails.tsx)
- [components/RuntimeRecovery.tsx](components/RuntimeRecovery.tsx)
- [components/RuntimeSteering.tsx](components/RuntimeSteering.tsx)
- [components/pickers/LanguagePickerGrid.tsx](components/pickers/LanguagePickerGrid.tsx)
- [components/pickers/ThemePickerGrid.tsx](components/pickers/ThemePickerGrid.tsx)
- [components/theme-effects/Starfield.tsx](components/theme-effects/Starfield.tsx)
- [components/theme-effects/ThemeEffectLayer.tsx](components/theme-effects/ThemeEffectLayer.tsx)
- [context/LanguageContext.tsx](context/LanguageContext.tsx)
- [context/ThemeContext.tsx](context/ThemeContext.tsx)
- [lib/agent-runtime.ts](lib/agent-runtime.ts)
- [lib/effects-prefs.ts](lib/effects-prefs.ts)
- [lib/project-settings-section-ids.ts](lib/project-settings-section-ids.ts)
- [lib/settings-registry.ts](lib/settings-registry.ts)
- [lib/terminal-settings-events.ts](lib/terminal-settings-events.ts)
- [lib/terminal-settings-types.ts](lib/terminal-settings-types.ts)
- [lib/theme-palette.ts](lib/theme-palette.ts)
- [lib/themes.ts](lib/themes.ts)
- [pages/GlobalSettingsPage.tsx](pages/GlobalSettingsPage.tsx)
- [pages/SettingsPage.tsx](pages/SettingsPage.tsx)

## Feature dependencies

- [builder](../builder/README.md)
- [integrations](../integrations/README.md)
- [jobs](../jobs/README.md)
- [loops](../loops/README.md)
- [missions](../missions/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [specs](../specs/README.md)
- [subscription-usage](../subscription-usage/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/settings`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
