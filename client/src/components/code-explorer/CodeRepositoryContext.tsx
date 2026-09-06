import { createContext, useContext } from 'react'
import { getApiBase } from '../../lib/api'

export interface CodeRepositoryScope {
  apiBase: string
  repositoryId?: string
  repositoryPath?: string
  isPrimary?: boolean
}

export const CodeRepositoryContext = createContext<CodeRepositoryScope | null>(null)

export function useCodeRepository(): CodeRepositoryScope {
  const scope = useContext(CodeRepositoryContext)
  // Standalone legacy file viewers preserve the existing project route.
  return scope ?? { apiBase: getApiBase() }
}

export function matchesCodeRepository(eventRepositoryId: string | undefined, scope: Pick<CodeRepositoryScope, 'repositoryId' | 'isPrimary'>): boolean {
  return eventRepositoryId ? eventRepositoryId === scope.repositoryId : !scope.repositoryId || scope.isPrimary === true
}
