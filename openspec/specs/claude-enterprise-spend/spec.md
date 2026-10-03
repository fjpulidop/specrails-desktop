# claude-enterprise-spend Specification

## Purpose
TBD - created by archiving change claude-enterprise-on-demand-usage. Update Purpose after archive.
## Requirements
### Requirement: Automatic Enterprise consumption classification

Desktop SHALL use the active Claude user session to detect the subscription and present monthly spend only for confirmed Enterprise accounts with financial usage and no meaningful conventional usage windows. No administrator key or manual budget SHALL be required.

#### Scenario: Enterprise reports only monthly spend
- **WHEN** an Enterprise user response contains a spend of 2078 minor USD units and a monthly cap of 100000 minor USD units without traditional windows
- **THEN** Desktop reports available usage and displays US$20.78 of US$1,000.00

#### Scenario: Normal plans report extra usage
- **WHEN** Pro, Max or Team reports extra usage alongside or without conventional windows
- **THEN** Desktop preserves its existing presentation and does not classify the account as Enterprise consumption

#### Scenario: Traditional Enterprise
- **WHEN** Enterprise reports valid session or weekly windows and extra usage
- **THEN** Desktop retains the conventional usage presentation

#### Scenario: Missing local subscription metadata
- **WHEN** financial usage has no traditional windows and local OAuth metadata has no subscription type
- **THEN** Desktop attempts a bounded read-only user profile lookup and requires confirmed Enterprise before showing the spend view

### Requirement: Accurate monetary presentation

The footer menu and settings SHALL show measured monthly spend, current assigned limit, currency and a progress bar when a percentage is available. They SHALL distinguish unknown amounts and caps from zero and unlimited caps, retain monetary amounts above the cap, and preserve other providers' views.

#### Scenario: Changed budget
- **WHEN** the next successful response changes the assigned cap
- **THEN** Desktop displays the new cap and percentage without requiring configuration

#### Scenario: Missing or unlimited cap
- **WHEN** Enterprise provides measured spend and an explicitly unlimited or missing cap
- **THEN** Desktop displays the spend with an unlimited or unknown-limit label and does not invent a percentage

#### Scenario: Over budget
- **WHEN** measured spend exceeds the assigned cap
- **THEN** Desktop retains the actual monetary values and caps only the visual bar at 100 percent

### Requirement: Financial observation lifecycle

Spend observations SHALL follow the existing machine-scoped refresh, account isolation and stale-value rules. Monthly resets SHALL follow provider timestamps when supplied or the documented calendar-month boundary at 00:00 UTC.

#### Scenario: Reset passes
- **WHEN** a monthly reset timestamp passes
- **THEN** the observation becomes stale and the previously measured spend is retained until refreshed

#### Scenario: Network failure or account change
- **WHEN** a refresh fails for the same account
- **THEN** prior spend remains visible as stale
- **WHEN** the user signs out or the account context changes
- **THEN** prior spend is cleared before showing the new account

