# Spec Delta

## Purpose

Defines how project settings are presented: over the current view, preserving the project's right sidebar, as a native window in the desktop app and as an app modal on web.

## ADDED Requirements

### Requirement: Project settings keep the right sidebar
Project settings SHALL keep the active mode's right sidebar, its shared open/closed state and its toggle button, as a mission conversation of the same project does.

#### Scenario: Entering settings
- **WHEN** the user enters project settings
- **THEN** the right sidebar and its toggle remain available and can be opened and closed

### Requirement: Native window or app modal presentation
Project settings SHALL open over the current view as a native `project-settings` window in the Tauri app and as the in-app modal on web, with one shared content implementation and existing deep links preserved.

#### Scenario: Desktop app
- **WHEN** project settings open in Tauri
- **THEN** a native window opens and content scrolls inside it without moving the shell or bottom bar

#### Scenario: Web
- **WHEN** project settings open on web
- **THEN** the same content shows in the app modal with internal scrolling
