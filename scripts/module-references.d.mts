export type ModuleReferenceKind = 'import' | 'export' | 'dynamic-import' | 'require' | 'import-type'

export interface ModuleReference {
  kind: ModuleReferenceKind
  /** Module string for a string literal or substitution-free template literal argument, otherwise null. */
  specifier: string | null
  literal: 'string' | 'template' | null
  /** 1-based line of the referencing node. */
  line: number
}

/** Parse `code` (named `file` to choose TS vs TSX syntax) and list its module references in source order. */
export function moduleReferences(file: string, code: string): ModuleReference[]
