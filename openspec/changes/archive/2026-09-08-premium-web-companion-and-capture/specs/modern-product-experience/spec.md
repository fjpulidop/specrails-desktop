## ADDED Requirements

### Requirement: Mission-first product discovery
The site SHALL present missions as the primary workflow, describe Board as a complementary view, and explain specs, loops, multi-repo execution, review, observability and Companion without fabricated runtime guarantees.

#### Scenario: Explore on a phone
- **WHEN** a visitor opens the homepage on a narrow screen
- **THEN** product navigation, tour and calls to action remain readable, keyboard accessible and free of page overflow.

### Requirement: Faithful product recordings
Feature demos SHALL use recordings of the actual application, preserving its interface 1:1. Visitors SHALL be able to start, pause and expand a recording. Initial page load SHALL not download video streams before the visitor starts playback.

#### Scenario: Inspect a feature recording
- **WHEN** a visitor starts and expands a feature recording
- **THEN** the original app interface is visible without invented controls or cropped content, with accessible playback controls and a textual description.

### Requirement: Current localized documentation
Documentation SHALL provide searchable current guides and load article bodies separately from the public landing bundle. Incomplete translations MUST identify the current fallback language.

#### Scenario: Open an untranslated current guide
- **WHEN** a visitor selects a guide unavailable in their selected language
- **THEN** the current fallback article opens with an explicit language notice and stable navigation.
