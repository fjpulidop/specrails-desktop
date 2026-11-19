// Public API of machine-wide installs (Core `machineInstalls`): the allowlist parser and the use cases.
export { INSTALL_ANSWERS, INSTALL_OPTION, installQuestionOf, parseInstallCommand, type InstallQuestion, type ParsedInstall } from './domain'
export { createMachineInstalls, type InstallApproval, type InstallApprovalStore, type InstallRunner, type InstallRunOutcome, type MachineInstalls } from './application'
