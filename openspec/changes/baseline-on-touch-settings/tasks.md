## 1. Server

- [x] 1.1 `baselineOnTouch` setting (domain, SQLite, HTTP)
- [x] 1.2 Bridge `applyPhase3RuntimeSwitches` (capability-gated forwarding and stripping); `projectRuntime` executor option and composition; vendored schema 5.7 (byte-identical)
- [x] 1.3 Efficiency summary accepts `baseline` kind and keeps spend; `runtimeErrorText` for `baseline_characterization_failed`
- [x] 1.4 `baseline.json` harvest with capabilities and cost; packet `baseline`

## 2. Client

- [x] 2.1 Settings switch gated on the capability
- [x] 2.2 Packet section and "baseline of it" cost line; locales ×8

## 3. Verification and docs

- [x] 3.1 Server tests: switches, error text, metrics reader, harvest, packet, executor option, settings
- [x] 3.2 Client tests: section states, cost line, settings switch
- [x] 3.3 Docs: configuration, review packet, existing-project anchoring, user guide ×8
