import type { RailPrDecision, RailImplementationOutcome, RailDeliveryOutcome } from '../types'

export interface RunExecutionManifest {
  version: 1
  groupId: string
  projectId: string
  primaryRepositoryId: string
  artifactRepositoryId: string
  selectedRepositoryIds: string[]
  repositories: Array<{
    repositoryId: string; name: string; sourcePath: string; gitCommonDir: string
    baseBranch: string; integrationBranch?: string; baseSha: string; worktreePath: string; branch: string; worktreeId: string
  }>
}

export interface RepositoryDeliverySnapshot {
  repositoryId: string
  name: string
  path: string
  deliveryId: string
  baseBranch: string
  integrationBranch?: string
  branch: string | null
  deliverySha: string | null
  decision: RailPrDecision
  implementationOutcome: RailImplementationOutcome
  deliveryOutcome: RailDeliveryOutcome
  statusCode: string | null
  statusDetail: string | null
  prUrl: string | null
  prNumber: number | null
  worktreeIds: string[]
  runIds: string[]
}
