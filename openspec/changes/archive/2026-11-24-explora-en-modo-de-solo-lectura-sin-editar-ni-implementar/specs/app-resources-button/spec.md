# Spec Delta

## Purpose

Keeps the general Resources control reachable in the status bar at all times, so the resources panel is accessible from startup and at rest.

## ADDED Requirements

### Requirement: Resources button is always visible
The status bar SHALL render the Resources button whenever it renders, including before the first measurement, with zero work processes, with the panel closed, and across navigation and terminal open/close.

#### Scenario: Zero processes
- **WHEN** the measured work-process count is zero and the panel is closed
- **THEN** the button remains visible and shows `0`

#### Scenario: Count drops to zero
- **WHEN** the count changes from positive to zero
- **THEN** the button stays visible

#### Scenario: Panel opens at rest
- **WHEN** the user activates the button with zero processes
- **THEN** the resources panel opens

### Requirement: Count only when measured
The button SHALL show the process count only when a supported measurement exists without error; otherwise it SHALL keep the accessible name "Recursos de la app" and omit the counter.

#### Scenario: Loading, error or unsupported
- **WHEN** no snapshot exists yet, the request failed, or the platform is unsupported
- **THEN** the button is visible with the neutral accessible name and no counter
