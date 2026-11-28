## 1. Server

- [x] 1.1 Mobile project detection, platform choice, build plans and artifact selection (pure), with tests
- [x] 1.2 Host tasks `mobile.build` and `tapflow.deliver` with their adapters, with tests
- [x] 1.3 `factory:mobile-test` recipe and registration, gated on Tapflow and host tasks
- [x] 1.4 Offer after delivery with platform choice and remembered preference

## 2. Client

- [x] 2.1 Offer row with platform buttons; strings in the 8 locales

## 3. Device windows

- [x] 3.1 Server: single-use ticket, Tapflow sign-in and cookie, redirect; release with grace period
- [x] 3.2 Host: `device_window_open` (external, no capability, loopback-only navigation, closed event)
- [x] 3.3 Client: Open <device> on the card; release on the closed event

## 4. Verification

- [x] 3.1 Suites and typecheck
- [x] 3.2 Live: an iOS sample project from the offer to the app running on the simulator
