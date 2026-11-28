## ADDED Requirements

### Requirement: Platform eligibility
The Tapflow plugin SHALL be offered for install only on macOS on Apple Silicon; on any other platform it SHALL be listed as unsupported with the reason and no install action.

#### Scenario: Intel Mac or Windows
- **WHEN** the app runs on Windows, Linux or an Intel Mac
- **THEN** the Tapflow card shows "Not available on this computer" with the reason and no install button

#### Scenario: Apple Silicon Mac
- **WHEN** the app runs on macOS on arm64 and Tapflow is not installed
- **THEN** the card shows Install and warns that iOS needs Xcode 26 or 27 and that Android needs Apple Silicon in this Tapflow version

### Requirement: Detection
The plugin SHALL detect a Specrails-managed install, an install the person made, and a running Tapflow, and SHALL never stop a Tapflow it did not start.

#### Scenario: Tapflow already running outside Specrails
- **WHEN** a Tapflow relay answers on its configured port and Specrails did not start it
- **THEN** the status is running-external and the switch does not stop it

#### Scenario: Not installed by default
- **WHEN** nothing is installed
- **THEN** the status is not-installed and no Tapflow process runs

### Requirement: Install in a terminal
Install SHALL open an installer terminal that installs the pinned Tapflow packages with Specrails' own Node and npm and then runs `tapflow setup` interactively, and SHALL record the install when the pinned packages are present after the terminal exits; a setup that did not finish SHALL be reported with a way to run it again.

#### Scenario: Successful install
- **WHEN** the installer terminal exits with code 0
- **THEN** the plugin is installed and inactive, with the installed version and the Node that installed it recorded

#### Scenario: Setup not finished
- **WHEN** the packages were installed but `tapflow setup` exited with another code or the terminal was closed
- **THEN** the plugin is installed and inactive, with a setup-incomplete warning and a Run setup again action

#### Scenario: Failed install
- **WHEN** the installer exits before the packages are installed
- **THEN** the plugin stays not-installed and the card shows the exit code

### Requirement: Activate and deactivate
Activating SHALL start a supervised Tapflow service bound to loopback only, with lean mode, audio off and display sleep allowed, and SHALL bootstrap its admin account and token without asking the person; deactivating SHALL stop it with SIGTERM.

#### Scenario: Activate
- **WHEN** the person turns the switch on
- **THEN** the service starts, answers its liveness probe, listens on 127.0.0.1 only, and the status becomes running

#### Scenario: Service dies
- **WHEN** the supervised service exits without being deactivated
- **THEN** the status becomes installed (inactive) with the reason, and the switch can start it again

#### Scenario: App restart
- **WHEN** the app starts and the plugin was active
- **THEN** the service is started again

### Requirement: Resource metering
While a Tapflow service runs, the Resources view SHALL show a `tapflow` category with the service tree and the simulator and emulator processes; with no Tapflow running the category SHALL not appear.

#### Scenario: Device booted
- **WHEN** Tapflow runs and an iOS simulator is booted
- **THEN** the category lists the Tapflow service and the simulator, each with CPU and memory

#### Scenario: Nothing running
- **WHEN** no Tapflow service runs
- **THEN** no `tapflow` category is listed, even if a simulator is booted
