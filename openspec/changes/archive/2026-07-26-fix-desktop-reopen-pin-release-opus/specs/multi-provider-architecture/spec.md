## ADDED Requirements

### Requirement: Claude catalog aliases resolve to explicit model ids at spawn time

The Claude adapter's catalog values are short aliases (`sonnet`, `opus`, `fable`, `haiku`) that remain the stored, validated, and displayed identity of a model choice. Where an alias would otherwise let the CLI decide which generation to run, the adapter SHALL resolve it to an explicit model id in the spawn arguments so the executed model is a product decision, not a CLI default.

The `opus` alias SHALL resolve to `claude-opus-5` in every spawn action that passes a model. Aliases without a pinned generation SHALL be passed through unchanged, and any value that is already a concrete model id SHALL be passed through unchanged.

The reverse mapping that collapses concrete model ids back to a catalog alias SHALL recognise `claude-opus-5` as `opus`, so persistence, analytics grouping, and selector state remain stable across the change.

#### Scenario: Selecting Opus spawns Opus 5

- **WHEN** a Claude spawn is built with model `opus`
- **THEN** the spawn arguments SHALL pass `claude-opus-5` as the model

#### Scenario: Other aliases are unchanged

- **WHEN** a Claude spawn is built with model `sonnet`, `haiku`, or `fable`
- **THEN** the spawn arguments SHALL pass that value unchanged

#### Scenario: Concrete ids pass through

- **WHEN** a Claude spawn is built with an explicit model id
- **THEN** the spawn arguments SHALL pass that id unchanged

#### Scenario: Opus 5 normalises back to the catalog alias

- **WHEN** a stream or stored row reports the model `claude-opus-5`
- **THEN** normalisation SHALL collapse it to the catalog value `opus`
