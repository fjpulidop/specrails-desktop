# setup-wizard-install-cta — delta

## REMOVED Requirements

### Requirement: Install CTA is horizontally centered
**Reason**: The setup wizard (Configure/Install/Done) is removed by `global-core-zero-friction`; the configure step and its install CTA no longer exist.
**Migration**: Add Project registers immediately and assembles in background (`silent-project-add`); there is no install button to position.

### Requirement: Skip control remains left-anchored
**Reason**: The configure step footer no longer exists.
**Migration**: There is nothing to skip — the add flow has no wizard steps.
