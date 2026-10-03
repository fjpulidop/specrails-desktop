## Why

Claude Enterprise accounts billed by consumption can report a monthly spend limit without session or weekly windows. Desktop currently discards that spend data and shows “Usage unavailable” despite a valid OAuth usage response.

## What Changes

- Detect the active Claude subscription from user OAuth metadata, with a read-only profile lookup when needed.
- Display monthly measured spend and the current assigned limit for Enterprise consumption accounts using the existing user session.
- Preserve session/weekly indicators for Pro, Max, Team and Enterprise accounts with traditional usage windows.
- Include Enterprise spend in the footer, settings panel, refresh and account-change lifecycle, preserving zero, missing values, currency and calendar-month resets.

## Capabilities

### New Capabilities

- `claude-enterprise-spend`: Automatically present monthly Enterprise consumption budgets from user-session observations.

### Modified Capabilities

None.

## Impact

Desktop's subscription-usage server and frontend feature, additive snapshot fields, adjacent tests, locale strings and feature READMEs. No administrator key, Core dependency, credential writes or persistence.
