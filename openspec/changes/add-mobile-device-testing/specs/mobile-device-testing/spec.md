## ADDED Requirements

### Requirement: Mobile app detection
Specrails SHALL detect the iOS and Android apps a repository builds — native Xcode and Gradle apps, Kotlin Multiplatform, Flutter, React Native and Expo — and SHALL report none for a project without a mobile app.

#### Scenario: Native iOS app
- **WHEN** the repository has an Xcode project with an iOS application target
- **THEN** one iOS app is detected, built from its workspace when one exists

#### Scenario: Cross-platform app
- **WHEN** the repository is a Flutter, React Native or Expo app with both platforms
- **THEN** one iOS and one Android app are detected, and their native folders are not reported again as separate native apps

### Requirement: Platform choice
A project with one mobile platform SHALL be tested on it without asking; a multiplatform project SHALL ask iOS, Android or Both, recommending the platform the change touched (both for shared code) or the person's remembered choice for the project.

#### Scenario: Change in shared code
- **WHEN** a Flutter project's change touches only Dart files
- **THEN** the offer asks the platform and recommends Both

#### Scenario: Remembered choice
- **WHEN** the person chose Android last time for the project
- **THEN** the next offer recommends Android

### Requirement: Build for the simulator
The loop SHALL build a Debug, unsigned, arm64 simulator build with the project's own tools in the run's working copy, keep build output under `.specrails/mobile-build/`, and install only a simulator `.app` or an arm64/universal `.apk`.

#### Scenario: Build fails
- **WHEN** the build command exits non-zero
- **THEN** the run ends failed with the command and the tail of its log, and nothing is installed

### Requirement: Run on a Tapflow device
The loop SHALL upload the build to Tapflow, boot or reuse one device of the platform, install and launch the app, and SHALL always end its device session, also on failure.

#### Scenario: Tapflow off
- **WHEN** the loop reaches delivery and Tapflow is not running
- **THEN** the run ends with "Turn Tapflow on" as the reason and the build kept

#### Scenario: App launched
- **WHEN** install and launch succeed
- **THEN** the run succeeds and reports the device and the build

### Requirement: Offer after delivery
After Implement delivers code for a project with a mobile app, while Tapflow is installed, the mission SHALL show a "Test in Mobile Device" offer; it SHALL not appear otherwise.

#### Scenario: Web project
- **WHEN** a web project's run delivers
- **THEN** no mobile offer appears

### Requirement: Device window
Once the app runs, the offer SHALL open the device in a native Specrails window showing Tapflow's interactive device view, signed in without asking the person; the window SHALL have no host command access, navigate only within loopback HTTP, and closing it SHALL shut the device down after a grace period unless it is reopened.

#### Scenario: Open the device
- **WHEN** the person presses Open <device> on a launched offer
- **THEN** a native window opens on the device, live and interactive, already signed in to Tapflow

#### Scenario: Close the window
- **WHEN** the person closes the device window and does not reopen it within the grace period
- **THEN** the device is shut down and its screen capture stops
