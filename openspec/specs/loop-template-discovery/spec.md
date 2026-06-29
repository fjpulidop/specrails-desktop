# loop-template-discovery Specification

## Purpose
TBD - created by archiving change loop-template-library. Update Purpose after archive.
## Requirements
### Requirement: Template Search

The Loops gallery SHALL provide a search input that filters the Templates section by a case-insensitive substring match over each template's name, description, tags, and category. Filtering SHALL be applied client-side over the already-loaded template list and SHALL NOT affect the user's own Drafts or Published loops.

#### Scenario: Search narrows the template list

- **WHEN** the user types a query into the template search input
- **THEN** only templates whose name, description, tags, or category contain the query (case-insensitively) SHALL remain visible in the Templates section

#### Scenario: Search does not affect user loops

- **WHEN** a template search query is active
- **THEN** the Drafts and Published sections SHALL continue to show all of the user's loops unfiltered

#### Scenario: Empty query shows all templates

- **WHEN** the search input is empty and no category chip is selected
- **THEN** every bundled template SHALL be visible

### Requirement: Category Chip Filter

The Loops gallery SHALL render a row of category chips, one per category present in the catalog, each labelled with the category and a count of matching templates. Chips SHALL be multi-selectable; selecting one or more chips SHALL show only templates whose category is among the selected chips, combined (AND) with any active search query. A means to clear the category selection SHALL be provided. Chips SHALL use semantic theme tokens only.

#### Scenario: Selecting a chip filters by category

- **WHEN** the user selects the chip for a category
- **THEN** only templates in that category SHALL be shown in the Templates section

#### Scenario: Multiple chips union their categories

- **WHEN** the user selects two or more category chips
- **THEN** templates belonging to any of the selected categories SHALL be shown

#### Scenario: Chips combine with search

- **WHEN** a search query and one or more category chips are both active
- **THEN** only templates that match the query AND belong to a selected category SHALL be shown

#### Scenario: Clearing the selection restores all categories

- **WHEN** the user clears the category selection
- **THEN** templates of every category SHALL again be eligible (subject only to any active search query)

### Requirement: Template Card Category And Tags

Each template card in the gallery SHALL display the template's category as a badge and SHALL display its tags. When the active filter yields no templates, the gallery SHALL render a localized empty state with an action to clear the filter.

#### Scenario: Card shows category and tags

- **WHEN** a template card renders
- **THEN** it SHALL show the template's category as a badge
- **AND** it SHALL show the template's tags

#### Scenario: No-results empty state

- **WHEN** the active search query and category selection match zero templates
- **THEN** the Templates section SHALL render a localized empty state
- **AND** the empty state SHALL offer an action that clears the active filter

### Requirement: Discovery Strings Localized

Every user-facing string introduced by the discovery UI (search placeholder, category labels, counts framing, empty-state copy, clear-filter action) SHALL be provided through the `loops` i18n namespace and SHALL be available in all 8 supported locales, enforced by the key-parity test.

#### Scenario: Category labels exist in every locale

- **WHEN** the locale resources are loaded
- **THEN** a localized label SHALL exist for each of the 15 categories in every supported locale

#### Scenario: Key-parity covers discovery strings

- **WHEN** the locale key-parity test runs
- **THEN** it SHALL fail if any locale is missing a discovery string key or placeholder present in the English `loops` namespace

