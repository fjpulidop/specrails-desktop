## ADDED Requirements

### Requirement: Mission requests address the Specrails listener unambiguously
Internal development proxy, authentication and WebSocket destinations SHALL use the address family and configured port of the Specrails server. A project server on another loopback address SHALL NOT receive these requests merely because it shares the numeric port.

#### Scenario: IPv6 project frontend uses the same numeric port
- **WHEN** Specrails listens on 127.0.0.1 and a project serves HTML on ::1 at the same port
- **THEN** mission API and WebSocket traffic SHALL reach Specrails through IPv4.

### Requirement: Invalid API responses preserve recoverable mission state
Mission API handling SHALL report non-JSON or unavailable-server responses as understandable connection/response failures rather than exposing parser exceptions. Failed or uncertain sends SHALL preserve the draft and request identity and SHALL NOT be blindly replayed.

#### Scenario: A send receives HTML
- **WHEN** a mission send receives HTML instead of its expected JSON response
- **THEN** the user SHALL receive a localized actionable error
- **AND** the message SHALL remain available for a deliberate retry without duplicate execution.

#### Scenario: Unknown API path
- **WHEN** a request reaches an unknown Specrails API route
- **THEN** the server SHALL return a JSON error rather than its SPA document.
