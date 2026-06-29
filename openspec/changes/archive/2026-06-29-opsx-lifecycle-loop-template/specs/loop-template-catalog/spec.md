## ADDED Requirements

### Requirement: OpenSpec Lifecycle Template Registration

The loop template catalog SHALL register the `opsx-lifecycle` template under the existing `Automation` category (no new category is introduced) and serve it through the template-listing endpoint exactly like any other starter template, so it can be cloned into an editable draft loop. Registering it SHALL NOT require changes to the closed category taxonomy on server or client.

#### Scenario: Template listed under Automation
- **WHEN** the template catalog is listed
- **THEN** the `opsx-lifecycle` template appears with category `Automation`

#### Scenario: Template can be instantiated
- **WHEN** a draft loop is created from the `opsx-lifecycle` template
- **THEN** the new draft contains the template's full graph (ff → apply → verify → decider → archive → end)
