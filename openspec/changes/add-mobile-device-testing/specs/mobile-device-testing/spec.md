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

### Requirement: Run from Loops
Test in Mobile Device SHALL be listed in Loops with the built-ins while Core runs host tasks, editable in place and never copied or run as a generic or rail loop. Its card SHALL offer Run on a device: the person picks the project, what to test (the checkout as it is, a delivery on review, or a branch), the platform among those the code builds (remembered per project) and, optionally, the device per platform; the run is followed in the same dialog until the app is open, with a button per device. A branch SHALL be built in a temporary worktree outside the repository, removed when the run ends, so the checkout is never touched. The agents' MCP `mobile_test` SHALL take the same targets and devices. Publishing an edit SHALL keep its contract: a `mobile.build` and a `tapflow.deliver` step, no other host task, and no spec change.

#### Scenario: Test the current code
- **WHEN** the person runs it on the checkout with iOS chosen
- **THEN** the checkout is built as it is, uncommitted changes included, and the app opens on an iOS device

#### Scenario: Test a branch
- **WHEN** the person runs it on a branch
- **THEN** the branch is built in a temporary worktree, the checkout stays on its branch, and the worktree is removed once the run ends

#### Scenario: Choose the device
- **WHEN** the person picks a device that Tapflow lists
- **THEN** the app runs on that device; if it is gone, Tapflow's usual pick applies

#### Scenario: Not runnable
- **WHEN** Tapflow is off or missing, Core cannot run host tasks, the branch does not exist or the code has no app for the platform
- **THEN** nothing starts and the dialog says why

#### Scenario: Gradle build in a worktree
- **WHEN** an Android app is built in a worktree, which has no `local.properties`
- **THEN** the build gets the Android SDK (ANDROID_HOME) and a JDK 17+ (JAVA_HOME, else Android Studio's) unless the person set their own

### Requirement: Agent runs the app
In a mission with an active Intent session, when the person asks to run the app on iOS or Android, the agent SHALL start Test in Mobile Device on the Intent worktree through the Specrails MCP (`mobile_test`, target `mission`) instead of building or booting devices itself, wait for the run and report the device or the failure. The mission SHALL come from the agent's capability, never from arguments, and the call SHALL be admitted at any permission level inside the agent's own active Intent.

#### Scenario: Run on iOS
- **WHEN** the person says "run it on the iPhone" in an Intent session
- **THEN** the agent calls `mobile_test` with target `mission` and platform iOS, and the app opens on an iOS simulator inside Specrails

#### Scenario: No Intent
- **WHEN** a mission without an active Intent asks for target `mission`
- **THEN** nothing starts and the agent is told to use checkout or branch

### Requirement: Mission processes
A run started from a mission (its agent, or its delivery card) SHALL appear in the mission's Processes with the run's log (build, upload, boot, install, launch), the lines Tapflow's service writes meanwhile, the PID of the step at work and the outcome, kept in the process history like any other process; it cannot be stopped from the list.

#### Scenario: History
- **WHEN** the run ended and the person reopens the mission's Processes later
- **THEN** the entry is there with its full log and its outcome

### Requirement: Mission resources
A mission's Resources SHALL include the device its mobile tests launched while it runs, the build of a run in progress and the Tapflow service, each with CPU and memory (simulators by physical footprint), and the mission's resource history SHALL be recorded while a run is in progress.

#### Scenario: Device running
- **WHEN** the mission's run launched the app on a simulator that is still booted
- **THEN** the mission's Resources lists that simulator by name and the Tapflow service, and not other simulators
